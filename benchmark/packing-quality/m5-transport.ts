/** Existing configured private CLI route only. No network client or credential transfer. */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { performance } from "node:perf_hooks";
import { sanitizeTransportFailureDiagnostic, TransportFailure, type QualityResponse, type Transport, type TransportFailureDiagnostic } from "./types.js";
export type SpawnM5 = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface M5TransportOptions { spawn?: SpawnM5; minimumStartIntervalMs?: number; now?: () => number; environment?: NodeJS.ProcessEnv }
const JUDGE_VERDICT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "munin_judge_verdict_v1",
    strict: true,
    schema: {
      type: "object",
      properties: {
        correct: { type: "boolean" },
        score: { type: "number", minimum: 0, maximum: 1 },
        reasoning: { type: "string" },
      },
      required: ["correct", "score", "reasoning"],
      additionalProperties: false,
    },
  },
} as const;
function failureDiagnostic(stdout: string, stderr: string, exitCode: unknown): TransportFailureDiagnostic {
  for (const output of [stdout, stderr]) {
    // The successful-response bound is unchanged; error JSON has its own smaller bound.
    if (Buffer.byteLength(output) > 65536) continue;
    let raw: unknown; try { raw = JSON.parse(output) as unknown; } catch { continue; }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const error = (raw as Record<string, unknown>).error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) continue;
    const fields = error as Record<string, unknown>;
    let category: TransportFailureDiagnostic["category"] = "unknown";
    let retryAfter: number | undefined;
    // Whole-message matches deliberately reject prefixes, suffixes and arbitrary text.
    if (fields.message === "Authentication failed.") category = "authentication";
    else if (fields.message === "Upstream error.") category = "upstream_error";
    else if (fields.message === "Request timed out.") category = "timeout";
    else if (fields.message === "The server is busy.") category = "busy";
    else if (fields.message === "Rate limit exceeded.") category = "rate_limited";
    else if (typeof fields.message === "string") {
      const match = /^(The server is busy|Rate limit exceeded)\. Retry after (0|[1-9]\d{0,3})s\.$/.exec(fields.message);
      if (match && Number(match[2]) <= 3600) { category = match[1] === "The server is busy" ? "busy" : "rate_limited"; retryAfter = Number(match[2]); }
    }
    return sanitizeTransportFailureDiagnostic({ category, cli_code: fields.code, retryable: fields.retryable, retry_after_seconds: fields.retry_after_seconds ?? retryAfter, exit_code: exitCode });
  }
  return sanitizeTransportFailureDiagnostic({ category: "unknown", exit_code: exitCode });
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("M5 call aborted before dispatch")); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("M5 call aborted before dispatch")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function createM5Transport(config: M5TransportOptions = {}): Transport {
  const interval = config.minimumStartIntervalMs ?? 8000;
  if (!Number.isSafeInteger(interval) || interval < 0) throw new Error("Minimum start interval must be a nonnegative safe integer");
  const spawnProcess: SpawnM5 = config.spawn ?? ((command, args, options) => spawn(command, args, { ...options, stdio: "pipe" }));
  const now = config.now ?? (() => performance.now());
  const ambient = config.environment ?? process.env;
  const env = { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", ...(ambient.HOME ? { HOME: ambient.HOME } : {}), ...(ambient.TMPDIR ? { TMPDIR: ambient.TMPDIR } : {}) };
  let previousStart = Number.NEGATIVE_INFINITY; let starts = Promise.resolve();
  return async (options, control) => {
    if (control.signal.aborted) throw new Error("M5 call aborted before dispatch");
    if (control.provider_kind !== "local_self_hosted" || options.apiKey) throw new Error("M5 requires credential-free local mode");
    if (!["gemma4", "gpt-oss-120b"].includes(options.model)) throw new Error("Model outside frozen M5 profile");
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens! <= 0 || !Number.isSafeInteger(control.timeout_ms) || control.timeout_ms <= 0) throw new Error("Explicit bounded output/timeout required");
    // The unchanged rubric sends one system then one user message; reject other
    // role patterns rather than flattening or reordering the prompt.
    if (options.messages.length !== 2 || options.messages[0].role !== "system" || options.messages[1].role !== "user") throw new Error("M5 requires system then user messages");
    const payload = JSON.stringify({ model: options.model, system: options.messages[0].content, prompt: options.messages[1].content, max_tokens: options.maxTokens, temperature: options.temperature, output_profile: "complete-within-budget", traffic_purpose: "evaluation", ...(control.stage === "judge" ? { response_format: JUDGE_VERDICT_RESPONSE_FORMAT } : {}) });
    if (Buffer.byteLength(payload) > 262144) throw new Error("M5 request exceeded bounded size");
    const turn = starts.then(async () => { await wait(Math.ceil(Math.max(0, previousStart + interval - now())), control.signal); if (control.signal.aborted) throw new Error("M5 call aborted before dispatch"); });
    starts = turn.then(() => undefined, () => undefined); await turn;
    return new Promise<QualityResponse>((resolve, reject) => {
      if (control.signal.aborted) { reject(new Error("M5 call aborted before dispatch")); return; }
      let child: ChildProcessWithoutNullStreams;
      try { child = spawnProcess("/opt/homebrew/bin/m5", ["--profile", "codex", "--private", "--timeout-ms", String(Math.min(600000, control.timeout_ms)), "ask"], { env, stdio: "pipe" }); previousStart = now(); }
      catch { reject(new Error("M5 process failed to start; outcome unknown")); return; }
      let stdout = ""; let stderr = ""; let stdoutBytes = 0; let stderrBytes = 0; let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); control.signal.removeEventListener("abort", abort); };
      const fail = (message: string, diagnostic?: TransportFailureDiagnostic) => {
        if (settled) return;
        settled = true; cleanup();
        const force = setTimeout(() => child.kill("SIGKILL"), 1000); force.unref();
        child.once("close", () => clearTimeout(force)); child.kill("SIGTERM"); reject(diagnostic ? new TransportFailure(diagnostic) : new Error(message));
      };
      const abort = () => fail("M5 call aborted; outcome unknown, no automatic retry");
      control.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail("M5 response timed out; outcome unknown, no automatic retry"), Math.min(600000, control.timeout_ms));
      child.on("error", () => fail("M5 process failed to start; outcome unknown"));
      child.stdin.on("error", () => fail("M5 stdin failed; outcome unknown"));
      child.stdout.on("data", (chunk: Buffer | string) => { stdoutBytes += Buffer.byteLength(chunk); if (stdoutBytes > 262144) { fail("M5 response exceeded bounded size"); return; } stdout += String(chunk); });
      child.stderr.on("data", (chunk: Buffer | string) => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > 65536) { fail("M5 diagnostic exceeded bounded size"); return; } stderr += String(chunk); });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) { fail("M5 process exited unsuccessfully; outcome unknown, no automatic retry", failureDiagnostic(stdout, stderr, code)); return; }
        let raw: unknown; try { raw = JSON.parse(stdout) as unknown; } catch { fail("M5 returned malformed JSON; outcome unknown"); return; }
        const result = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const usage = result.usage !== null && typeof result.usage === "object" && !Array.isArray(result.usage) ? result.usage as Record<string, unknown> : undefined;
        const response: QualityResponse & { truncated: boolean; gateway_metadata: unknown } = {
          model: typeof result.model === "string" ? result.model : "", provider: "m5-private-configured-gateway", truncated: result.truncated !== false, gateway_metadata: raw,
          ...(typeof result.feedback_handle === "string" ? { id: `m5-feedback:${result.feedback_handle}` } : {}),
          choices: [{ message: { content: typeof result.text === "string" ? result.text : "" }, finish_reason: result.error !== undefined || result.ok === false ? "error" : typeof result.finish_reason === "string" ? result.finish_reason : null }],
          ...(result.metered === true && usage ? { usage: { prompt_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : -1, completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : -1 } } : {}),
        };
        settled = true; cleanup(); resolve(response);
      });
      if (control.signal.aborted) abort();
      if (!settled) child.stdin.end(payload);
    });
  };
}
/** One shared pacing gate for all root evaluation calls using this module. */
export const m5Transport = createM5Transport();
