/** Explicitly injected, non-retrying inference orchestration. No built-in network transport. */
import { closeSync, existsSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { OpenRouterCallOptions } from "../../src/internal/openrouter.js";
import { generateAnswer, judgeAnswer } from "../answer-quality/judge.js";
import { canonical } from "../evidence-metric/metric.js";
import { hashFile, sha256 } from "../evidence-metric/evaluate.js";
import { assertSafeParents } from "../evidence-metric/shared-artifacts.js";
import { assertManifestFiles, regularFile, SOURCE_ROOT, validateManifest } from "./prepare.js";
import { summarizePairs } from "./summary.js";
import { sanitizeTransportFailureDiagnostic, TransportFailure } from "./types.js";
import type { CallCheckpoint, ModelProfile, PairOutcome, QualityManifest, RunConfig, Stage, Transport, Variant, QualityResponse } from "./types.js";

function validateConfig(config: RunConfig): void {
  if (config.schema_version !== 1 || !Number.isSafeInteger(config.timeout_ms) || config.timeout_ms < 1 || config.timeout_ms > 3_600_000) throw new Error("Invalid bounded timeout/config");
  if (config.cost.mode === "paid" && (!Number.isFinite(config.cost.max_total_usd) || config.cost.max_total_usd <= 0 || config.cost.max_total_usd > 25)) throw new Error("Paid total cost cap must be positive and <= authorized USD 25");
  if (config.cost.mode !== "paid" && (config.cost.mode !== "local" || config.cost.api_charge_assumption !== "self_hosted_no_paid_api")) throw new Error("Explicit local cost assumption required");
  for (const profile of [config.reader, config.judge]) {
    if (!profile.model?.trim() || !profile.identity?.trim() || !Number.isSafeInteger(profile.max_output_tokens) || profile.max_output_tokens <= 0
      || !Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2
      || profile.provider_kind !== (config.cost.mode === "local" ? "local_self_hosted" : "paid_api")) throw new Error("Invalid immutable model profile/provider mode");
    if (config.cost.mode === "paid") {
      const price = profile.pricing;
      if (!price?.source?.trim() || !Number.isFinite(price.input_usd_per_million) || price.input_usd_per_million <= 0
        || !Number.isFinite(price.output_usd_per_million) || price.output_usd_per_million <= 0) throw new Error("Paid mode requires pinned positive prices");
    }
  }
}
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** All ledger states are flushed before a subsequent inference dispatch. */
function durableJson(path: string, value: unknown, replace = false): void {
  assertSafeParents(path);
  if (replace) {
    if (!lstatSync(path).isFile()) throw new Error("Expected regular checkpoint");
    const tmp = `${path}.tmp-${randomUUID()}`;
    durableJson(tmp, value);
    try { renameSync(tmp, path); syncDirectory(dirname(path)); } finally { rmSync(tmp, { force: true }); }
    return;
  }
  const tmp = `${path}.write-${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    // Hard-link publication is atomic and refuses an existing destination.
    linkSync(tmp, path); syncDirectory(dirname(path));
  } finally { rmSync(tmp, { force: true }); syncDirectory(dirname(path)); }
}
function sealCall(body: Omit<CallCheckpoint, "checkpoint_sha256">): CallCheckpoint { return { ...body, checkpoint_sha256: sha256(canonical(body)) }; }
function checkpoint(path: string, binding: string): CallCheckpoint {
  regularFile(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as CallCheckpoint;
  const { checkpoint_sha256: hash, ...body } = value;
  if (value.schema_version !== 1 || value.binding_sha256 !== binding || hash !== sha256(canonical(body))
    || !["pending", "complete", "invalid", "malformed", "unknown"].includes(value.status)) throw new Error("Checkpoint hash/binding/schema mismatch");
  return value;
}
export function conservativeReservation(opts: OpenRouterCallOptions, profile: ModelProfile): number {
  if (!profile.pricing) throw new Error("Missing pinned prices");
  // A token per UTF-8 byte plus 4096 framing tokens is deliberately conservative;
  // output max includes reasoning tokens. No API-key bytes enter the ledger.
  const input = Buffer.byteLength(JSON.stringify({ model: opts.model, messages: opts.messages }), "utf8") + 4096;
  return Math.ceil((input * profile.pricing.input_usd_per_million + profile.max_output_tokens * profile.pricing.output_usd_per_million) * 1e6) / 1e12;
}
function validateResponse(response: QualityResponse, profile: ModelProfile): string | undefined {
  const usage = response.usage;
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0 || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens <= 0) return "Missing or invalid actual token usage";
  const choice = response.choices?.[0];
  if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) return "Empty model output";
  if (choice.finish_reason !== "stop" || usage.completion_tokens > profile.max_output_tokens || (response as QualityResponse & { truncated?: boolean }).truncated === true) return "Truncated output or non-stop/missing finish reason";
  if (typeof response.model !== "string" || !response.model.trim() || typeof response.provider !== "string" || !response.provider.trim()) return "Missing actual model/provider identity";
  if (profile.provider_kind === "local_self_hosted" && response.model !== profile.model) return "Local model fallback/identity mismatch";
  return undefined;
}
export interface RunOptions { manifest: QualityManifest | string; config: RunConfig; checkpointDir: string; transport: Transport; stage?: "all" | "readers" | "judges" | "inspect" }
export async function runPairedQuality(options: RunOptions) {
  if (typeof options.transport !== "function") throw new Error("An explicit transport is required");
  if (options.stage !== undefined && !["all", "readers", "judges", "inspect"].includes(options.stage)) throw new Error("Invalid stage");
  const manifestPath = typeof options.manifest === "string" ? regularFile(options.manifest) : undefined;
  const manifest = validateManifest(JSON.parse(manifestPath ? readFileSync(manifestPath, "utf8") : JSON.stringify(options.manifest)) as QualityManifest);
  const config = JSON.parse(JSON.stringify(options.config)) as RunConfig; validateConfig(config); assertManifestFiles(manifest);
  const dir = resolve(options.checkpointDir); assertSafeParents(dir);
  const protectedPaths = [...Object.values(manifest.inputs).map((pin) => pin.path), ...Object.keys(manifest.source_sha256).map((path) => join(SOURCE_ROOT, path)), ...(manifestPath ? [manifestPath] : [])];
  if (protectedPaths.some((path) => { const part = relative(dir, resolve(path)); return part === "" || (!part.startsWith("..") && !part.startsWith("/")); })) throw new Error("Checkpoint directory overlaps an input/source path");
  const binding = { schema_version: 1, manifest_sha256: manifest.manifest_sha256, config, runner_source_sha256: Object.fromEntries(["prepare.ts", "run.ts", "summary.ts", "types.ts"].map((name) => [name, hashFile(join(SOURCE_ROOT, "benchmark/packing-quality", name))])) };
  const bindingHash = sha256(canonical(binding));
  const fresh = !existsSync(dir);
  if (fresh && options.stage === "inspect") throw new Error("Cannot inspect a missing checkpoint directory");
  if (fresh) { mkdirSync(dir, { mode: 0o700 }); syncDirectory(dirname(dir)); }
  else if (!lstatSync(dir).isDirectory()) throw new Error("Checkpoint path is not a directory");
  const lockPath = join(dir, ".lock"); const lock = openSync(lockPath, "wx", 0o600);
  try {
    if (fresh) durableJson(join(dir, "binding.json"), { ...binding, binding_sha256: bindingHash });
    else {
      const path = regularFile(join(dir, "binding.json"));
      if (canonical(JSON.parse(readFileSync(path, "utf8")) as unknown) !== canonical({ ...binding, binding_sha256: bindingHash })) throw new Error("Immutable config/input/source binding mismatch");
    }
    const calls = new Map<string, CallCheckpoint>();
    const expectedCallIds = new Set(manifest.queries.flatMap((_q, i) => (["reader", "judge"] as const).flatMap((stage) => (["baseline", "core"] as const).map((variant) => `${stage}-${String(i).padStart(6, "0")}-${variant}`))));
    for (const name of readdirSync(dir)) {
      if (name === ".lock" || name === "binding.json") continue;
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !expectedCallIds.has(id)) throw new Error("Unexpected checkpoint file; manual reconciliation required");
      const c = checkpoint(join(dir, name), bindingHash);
      if (c.call_id !== id) throw new Error("Checkpoint filename/ID mismatch");
      calls.set(id, c);
      if (c.status !== "complete" && options.stage !== "inspect") throw new Error(`Unresolved ${c.status} call ${id}; replay blocked, reconcile manually`);
    }
    const exposure = () => [...calls.values()].reduce((sum, call) => sum + (call.cost_usd ?? call.reserved_usd ?? 0), 0);
    const execute = async (stage: Stage, variant: Variant, index: number): Promise<void> => {
      const q = manifest.queries[index]; const id = `${stage}-${String(index).padStart(6, "0")}-${variant}`;
      if (calls.has(id)) return;
      const profile = stage === "reader" ? config.reader : config.judge;
      const reader = calls.get(`reader-${String(index).padStart(6, "0")}-${variant}`);
      if (stage === "judge" && reader?.status !== "complete") return;
      const path = join(dir, `${id}.json`);
      let pending: CallCheckpoint | undefined;
      let observed: QualityResponse | undefined;
      const start = performance.now();
      // Wrap the unchanged generation/judge functions to intercept the exact
      // rubric prompt, reserve cost, and persist pending BEFORE any dispatch.
      const chat = async (opts: OpenRouterCallOptions): Promise<QualityResponse> => {
        const { apiKey: _excluded, ...request } = opts; void _excluded;
        const reserved = config.cost.mode === "paid" ? conservativeReservation(opts, profile) : null;
        if (config.cost.mode === "paid" && exposure() + reserved! > config.cost.max_total_usd) throw new Error("Total paid API cost cap would be exceeded before dispatch");
        pending = sealCall({ schema_version: 1, binding_sha256: bindingHash, call_id: id, query_id: q.query_id, variant, stage, request_sha256: sha256(canonical(request)), status: "pending", reserved_usd: reserved, cost_usd: null, cost_basis: config.cost.mode === "local" ? "self_hosted_assumption" : "unreconciled_reservation" });
        durableJson(path, pending); calls.set(id, pending);
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Inference timeout; outcome unknown")); }, config.timeout_ms); });
          observed = await Promise.race([options.transport({ ...request, apiKey: "" }, { call_id: id, query_id: q.query_id, variant, stage, signal: controller.signal, timeout_ms: config.timeout_ms, provider_kind: profile.provider_kind }), timeout]);
          return observed;
        } finally { if (timer) clearTimeout(timer); }
      };
      try {
        const generated = stage === "reader" ? await generateAnswer({ question: q.question, questionDate: q.question_date, context: q[variant].text, model: profile.model, apiKey: "", temperature: profile.temperature, maxTokens: profile.max_output_tokens }, chat) : undefined;
        const verdict = stage === "judge" ? await judgeAnswer({ question: q.question, category: q.category, referenceAnswer: q.reference_answer, candidateAnswer: reader!.answer!, model: profile.model, apiKey: "", temperature: profile.temperature, maxTokens: profile.max_output_tokens }, chat) : undefined;
        if (!pending || !observed) throw new Error("Missing durable dispatch/response");
        let cost: number | null = null;
        if (config.cost.mode === "paid") {
          const charge = observed.usage?.cost;
          if (typeof charge !== "number" || !Number.isFinite(charge) || charge < 0) throw new Error("Unknown actual provider charge; paid cost receipt missing");
          cost = charge;
          if (cost > pending.reserved_usd!) throw new Error("Actual provider charge exceeded conservative cost reservation; reconcile manually");
        }
        const error = validateResponse(observed, profile);
        const { checkpoint_sha256: _old, ...body } = pending; void _old;
        const final = sealCall({ ...body, status: error ? "invalid" : verdict && !verdict.parse_ok ? "malformed" : "complete", response: observed, ...(generated ? { answer: generated.answer } : {}), ...(verdict ? { verdict } : {}), ...(error ? { error } : {}), finish_reason: observed.choices?.[0]?.finish_reason, truncated: observed.choices?.[0]?.finish_reason === "length" || (observed as QualityResponse & { truncated?: boolean }).truncated === true, cost_usd: cost, cost_basis: config.cost.mode === "paid" ? "provider_receipt" : "self_hosted_assumption", duration_ms: performance.now() - start });
        durableJson(path, final, true); calls.set(id, final);
        if (final.status !== "complete") throw new Error(`${final.status} call ${id}; stopped before next dispatch: ${final.error ?? "Judge response failed primary rubric parsing"}`);
      } catch (error) {
        const current = calls.get(id);
        if (current?.status === "invalid" || current?.status === "malformed") throw error;
        if (pending) {
          const { checkpoint_sha256: _old, ...body } = pending; void _old;
          const failed = sealCall({ ...body, status: "unknown", ...(observed ? { response: observed } : {}), ...(error instanceof TransportFailure ? { transport_diagnostic: sanitizeTransportFailureDiagnostic(error.diagnostic) } : {}), error: "Transport/charge outcome unknown; manual reconciliation required", duration_ms: performance.now() - start });
          durableJson(path, failed, true); calls.set(id, failed);
          throw new Error(`Unknown call ${id}; no automatic replay. ${error instanceof Error ? error.message : "Inference failed"}`);
        }
        throw error;
      }
    };
    for (const stage of ["reader", "judge"] as const) {
      if (options.stage === "inspect") continue;
      if ((options.stage === "readers" && stage === "judge") || (options.stage === "judges" && stage === "reader")) continue;
      for (let index = 0; index < manifest.queries.length; index++) {
        const order: Variant[] = index % 2 === 0 ? ["baseline", "core"] : ["core", "baseline"];
        for (const variant of order) await execute(stage, variant, index);
      }
    }
    const rows: PairOutcome[] = manifest.queries.map((q, index) => {
      const outcome = (variant: Variant) => {
        const prefix = `${String(index).padStart(6, "0")}-${variant}`;
        const reader = calls.get(`reader-${prefix}`); const judge = calls.get(`judge-${prefix}`);
        return reader?.status === "complete" && judge?.status === "complete" && judge.verdict?.parse_ok ? { correct: judge.verdict.correct, abstained: /\b(?:cannot find|can't find|not (?:found |available |present )?in (?:the )?context|don't know|do not know)\b/i.test(reader.answer ?? "") } : null;
      };
      return { query_id: q.query_id, category: q.category, baseline: outcome("baseline"), core: outcome("core") };
    });
    const statuses = [...calls.values()].reduce<Record<string, number>>((counts, call) => { counts[call.status] = (counts[call.status] ?? 0) + 1; return counts; }, {});
    assertManifestFiles(manifest);
    return { report_kind: "packing_quality" as const, evidence_scope: manifest.evidence_scope, manifest_sha256: manifest.manifest_sha256, binding_sha256: bindingHash, config, summary: summarizePairs(rows), rows, calls: [...calls.values()], call_status_counts: statuses, cost_usd: config.cost.mode === "local" ? null : exposure(), cost_basis: config.cost.mode === "local" ? "self_hosted_assumption_not_measured_usd" : "provider_receipts_plus_unreconciled_reservations" };
  } finally { closeSync(lock); rmSync(lockPath); syncDirectory(dir); }
}
