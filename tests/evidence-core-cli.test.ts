import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, storeEmbedding, writeState } from "../src/db.js";
import { evaluate, sha256, type EvidenceReport } from "../benchmark/evidence-metric/evaluate.js";
import { main } from "../benchmark/evidence-metric/run.js";
import * as runner from "../benchmark/runner.js";

let dir: string, snapshot: string, queries: string, vectors: string, output: string, labels: string, boundaries: string;
const asOf = "2026-10-01T12:00:00.000Z";
const model = "fixture/frozen-model", identity = "fixture/frozen-model@immutable-test-revision/float32";
const options = () => ({ snapshot, queries, vectors, asOf });
const args = (baseline?: string) => ["--snapshot", snapshot, "--queries", queries, "--vectors", vectors, "--as-of", asOf, "--output", output, ...(baseline ? ["--baseline", baseline] : [])];
const comparisons = () => ["--passage-comparison", "query-passages-v1", "--gold-turns", labels, "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "munin-core-fixture-"));
  snapshot = join(dir, "snapshot.db"); queries = join(dir, "queries.jsonl"); vectors = join(dir, "vectors.json"); output = join(dir, "report.json"); labels = join(dir, "labels.json"); boundaries = join(dir, "boundaries.json");
  const prefix = "Session ID: fixture\nConversation:\n", content = prefix + "user: needle 😀";
  const db = initDatabase(snapshot), result = writeState(db, "fixture/a", "gold", content, []);
  if (!result.id) throw new Error("Missing fixture ID");
  const id = result.id, vector = new Float32Array(384); vector[0] = 1;
  db.prepare("UPDATE entries SET created_at = ?, updated_at = ?, valid_from = ?").run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  storeEmbedding(db, id, Buffer.from(vector.buffer), model, identity);
  db.pragma("wal_checkpoint(TRUNCATE)"); db.pragma("journal_mode = DELETE"); db.close();
  writeFileSync(queries, JSON.stringify({ id: "q1", query: "needle", source: "synthetic", expected_ids: [id], scope_namespace: "fixture/a", search_mode: "hybrid" }) + "\n");
  writeFileSync(vectors, JSON.stringify({ schema_version: 1, query_set_sha256: sha256(readFileSync(queries)), model, identity, dimensions: 384, vectors: { q1: Array.from(vector) } }));
  const source = { dataset_sha256: "d".repeat(64), snapshot_sha256: sha256(readFileSync(snapshot)) };
  writeFileSync(labels, JSON.stringify({ schema_version: 1, coordinate_system: "utf16_code_units", source: { ...source, queries_sha256: sha256(readFileSync(queries)) }, queries: [{ query_id: "q1", entries: [{ entry_id: id, content_sha256: sha256(content), turns: [{ message_index: 0, start: prefix.length + 6, end: content.length }] }] }] }));
  writeFileSync(boundaries, JSON.stringify({ schema_version: 1, coordinate_system: "utf16_code_units", source, entries: [{ entry_id: id, content_sha256: sha256(content), prefix_end: prefix.length, messages: [[prefix.length, prefix.length + 6, content.length]] }] }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("uses one retrieval for all frozen pairs, records exact core lineage, and preserves baseline output and gate", async () => {
  const baseline = join(dir, "baseline.json"), initial = await evaluate(options());
  expect(initial.report.core_comparison).toBeUndefined();
  writeFileSync(baseline, JSON.stringify(initial.report));
  const production = vi.spyOn(runner, "runBenchmark");
  expect(await main([...args(baseline), ...comparisons(), "--core-comparison", "query-message-cores-v1"])).toBe(0);
  expect(production).toHaveBeenCalledTimes(1);
  const report = JSON.parse(readFileSync(output, "utf8")) as EvidenceReport;
  expect(report.rows).toEqual(initial.report.rows);
  expect(report.quality_state).toBe("unchanged");
  const core = report.core_comparison!;
  expect(core).toMatchObject({ strategy: "query-message-cores-v1", control_reproduced: true, coordinate_system: "utf16_code_units", versus_legacy: { reference_strategy: "legacy" }, versus_passages: { reference_strategy: "query-passages-v1" }, versus_neighbors: { reference_strategy: "query-message-neighbors-v1" }, whole_message_conservation: { selected_message_count: 1, partial_message_count: 0 } });
  expect(core.metric_limitation).toMatch(/accuracy|span/);
  expect(core.lineage).toEqual({
    message_boundaries_sha256: sha256(readFileSync(boundaries)),
    message_boundaries_source_sha256: sha256(readFileSync(new URL("../benchmark/evidence-metric/message-boundaries.ts", import.meta.url))),
    message_packing_source_sha256: sha256(readFileSync(new URL("../benchmark/answer-quality/message-packing.ts", import.meta.url))),
    message_comparison_source_sha256: sha256(readFileSync(new URL("../benchmark/evidence-metric/message-comparison.ts", import.meta.url))),
    core_packing_source_sha256: sha256(readFileSync(new URL("../benchmark/answer-quality/core-packing.ts", import.meta.url))),
    core_comparison_source_sha256: sha256(readFileSync(new URL("../benchmark/evidence-metric/core-comparison.ts", import.meta.url))),
    source: { dataset_sha256: "d".repeat(64), snapshot_sha256: sha256(readFileSync(snapshot)) },
  });
  expect(report.message_comparison).toBeDefined();
});

it("requires the complete frozen control option set and rejects malformed core flags before retrieval", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const production = vi.spyOn(runner, "runBenchmark");
  await expect(evaluate({ ...options(), coreComparison: "query-message-cores-v1" })).rejects.toThrow(/Core comparison requires/);
  await expect(evaluate({ ...options(), coreComparison: "invented" as never })).rejects.toThrow(/Unsupported core/);
  for (const extra of [
    ["--core-comparison", "query-message-cores-v1"],
    ["--core-comparison", "invented"],
    ["--core-comparison", "query-message-cores-v1", "--core-comparison", "query-message-cores-v1"],
    ["--core-comparison"],
  ]) expect(await main([...args(), ...extra])).toBe(2);
  const baseline = join(dir, "baseline.json");
  writeFileSync(baseline, "{}");
  for (const absent of ["--baseline", "--passage-comparison", "--gold-turns", "--message-comparison", "--message-boundaries"]) {
    const full = [...args(baseline), ...comparisons(), "--core-comparison", "query-message-cores-v1"];
    const index = full.indexOf(absent); full.splice(index, 2);
    expect(await main(full)).toBe(2);
  }
  expect(stderr).toHaveBeenCalled();
  expect(production).not.toHaveBeenCalled();
});
