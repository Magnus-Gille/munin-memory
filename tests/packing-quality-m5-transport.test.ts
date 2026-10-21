import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createM5Transport, type SpawnM5 } from "../benchmark/packing-quality/m5-transport.js";
import type { CallControl } from "../benchmark/packing-quality/types.js";
import { runPairedQuality } from "../benchmark/packing-quality/run.js";
import { sealManifest } from "../benchmark/packing-quality/prepare.js";
import { sha256 } from "../benchmark/evidence-metric/evaluate.js";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
const options = () => ({ model: "gemma4", messages: [{ role: "system" as const, content: "system exactly\n\"quoted\"" }, { role: "user" as const, content: "user exactly\n{data}" }], maxTokens: 1024, temperature: 0, apiKey: "" });
const control = (controller = new AbortController()): CallControl => ({ call_id: "reader-000000-baseline", query_id: "q", variant: "baseline", stage: "reader", signal: controller.signal, timeout_ms: 1000, provider_kind: "local_self_hosted" });
const good = () => ({ model: "gemma4", text: "answer", finish_reason: "stop", truncated: false, metered: true, usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20, reasoning_tokens: 1 }, feedback_handle: "feedback-1" });
function fakeProcess(reply?: unknown, action?: (child: ReturnType<typeof childProcess>) => void) {
  const children: ReturnType<typeof childProcess>[] = []; const inputs: string[] = [];
  const spawn: SpawnM5 = vi.fn((_command, _args, _config) => {
    const child = childProcess(); children.push(child);
    child.stdin.on("data", (chunk: Buffer) => inputs.push(String(chunk)));
    child.stdin.on("finish", () => { if (action) action(child); else { child.stdout.write(JSON.stringify(reply ?? good())); child.emit("close", 0); } });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return { spawn, children, inputs };
}
function childProcess() { return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) }); }
async function dispatched(factory: ReturnType<typeof fakeProcess>) { while (factory.children.length === 0) await new Promise((resolve) => setTimeout(resolve, 1)); return factory.children[0]; }
function qualityFixture() {
  const context = { text: "fact", sha256: sha256("fact"), ordered_ids: ["e"], budget: { max_estimated_tokens: 8192, estimated_tokens: 1, estimator: "utf8_bytes_div4_ceil_v1" as const, truncated: false, candidate_entry_count: 1, included_entry_count: 1, dropped_entry_count: 0 } };
  const manifest = sealManifest({ schema_version: 1, report_kind: "packing_quality_manifest", evidence_scope: "development_set_not_held_out", as_of: "2026-10-01T00:00:00.000Z", identity: "fixture", rule: "query-message-cores-v1", retrieval: { runner_mode: "production_ranker", search_mode: "hybrid", top_k: 10, search_recency_weight: 0, context_token_budget: 8192 }, inputs: {}, source_revision: "a".repeat(40), source_sha256: {}, queries: [{ query_id: "q", question: "question", reference_answer: "fact", category: "fixture", retrieved_ids: ["e"], baseline: context, core: context }] });
  const profile = { model: "gemma4", identity: "fixture", provider_kind: "local_self_hosted" as const, max_output_tokens: 1024, temperature: 0 };
  return { manifest, config: { schema_version: 1 as const, reader: profile, judge: profile, timeout_ms: 1000, cost: { mode: "local" as const, api_charge_assumption: "self_hosted_no_paid_api" as const } } };
}
describe("configured private M5 transport", () => {
  it("preserves prompt roles, actual identity and usage while passing only allowlisted environment", async () => {
    const f = fakeProcess(); const call = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0, environment: { HOME: "/fixture/home", TMPDIR: "/fixture/tmp", OPENROUTER_API_KEY: "fixture-secret-do-not-forward", SSH_AUTH_SOCK: "/fixture/socket", NODE_OPTIONS: "fixture" } });
    const response = await call(options(), control());
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith("/opt/homebrew/bin/m5", ["--profile", "codex", "--private", "--timeout-ms", "1000", "ask"], { stdio: "pipe", env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/fixture/home", TMPDIR: "/fixture/tmp" } });
    expect(JSON.parse(f.inputs[0])).toEqual({ model: "gemma4", system: options().messages[0].content, prompt: options().messages[1].content, max_tokens: 1024, temperature: 0, output_profile: "complete-within-budget", traffic_purpose: "evaluation" });
    expect(f.inputs[0]).not.toContain("fixture-secret");
    expect(response).toMatchObject({ model: "gemma4", provider: "m5-private-configured-gateway", id: "m5-feedback:feedback-1", truncated: false, usage: { prompt_tokens: 17, completion_tokens: 3 }, gateway_metadata: good() });
    expect(response.usage).not.toHaveProperty("cost");
  });
  it("rejects a paid route, credentials, unapproved model and reordered roles before spawning", async () => {
    const f = fakeProcess(); const call = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 });
    await expect(call({ ...options(), apiKey: "synthetic-not-a-real-key" }, control())).rejects.toThrow(/credential/);
    await expect(call(options(), { ...control(), provider_kind: "paid_api" })).rejects.toThrow(/local/);
    await expect(call({ ...options(), model: "other" }, control())).rejects.toThrow(/model|profile/i);
    await expect(call({ ...options(), messages: [...options().messages].reverse() }, control())).rejects.toThrow(/system then user/); expect(f.spawn).not.toHaveBeenCalled();
  });
  it("never spawns for an already aborted signal", async () => {
    const f = fakeProcess(); const controller = new AbortController(); controller.abort();
    await expect(createM5Transport({ spawn: f.spawn })(options(), control(controller))).rejects.toThrow(/before dispatch/); expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(["stdout", "stderr"] as const)("retains a busy diagnostic from %s on an unknown checkpoint and blocks replay", async (stream) => {
    const f = fakeProcess(undefined, (child) => { child[stream].write(JSON.stringify({ error: { code: "tool_error", message: "The server is busy. Retry after 5s." } })); child.emit("close", 1); });
    const transport = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "m5-transport-test-")); dirs.push(dir);
    const checkpointDir = join(dir, "calls"); const fixture = qualityFixture();
    await expect(runPairedQuality({ ...fixture, checkpointDir, transport })).rejects.toThrow(/unknown/i);
    const checkpoint = JSON.parse(readFileSync(join(checkpointDir, "reader-000000-baseline.json"), "utf8")) as Record<string, unknown>;
    expect(checkpoint).toMatchObject({ status: "unknown", transport_diagnostic: { category: "busy", cli_code: "tool_error", retry_after_seconds: 5, exit_code: 1 } });
    expect(checkpoint).not.toHaveProperty("response"); expect(checkpoint).not.toHaveProperty("answer"); expect(checkpoint.transport_diagnostic).not.toHaveProperty("retryable");
    const report = await runPairedQuality({ ...fixture, checkpointDir, transport, stage: "inspect" });
    expect(report.summary.complete_pairs).toBe(0); expect(report.call_status_counts.unknown).toBe(1);
    await expect(runPairedQuality({ ...fixture, checkpointDir, transport })).rejects.toThrow(/unknown.*replay blocked/i); expect(f.spawn).toHaveBeenCalledOnce();
  });
  it.each([
    { error: { code: "authentication_error", message: "Authentication failed.", retryable: false }, expected: { category: "authentication", cli_code: "authentication_error", retryable: false } },
    { error: { code: "upstream_error", message: "Upstream error.", retryable: true, retry_after_seconds: 10 }, expected: { category: "upstream_error", cli_code: "upstream_error", retryable: true, retry_after_seconds: 10 } },
    { error: { code: "tool_error", message: "Rate limit exceeded. Retry after 30s.", retryable: true }, expected: { category: "rate_limited", cli_code: "tool_error", retryable: true, retry_after_seconds: 30 } },
    { error: { code: "timeout", message: "Request timed out." }, expected: { category: "timeout", cli_code: "timeout" } },
    { error: { code: "tool_error", message: "The server is busy. Retry after 99999999s.", retryable: "true", retry_after_seconds: 3601 }, expected: { category: "unknown", cli_code: "tool_error" } },
    { error: { code: "secret-fixture-token", message: "secret-fixture-token Authentication failed. The server is busy. Retry after 5s.", retryable: "false", retry_after_seconds: -1 }, expected: { category: "unknown" } },
  ])("keeps only allowlisted primitive failure fields: $expected.category", async ({ error, expected }) => {
    const f = fakeProcess(undefined, (child) => { child.stdout.write(JSON.stringify({ error, payload: "secret-fixture-token" })); child.emit("close", 1); });
    const failure: unknown = await createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 })(options(), control()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "TransportFailure", diagnostic: { ...expected, exit_code: 1 } });
    expect((failure as { diagnostic: unknown }).diagnostic).toEqual({ ...expected, exit_code: 1 });
    expect(JSON.stringify(failure)).not.toContain("secret-fixture-token"); expect(String(failure)).not.toContain("secret-fixture-token"); expect(f.spawn).toHaveBeenCalledOnce();
  });
  it.each(["not-json", JSON.stringify({ message: "secret-fixture-token" }), JSON.stringify({ error: { message: "secret-fixture-token".repeat(4000) } })])("keeps missing, malformed or oversized CLI diagnostics unknown", async (raw) => {
    const f = fakeProcess(undefined, (child) => { child.stdout.write(raw); child.emit("close", 1); });
    const failure: unknown = await createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 })(options(), control()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "TransportFailure", diagnostic: { category: "unknown", exit_code: 1 } });
    expect(JSON.stringify(failure)).not.toContain("secret-fixture-token"); expect(f.spawn).toHaveBeenCalledOnce();
  });
  it.each(["abort", "timeout", "nonzero", "spawn-error", "stdin-error", "bad-json", "large-stdout", "large-stderr"])("fails closed without retry after %s", async (kind) => {
    const controller = new AbortController();
    const f = fakeProcess(undefined, (child) => {
      if (kind === "nonzero") child.emit("close", 1);
      if (kind === "spawn-error") child.emit("error", new Error("synthetic private diagnostic"));
      if (kind === "stdin-error") child.stdin.emit("error", new Error("synthetic private diagnostic"));
      if (kind === "bad-json") { child.stdout.write("not-json"); child.emit("close", 0); }
      if (kind === "large-stdout") child.stdout.write("x".repeat(262145));
      if (kind === "large-stderr") child.stderr.write("x".repeat(65537));
    });
    const c = control(controller); if (kind === "timeout") c.timeout_ms = 5;
    const promise = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 })(options(), c);
    const assertion = expect(promise).rejects.toThrow(/unknown|bounded size/);
    const child = await dispatched(f); if (kind === "abort") controller.abort();
    await assertion; expect(f.spawn).toHaveBeenCalledOnce(); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("forces termination when a process ignores the abort signal", async () => {
    vi.useFakeTimers(); const f = fakeProcess(undefined, () => undefined); const controller = new AbortController();
    const promise = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 })(options(), control(controller));
    const rejected = expect(promise).rejects.toThrow(/aborted/); await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejected;
    expect(f.children[0].kill).toHaveBeenCalledWith("SIGTERM"); await vi.advanceTimersByTimeAsync(1000); expect(f.children[0].kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("paces starts independently of process response duration and cancels queued work", async () => {
    vi.useFakeTimers(); const f = fakeProcess(); const call = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 8000, now: () => Date.now() });
    const first = call(options(), control()); await vi.advanceTimersByTimeAsync(0); await first;
    const queuedController = new AbortController(); const second = call(options(), control(queuedController)); const rejected = expect(second).rejects.toThrow(/before dispatch/);
    await vi.advanceTimersByTimeAsync(7999); expect(f.spawn).toHaveBeenCalledOnce(); queuedController.abort(); await rejected; expect(f.spawn).toHaveBeenCalledOnce();
    const third = call(options(), control()); await vi.advanceTimersByTimeAsync(1); await third; expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it.each(["empty", "truncated", "unmetered", "error"])("returns known %s metadata and lets the runner persist invalid status", async (kind) => {
    const reply = good(); if (kind === "empty") reply.text = ""; if (kind === "truncated") { reply.truncated = true; reply.finish_reason = "length"; } if (kind === "unmetered") reply.metered = false;
    const raw = kind === "error" ? { ...reply, error: "known failure" } : reply;
    const f = fakeProcess(raw); const transport = createM5Transport({ spawn: f.spawn, minimumStartIntervalMs: 0 });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "m5-transport-test-")); dirs.push(dir);
    const { manifest, config } = qualityFixture();
    const checkpointDir = join(dir, "calls");
    await expect(runPairedQuality({ manifest, config, checkpointDir, transport })).rejects.toThrow(/invalid/);
    const report = await runPairedQuality({ manifest, config, checkpointDir, transport, stage: "inspect" });
    expect(report.call_status_counts.invalid).toBe(1); expect(report.summary.complete_pairs).toBe(0); expect(report.cost_usd).toBeNull(); expect(f.spawn).toHaveBeenCalledOnce();
    expect(report.calls[0].response).toHaveProperty("gateway_metadata", raw);
  });
});
