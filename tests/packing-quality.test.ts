import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealManifest, validateManifest, packPair, prepareQualityManifest } from "../benchmark/packing-quality/prepare.js";
import { runPairedQuality } from "../benchmark/packing-quality/run.js";
import { summarizePairs } from "../benchmark/packing-quality/summary.js";
import type { QualityManifest, RunConfig, Transport } from "../benchmark/packing-quality/types.js";
import { TransportFailure } from "../benchmark/packing-quality/types.js";
import type { Entry } from "../src/types.js";
import { canonical } from "../benchmark/evidence-metric/metric.js";
import { hashFile, sha256 } from "../benchmark/evidence-metric/evaluate.js";
import { initDatabase, storeEmbedding, writeState } from "../src/db.js";
import * as embeddings from "../src/embeddings.js";
import * as benchmarkRunner from "../benchmark/runner.js";
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "packing-quality-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
const budget = { max_estimated_tokens: 8192, estimated_tokens: 1, estimator: "utf8_bytes_div4_ceil_v1" as const, truncated: false, candidate_entry_count: 1, included_entry_count: 1, dropped_entry_count: 0 };
const context = (text = "fact") => ({ text, sha256: sha256(text), ordered_ids: ["e"], budget: { ...budget, estimated_tokens: Math.ceil(Buffer.byteLength(text) / 4) } });
const manifest = (): QualityManifest => sealManifest({ schema_version: 1, report_kind: "packing_quality_manifest", evidence_scope: "development_set_not_held_out", as_of: "2026-10-01T00:00:00.000Z", identity: "fixture", rule: "query-message-cores-v1", retrieval: { runner_mode: "production_ranker", search_mode: "hybrid", top_k: 10, search_recency_weight: 0, context_token_budget: 8192 }, inputs: {}, source_revision: "a".repeat(40), source_sha256: {}, queries: ["q1", "q2"].map((query_id) => ({ query_id, question: "what?", category: "temporal", reference_answer: "fact", retrieved_ids: ["e"], baseline: context(), core: context("core fact") })) });
const config = (): RunConfig => ({ schema_version: 1, reader: { model: "fixture-reader", identity: "r1", provider_kind: "local_self_hosted", max_output_tokens: 50, temperature: 0 }, judge: { model: "fixture-judge", identity: "j1", provider_kind: "local_self_hosted", max_output_tokens: 50, temperature: 0 }, timeout_ms: 1000, cost: { mode: "local", api_charge_assumption: "self_hosted_no_paid_api" } });
const transport: Transport = async (opts) => ({ model: opts.model, provider: "fixture", choices: [{ message: { content: opts.model.includes("judge") ? '{"correct":true,"score":1,"reasoning":"ok"}' : "fact" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
describe("frozen paired packing", () => {
  it("gives both packers the same immutable ranked entries", () => {
    const content = "Session ID: x\nConversation:\nuser: fact needle";
    const e = { id: "e", namespace: "fixture", key: "e", content, updated_at: "2026-01-01" } as Entry;
    const start = content.indexOf("user: ");
    const pair = packPair("needle", [e], new Map([["e", { entry_id: "e", content_sha256: sha256(content), prefix_end: start, messages: [[start, start + 6, content.length]] }]]));
    expect(pair.baseline.ordered_ids).toEqual(["e"]); expect(pair.core.ordered_ids).toEqual(["e"]);
    expect(pair.baseline.text).toContain(content); expect(pair.core.text).toContain("fact needle"); expect(e.content).toBe(content);
  });
  it("rejects hash tampering", () => { const m = manifest(); m.queries[0].core.text += "tamper"; expect(() => validateManifest(m)).toThrow(/hash|digest/i); });
});
describe("durable runner", () => {
  it("stages readers then judges, alternates question order and resumes without duplicate dispatch", async () => {
    const dir = join(scratch(), "calls"); const seen: string[] = [];
    const call: Transport = async (opts, control) => { seen.push(`${control.stage}:${control.query_id}:${control.variant}`); return transport(opts, control); };
    await runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call, stage: "readers" });
    expect(seen).toEqual(["reader:q1:baseline", "reader:q1:core", "reader:q2:core", "reader:q2:baseline"]);
    const result = await runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call, stage: "judges" });
    expect(result.summary.complete_pairs).toBe(2); expect(result.cost_usd).toBeNull();
    await runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call }); expect(seen).toHaveLength(8);
  });
  it("writes pending before dispatch and blocks replay after unknown failure", async () => {
    const dir = join(scratch(), "calls"); let calls = 0;
    const call: Transport = async (_opts, control) => { calls++; expect(JSON.parse(readFileSync(join(dir, `${control.call_id}.json`), "utf8"))).toMatchObject({ status: "pending" }); throw new Error("unknown network outcome"); };
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call })).rejects.toThrow(/unknown/i);
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call })).rejects.toThrow(/unknown|pending/i); expect(calls).toBe(1);
  });
  it("persists only validated primitive diagnostics from a typed transport failure", async () => {
    const dir = join(scratch(), "calls");
    const call = vi.fn<Transport>(async () => { throw new TransportFailure({ category: "secret-fixture-token", cli_code: "secret-fixture-token", retryable: "true", retry_after_seconds: 3601, exit_code: "1", message: "secret-fixture-token", payload: { token: "secret-fixture-token" } }); });
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call })).rejects.toThrow(/unknown/i);
    const raw = readFileSync(join(dir, "reader-000000-baseline.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ status: "unknown", transport_diagnostic: { category: "unknown" } });
    expect((JSON.parse(raw) as { transport_diagnostic: unknown }).transport_diagnostic).toEqual({ category: "unknown" }); expect(raw).not.toContain("secret-fixture-token");
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call })).rejects.toThrow(/replay blocked/i); expect(call).toHaveBeenCalledOnce();
  });
  it("rejects config mismatch, symlink directories and tampered checkpoints", async () => {
    const base = scratch(); const dir = join(base, "calls"); await runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport, stage: "readers" });
    const changed = config(); changed.reader.model = "changed";
    await expect(runPairedQuality({ manifest: manifest(), config: changed, checkpointDir: dir, transport })).rejects.toThrow(/binding|config/i);
    symlinkSync(dir, join(base, "alias")); await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: join(base, "alias"), transport })).rejects.toThrow(/symlink/i);
    writeFileSync(join(dir, "reader-000000-baseline.json"), "{}"); await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport })).rejects.toThrow(/checkpoint/i);
  });
  it("reserves paid cost before dispatch and requires actual charge receipts", async () => {
    const paid = config(); paid.reader.provider_kind = paid.judge.provider_kind = "paid_api"; paid.reader.pricing = paid.judge.pricing = { input_usd_per_million: 10, output_usd_per_million: 10, source: "pinned" }; paid.cost = { mode: "paid", max_total_usd: 0.000001 };
    const call = vi.fn(transport); await expect(runPairedQuality({ manifest: manifest(), config: paid, checkpointDir: join(scratch(), "tiny"), transport: call })).rejects.toThrow(/cap/i); expect(call).not.toHaveBeenCalled();
    paid.cost.max_total_usd = 25; await expect(runPairedQuality({ manifest: manifest(), config: paid, checkpointDir: join(scratch(), "missing-cost"), transport })).rejects.toThrow(/cost|charge/i);
  });
  it.each(["empty", "length", "missing-usage", "malformed"])("excludes %s output from success", async (kind) => {
    const call: Transport = async (opts, control) => { const r = await transport(opts, control); if (kind === "empty") r.choices[0].message.content = ""; if (kind === "length") r.choices[0].finish_reason = "length"; if (kind === "missing-usage") delete r.usage; if (kind === "malformed" && control.stage === "judge") r.choices[0].message.content = "bad-json"; return r; };
    const dir = join(scratch(), "calls"); const tracked = vi.fn(call);
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: tracked })).rejects.toThrow(/invalid|malformed/i);
    const count = tracked.mock.calls.length;
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: tracked })).rejects.toThrow(/invalid|malformed/i);
    expect(tracked).toHaveBeenCalledTimes(count);
    const result = await runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: tracked, stage: "inspect" });
    expect(tracked).toHaveBeenCalledTimes(count); expect(result.summary.complete_pairs).toBe(0); expect(result.summary.incomplete_pairs).toBe(2); expect(result.summary.accuracy_delta).toBeNull();
  });
});
it("sorts query IDs before counterbalancing and rejects local model fallback", async () => {
  const m = manifest(); const reordered = sealManifest({ ...m, queries: [...m.queries].reverse() });
  expect(reordered.queries.map((q) => q.query_id)).toEqual(["q1", "q2"]);
  const call: Transport = async (opts, control) => ({ ...await transport(opts, control), model: "silent-fallback" });
  await expect(runPairedQuality({ manifest: m, config: config(), checkpointDir: join(scratch(), "fallback"), transport: call })).rejects.toThrow(/invalid/i);
});
it("reports paired gains, losses, abstention and seeded bootstrap", () => {
  const rows = [{ query_id: "g", category: "a", baseline: { correct: false, abstained: true }, core: { correct: true, abstained: false } }, { query_id: "l", category: "b", baseline: { correct: true, abstained: false }, core: { correct: false, abstained: true } }, { query_id: "x", category: "a", baseline: null, core: { correct: true, abstained: false } }];
  const s = summarizePairs(rows); expect(s.gained_question_ids).toEqual(["g"]); expect(s.lost_question_ids).toEqual(["l"]); expect(s.complete_pairs).toBe(2); expect(s.incomplete_pairs).toBe(1); expect(s.accuracy_delta).toBe(0); expect(s.bootstrap).toMatchObject({ seed: 227, resamples: 2000, confidence: 0.95 }); expect(summarizePairs(rows)).toEqual(s);
});

describe("actual frozen snapshot preparation", () => {
  it("reuses production retrieval, validates lineage and leaves every source byte unchanged", async () => {
    const dir = scratch(); const snapshot = join(dir, "snapshot.db"); const queries = join(dir, "queries.jsonl"); const vectors = join(dir, "vectors.json"); const sourceManifest = join(dir, "source-manifest.json"); const messageBoundaries = join(dir, "message-boundaries.json"); const output = join(dir, "prepared.json");
    const model = "fixture/model"; const identity = "fixture/identity"; const vector = new Float32Array(384); vector[0] = 1;
    const content = "Session ID: fixture\nConversation:\nuser: The needle is cobalt."; const start = content.indexOf("user: ");
    const db = initDatabase(snapshot); const result = writeState(db, "fixture/a", "answer", content, []);
    if (!result.id) throw new Error("Fixture ID missing");
    const id = result.id;
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ?, valid_from = ?").run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    storeEmbedding(db, id, Buffer.from(vector.buffer), model, identity); db.pragma("wal_checkpoint(TRUNCATE)"); db.pragma("journal_mode = DELETE"); db.close();
    writeFileSync(queries, JSON.stringify({ id: "q1", query: "needle", source: "synthetic", expected_ids: [id], reference_answer: "cobalt", category: "fixture", scope_namespace: "fixture/a", search_mode: "hybrid" }) + "\n");
    writeFileSync(vectors, JSON.stringify({ schema_version: 1, query_set_sha256: hashFile(queries), model, identity, dimensions: 384, vectors: { q1: Array.from(vector) } }));
    writeFileSync(sourceManifest, JSON.stringify({ schema_version: 1, status: "prepared", as_of: "2026-10-01T00:00:00.000Z", input: { sha256: "d".repeat(64) }, embedding: { model, identity, dimensions: 384 } }));
    writeFileSync(messageBoundaries, JSON.stringify({ schema_version: 1, coordinate_system: "utf16_code_units", source: { dataset_sha256: "d".repeat(64), snapshot_sha256: hashFile(snapshot) }, entries: [{ entry_id: id, content_sha256: sha256(content), prefix_end: start, messages: [[start, start + 6, content.length]] }] }));
    const paths = { snapshot, queries, vectors, sourceManifest, messageBoundaries };
    const expected = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, hashFile(path)])) as Record<keyof typeof paths, string>;
    const generate = vi.spyOn(embeddings, "generateEmbedding"); const initialize = vi.spyOn(embeddings, "initEmbeddings"); const retrieve = vi.spyOn(benchmarkRunner, "runBenchmark");
    const prepared = await prepareQualityManifest({ ...paths, expected, asOf: "2026-10-01T00:00:00.000Z", identity: "fixture/frozen", output });
    expect(prepared.queries[0].retrieved_ids).toEqual([id]); expect(prepared.queries[0].baseline.ordered_ids).toEqual([id]); expect(prepared.queries[0].core.ordered_ids).toEqual([id]);
    expect(retrieve).toHaveBeenCalledOnce(); expect(generate).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
    expect(Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, hashFile(path)]))).toEqual(expected);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(prepared);
    expect(prepared.queries[0]).not.toHaveProperty("expected_ids");
    await expect(prepareQualityManifest({ ...paths, expected: { ...expected, queries: "0".repeat(64) }, asOf: prepared.as_of, identity: "fixture", output: join(dir, "bad.json") })).rejects.toThrow(/hash mismatch/);
    const reproduction = join(dir, "reproduction.json"); writeFileSync(reproduction, "not a parsed reproduction report");
    await expect(prepareQualityManifest({ ...paths, expected, asOf: prepared.as_of, identity: "fixture", reproduction: { path: reproduction, sha256: "0".repeat(64) }, output: join(dir, "bad-reproduction.json") })).rejects.toThrow(/Reproduction report hash mismatch/);
    expect(Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, hashFile(path)]))).toEqual(expected);
    writeFileSync(sourceManifest, "tampered");
    await expect(runPairedQuality({ manifest: prepared, config: config(), checkpointDir: join(dir, "calls"), transport })).rejects.toThrow(/input hash mismatch/);
  });
});

describe("dispatch and recovery boundaries", () => {
  it("retains an unresolved pending checkpoint without duplicate dispatch", async () => {
    const dir = join(scratch(), "calls"); const call = vi.fn<Transport>(async () => { throw new Error("unknown"); });
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call })).rejects.toThrow(/unknown/i);
    const path = join(dir, "reader-000000-baseline.json");
    const prior = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; const { checkpoint_sha256: _old, ...body } = prior; void _old;
    body.status = "pending"; writeFileSync(path, JSON.stringify({ ...body, checkpoint_sha256: sha256(canonical(body)) }));
    await expect(runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call })).rejects.toThrow(/pending/i); expect(call).toHaveBeenCalledOnce();
    const report = await runPairedQuality({ manifest: manifest(), config: config(), checkpointDir: dir, transport: call, stage: "inspect" });
    expect(report.call_status_counts.pending).toBe(1); expect(report.summary.complete_pairs).toBe(0); expect(call).toHaveBeenCalledOnce();
  });
  it("exposes bounded cancellation and never retries timed-out dispatch", async () => {
    const dir = join(scratch(), "calls"); const c = config(); c.timeout_ms = 5; let aborted = false;
    const call = vi.fn<Transport>(async (_opts, control) => {
      expect(control.timeout_ms).toBe(5);
      return await new Promise((_resolve, reject) => control.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
    });
    await expect(runPairedQuality({ manifest: manifest(), config: c, checkpointDir: dir, transport: call })).rejects.toThrow(/unknown/i);
    expect(aborted).toBe(true);
    await expect(runPairedQuality({ manifest: manifest(), config: c, checkpointDir: dir, transport: call })).rejects.toThrow(/unknown/i); expect(call).toHaveBeenCalledOnce();
  });
  it("reconciles actual paid charges before reserving the next call", async () => {
    const dir = join(scratch(), "calls"); const c = config(); c.reader.provider_kind = c.judge.provider_kind = "paid_api";
    c.reader.pricing = c.judge.pricing = { input_usd_per_million: 10, output_usd_per_million: 10, source: "pinned" }; c.cost = { mode: "paid", max_total_usd: 0.07 };
    const call = vi.fn<Transport>(async (opts, control) => { const response = await transport(opts, control); response.usage!.cost = 0.01; return response; });
    await expect(runPairedQuality({ manifest: manifest(), config: c, checkpointDir: dir, transport: call })).rejects.toThrow(/cap/i);
    const count = call.mock.calls.length; expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(8);
    const report = await runPairedQuality({ manifest: manifest(), config: c, checkpointDir: dir, transport: call, stage: "inspect" });
    expect(report.cost_usd).toBeCloseTo(count * 0.01); expect(report.calls.every((r) => r.cost_basis === "provider_receipt")).toBe(true);
    await expect(runPairedQuality({ manifest: manifest(), config: c, checkpointDir: dir, transport: call })).rejects.toThrow(/cap/i); expect(call).toHaveBeenCalledTimes(count);
  });
  it("rejects invalid paid caps and local/paid profile mixing before dispatch", async () => {
    const call = vi.fn(transport);
    for (const cap of [0, -1, Number.NaN, 26]) {
      const c = config(); c.cost = { mode: "paid", max_total_usd: cap };
      await expect(runPairedQuality({ manifest: manifest(), config: c, checkpointDir: join(scratch(), "calls"), transport: call })).rejects.toThrow(/cap/i);
    }
    const c = config(); c.reader.provider_kind = "paid_api";
    await expect(runPairedQuality({ manifest: manifest(), config: c, checkpointDir: join(scratch(), "calls"), transport: call })).rejects.toThrow(/provider/i); expect(call).not.toHaveBeenCalled();
  });
});
