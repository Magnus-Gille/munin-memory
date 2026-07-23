import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  platform,
  release,
  totalmem,
} from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  buildLongMemEvalArtifacts,
  type BuildOptions,
} from "../adapters/longmemeval/build.js";
import {
  ensureSafeGeneratedPath,
  populateCorpusEmbeddings,
} from "../adapters/shared.js";
import { JUDGE_SYSTEM_SENTINEL, type ChatFn } from "../answer-quality/judge.js";
import { runAnswerQuality } from "../answer-quality/runner.js";
import type { AnswerQualityReport } from "../answer-quality/types.js";
import { loadQueriesWithSource, runBenchmark } from "../runner.js";
import type { BenchmarkQuery, BenchmarkReport } from "../types.js";
import {
  callOpenRouter,
  checkOpenRouterKey,
  getOpenRouterApiKey,
  isCustomLlmBaseUrl,
  OpenRouterHttpError,
} from "../../src/internal/openrouter.js";
import {
  runDeterministicTrustLanes,
  runLivePoisonLane,
} from "./trust-lanes.js";
import type {
  MuninAgentMemoryScorecardReport,
  ScorecardContract,
  ScorecardEnvironmentEvidence,
  ScorecardInterval,
  ScorecardModelContract,
  ScorecardProfileContract,
  ScorecardProfileName,
} from "./types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTRACT_PATH = join(
  MODULE_DIR,
  "contracts",
  "longmemeval-s-v2.json",
);

const SMOKE_LIMITATIONS = [
  "The deterministic smoke uses fixture-specific stub models and is not a publishable quality result.",
] as const;

export interface RunScorecardOptions {
  profile: ScorecardProfileName;
  contractPath?: string;
  artifactDir?: string;
  reportDir?: string;
  /** Test-only or alternate OpenAI-compatible caller. Smoke always uses its deterministic stub. */
  chat?: ChatFn;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function validateModelContract(
  value: unknown,
  label: string,
): asserts value is ScorecardModelContract {
  assertObject(value, label);
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error(`${label}.model must be a non-empty string.`);
  }
  assertPositiveInteger(value.max_output_tokens, `${label}.max_output_tokens`);
  if (
    typeof value.temperature !== "number" ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 2
  ) {
    throw new Error(`${label}.temperature must be a finite number in [0, 2].`);
  }
  if (value.temperature_policy !== "fixed_zero" || value.temperature !== 0) {
    throw new Error(`${label} must use fixed_zero temperature in contract v2.`);
  }
}

/**
 * Validate the fields that control execution. This is deliberately fail-closed:
 * an unknown contract revision or an accidentally publication-eligible profile
 * cannot reach either benchmark harness.
 */
export function validateScorecardContract(value: unknown): ScorecardContract {
  assertObject(value, "Scorecard contract");
  if (value.contract_schema_version !== 2) {
    throw new Error(
      `Unsupported scorecard contract_schema_version: ${String(value.contract_schema_version)}.`,
    );
  }
  if (value.contract_id !== "munin-longmemeval-s-e2e-v2") {
    throw new Error(`Unsupported scorecard contract_id: ${String(value.contract_id)}.`);
  }
  if (value.publication_status !== "publication_candidate") {
    throw new Error("Phase A v2 contract must remain a publication candidate.");
  }
  assertObject(value.dataset, "dataset");
  if (
    value.dataset.adapter !== "longmemeval" ||
    value.dataset.split !== "s" ||
    value.dataset.expected_full_question_count !== 500 ||
    value.dataset.haystack_policy !== "per_question_namespace"
  ) {
    throw new Error("Scorecard dataset contract does not match LongMemEval-S isolation v2.");
  }
  assertObject(value.ingestion, "ingestion");
  if (
    value.ingestion.entry_type !== "state" ||
    value.ingestion.classification !== "public" ||
    value.ingestion.answer_labels_stored_in_corpus !== false
  ) {
    throw new Error("Scorecard ingestion contract must preserve the public state-entry mapping without answer labels in corpus content.");
  }
  assertObject(value.grading, "grading");
  if (
    value.grading.rubric_version !== "answer-quality-v1" ||
    value.grading.correct_signal !== "judge_boolean"
  ) {
    throw new Error("Scorecard grading contract is unsupported.");
  }
  assertObject(value.context_budget, "context_budget");
  assertPositiveInteger(value.context_budget.top_k, "context_budget.top_k");
  assertPositiveInteger(
    value.context_budget.retrieved_token_budget,
    "context_budget.retrieved_token_budget",
  );
  if (
    value.context_budget.unit !== "estimated_tokens" ||
    value.context_budget.estimator !== "utf8_bytes_div4_ceil_v1" ||
    typeof value.context_budget.limitation !== "string" ||
    value.context_budget.limitation.length === 0
  ) {
    throw new Error(
      "Scorecard context budget must enforce estimated tokens with the v1 UTF-8 estimator.",
    );
  }
  assertObject(value.uncertainty, "uncertainty");
  assertPositiveInteger(value.uncertainty.resamples, "uncertainty.resamples");
  if (
    value.uncertainty.method !== "deterministic_bootstrap_percentile_95"
    || value.uncertainty.confidence !== 0.95
    || value.uncertainty.seed !== 227
  ) {
    throw new Error("Scorecard uncertainty contract is unsupported.");
  }
  assertObject(value.provider_policy, "provider_policy");
  if (
    value.provider_policy.gateway !== "openrouter"
    || value.provider_policy.routing !== "zdr_balanced"
    || value.provider_policy.require_response_model !== true
    || value.provider_policy.require_provider !== true
    || value.provider_policy.require_provider_reported_cost !== true
  ) {
    throw new Error("Scorecard provider identity/cost policy is unsupported.");
  }
  assertObject(value.trust_lanes, "trust_lanes");
  if (
    value.trust_lanes.authorization !== "deterministic_production_primitives_v1"
    || value.trust_lanes.instruction_shaped_content
      !== "deterministic_structure_plus_live_reader_v1"
    || value.trust_lanes.full_profile_requires_live_poison_pass !== true
  ) {
    throw new Error("Scorecard trust-lane contract is unsupported.");
  }
  assertObject(value.profiles, "profiles");
  for (const name of ["smoke", "full"] as const) {
    const profile = value.profiles[name];
    assertObject(profile, `profiles.${name}`);
    assertPositiveInteger(profile.expected_question_count, `profiles.${name}.expected_question_count`);
    assertPositiveInteger(profile.top_k, `profiles.${name}.top_k`);
    assertPositiveInteger(profile.repetitions, `profiles.${name}.repetitions`);
    if (profile.repetitions !== 1) {
      throw new Error(`profiles.${name}.repetitions must remain 1 under the bootstrap-v2 contract.`);
    }
    if (profile.granularity !== "session" || profile.serialization !== "linear") {
      throw new Error(`profiles.${name} must use session granularity and linear serialization.`);
    }
    validateModelContract(profile.reader, `profiles.${name}.reader`);
    validateModelContract(profile.judge, `profiles.${name}.judge`);
    if (profile.top_k !== value.context_budget.top_k) {
      throw new Error(`profiles.${name}.top_k must match context_budget.top_k.`);
    }
  }
  const smoke = value.profiles.smoke;
  const full = value.profiles.full;
  assertObject(smoke, "profiles.smoke");
  assertObject(full, "profiles.full");
  validateModelContract(full.reader, "profiles.full.reader");
  validateModelContract(full.judge, "profiles.full.judge");
  if (
    smoke.profile_id !== "deterministic_pipeline_smoke" ||
    smoke.expected_question_count !== 2 ||
    smoke.limit !== 2 ||
    smoke.granularity !== "session" ||
    smoke.runner_mode !== "raw" ||
    smoke.search_mode !== "lexical" ||
    smoke.serialization !== "linear" ||
    smoke.seed_policy !== "fixed_fixture_stub" ||
    smoke.publication_eligible !== false
  ) {
    throw new Error("Smoke profile must remain deterministic, lexical, raw, and fixture-backed.");
  }
  if (
    full.profile_id !== "longmemeval_s_full_on_demand" ||
    full.expected_question_count !== 500 ||
    full.limit !== null ||
    full.granularity !== "session" ||
    full.runner_mode !== "production_ranker" ||
    full.search_mode !== "hybrid" ||
    full.serialization !== "linear" ||
    full.seed_policy !== "temperature_zero_provider_no_seed" ||
    full.publication_eligible !== true
  ) {
    throw new Error(
      "Full profile must be publication eligible and remain the 500-question production-ranker hybrid on-demand run.",
    );
  }
  if (
    full.reader.model !== "anthropic/claude-haiku-4.5"
    || full.judge.model !== "anthropic/claude-sonnet-4.5"
  ) {
    throw new Error("Full profile must use the pinned OpenRouter Claude 4.5 model slugs.");
  }
  if (
    !Array.isArray(value.limitations)
    || value.limitations.length === 0
    || value.limitations.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("Scorecard contract must disclose non-empty limitations.");
  }
  return value as unknown as ScorecardContract;
}

export function loadScorecardContract(
  contractPath = DEFAULT_CONTRACT_PATH,
): { contract: ScorecardContract; sha256: string; path: string } {
  const path = resolve(contractPath);
  const raw = readFileSync(path);
  const contract = validateScorecardContract(JSON.parse(raw.toString("utf-8")));
  return {
    contract,
    sha256: createHash("sha256").update(raw).digest("hex"),
    path,
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanInterval(
  values: number[],
  options: { confidence: 0.95; resamples: number; seed: number },
): ScorecardInterval {
  if (values.length === 0) {
    throw new Error("Cannot compute a scorecard interval over an empty sample.");
  }
  if (
    values.some((value) => !Number.isFinite(value))
    || !Number.isSafeInteger(options.resamples)
    || options.resamples <= 0
  ) {
    throw new Error("Scorecard interval requires finite values and positive resamples.");
  }
  const random = seededRandom(options.seed);
  const means: number[] = [];
  for (let sampleIndex = 0; sampleIndex < options.resamples; sampleIndex += 1) {
    let total = 0;
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      total += values[Math.floor(random() * values.length)]!;
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - options.confidence;
  const lowerIndex = Math.floor((alpha / 2) * (means.length - 1));
  const upperIndex = Math.ceil((1 - alpha / 2) * (means.length - 1));
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return {
    point_estimate: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    lower: round(means[lowerIndex]!),
    upper: round(means[upperIndex]!),
    confidence: options.confidence,
    method: "deterministic_bootstrap_percentile",
    resamples: options.resamples,
    seed: options.seed,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function captureEnvironmentEvidence(): ScorecardEnvironmentEvidence {
  const cpuList = cpus();
  const dirtyOutput = gitOutput(["status", "--porcelain"]);
  return {
    node_version: process.version,
    platform: platform(),
    arch: arch(),
    os_release: release(),
    cpu_model: cpuList[0]?.model ?? "unknown",
    cpu_count: cpuList.length,
    total_memory_bytes: totalmem(),
    git_commit: gitOutput(["rev-parse", "HEAD"]),
    git_dirty: dirtyOutput === null ? null : dirtyOutput.length > 0,
    package_json_sha256: sha256File(resolve("package.json")),
    package_lock_sha256: sha256File(resolve("package-lock.json")),
  };
}

function currentPeakRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

export type ScorecardRetryReason =
  | "http_429"
  | "http_503"
  | "transport_fetch_failed"
  | "transport_terminated";

function retryableScorecardReason(error: unknown): ScorecardRetryReason | null {
  if (error instanceof OpenRouterHttpError) {
    return error.status === 429
      ? "http_429"
      : error.status === 503
        ? "http_503"
        : null;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^LLM API error (429|503)\b/);
  if (match?.[1] === "429") return "http_429";
  if (match?.[1] === "503") return "http_503";
  if (error instanceof TypeError && message === "fetch failed") {
    return "transport_fetch_failed";
  }
  if (error instanceof TypeError && message === "terminated") {
    return "transport_terminated";
  }
  return null;
}

export function withScorecardRetry(
  chat: ChatFn,
  options: {
    maxAttempts?: number;
    wait?: (delayMs: number) => Promise<void>;
    onRetry?: (event: { reason: ScorecardRetryReason; attempt: number }) => void;
  } = {},
): ChatFn {
  const maxAttempts = options.maxAttempts ?? 4;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("Scorecard retry maxAttempts must be a positive safe integer.");
  }
  const wait = options.wait ?? (
    (delayMs: number) => new Promise((resolveWait) => {
      setTimeout(resolveWait, delayMs);
    })
  );
  return async (callOptions) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await chat(callOptions);
      } catch (error) {
        lastError = error;
        const reason = retryableScorecardReason(error);
        if (reason === null || attempt === maxAttempts) {
          throw error;
        }
        options.onRetry?.({ reason, attempt });
        const providerDelay = error instanceof OpenRouterHttpError
          ? error.retryAfterMs
          : undefined;
        await wait(providerDelay ?? 1000 * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  };
}

function portableReportPath(path: string): string {
  if (!isAbsolute(path)) return path;
  const relativePath = relative(process.cwd(), path);
  if (relativePath.startsWith("..")) {
    throw new Error(`Scorecard report path escapes the repository: ${path}`);
  }
  return relativePath;
}

/** Run before retrieval or model calls so incomplete paid suites fail cheaply. */
export function preflightScorecardQueries(
  queries: BenchmarkQuery[],
  profile: ScorecardProfileName,
  expectedQuestionCount: number,
): void {
  if (queries.length !== expectedQuestionCount) {
    throw new Error(
      `Scorecard ${profile} preflight expected exactly ${expectedQuestionCount} questions, got ${queries.length}.`,
    );
  }
  const missingReferences = queries
    .filter((query) => query.reference_answer === undefined)
    .map((query) => query.id);
  if (missingReferences.length > 0) {
    throw new Error(
      `Scorecard ${profile} preflight found missing reference_answer on: ${missingReferences.slice(0, 10).join(", ")}.`,
    );
  }
  const unscoped = queries.filter((query) => !query.scope_namespace).map((query) => query.id);
  if (unscoped.length > 0) {
    throw new Error(
      `Scorecard ${profile} preflight found queries without per-question scope_namespace: ${unscoped.slice(0, 10).join(", ")}.`,
    );
  }
  const missingDates = queries
    .filter((query) => typeof query.question_date !== "string" || query.question_date.trim().length === 0)
    .map((query) => query.id);
  if (missingDates.length > 0) {
    throw new Error(
      `Scorecard ${profile} preflight found missing question_date on: ${missingDates.slice(0, 10).join(", ")}.`,
    );
  }
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const query of queries) {
    if (seen.has(query.id)) duplicateIds.add(query.id);
    seen.add(query.id);
  }
  if (duplicateIds.size > 0) {
    throw new Error(
      `Scorecard ${profile} preflight found duplicate query IDs: ${[...duplicateIds].slice(0, 10).join(", ")}.`,
    );
  }
}

export function validateScorecardAnswerQualityReport(
  report: AnswerQualityReport,
  profile: ScorecardProfileName,
  expectedQuestionCount: number,
  expectedSearchMode: ScorecardProfileContract["search_mode"],
): void {
  if (report.skipped) {
    throw new Error(
      `Scorecard ${profile} answer-quality run skipped: ${report.skip_reason ?? "unknown reason"}`,
    );
  }
  if (report.skipped_no_reference !== 0) {
    throw new Error(
      `Scorecard ${profile} unexpectedly skipped ${report.skipped_no_reference} reference answers.`,
    );
  }
  if (report.query_count !== expectedQuestionCount) {
    throw new Error(
      `Scorecard ${profile} answer-quality count drifted: ${report.query_count} != ${expectedQuestionCount}.`,
    );
  }
  if (report.warnings?.length) {
    throw new Error(
      `Scorecard ${profile} answer-quality warned or degraded: ${report.warnings.join("; ")}`,
    );
  }
  if (report.judge_parse_failures !== 0) {
    throw new Error(
      `Scorecard ${profile} had ${report.judge_parse_failures} malformed judge responses.`,
    );
  }
  const executionFailures = report.results
    .filter((result) => result.answer_error !== undefined || result.judge_error !== undefined)
    .map((result) => result.query_id);
  if (executionFailures.length > 0) {
    throw new Error(
      `Scorecard ${profile} had reader/judge execution failures on: ${executionFailures.slice(0, 10).join(", ")}.`,
    );
  }
  const degradedQueries = report.results
    .filter((result) => result.effective_search_mode !== expectedSearchMode)
    .map((result) => result.query_id);
  if (degradedQueries.length > 0) {
    throw new Error(
      `Scorecard ${profile} answer-quality search mode degraded on: ${degradedQueries.slice(0, 10).join(", ")}.`,
    );
  }
}

export function validateScorecardRetrievalReport(
  report: BenchmarkReport,
  profile: ScorecardProfileName,
  expectedQuestionCount: number,
  expectedSearchMode: ScorecardProfileContract["search_mode"],
  expectedRunnerMode: ScorecardProfileContract["runner_mode"],
): void {
  if (report.runner_mode !== expectedRunnerMode || report.warnings?.length) {
    throw new Error(
      `Scorecard ${profile} retrieval degraded or warned: ${(report.warnings ?? []).join("; ") || `${report.runner_mode} != ${expectedRunnerMode}`}`,
    );
  }
  if (report.query_count !== expectedQuestionCount) {
    throw new Error(
      `Scorecard ${profile} retrieval count drifted: ${report.query_count} != ${expectedQuestionCount}.`,
    );
  }
  const degradedQueries = report.queries
    .filter((result) =>
      result.search_mode !== expectedSearchMode ||
      (result.actual_mode !== undefined && result.actual_mode !== expectedSearchMode))
    .map((result) => result.query_id);
  if (degradedQueries.length > 0) {
    throw new Error(
      `Scorecard ${profile} retrieval mode degraded on: ${degradedQueries.slice(0, 10).join(", ")}.`,
    );
  }
}

function extractPromptPayload(content: string): Record<string, unknown> {
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first < 0 || last <= first) return {};
  try {
    const parsed = JSON.parse(content.slice(first, last + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Hermetic fixture stub. It validates that the known fixture answer text is
 * present in retrieved context, then returns that exact answer. It exists only
 * to prove orchestration and report wiring; the enclosing report is permanently
 * marked non-publication-eligible.
 */
function deterministicSmokeChat(): ChatFn {
  return async (options) => {
    const isJudge = options.messages.some((message) =>
      message.content.includes(JUDGE_SYSTEM_SENTINEL),
    );
    const payload = extractPromptPayload(options.messages.at(-1)?.content ?? "");
    if (isJudge) {
      const reference = String(payload.reference_answer ?? "");
      const candidate = String(payload.candidate_answer ?? "");
      const correct = reference.length > 0 && candidate === reference;
      return {
        id: "scorecard-smoke-judge",
        model: options.model,
        provider: "deterministic-local",
        choices: [{
          message: {
            content: JSON.stringify({
              correct,
              score: correct ? 1 : 0,
              reasoning: "Deterministic fixture equality check; not a quality judgment.",
            }),
          },
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
      };
    }
    const question = String(payload.question ?? "");
    const context = String(payload.context ?? "");
    const fixtureAnswers: Readonly<Record<string, { answer: string; evidence: string }>> = {
      "Business Administration degree": {
        answer: "Business Administration",
        evidence: "Business Administration",
      },
      "GPS system not functioning correctly": {
        answer: "GPS system not functioning correctly",
        evidence: "GPS system was not functioning correctly",
      },
    };
    const expected = fixtureAnswers[question];
    const answer = expected && context.includes(expected.evidence)
      ? expected.answer
      : "I cannot find the answer in the provided context.";
    return {
      id: "scorecard-smoke-reader",
      model: options.model,
      provider: "deterministic-local",
      choices: [{ message: { content: answer } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
    };
  };
}

function artifactPaths(
  profileName: ScorecardProfileName,
  profile: ScorecardProfileContract,
  artifactDir: string,
): Pick<BuildOptions, "inputPath" | "dbPath" | "queryPath" | "provenancePath"> {
  const prefix = profileName === "smoke"
    ? "scorecard-smoke-v2"
    : "scorecard-longmemeval-s-v2";
  return {
    inputPath: resolve(profile.input_path),
    dbPath: join(artifactDir, `${prefix}.db`),
    queryPath: join(artifactDir, `${prefix}.jsonl`),
    provenancePath: join(artifactDir, `${prefix}.provenance.json`),
  };
}

function writeScorecardReport(
  report: MuninAgentMemoryScorecardReport,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outputDir, `scorecard-${report.profile}-${timestamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf-8");
  return path;
}

export async function runScorecard(
  options: RunScorecardOptions,
): Promise<{ report: MuninAgentMemoryScorecardReport; reportPath: string }> {
  const totalStart = performance.now();
  const initialRssBytes = process.memoryUsage().rss;
  const { contract, sha256 } = loadScorecardContract(options.contractPath);
  const profile = contract.profiles[options.profile];
  const environment = captureEnvironmentEvidence();
  const isFull = options.profile === "full";
  const apiKey = getOpenRouterApiKey() ?? "";
  const retryEvents: Array<{ reason: ScorecardRetryReason; attempt: number }> = [];
  const scorecardChat = isFull
    ? withScorecardRetry(options.chat ?? callOpenRouter, {
      onRetry: (event) => {
        retryEvents.push(event);
        console.warn(
          `Scorecard transient retry: ${event.reason} after attempt ${event.attempt}.`,
        );
      },
    })
    : deterministicSmokeChat();
  if (isFull) {
    if (isCustomLlmBaseUrl()) {
      throw new Error("Publication-candidate full scorecard must use the pinned OpenRouter gateway.");
    }
    if (!options.chat && apiKey.length === 0) {
      throw new Error("Publication-candidate full scorecard requires OPENROUTER_API_KEY.");
    }
    if (!options.chat) {
      const keyHealth = await checkOpenRouterKey(apiKey);
      if (!keyHealth.ok) {
        throw new Error(
          `OpenRouter key preflight failed${keyHealth.status === undefined ? "" : ` (${keyHealth.status})`}: ${keyHealth.error ?? "unknown error"}`,
        );
      }
    }
    if (environment.git_dirty !== false || environment.git_commit === null) {
      throw new Error(
        "Publication-candidate full scorecard requires a clean Git commit for environment lineage.",
      );
    }
  }
  const artifactDir = resolve(options.artifactDir ?? "benchmark/generated/scorecard");
  const reportDir = resolve(options.reportDir ?? "benchmark/reports/scorecard");
  mkdirSync(artifactDir, { recursive: true });
  const paths = artifactPaths(options.profile, profile, artifactDir);
  ensureSafeGeneratedPath(paths.dbPath, "Scorecard DB");
  ensureSafeGeneratedPath(paths.queryPath, "Scorecard query file");
  ensureSafeGeneratedPath(paths.provenancePath, "Scorecard provenance file");

  const ingestionStart = performance.now();
  buildLongMemEvalArtifacts({
    split: contract.dataset.split,
    granularity: profile.granularity,
    searchMode: profile.search_mode,
    inputPath: paths.inputPath,
    dbPath: paths.dbPath,
    queryPath: paths.queryPath,
    provenancePath: paths.provenancePath,
    limit: profile.limit ?? undefined,
  });
  const ingestionDuration = performance.now() - ingestionStart;

  const { queries, source } = loadQueriesWithSource(paths.queryPath);
  preflightScorecardQueries(
    queries,
    options.profile,
    profile.expected_question_count,
  );

  const embeddingStart = performance.now();
  if (profile.search_mode !== "lexical") {
    const embeddings = await populateCorpusEmbeddings(paths.dbPath);
    if (embeddings.total > 0 && embeddings.vector_rows === 0) {
      throw new Error(
        `Scorecard ${options.profile} preflight produced no usable corpus vectors; refusing a degraded ${profile.search_mode} run.`,
      );
    }
  }
  const embeddingDuration = performance.now() - embeddingStart;

  const retrievalStart = performance.now();
  const retrieval = await runBenchmark(paths.dbPath, queries, {
    querySetSources: [source],
    runnerMode: profile.runner_mode,
    manifestPath: null,
  });
  validateScorecardRetrievalReport(
    retrieval,
    options.profile,
    profile.expected_question_count,
    profile.search_mode,
    profile.runner_mode,
  );
  const retrievalDuration = performance.now() - retrievalStart;

  const trustStart = performance.now();
  const trustLanes = await runDeterministicTrustLanes();
  if (isFull) {
    trustLanes.live_poison = await runLivePoisonLane({
      model: profile.reader.model,
      apiKey,
      temperature: profile.reader.temperature,
      maxTokens: profile.reader.max_output_tokens,
      chat: scorecardChat,
    });
    trustLanes.overall_pass =
      trustLanes.authorization.status === "pass"
      && trustLanes.instruction_shaped_content.status === "pass"
      && trustLanes.live_poison.status === "pass";
  }
  if (!trustLanes.overall_pass) {
    throw new Error("Scorecard trust lane failed; refusing to continue to the paid suite.");
  }
  const trustDuration = performance.now() - trustStart;

  const answerQualityStart = performance.now();
  const answerQuality = await runAnswerQuality({
    snapshotPath: paths.dbPath,
    queries,
    serialization: profile.serialization,
    runnerMode: profile.runner_mode,
    searchMode: profile.search_mode,
    topK: profile.top_k,
    contextTokenBudget: contract.context_budget.retrieved_token_budget,
    answerModel: profile.reader.model,
    judgeModel: profile.judge.model,
    answerTemperature: profile.reader.temperature,
    answerMaxTokens: profile.reader.max_output_tokens,
    judgeTemperature: profile.judge.temperature,
    judgeMaxTokens: profile.judge.max_output_tokens,
    querySetSources: [source],
    chat: scorecardChat,
    requireCompleteUsage: isFull,
    onProgress: isFull
      ? (completed, total) => {
          if (completed === total || completed % 25 === 0) {
            console.log(`Scorecard answer-quality progress: ${completed}/${total}`);
          }
        }
      : undefined,
  });
  validateScorecardAnswerQualityReport(
    answerQuality,
    options.profile,
    profile.expected_question_count,
    profile.search_mode,
  );
  const answerQualityDuration = performance.now() - answerQualityStart;
  const overBudget = answerQuality.results
    .filter((result) =>
      result.context_budget.estimated_tokens
      > contract.context_budget.retrieved_token_budget)
    .map((result) => result.query_id);
  if (overBudget.length > 0) {
    throw new Error(
      `Scorecard context budget exceeded on: ${overBudget.slice(0, 10).join(", ")}.`,
    );
  }
  if (isFull) {
    if (answerQuality.execution_identity.missing_identity_calls !== 0) {
      throw new Error(
        `Scorecard provider/model identity missing on ${answerQuality.execution_identity.missing_identity_calls} calls.`,
      );
    }
    if (answerQuality.total_usage?.cost === undefined) {
      throw new Error("Scorecard full run did not receive provider-reported monetary cost.");
    }
    if (
      answerQuality.usage_accounting.usage_reported_calls
        !== answerQuality.usage_accounting.expected_calls
      || answerQuality.usage_accounting.cost_reported_calls
        !== answerQuality.usage_accounting.expected_calls
      || answerQuality.results.some((result) =>
        [result.answer_usage, result.judge_usage].some((usage) =>
          usage === undefined
          || !Number.isFinite(usage.prompt_tokens)
          || usage.prompt_tokens < 0
          || !Number.isFinite(usage.completion_tokens)
          || usage.completion_tokens < 0
          || usage.cost === undefined
          || !Number.isFinite(usage.cost)
          || usage.cost < 0))
    ) {
      throw new Error("Scorecard full run has incomplete or invalid per-call usage/cost accounting.");
    }
    if (
      trustLanes.live_poison.call_identity?.response_model === undefined
      || trustLanes.live_poison.call_identity.provider === undefined
      || trustLanes.live_poison.usage?.cost === undefined
      || !Number.isFinite(trustLanes.live_poison.usage.cost)
      || trustLanes.live_poison.usage.cost < 0
    ) {
      throw new Error("Scorecard live poison lane lacks provider model identity or cost.");
    }
  }
  const retrievalSources = retrieval.query_set_sources
    .map((item) => `${item.filename}:${item.sha256}`)
    .sort();
  const answerSources = answerQuality.query_set_sources
    .map((item) => `${item.filename}:${item.sha256}`)
    .sort();
  if (JSON.stringify(retrievalSources) !== JSON.stringify(answerSources)) {
    throw new Error("Scorecard harness query-set source bytes differ; refusing to compose report.");
  }
  retrieval.snapshot_path = portableReportPath(retrieval.snapshot_path);
  retrieval.query_set_sources = retrieval.query_set_sources.map((item) => ({
    ...item,
    path: portableReportPath(item.path),
  }));
  answerQuality.snapshot_path = portableReportPath(answerQuality.snapshot_path);
  answerQuality.query_set_sources = answerQuality.query_set_sources.map((item) => ({
    ...item,
    path: portableReportPath(item.path),
  }));

  const uncertaintyOptions = {
    confidence: contract.uncertainty.confidence,
    resamples: contract.uncertainty.resamples,
    seed: contract.uncertainty.seed,
  } as const;
  const uncertainty = {
    answer_accuracy: bootstrapMeanInterval(
      answerQuality.results.map((result) => result.verdict.correct ? 1 : 0),
      uncertaintyOptions,
    ),
    retrieval_recall_at_5: bootstrapMeanInterval(
      retrieval.queries.map((result) => result.scores.recallAt5),
      uncertaintyOptions,
    ),
  };
  const disk = {
    database_bytes: statSync(paths.dbPath).size,
    query_bytes: statSync(paths.queryPath).size,
    provenance_bytes: statSync(paths.provenancePath).size,
    total_artifact_bytes: 0,
  };
  disk.total_artifact_bytes =
    disk.database_bytes + disk.query_bytes + disk.provenance_bytes;
  const finalRssBytes = process.memoryUsage().rss;
  const costUsd = answerQuality.total_usage?.cost === undefined
    && trustLanes.live_poison.usage?.cost === undefined
    ? null
    : (answerQuality.total_usage?.cost ?? 0)
      + (trustLanes.live_poison.usage?.cost ?? 0);
  const roundDuration = (value: number) => Math.round(value * 100) / 100;

  const report: MuninAgentMemoryScorecardReport = {
    report_kind: "munin_agent_memory_scorecard",
    report_schema_version: 2,
    run_at: new Date().toISOString(),
    contract_id: contract.contract_id,
    contract_schema_version: contract.contract_schema_version,
    contract_sha256: sha256,
    profile: profile.profile_id,
    publication_status: isFull ? "publication_candidate" : "pipeline_smoke",
    publication_eligible: isFull && profile.publication_eligible,
    retrieval,
    answer_quality: answerQuality,
    uncertainty,
    evidence: {
      environment,
      stage_duration_ms: {
        ingestion: roundDuration(ingestionDuration),
        embedding: roundDuration(embeddingDuration),
        retrieval: roundDuration(retrievalDuration),
        answer_quality: roundDuration(answerQualityDuration),
        trust_lanes: roundDuration(trustDuration),
        total: roundDuration(performance.now() - totalStart),
      },
      resources: {
        initial_rss_bytes: initialRssBytes,
        final_rss_bytes: finalRssBytes,
        peak_rss_bytes: Math.max(
          initialRssBytes,
          finalRssBytes,
          currentPeakRssBytes(),
        ),
      },
      disk,
      cost_usd: costUsd,
      retries: {
        total: retryEvents.length,
        http_429: retryEvents.filter((event) => event.reason === "http_429").length,
        http_503: retryEvents.filter((event) => event.reason === "http_503").length,
        transport_fetch_failed: retryEvents.filter(
          (event) => event.reason === "transport_fetch_failed",
        ).length,
        transport_terminated: retryEvents.filter(
          (event) => event.reason === "transport_terminated",
        ).length,
      },
      trust_lanes: trustLanes,
    },
    limitations: [
      ...(isFull ? [] : SMOKE_LIMITATIONS),
      ...(retryEvents.some((event) => event.reason.startsWith("transport_"))
        ? [
          "Transport retries are counted in evidence. OpenRouter may charge upstream prompt processing for an attempt whose response was not returned, so provider-reported successful-call cost can understate account-level spend by those failed attempts.",
        ]
        : []),
      ...contract.limitations,
    ],
  };
  const reportPath = writeScorecardReport(report, reportDir);
  return { report, reportPath };
}

function parseProfile(argv: string[]): ScorecardProfileName {
  const index = argv.indexOf("--profile");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (raw !== "smoke" && raw !== "full") {
    throw new Error("Usage: tsx benchmark/scorecard/run.ts --profile <smoke|full>");
  }
  return raw;
}

async function main(): Promise<void> {
  const profile = parseProfile(process.argv.slice(2));
  const { report, reportPath } = await runScorecard({ profile });
  console.log(`Scorecard profile completed: ${report.profile}`);
  console.log(`Publication eligible: ${report.publication_eligible}`);
  console.log(`Retrieval R@5: ${report.retrieval.overall.recallAt5.toFixed(4)}`);
  console.log(`Answer accuracy: ${report.answer_quality.overall_accuracy.toFixed(4)}`);
  console.log(`Report: ${reportPath}`);
}

const isEntryPoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      "Scorecard failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
