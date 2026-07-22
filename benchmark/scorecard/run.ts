import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type {
  MuninAgentMemoryScorecardReport,
  ScorecardContract,
  ScorecardProfileContract,
  ScorecardProfileName,
} from "./types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTRACT_PATH = join(
  MODULE_DIR,
  "contracts",
  "longmemeval-s-v1.json",
);

const FOUNDATION_LIMITATIONS = [
  "The deterministic smoke uses fixture-specific stub models and is not a publishable quality result.",
  "A retrieved-token budget is not yet enforced; context is limited by top_k entries.",
  "Stage-separated latency, peak RAM, disk footprint, monetary cost, repeated-run variance, and adversarial authorization/poison lanes remain to be added.",
  "No complete 500-question result is published by this foundation.",
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

function validateModelContract(value: unknown, label: string): void {
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
    throw new Error(`${label} must use fixed_zero temperature in contract v1.`);
  }
}

/**
 * Validate the fields that control execution. This is deliberately fail-closed:
 * an unknown contract revision or an accidentally publication-eligible profile
 * cannot reach either benchmark harness.
 */
export function validateScorecardContract(value: unknown): ScorecardContract {
  assertObject(value, "Scorecard contract");
  if (value.contract_schema_version !== 1) {
    throw new Error(
      `Unsupported scorecard contract_schema_version: ${String(value.contract_schema_version)}.`,
    );
  }
  if (value.contract_id !== "munin-longmemeval-s-e2e-v1") {
    throw new Error(`Unsupported scorecard contract_id: ${String(value.contract_id)}.`);
  }
  if (value.publication_status !== "unpublished_foundation") {
    throw new Error("Phase A foundation contract must remain unpublished.");
  }
  assertObject(value.dataset, "dataset");
  if (
    value.dataset.adapter !== "longmemeval" ||
    value.dataset.split !== "s" ||
    value.dataset.expected_full_question_count !== 500 ||
    value.dataset.haystack_policy !== "per_question_namespace"
  ) {
    throw new Error("Scorecard dataset contract does not match LongMemEval-S isolation v1.");
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
  if (
    value.context_budget.unit !== "entries" ||
    value.context_budget.retrieved_token_budget !== null ||
    typeof value.context_budget.limitation !== "string" ||
    value.context_budget.limitation.length === 0
  ) {
    throw new Error(
      "Foundation context budget must declare entry-count limiting and the unenforced token-budget limitation.",
    );
  }
  assertObject(value.profiles, "profiles");
  for (const name of ["smoke", "full"] as const) {
    const profile = value.profiles[name];
    assertObject(profile, `profiles.${name}`);
    assertPositiveInteger(profile.expected_question_count, `profiles.${name}.expected_question_count`);
    assertPositiveInteger(profile.top_k, `profiles.${name}.top_k`);
    assertPositiveInteger(profile.repetitions, `profiles.${name}.repetitions`);
    if (profile.repetitions !== 1) {
      throw new Error(`profiles.${name}.repetitions must remain 1 in the unpublished foundation.`);
    }
    if (profile.granularity !== "session" || profile.serialization !== "linear") {
      throw new Error(`profiles.${name} must use session granularity and linear serialization.`);
    }
    validateModelContract(profile.reader, `profiles.${name}.reader`);
    validateModelContract(profile.judge, `profiles.${name}.judge`);
    if (profile.publication_eligible !== false) {
      throw new Error(`profiles.${name} must not be publication eligible.`);
    }
    if (profile.top_k !== value.context_budget.top_k) {
      throw new Error(`profiles.${name}.top_k must match context_budget.top_k.`);
    }
  }
  const smoke = value.profiles.smoke;
  const full = value.profiles.full;
  assertObject(smoke, "profiles.smoke");
  assertObject(full, "profiles.full");
  if (
    smoke.profile_id !== "deterministic_pipeline_smoke" ||
    smoke.expected_question_count !== 2 ||
    smoke.limit !== 2 ||
    smoke.granularity !== "session" ||
    smoke.runner_mode !== "raw" ||
    smoke.search_mode !== "lexical" ||
    smoke.serialization !== "linear" ||
    smoke.seed_policy !== "fixed_fixture_stub"
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
    full.seed_policy !== "temperature_zero_provider_no_seed"
  ) {
    throw new Error("Full profile must remain the 500-question production-ranker hybrid on-demand run.");
  }
  if (
    !Array.isArray(value.required_before_publication) ||
    value.required_before_publication.length === 0 ||
    value.required_before_publication.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("required_before_publication must list the remaining publication gates.");
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
        choices: [{
          message: {
            content: JSON.stringify({
              correct,
              score: correct ? 1 : 0,
              reasoning: "Deterministic fixture equality check; not a quality judgment.",
            }),
          },
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
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
      choices: [{ message: { content: answer } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
  };
}

function artifactPaths(
  profileName: ScorecardProfileName,
  profile: ScorecardProfileContract,
  artifactDir: string,
): Pick<BuildOptions, "inputPath" | "dbPath" | "queryPath" | "provenancePath"> {
  const prefix = profileName === "smoke" ? "scorecard-smoke-v1" : "scorecard-longmemeval-s-v1";
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
  const { contract, sha256 } = loadScorecardContract(options.contractPath);
  const profile = contract.profiles[options.profile];
  const artifactDir = resolve(options.artifactDir ?? "benchmark/generated/scorecard");
  const reportDir = resolve(options.reportDir ?? "benchmark/reports/scorecard");
  mkdirSync(artifactDir, { recursive: true });
  const paths = artifactPaths(options.profile, profile, artifactDir);
  ensureSafeGeneratedPath(paths.dbPath, "Scorecard DB");
  ensureSafeGeneratedPath(paths.queryPath, "Scorecard query file");
  ensureSafeGeneratedPath(paths.provenancePath, "Scorecard provenance file");

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

  const { queries, source } = loadQueriesWithSource(paths.queryPath);
  preflightScorecardQueries(
    queries,
    options.profile,
    profile.expected_question_count,
  );

  if (profile.search_mode !== "lexical") {
    const embeddings = await populateCorpusEmbeddings(paths.dbPath);
    if (embeddings.total > 0 && embeddings.vector_rows === 0) {
      throw new Error(
        `Scorecard ${options.profile} preflight produced no usable corpus vectors; refusing a degraded ${profile.search_mode} run.`,
      );
    }
  }

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

  const answerQuality = await runAnswerQuality({
    snapshotPath: paths.dbPath,
    queries,
    serialization: profile.serialization,
    runnerMode: profile.runner_mode,
    searchMode: profile.search_mode,
    topK: profile.top_k,
    answerModel: profile.reader.model,
    judgeModel: profile.judge.model,
    answerTemperature: profile.reader.temperature,
    answerMaxTokens: profile.reader.max_output_tokens,
    judgeTemperature: profile.judge.temperature,
    judgeMaxTokens: profile.judge.max_output_tokens,
    querySetSources: [source],
    chat: options.profile === "smoke" ? deterministicSmokeChat() : options.chat,
  });
  validateScorecardAnswerQualityReport(
    answerQuality,
    options.profile,
    profile.expected_question_count,
    profile.search_mode,
  );
  const retrievalSources = retrieval.query_set_sources
    .map((item) => `${item.filename}:${item.sha256}`)
    .sort();
  const answerSources = answerQuality.query_set_sources
    .map((item) => `${item.filename}:${item.sha256}`)
    .sort();
  if (JSON.stringify(retrievalSources) !== JSON.stringify(answerSources)) {
    throw new Error("Scorecard harness query-set source bytes differ; refusing to compose report.");
  }

  const report: MuninAgentMemoryScorecardReport = {
    report_kind: "munin_agent_memory_scorecard",
    report_schema_version: 1,
    run_at: new Date().toISOString(),
    contract_id: contract.contract_id,
    contract_schema_version: contract.contract_schema_version,
    contract_sha256: sha256,
    profile: profile.profile_id,
    publication_status: "unpublished_foundation",
    publication_eligible: false,
    retrieval,
    answer_quality: answerQuality,
    limitations: [...FOUNDATION_LIMITATIONS, ...contract.required_before_publication],
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
