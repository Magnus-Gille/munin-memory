/**
 * Answer-quality eval runner.
 *
 * Orchestrates: open snapshot → retrieve → serialize → generate answer →
 * judge → aggregate results.
 *
 * Reuses the production retrieval pipeline (executeQuery + applyProductionReranker)
 * from benchmark/runner.ts so the eval exercises the same code path as the IR
 * benchmark and the MCP memory_query tool.
 *
 * All LLM calls go through the injected `chat` function — tests pass a mock,
 * live runs use the shared callOpenRouter.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setVecLoaded } from "../../src/db.js";
import { initEmbeddings } from "../../src/embeddings.js";
import {
  DEFAULT_SEARCH_RECENCY_WEIGHT,
  QUERY_RERANK_OVERFETCH_MULTIPLIER,
} from "../../src/internal/reranker.js";
import {
  callOpenRouter as defaultCallOpenRouter,
  getOpenRouterApiKey,
  isCustomLlmBaseUrl,
} from "../../src/internal/openrouter.js";
import type { QueryParams } from "../../src/types.js";
import type { SearchMode } from "../../src/types.js";
import { executeQuery, applyProductionReranker, checkProductionRankerPrereqs } from "../runner.js";
import type { BenchmarkQuery, QuerySetSource, DurationSummary, RunnerMode } from "../types.js";
import { populateCorpusEmbeddings, type CorpusEmbeddingSummary } from "../adapters/shared.js";
import { serializeContext } from "./serialize.js";
import { generateAnswer, judgeAnswer, type ChatFn } from "./judge.js";
import {
  type AnswerQualityReport,
  type AnswerQualityResult,
  type AnswerQualityCategorySummary,
  type LlmCallIdentity,
  type TokenUsage,
  type SerializationMode,
} from "./types.js";

// --- Options ---

export interface AnswerQualityOptions {
  snapshotPath: string;
  queries: BenchmarkQuery[];
  serialization: SerializationMode;
  /** Runner mode. Defaults to "production_ranker". */
  runnerMode?: RunnerMode;
  /** Search mode. Defaults to "hybrid". */
  searchMode?: SearchMode;
  searchRecencyWeight?: number;
  /** Number of top entries serialized into context. Defaults to 10. */
  topK?: number;
  /** Enforced retrieved-context budget using the pinned UTF-8/4 estimator. */
  contextTokenBudget?: number;
  /** Model for answer generation. */
  answerModel: string;
  /** Model for judging. Should differ from answerModel to reduce self-preference. */
  judgeModel: string;
  /** Reader sampling temperature. Omitted means provider/model default. */
  answerTemperature?: number;
  /** Reader output-token ceiling. Defaults to the shared client ceiling (4096). */
  answerMaxTokens?: number;
  /** Judge sampling temperature. Defaults to 0. */
  judgeTemperature?: number;
  /** Judge output-token ceiling. Defaults to the shared client ceiling (4096). */
  judgeMaxTokens?: number;
  /** Injected LLM call function. Defaults to shared callOpenRouter. */
  chat?: ChatFn;
  /** OpenRouter API key. Defaults to getOpenRouterApiKey(). */
  apiKey?: string | null;
  /** Per-file lineage metadata for the query set(s). */
  querySetSources?: QuerySetSource[];
  /** Optional progress hook for long paid suites. */
  onProgress?: (completed: number, total: number) => void;
  /**
   * Fail at the individual call boundary unless provider-native usage, cost,
   * response model, and provider identity are complete. Publication harnesses
   * enable this; exploratory answer-quality runs preserve graceful diagnostics.
   */
  requireCompleteUsage?: boolean;
}

// --- Skip predicate (also exported for unit tests) ---

/**
 * Returns a skip message when the answer-quality eval cannot proceed,
 * or null when it is safe to run.
 *
 * Exported for unit testing; the CLI and runner call it internally.
 */
export function shouldSkipForMissingKey(
  apiKey: string | null | undefined,
  chat: ChatFn | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (chat) return null; // injected mock — always runnable
  const key = apiKey ?? env.OPENROUTER_API_KEY ?? null;
  if (key && key.length > 0) return null; // explicit key provided
  // A non-default base URL (local server) needs no API key — allow running.
  if (isCustomLlmBaseUrl(env)) return null;
  return (
    "OPENROUTER_API_KEY unset — answer-quality eval requires it. " +
    "Set OPENROUTER_API_KEY in your environment and re-run."
  );
}

// --- Embedding requirement predicate ---

/**
 * Returns true when at least one eligible query (has reference_answer) will
 * use a non-lexical search mode, meaning corpus embeddings must be generated
 * before the read-only DB is opened.
 *
 * Exported for unit tests.
 */
export function querySetRequiresEmbeddings(
  queries: BenchmarkQuery[],
  searchMode: SearchMode,
): boolean {
  return queries.some((q) => {
    if (q.reference_answer === undefined) return false; // only eligible queries run
    const effectiveMode = q.search_mode === "all" ? searchMode : q.search_mode;
    return effectiveMode !== "lexical";
  });
}

// --- Aggregation helpers ---

function percentilesFromSortedMs(sorted: number[]): { p50_ms: number | null; p95_ms: number | null } {
  if (sorted.length === 0) return { p50_ms: null, p95_ms: null };
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? null;
  const p95 = sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)] ?? null;
  return { p50_ms: p50, p95_ms: p95 };
}

function summarizeDurations(durations: number[]): DurationSummary {
  if (durations.length === 0) return { p50_ms: null, p95_ms: null, total_ms: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const { p50_ms, p95_ms } = percentilesFromSortedMs(sorted);
  const total_ms = durations.reduce((s, d) => s + d, 0);
  return {
    p50_ms: p50_ms !== null ? Math.round(p50_ms * 100) / 100 : null,
    p95_ms: p95_ms !== null ? Math.round(p95_ms * 100) / 100 : null,
    total_ms: Math.round(total_ms * 100) / 100,
  };
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a && !b) return undefined;
  const cost = (a?.cost ?? 0) + (b?.cost ?? 0);
  const hasCost = a?.cost !== undefined || b?.cost !== undefined;
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    ...(hasCost ? { cost } : {}),
  };
}

function requireCompleteCallEvidence(
  queryId: string,
  role: "reader" | "judge",
  usage: TokenUsage | undefined,
  identity: LlmCallIdentity | undefined,
  callError: string | undefined,
): void {
  const prefix = `Scorecard query ${queryId} ${role}`;
  if (callError !== undefined) {
    throw new Error(`${prefix} call failed: ${callError}`);
  }
  if (usage === undefined) {
    throw new Error(`${prefix} call is missing provider-native usage.`);
  }
  if (
    !Number.isSafeInteger(usage.prompt_tokens)
    || usage.prompt_tokens < 0
    || !Number.isSafeInteger(usage.completion_tokens)
    || usage.completion_tokens < 0
  ) {
    throw new Error(`${prefix} call has invalid provider-native token usage.`);
  }
  if (usage.cost === undefined || !Number.isFinite(usage.cost) || usage.cost < 0) {
    throw new Error(`${prefix} call is missing a valid provider-reported cost.`);
  }
  if (
    identity?.response_model === undefined
    || identity.response_model.trim().length === 0
    || identity.provider === undefined
    || identity.provider.trim().length === 0
  ) {
    throw new Error(`${prefix} call is missing provider/model execution identity.`);
  }
}

function computeQuerySetChecksum(sources: QuerySetSource[]): string {
  const pairs = [...sources]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((s) => `${s.filename}:${s.sha256}`)
    .join("|");
  return createHash("sha256").update(pairs).digest("hex");
}

// --- Main runner ---

/**
 * Run the answer-quality eval and produce a report.
 *
 * Graceful skip: if OPENROUTER_API_KEY is unset and no `chat` mock is
 * injected, returns immediately with `{ skipped: true, ... }` — zero network
 * calls, no throw.
 */
export async function runAnswerQuality(
  opts: AnswerQualityOptions,
): Promise<AnswerQualityReport> {
  const runAt = new Date().toISOString();
  const serialization = opts.serialization;
  const runnerMode: RunnerMode = opts.runnerMode ?? "production_ranker";
  const searchMode: SearchMode = opts.searchMode ?? "hybrid";
  const topK = opts.topK ?? 10;
  const contextTokenBudget = opts.contextTokenBudget ?? null;
  if (
    contextTokenBudget !== null
    && (!Number.isSafeInteger(contextTokenBudget) || contextTokenBudget <= 0)
  ) {
    throw new Error("contextTokenBudget must be a positive safe integer.");
  }
  const searchRecencyWeight = opts.searchRecencyWeight ?? null;
  const answerTemperature = opts.answerTemperature ?? null;
  const answerMaxTokens = opts.answerMaxTokens ?? 4096;
  const judgeTemperature = opts.judgeTemperature ?? 0;
  const judgeMaxTokens = opts.judgeMaxTokens ?? 4096;

  // Graceful skip when no API key is available
  const skipReason = shouldSkipForMissingKey(opts.apiKey, opts.chat);
  if (skipReason) {
    return {
      report_kind: "answer_quality",
      report_schema_version: 3,
      run_at: runAt,
      snapshot_path: opts.snapshotPath,
      snapshot_schema_version: 0,
      entry_count: 0,
      serialization,
      runner_mode: runnerMode,
      search_mode: searchMode,
      search_recency_weight: searchRecencyWeight,
      top_k: topK,
      context_token_budget: contextTokenBudget,
      context_token_estimator: "utf8_bytes_div4_ceil_v1",
      answer_model: opts.answerModel,
      answer_temperature: answerTemperature,
      answer_max_output_tokens: answerMaxTokens,
      judge_model: opts.judgeModel,
      judge_temperature: judgeTemperature,
      judge_max_output_tokens: judgeMaxTokens,
      query_set_sources: opts.querySetSources ?? [],
      query_set_checksum: computeQuerySetChecksum(opts.querySetSources ?? []),
      query_count: 0,
      skipped_no_reference: 0,
      overall_accuracy: 0,
      overall_mean_score: 0,
      judge_parse_failures: 0,
      overall_duration: { p50_ms: null, p95_ms: null, total_ms: 0 },
      by_category: [],
      results: [],
      usage_accounting: {
        expected_calls: 0,
        usage_reported_calls: 0,
        cost_reported_calls: 0,
      },
      execution_identity: {
        requested_answer_model: opts.answerModel,
        requested_judge_model: opts.judgeModel,
        response_models: [],
        providers: [],
        missing_identity_calls: 0,
      },
      embedding_summary: null,
      skipped: true,
      skip_reason: skipReason,
    };
  }

  const apiKey = opts.apiKey ?? getOpenRouterApiKey() ?? "";
  const chat: ChatFn = opts.chat ?? defaultCallOpenRouter;

  // Pre-populate corpus embeddings (read-write pass) BEFORE opening the read-only DB.
  // A hybrid/semantic run has no vectors in a freshly-copied snapshot — without this
  // the run silently degrades to lexical (see #137).
  let embeddingSummary: CorpusEmbeddingSummary | null = null;
  if (querySetRequiresEmbeddings(opts.queries, searchMode)) {
    embeddingSummary = await populateCorpusEmbeddings(opts.snapshotPath);
    if (embeddingSummary.total > 0 && embeddingSummary.vector_rows === 0) {
      throw new Error(
        `answer-quality: hybrid/semantic run requested but snapshot ${opts.snapshotPath} has 0 usable vectors ` +
          `(total=${embeddingSummary.total}, generated=${embeddingSummary.generated}, failed=${embeddingSummary.failed}, ` +
          `vector_rows=${embeddingSummary.vector_rows}) — the run would silently degrade to lexical (see #137).`,
      );
    }
  }

  // Open snapshot DB (read-only)
  const db = new Database(opts.snapshotPath, { readonly: true });
  try {
    return await runAnswerQualityInner(
      db,
      opts,
      runAt,
      serialization,
      runnerMode,
      searchMode,
      topK,
      searchRecencyWeight,
      apiKey,
      chat,
      embeddingSummary,
    );
  } finally {
    db.close();
  }
}

export async function runAnswerQualityInner(
  db: Database.Database,
  opts: AnswerQualityOptions,
  runAt: string,
  serialization: SerializationMode,
  runnerMode: RunnerMode,
  searchMode: SearchMode,
  topK: number,
  searchRecencyWeight: number | null,
  apiKey: string,
  chat: ChatFn,
  embeddingSummary: CorpusEmbeddingSummary | null = null,
): Promise<AnswerQualityReport> {
  const warnings: string[] = [];
  const answerTemperature = opts.answerTemperature ?? null;
  const answerMaxTokens = opts.answerMaxTokens ?? 4096;
  const judgeTemperature = opts.judgeTemperature ?? 0;
  const judgeMaxTokens = opts.judgeMaxTokens ?? 4096;

  // Partition queries: those with a reference_answer field participate; others are skipped.
  // Note: empty-string reference_answer is allowed (e.g. adversarial/unanswerable questions
  // where the correct response is abstention — the judge rubric handles them appropriately).
  // Computed BEFORE the embeddings init block so we can inspect per-query effective modes.
  const eligible = opts.queries.filter((q) => q.reference_answer !== undefined);
  const skippedNoReference = opts.queries.length - eligible.length;

  // Determine whether ANY eligible query needs embeddings (semantic or hybrid effective mode).
  // A query's effective mode is its own search_mode unless it is "all", in which case the
  // global searchMode is used. This fixes a bug where the embeddings init was gated only on
  // the global searchMode: when global=lexical but a per-query search_mode="semantic|hybrid",
  // embeddings were never initialized, silently degrading those queries to lexical.
  const requiresEmbeddings = querySetRequiresEmbeddings(opts.queries, searchMode);

  // Load sqlite-vec (soft dependency — lexical still works without it)
  try {
    sqliteVec.load(db);
    setVecLoaded(true);
  } catch (err) {
    setVecLoaded(false);
    const msg = err instanceof Error ? err.message : String(err);
    if (requiresEmbeddings) {
      warnings.push(`sqlite-vec unavailable — search degraded to lexical. (${msg})`);
    }
  }

  // Init embeddings (needed for semantic/hybrid — gated on per-query effective modes)
  if (requiresEmbeddings) {
    try {
      const embeddingsReady = await initEmbeddings();
      if (!embeddingsReady) {
        warnings.push(
          `initEmbeddings() returned false — embedding model did not load. Search will degrade to lexical.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Embedding init failed — search may degrade to lexical. (${msg})`);
    }
  }

  // DB metadata
  const schemaRow = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number } | undefined;
  const snapshotSchemaVersion = schemaRow?.v ?? 0;
  const countRow = db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number };
  const entryCount = countRow.c;

  // Fail loud before any LLM calls when production_ranker prereqs are not met
  if (runnerMode === "production_ranker") {
    const prereq = checkProductionRankerPrereqs(db, snapshotSchemaVersion);
    if (!prereq.ok) {
      throw new Error(`production_ranker prereq check failed: ${prereq.reason}`);
    }
  }

  // Query set lineage
  const querySetSources = opts.querySetSources ?? [];
  if (querySetSources.length === 0) {
    warnings.push("query_set_sources not tracked — lineage unavailable for reproducibility");
  }
  const querySetChecksum = computeQuerySetChecksum(querySetSources);

  // Per-query eval
  const results: AnswerQualityResult[] = [];
  let totalUsage: TokenUsage | undefined = undefined;

  const internalLimit =
    runnerMode === "production_ranker"
      ? Math.min(topK * QUERY_RERANK_OVERFETCH_MULTIPLIER, 50)
      : topK;

  for (const query of eligible) {
    const queryStart = performance.now();
    const retrievalStart = queryStart;

    // Retrieve — honor per-query search_mode override (skip when "all", use global then)
    const querySearchMode = query.search_mode === "all" ? searchMode : query.search_mode;
    const { entries: rawEntries, effectiveMode } = await executeQuery(
      db,
      query.query,
      querySearchMode,
      internalLimit,
      undefined,
      query.scope_namespace,
    );

    let finalEntries = rawEntries;
    if (runnerMode === "production_ranker") {
      const queryParams: QueryParams = {
        query: query.query,
        limit: topK,
        search_mode: effectiveMode,
        search_recency_weight: searchRecencyWeight ?? DEFAULT_SEARCH_RECENCY_WEIGHT,
        include_expired: true,
        explain: false,
        namespace: query.scope_namespace,
      };
      finalEntries = applyProductionReranker(db, rawEntries, queryParams, topK);
    } else {
      finalEntries = rawEntries.slice(0, topK);
    }
    const retrievalMs = performance.now() - retrievalStart;

    const retrievedIds = finalEntries.map((e) => e.id);

    // Serialize context
    const serializationStart = performance.now();
    const {
      text: contextText,
      orderedIds: serializedOrderIds,
      budget: contextBudget,
    } = serializeContext(
      finalEntries,
      serialization,
      opts.contextTokenBudget === undefined
        ? undefined
        : {
            maxEstimatedTokens: opts.contextTokenBudget,
            estimator: "utf8_bytes_div4_ceil_v1",
          },
    );
    const serializationMs = performance.now() - serializationStart;

    // Generate answer
    let candidateAnswer = "";
    let answerUsage: TokenUsage | undefined;
    let answerCall: LlmCallIdentity | undefined;
    let answerError: string | undefined;
    const readerStart = performance.now();
    try {
      const generated = await generateAnswer(
        {
          question: query.query,
          questionDate: query.question_date,
          context: contextText,
          model: opts.answerModel,
          apiKey,
          temperature: opts.answerTemperature,
          maxTokens: answerMaxTokens,
        },
        chat,
      );
      candidateAnswer = generated.answer;
      answerUsage = generated.usage;
      answerCall = generated.call_identity;
    } catch (err) {
      answerError = err instanceof Error ? err.message : String(err);
      candidateAnswer = `[answer generation failed: ${answerError}]`;
    }
    const readerMs = performance.now() - readerStart;
    if (opts.requireCompleteUsage) {
      requireCompleteCallEvidence(
        query.id,
        "reader",
        answerUsage,
        answerCall,
        answerError,
      );
    }

    // Judge
    const referenceAnswer = query.reference_answer!;
    let verdict;
    let judgeUsage: TokenUsage | undefined;
    let judgeCall: LlmCallIdentity | undefined;
    let judgeError: string | undefined;
    const judgeStart = performance.now();
    try {
      const judgeResult = await judgeAnswer(
        {
          question: query.query,
          referenceAnswer,
          candidateAnswer,
          category: query.category,
          model: opts.judgeModel,
          apiKey,
          temperature: judgeTemperature,
          maxTokens: judgeMaxTokens,
        },
        chat,
      );
      verdict = judgeResult;
      judgeUsage = judgeResult.usage;
      judgeCall = judgeResult.call_identity;
    } catch (err) {
      judgeError = err instanceof Error ? err.message : String(err);
      verdict = {
        correct: false,
        score: 0,
        reasoning: `[judge failed: ${judgeError}]`,
        parse_ok: false,
        raw: undefined,
      };
    }
    const judgeMs = performance.now() - judgeStart;
    if (opts.requireCompleteUsage) {
      requireCompleteCallEvidence(
        query.id,
        "judge",
        judgeUsage,
        judgeCall,
        judgeError,
      );
    }

    const durationMs = Math.round((performance.now() - queryStart) * 100) / 100;
    totalUsage = addUsage(totalUsage, addUsage(answerUsage, judgeUsage));

    results.push({
      query_id: query.id,
      category: query.category,
      question: query.query,
      question_date: query.question_date,
      reference_answer: referenceAnswer,
      candidate_answer: candidateAnswer,
      answer_error: answerError,
      judge_error: judgeError,
      retrieved_ids: retrievedIds,
      serialized_order_ids: serializedOrderIds,
      serialization,
      effective_search_mode: effectiveMode,
      verdict,
      duration_ms: durationMs,
      stage_duration_ms: {
        retrieval: Math.round(retrievalMs * 100) / 100,
        serialization: Math.round(serializationMs * 100) / 100,
        reader: Math.round(readerMs * 100) / 100,
        judge: Math.round(judgeMs * 100) / 100,
      },
      context_budget: contextBudget,
      answer_call: answerCall,
      judge_call: judgeCall,
      answer_usage: answerUsage,
      judge_usage: judgeUsage,
    });
    opts.onProgress?.(results.length, eligible.length);
  }

  // Aggregate
  const overallAccuracy =
    results.length > 0
      ? results.filter((r) => r.verdict.correct).length / results.length
      : 0;
  const overallMeanScore =
    results.length > 0
      ? results.reduce((s, r) => s + r.verdict.score, 0) / results.length
      : 0;
  const judgeParseFails = results.filter((r) => !r.verdict.parse_ok).length;
  const overallDuration = summarizeDurations(results.map((r) => r.duration_ms));

  // Per-category breakdown
  const categoryMap = new Map<string, AnswerQualityResult[]>();
  for (const r of results) {
    const bucket = categoryMap.get(r.category) ?? [];
    bucket.push(r);
    categoryMap.set(r.category, bucket);
  }
  const byCategory: AnswerQualityCategorySummary[] = [];
  for (const [category, catResults] of categoryMap) {
    const accuracy =
      catResults.length > 0
        ? catResults.filter((r) => r.verdict.correct).length / catResults.length
        : 0;
    const meanScore =
      catResults.length > 0
        ? catResults.reduce((s, r) => s + r.verdict.score, 0) / catResults.length
        : 0;
    byCategory.push({
      category,
      query_count: catResults.length,
      accuracy,
      mean_score: meanScore,
      judge_parse_failures: catResults.filter((r) => !r.verdict.parse_ok).length,
      duration: summarizeDurations(catResults.map((r) => r.duration_ms)),
    });
  }
  byCategory.sort((a, b) => a.category.localeCompare(b.category));
  const callIdentities = results.flatMap((result) =>
    [result.answer_call, result.judge_call].filter(
      (identity): identity is LlmCallIdentity => identity !== undefined,
    ),
  );
  const responseModels = [...new Set(
    callIdentities
      .map((identity) => identity.response_model)
      .filter((model): model is string => model !== undefined),
  )].sort();
  const providers = [...new Set(
    callIdentities
      .map((identity) => identity.provider)
      .filter((provider): provider is string => provider !== undefined),
  )].sort();
  const missingIdentityCalls =
    (results.length * 2)
    - callIdentities.filter(
      (identity) => identity.response_model !== undefined && identity.provider !== undefined,
    ).length;
  const usages = results.flatMap((result) =>
    [result.answer_usage, result.judge_usage].filter(
      (usage): usage is TokenUsage => usage !== undefined,
    ),
  );

  return {
    report_kind: "answer_quality",
    report_schema_version: 3,
    run_at: runAt,
    snapshot_path: opts.snapshotPath,
    snapshot_schema_version: snapshotSchemaVersion,
    entry_count: entryCount,
    serialization,
    runner_mode: runnerMode,
    search_mode: searchMode,
    search_recency_weight: searchRecencyWeight,
    top_k: topK,
    context_token_budget: opts.contextTokenBudget ?? null,
    context_token_estimator: "utf8_bytes_div4_ceil_v1",
    answer_model: opts.answerModel,
    answer_temperature: answerTemperature,
    answer_max_output_tokens: answerMaxTokens,
    judge_model: opts.judgeModel,
    judge_temperature: judgeTemperature,
    judge_max_output_tokens: judgeMaxTokens,
    query_set_sources: querySetSources,
    query_set_checksum: querySetChecksum,
    query_count: eligible.length,
    skipped_no_reference: skippedNoReference,
    overall_accuracy: overallAccuracy,
    overall_mean_score: overallMeanScore,
    judge_parse_failures: judgeParseFails,
    overall_duration: overallDuration,
    by_category: byCategory,
    results,
    total_usage: totalUsage,
    usage_accounting: {
      expected_calls: results.length * 2,
      usage_reported_calls: usages.length,
      cost_reported_calls: usages.filter((usage) => usage.cost !== undefined).length,
    },
    execution_identity: {
      requested_answer_model: opts.answerModel,
      requested_judge_model: opts.judgeModel,
      response_models: responseModels,
      providers,
      missing_identity_calls: missingIdentityCalls,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
    embedding_summary: embeddingSummary,
  };
}

// --- Report writing ---

/**
 * Write an answer-quality report to disk.
 * Reports land in benchmark/reports/answer-quality/ (separate from IR reports).
 */
export function writeAnswerQualityReport(
  report: AnswerQualityReport,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const kind = report.skipped ? "skipped" : `${report.serialization}`;
  const filePath = join(outputDir, `aq-report-${kind}-${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}
