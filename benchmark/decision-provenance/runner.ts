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
import type { Arm, Probe, World, RunRecord, AggregateStats, VerdictAction, GradeOutcome } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Defaults ---

export const DEFAULT_BASE_URL = "http://127.0.0.1:8091/v1";
export const DEFAULT_CORPUS_PATH = join(HERE, "corpus", "toy.json");
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_K = 5;
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_MAX_TOKENS = 2048;
/** Cap on how many times a 429 is retried, independent of `maxRetries` (which governs 5xx/network). */
export const DEFAULT_MAX_429_RETRIES = 4;
/** Fallback backoff when a 429 carries neither a `Retry-After` header nor a body hint. */
export const DEFAULT_429_BACKOFF_MS = 2000;
/** Ceiling on any single 429 wait, so a run can't hang forever on a huge Retry-After value. */
export const MAX_429_WAIT_MS = 30_000;
/** Default errored-rate threshold above which the run is flagged as untrustworthy. */
export const DEFAULT_ERRORED_RATE_WARN_THRESHOLD = 0.2;

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
  maxTokens: number;
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

  const maxTokensRaw = getFlag(argv, "--max-tokens");
  const maxTokens = maxTokensRaw !== undefined ? Number(maxTokensRaw) : DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(
      `Decision-provenance runner: --max-tokens must be a positive integer (got "${maxTokensRaw}"). ` +
        "A thinking model can blank out on the longest prompts if this is too tight.",
    );
  }

  return { corpusPath, arms, k, outDir, model, temperature, maxRetries, maxTokens };
}

// --- Minimal OpenAI-compatible chat-completions client (no new deps — plain fetch) ---

export interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  /** Optional — only consulted for 429 responses, to honor `Retry-After`. */
  headers?: { get(name: string): string | null };
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

/** Injectable delay — tests supply a spy so the retry loop never actually waits. */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CallModelOptions {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  temperature: number;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Number of retries after the first attempt, for 5xx/network errors. Default 1 (i.e. up to 2 attempts total). */
  maxRetries?: number;
  /** Cap on 429 retries, independent of `maxRetries`. Default `DEFAULT_MAX_429_RETRIES`. */
  max429Retries?: number;
  fetchImpl?: FetchLike;
  /** Injected delay for 429 backoff — tests supply a spy. Defaults to a real `setTimeout`-based wait. */
  sleep?: SleepFn;
}

interface RawChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Tags whether a failed attempt is worth retrying (5xx/network, or 429 with
 * its own separate retry budget) or not (other 4xx / malformed body).
 */
class ModelCallError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    /** For a 429: how long to wait before retrying, in milliseconds. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

/**
 * Resolve how long to wait before retrying a 429: the `Retry-After` header
 * (seconds) wins, then a "Retry after Ns" hint in the response body, then a
 * fixed default. `Retry-After` as an HTTP-date is not handled — falls
 * through to the body hint / default in that case.
 */
function parseRetryAfterMs(response: MinimalFetchResponse, bodyText: string): number {
  const header = response.headers?.get("Retry-After") ?? response.headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const bodyMatch = bodyText.match(/retry[\s-]?after\s+(\d+(?:\.\d+)?)\s*s/i);
  if (bodyMatch) {
    return Number(bodyMatch[1]) * 1000;
  }
  return DEFAULT_429_BACKOFF_MS;
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
    const status = response.status;
    if (status === 429) {
      throw new ModelCallError(
        `Decision-provenance runner: model call to ${endpoint} was rate-limited (HTTP 429): ${text.slice(0, 200)}`,
        true,
        status,
        parseRetryAfterMs(response, text),
      );
    }
    throw new ModelCallError(
      `Decision-provenance runner: model call to ${endpoint} failed with HTTP ${status}: ${text.slice(0, 200)}`,
      status >= 500,
      status,
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
 * Call an OpenAI-compatible chat-completions endpoint with retry:
 *
 * - **429** is retried on its own budget (`max429Retries`, default
 *   `DEFAULT_MAX_429_RETRIES`), honoring `Retry-After` (header, then a body
 *   hint, then a fixed default), capped at `MAX_429_WAIT_MS` per wait so a
 *   run can never hang forever on a huge Retry-After value.
 * - **5xx / network errors** get one retry by default (`maxRetries`), same
 *   as before.
 * - **Other 4xx responses and malformed-JSON bodies fail immediately** —
 *   retrying a deterministic client error, or a body that will not parse any
 *   differently, wastes a call without plausibly fixing anything.
 */
export async function callModel(opts: CallModelOptions): Promise<{ content: string; raw: unknown }> {
  const maxAttempts = 1 + (opts.maxRetries ?? DEFAULT_MAX_RETRIES);
  const max429Retries = opts.max429Retries ?? DEFAULT_MAX_429_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  let generalAttempts = 0;
  let retries429 = 0;
  for (;;) {
    try {
      return await attemptModelCall(opts);
    } catch (err) {
      if (err instanceof ModelCallError && err.status === 429) {
        if (retries429 < max429Retries) {
          retries429++;
          const waitMs = Math.min(err.retryAfterMs ?? DEFAULT_429_BACKOFF_MS, MAX_429_WAIT_MS);
          await sleep(waitMs);
          continue;
        }
        throw err;
      }
      const retryable = err instanceof ModelCallError ? err.retryable : false;
      generalAttempts++;
      if (retryable && generalAttempts < maxAttempts) continue;
      throw err;
    }
  }
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
  max429Retries?: number;
  maxTokens?: number;
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
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
  maxTokens: number;
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
      maxTokens: opts.maxTokens,
    });
    rawResponse = result.content;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Math.round((performance.now() - start) * 100) / 100;
  // A run whose call THREW (HTTP error after retries, network error) is
  // "errored" infrastructure noise, never graded as a model response — grade()
  // is only meaningful for a call that actually succeeded (HTTP 200).
  // Conflating the two silently launders rate-limit/5xx failures into "blank"
  // model behavior.
  const gradeOutcome: GradeOutcome =
    errorMessage !== undefined
      ? { parsed_action: "INVALID", ternary_match: false, binary_match: false, errored: true }
      : grade(rawResponse, opts.probe.expected);

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
    let blankCount = 0;
    let erroredCount = 0;
    for (const r of bucket) {
      verdictCounts[r.grade.parsed_action]++;
      if (r.grade.ternary_match) ternaryHits++;
      if (r.grade.binary_match) binaryHits++;
      if (r.grade.blank) blankCount++;
      if (r.grade.errored) erroredCount++;
      if (r.grade.parsed_action !== "INVALID" && isReopenAction(r.grade.parsed_action)) {
        reopenCount++;
      }
    }
    // verdictCounts.INVALID includes blank, errored, and malformed responses
    // (it buckets purely on parsed_action); invalid_count narrows to
    // malformed only so blank/errored/invalid are visibly distinct,
    // non-overlapping signals.
    const invalidCount = verdictCounts.INVALID - blankCount - erroredCount;
    // Decisions can only come from runs whose call actually succeeded — an
    // errored run is infrastructure noise, never a model decision.
    const decidedCount = k - erroredCount;

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
      blank_count: blankCount,
      blank_rate: blankCount / k,
      errored_count: erroredCount,
      errored_rate: erroredCount / k,
    };
    if (first.probe_kind === "perturbation") {
      stats.should_flip_rate = decidedCount > 0 ? binaryHits / decidedCount : undefined;
    } else {
      stats.false_flip_rate = decidedCount > 0 ? reopenCount / decidedCount : undefined;
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
  /** Sum of blank_count across the (world, arm)'s probes — see AggregateStats.blank_count. */
  blank_count: number;
  /** Sum of errored_count across the (world, arm)'s probes — see AggregateStats.errored_count. */
  errored_count: number;
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
      blank_count: bucket.reduce((s, a) => s + a.blank_count, 0),
      errored_count: bucket.reduce((s, a) => s + a.errored_count, 0),
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
    "| World | Arm | Should-flip (perturbation) | False-flip (stasis) | Binary agreement | Ternary agreement | Invalid | Blank | Errored |\n" +
    "|---|---|---|---|---|---|---|---|---|\n";
  const tableRows = rows
    .map(
      (r) =>
        `| ${r.world_id} | ${r.arm} | ${pct(r.should_flip_rate)} | ${pct(r.false_flip_rate)} | ` +
        `${pct(r.binary_agreement_rate)} | ${pct(r.ternary_agreement_rate)} | ${r.invalid_count} | ${r.blank_count} | ${r.errored_count} |`,
    )
    .join("\n");
  return `${header}${tableHeader}${tableRows}\n`;
}

/**
 * Loud, human-facing text for a run whose errored rate exceeds the warning
 * threshold — used for both the stderr banner and the markdown prefix. The
 * caller decides where/whether to emit it (`maybePrependHighErrorRateBanner`,
 * and the stderr banner in `runDecisionProvenanceEval`).
 */
export function highErrorRateWarningText(erroredRate: number, threshold: number): string {
  const pct = (erroredRate * 100).toFixed(1);
  const thresholdPct = (threshold * 100).toFixed(0);
  return (
    `HIGH ERROR RATE: ${pct}% of runs errored (rate-limited/failed) — results are NOT trustworthy ` +
    `(threshold: ${thresholdPct}%). Re-run once the endpoint is healthy before drawing conclusions.`
  );
}

/** Fraction of `records` whose model call itself failed (see `GradeOutcome.errored`). */
export function computeErroredRate(records: RunRecord[]): number {
  if (records.length === 0) return 0;
  const erroredCount = records.filter((r) => r.grade.errored).length;
  return erroredCount / records.length;
}

/**
 * Prepend a loud "⚠ HIGH ERROR RATE" banner to `markdown` when `erroredRate`
 * exceeds `threshold`. Never silently produces a normal-looking table when
 * infrastructure failures (rate limits, 5xx, network) dominated the run.
 */
export function maybePrependHighErrorRateBanner(
  markdown: string,
  erroredRate: number,
  threshold: number = DEFAULT_ERRORED_RATE_WARN_THRESHOLD,
): string {
  if (erroredRate <= threshold) return markdown;
  const warning = highErrorRateWarningText(erroredRate, threshold);
  return `> ⚠ **${warning}**\n\n${markdown}`;
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
  maxTokens?: number;
  /** Injected chat function — tests supply a mock; default calls callModel. */
  chat?: ChatFn;
  /** Only consulted when `chat` is not supplied — passed through to callModel's fetch. */
  fetchImpl?: FetchLike;
  /**
   * Errored-rate threshold above which the run is flagged as untrustworthy
   * (loud stderr banner + markdown prefix). Default `DEFAULT_ERRORED_RATE_WARN_THRESHOLD`.
   */
  erroredRateWarnThreshold?: number;
}

export interface DecisionProvenanceRunOutcome {
  records: RunRecord[];
  aggregates: AggregateStats[];
  corpusPath: string;
  corpusSha256: string;
  /** Fraction of records whose model call itself failed — see `computeErroredRate`. */
  erroredRate: number;
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
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
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
            maxTokens,
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
    max_tokens: maxTokens,
    arms: opts.arms,
    corpus_path: opts.corpusPath,
    corpus_sha256: sha256,
    base_url: baseUrl,
  };
  writeFileSync(aggregateJsonPath, `${JSON.stringify({ meta, aggregates }, null, 2)}\n`);

  const rows = summarizeByWorldArm(aggregates);
  let markdown = renderMarkdownSummary(rows, {
    model: opts.model,
    k: opts.k,
    temperature,
    corpus_sha256: sha256,
  });

  const erroredRateWarnThreshold = opts.erroredRateWarnThreshold ?? DEFAULT_ERRORED_RATE_WARN_THRESHOLD;
  const erroredRate = computeErroredRate(records);
  if (erroredRate > erroredRateWarnThreshold) {
    const warning = highErrorRateWarningText(erroredRate, erroredRateWarnThreshold);
    // Loud, impossible-to-miss stderr banner — never let a high-error-rate run
    // produce output that silently looks like a normal, trustworthy summary.
    console.error(`\n${"!".repeat(72)}\n⚠ ${warning}\n${"!".repeat(72)}\n`);
    markdown = maybePrependHighErrorRateBanner(markdown, erroredRate, erroredRateWarnThreshold);
  }
  writeFileSync(markdownPath, markdown);

  return {
    records,
    aggregates,
    corpusPath: opts.corpusPath,
    corpusSha256: sha256,
    erroredRate,
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
      `model=${model} baseUrl=${baseUrl} temperature=${parsed.temperature} maxTokens=${parsed.maxTokens}`,
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
    maxTokens: parsed.maxTokens,
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
