/**
 * Decision-provenance outcome-eval runner (issue #186).
 *
 * CLI:
 *   npx tsx benchmark/decision-provenance/runner.ts \
 *     --corpus benchmark/decision-provenance/corpus/toy.json \
 *     --arms A,B,C --k 5 --out benchmark/decision-provenance/reports
 *
 * For each (world x arm x probe x k) it builds the arm-specific memory
 * payload (arms.ts), renders the neutral agent prompt (prompt.ts), calls an
 * OpenAI-compatible chat-completions endpoint, and grades the response
 * (grade.ts) against the probe's expected verdict. Requests are sequential
 * (no concurrency in v1) with a basic retry on 5xx/network errors.
 *
 * Model + endpoint resolution:
 *   - `MUNIN_LLM_BASE_URL` — base URL, default `http://127.0.0.1:8091/v1`
 *     (the M5 llama-swap loopback endpoint — NOT the same default as
 *     src/internal/openrouter.ts, which defaults to the OpenRouter API; this
 *     eval is built to run local sweeps by default).
 *   - `DECISION_PROVENANCE_MODEL` — required (env var or `--model`). No default:
 *     silently picking a model would make flip-rate numbers across runs
 *     incomparable.
 *   - `OPENROUTER_API_KEY` — optional bearer token, omitted entirely when
 *     unset (local servers typically need no auth).
 *
 * All LLM calls go through the injectable `chat` (or lower-level `fetchImpl`)
 * so tests never touch the network.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadCorpus } from "./corpus.js";
import { buildArmPayload } from "./arms.js";
import { buildAgentPrompt } from "./prompt.js";
import { grade } from "./grade.js";
import { ALL_ARMS, isReopenAction } from "./types.js";
import type { Arm, Probe, World, RunRecord, AggregateStats, VerdictAction } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Defaults ---

export const DEFAULT_BASE_URL = "http://127.0.0.1:8091/v1";
export const DEFAULT_CORPUS_PATH = join(HERE, "corpus", "toy.json");
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_K = 5;
export const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_TOKENS = 1024;

// --- Env resolution ---

/**
 * Resolve the chat-completions base URL. Honors `MUNIN_LLM_BASE_URL` (same
 * env var the rest of the codebase uses), trimming trailing slashes and a
 * trailing `/chat/completions` suffix. Falls back to the M5 loopback
 * endpoint, NOT the shared client's OpenRouter default — this eval is meant
 * to run local sweeps by default.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MUNIN_LLM_BASE_URL;
  const base = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_BASE_URL;
  return base
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/+$/, "");
}

/** Optional bearer token. Returns null when unset (omit Authorization header). */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.OPENROUTER_API_KEY;
  return key && key.length > 0 ? key : null;
}

/**
 * Resolve the model under test. `--model` wins over `DECISION_PROVENANCE_MODEL`.
 * Throws when neither is set — there is deliberately no default model.
 */
export function resolveModel(
  cliModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = cliModel ?? env.DECISION_PROVENANCE_MODEL;
  if (!model || model.trim().length === 0) {
    throw new Error(
      "Decision-provenance runner: DECISION_PROVENANCE_MODEL is required (set the env var, or pass --model). " +
        "There is no default model — silently picking one would make flip-rate numbers across runs incomparable.",
    );
  }
  return model;
}

// --- CLI argument parsing ---

export interface ParsedArgs {
  corpusPath: string;
  arms: Arm[];
  k: number;
  outDir?: string;
  model?: string;
  temperature: number;
  maxRetries: number;
}

function getFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Decision-provenance runner: ${name} requires a value.`);
  }
  return value;
}

/** Parse CLI args into a `ParsedArgs`. Pure — no env/filesystem access. */
export function parseArgs(argv: string[]): ParsedArgs {
  const corpusPath = getFlag(argv, "--corpus") ?? DEFAULT_CORPUS_PATH;

  const armsRaw = getFlag(argv, "--arms") ?? ALL_ARMS.join(",");
  const arms = armsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (!(ALL_ARMS as readonly string[]).includes(s)) {
        throw new Error(
          `Decision-provenance runner: invalid arm "${s}" in --arms — must be one of ${ALL_ARMS.join(", ")}.`,
        );
      }
      return s as Arm;
    });
  if (arms.length === 0) {
    throw new Error("Decision-provenance runner: --arms must name at least one arm (A, B, and/or C).");
  }

  const kRaw = getFlag(argv, "--k");
  const k = kRaw !== undefined ? Number(kRaw) : DEFAULT_K;
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`Decision-provenance runner: --k must be a positive integer (got "${kRaw}").`);
  }

  const outDir = getFlag(argv, "--out");
  const model = getFlag(argv, "--model");

  const temperatureRaw = getFlag(argv, "--temperature");
  const temperature = temperatureRaw !== undefined ? Number(temperatureRaw) : DEFAULT_TEMPERATURE;
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new Error(
      `Decision-provenance runner: --temperature must be a non-negative number (got "${temperatureRaw}").`,
    );
  }

  const maxRetriesRaw = getFlag(argv, "--max-retries");
  const maxRetries = maxRetriesRaw !== undefined ? Number(maxRetriesRaw) : DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      `Decision-provenance runner: --max-retries must be a non-negative integer (got "${maxRetriesRaw}").`,
    );
  }

  return { corpusPath, arms, k, outDir, model, temperature, maxRetries };
}

// --- Minimal OpenAI-compatible chat-completions client (no new deps — plain fetch) ---

export interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Matches the subset of `fetch`'s contract this module actually uses — injectable for tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<MinimalFetchResponse>;

const defaultFetchImpl: FetchLike = (url, init) => fetch(url, init);

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface CallModelOptions {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  temperature: number;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Number of retries after the first attempt. Default 1 (i.e. up to 2 attempts total). */
  maxRetries?: number;
  fetchImpl?: FetchLike;
}

interface RawChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** Tags whether a failed attempt is worth retrying (5xx/network) or not (4xx/malformed body). */
class ModelCallError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

async function attemptModelCall(opts: CallModelOptions): Promise<{ content: string; raw: unknown }> {
  const fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
  const endpoint = `${opts.baseUrl}/chat/completions`;
  const body = {
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: opts.messages,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  let response: MinimalFetchResponse;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ModelCallError(
      `Decision-provenance runner: network error calling ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ModelCallError(
      `Decision-provenance runner: model call to ${endpoint} failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
      response.status >= 500,
    );
  }

  let json: RawChatCompletionResponse;
  try {
    json = (await response.json()) as RawChatCompletionResponse;
  } catch (err) {
    throw new ModelCallError(
      `Decision-provenance runner: response from ${endpoint} was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }

  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, raw: json };
}

/**
 * Call an OpenAI-compatible chat-completions endpoint with a basic retry:
 * one retry (by default) on a 5xx response or a network-level error. 4xx
 * responses and malformed-JSON bodies fail immediately — retrying a
 * deterministic client error, or a body that will not parse any differently,
 * wastes a call without plausibly fixing anything.
 */
export async function callModel(opts: CallModelOptions): Promise<{ content: string; raw: unknown }> {
  const maxAttempts = 1 + (opts.maxRetries ?? DEFAULT_MAX_RETRIES);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await attemptModelCall(opts);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ModelCallError ? err.retryable : false;
      if (retryable && attempt < maxAttempts - 1) continue;
      throw err;
    }
  }
  // Unreachable in practice (the loop always either returns or throws), but
  // keeps the function's return type honest for the type checker.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// --- Chat DI point used by the eval orchestration (distinct from callModel's raw options,
// so tests can inject a bare `(req) => Promise<{ content }>` mock without constructing a
// full fetch-response fixture). ---

export interface ChatRequest {
  model: string;
  temperature: number;
  messages: ChatMessage[];
  baseUrl: string;
  apiKey?: string | null;
  maxRetries?: number;
  fetchImpl?: FetchLike;
}

export type ChatFn = (req: ChatRequest) => Promise<{ content: string }>;

const defaultChat: ChatFn = (req) => callModel(req);

// --- Per-case execution ---

interface RunOneCaseOptions {
  world: World;
  arm: Arm;
  probe: Probe;
  runIndex: number;
  payload: string;
  model: string;
  temperature: number;
  baseUrl: string;
  apiKey: string | null;
  maxRetries: number;
  chat: ChatFn;
}

async function runOneCase(opts: RunOneCaseOptions): Promise<RunRecord> {
  const promptText = buildAgentPrompt(opts.payload, opts.probe.text);
  const start = performance.now();
  let rawResponse = "";
  let errorMessage: string | undefined;
  try {
    const result = await opts.chat({
      model: opts.model,
      temperature: opts.temperature,
      messages: [{ role: "user", content: promptText }],
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries,
    });
    rawResponse = result.content;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Math.round((performance.now() - start) * 100) / 100;
  const gradeOutcome = grade(rawResponse, opts.probe.expected);

  return {
    world_id: opts.world.id,
    domain: opts.world.domain,
    arm: opts.arm,
    probe_id: opts.probe.id,
    probe_kind: opts.probe.kind,
    probe_attacks: opts.probe.attacks,
    expected: opts.probe.expected,
    run_index: opts.runIndex,
    model: opts.model,
    temperature: opts.temperature,
    ts: new Date().toISOString(),
    latency_ms: latencyMs,
    raw_response: rawResponse,
    error: errorMessage,
    grade: gradeOutcome,
  };
}

// --- Aggregation ---

/** Aggregate a flat list of RunRecords into per-(world, arm, probe) stats. */
export function aggregateRuns(records: RunRecord[]): AggregateStats[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = `${r.world_id} ${r.arm} ${r.probe_id}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(r);
    } else {
      groups.set(key, [r]);
    }
  }

  const result: AggregateStats[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0];
    const k = bucket.length;
    const verdictCounts: Record<VerdictAction | "INVALID", number> = {
      REOPEN_SWITCH: 0,
      REOPEN_HOLD: 0,
      HOLD: 0,
      INVALID: 0,
    };
    let ternaryHits = 0;
    let binaryHits = 0;
    let reopenCount = 0;
    for (const r of bucket) {
      verdictCounts[r.grade.parsed_action]++;
      if (r.grade.ternary_match) ternaryHits++;
      if (r.grade.binary_match) binaryHits++;
      if (r.grade.parsed_action !== "INVALID" && isReopenAction(r.grade.parsed_action)) {
        reopenCount++;
      }
    }
    const invalidCount = verdictCounts.INVALID;

    const stats: AggregateStats = {
      world_id: first.world_id,
      domain: first.domain,
      arm: first.arm,
      probe_id: first.probe_id,
      probe_kind: first.probe_kind,
      probe_attacks: first.probe_attacks,
      expected: first.expected,
      k,
      verdict_counts: verdictCounts,
      ternary_agreement_rate: ternaryHits / k,
      binary_agreement_rate: binaryHits / k,
      invalid_count: invalidCount,
      invalid_rate: invalidCount / k,
    };
    if (first.probe_kind === "perturbation") {
      stats.should_flip_rate = binaryHits / k;
    } else {
      stats.false_flip_rate = reopenCount / k;
    }
    result.push(stats);
  }

  result.sort(
    (a, b) =>
      a.world_id.localeCompare(b.world_id) ||
      a.arm.localeCompare(b.arm) ||
      a.probe_id.localeCompare(b.probe_id),
  );
  return result;
}

// --- Compact per-(world, arm) markdown summary ---

export interface WorldArmSummaryRow {
  world_id: string;
  arm: Arm;
  /** Mean should_flip_rate over this (world, arm)'s perturbation probes. Null if none. */
  should_flip_rate: number | null;
  /** Mean false_flip_rate over this (world, arm)'s stasis probes. Null if none. */
  false_flip_rate: number | null;
  binary_agreement_rate: number;
  ternary_agreement_rate: number;
  invalid_count: number;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Roll per-probe aggregates up to one row per (world, arm) for the compact summary table. */
export function summarizeByWorldArm(aggregates: AggregateStats[]): WorldArmSummaryRow[] {
  const groups = new Map<string, AggregateStats[]>();
  for (const a of aggregates) {
    const key = `${a.world_id} ${a.arm}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(a);
    } else {
      groups.set(key, [a]);
    }
  }

  const rows: WorldArmSummaryRow[] = [];
  for (const bucket of groups.values()) {
    const perturbations = bucket.filter((a) => a.probe_kind === "perturbation");
    const stasis = bucket.filter((a) => a.probe_kind === "stasis");
    rows.push({
      world_id: bucket[0].world_id,
      arm: bucket[0].arm,
      should_flip_rate: mean(perturbations.map((a) => a.should_flip_rate ?? 0)),
      false_flip_rate: mean(stasis.map((a) => a.false_flip_rate ?? 0)),
      binary_agreement_rate: mean(bucket.map((a) => a.binary_agreement_rate)) ?? 0,
      ternary_agreement_rate: mean(bucket.map((a) => a.ternary_agreement_rate)) ?? 0,
      invalid_count: bucket.reduce((s, a) => s + a.invalid_count, 0),
    });
  }

  rows.sort((a, b) => a.world_id.localeCompare(b.world_id) || a.arm.localeCompare(b.arm));
  return rows;
}

export interface SummaryMeta {
  model: string;
  k: number;
  temperature: number;
  corpus_sha256: string;
}

/** Render the compact per-(world, arm) markdown summary table. */
export function renderMarkdownSummary(rows: WorldArmSummaryRow[], meta: SummaryMeta): string {
  const pct = (n: number | null): string => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
  const header =
    `# Decision-Provenance Summary\n\n` +
    `Model: \`${meta.model}\`  k=${meta.k}  temperature=${meta.temperature}\n` +
    `Corpus sha256: \`${meta.corpus_sha256}\`\n\n`;
  const tableHeader =
    "| World | Arm | Should-flip (perturbation) | False-flip (stasis) | Binary agreement | Ternary agreement | Invalid |\n" +
    "|---|---|---|---|---|---|---|\n";
  const tableRows = rows
    .map(
      (r) =>
        `| ${r.world_id} | ${r.arm} | ${pct(r.should_flip_rate)} | ${pct(r.false_flip_rate)} | ` +
        `${pct(r.binary_agreement_rate)} | ${pct(r.ternary_agreement_rate)} | ${r.invalid_count} |`,
    )
    .join("\n");
  return `${header}${tableHeader}${tableRows}\n`;
}

// --- End-to-end orchestration ---

export interface DecisionProvenanceRunOptions {
  corpusPath: string;
  arms: Arm[];
  k: number;
  outDir: string;
  model: string;
  temperature?: number;
  baseUrl?: string;
  apiKey?: string | null;
  maxRetries?: number;
  /** Injected chat function — tests supply a mock; default calls callModel. */
  chat?: ChatFn;
  /** Only consulted when `chat` is not supplied — passed through to callModel's fetch. */
  fetchImpl?: FetchLike;
}

export interface DecisionProvenanceRunOutcome {
  records: RunRecord[];
  aggregates: AggregateStats[];
  corpusPath: string;
  corpusSha256: string;
  paths: { jsonl: string; aggregateJson: string; markdown: string };
}

/**
 * Run the full decision-provenance eval: load + validate the corpus, iterate every
 * (world, arm, probe, k) case sequentially, grade each response, aggregate,
 * and write JSONL + aggregate-JSON + markdown-summary reports to `outDir`.
 */
export async function runDecisionProvenanceEval(
  opts: DecisionProvenanceRunOptions,
): Promise<DecisionProvenanceRunOutcome> {
  const { worlds, sha256 } = loadCorpus(opts.corpusPath);
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const baseUrl = opts.baseUrl ?? resolveBaseUrl();
  const apiKey = opts.apiKey === undefined ? resolveApiKey() : opts.apiKey;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const chat: ChatFn = opts.chat ?? ((req) => defaultChat({ ...req, fetchImpl: opts.fetchImpl }));

  const records: RunRecord[] = [];
  for (const world of worlds) {
    for (const arm of opts.arms) {
      const payload = buildArmPayload(world, arm, worlds);
      for (const probe of world.probes) {
        for (let runIndex = 0; runIndex < opts.k; runIndex++) {
          // Sequential by design (no concurrency in v1) — see module docstring.
          const record = await runOneCase({
            world,
            arm,
            probe,
            runIndex,
            payload,
            model: opts.model,
            temperature,
            baseUrl,
            apiKey,
            maxRetries,
            chat,
          });
          records.push(record);
        }
      }
    }
  }

  const aggregates = aggregateRuns(records);

  mkdirSync(opts.outDir, { recursive: true });
  const runAt = new Date().toISOString();
  const stamp = runAt.replace(/[:.]/g, "-").slice(0, 19);
  const jsonlPath = join(opts.outDir, `decision-provenance-${stamp}.jsonl`);
  const aggregateJsonPath = join(opts.outDir, `decision-provenance-${stamp}.aggregate.json`);
  const markdownPath = join(opts.outDir, `decision-provenance-${stamp}.summary.md`);

  writeFileSync(
    jsonlPath,
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""),
  );

  const meta = {
    run_at: runAt,
    model: opts.model,
    temperature,
    k: opts.k,
    arms: opts.arms,
    corpus_path: opts.corpusPath,
    corpus_sha256: sha256,
    base_url: baseUrl,
  };
  writeFileSync(aggregateJsonPath, `${JSON.stringify({ meta, aggregates }, null, 2)}\n`);

  const rows = summarizeByWorldArm(aggregates);
  const markdown = renderMarkdownSummary(rows, {
    model: opts.model,
    k: opts.k,
    temperature,
    corpus_sha256: sha256,
  });
  writeFileSync(markdownPath, markdown);

  return {
    records,
    aggregates,
    corpusPath: opts.corpusPath,
    corpusSha256: sha256,
    paths: { jsonl: jsonlPath, aggregateJson: aggregateJsonPath, markdown: markdownPath },
  };
}

// --- CLI entry point ---

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.outDir) {
    console.error("Decision-provenance runner: --out <dir> is required.");
    process.exitCode = 2;
    return;
  }

  const model = resolveModel(parsed.model);
  const baseUrl = resolveBaseUrl();
  const apiKey = resolveApiKey();

  console.log(
    `Decision-provenance runner: corpus=${parsed.corpusPath} arms=${parsed.arms.join(",")} k=${parsed.k} ` +
      `model=${model} baseUrl=${baseUrl} temperature=${parsed.temperature}`,
  );

  const outcome = await runDecisionProvenanceEval({
    corpusPath: parsed.corpusPath,
    arms: parsed.arms,
    k: parsed.k,
    outDir: parsed.outDir,
    model,
    temperature: parsed.temperature,
    baseUrl,
    apiKey,
    maxRetries: parsed.maxRetries,
  });

  console.log(`Wrote ${outcome.records.length} run records -> ${outcome.paths.jsonl}`);
  console.log(`Wrote aggregate -> ${outcome.paths.aggregateJson}`);
  console.log(`Wrote summary -> ${outcome.paths.markdown}`);
  console.log("");
  console.log(readFileSync(outcome.paths.markdown, "utf-8"));
}

// Run only when invoked directly (tsx benchmark/decision-provenance/runner.ts), not when imported
// by the test suite.
const invokedPath = process.argv[1] ?? "";
if (/decision-provenance[\\/]runner\.(ts|js|mjs)$/.test(invokedPath)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
