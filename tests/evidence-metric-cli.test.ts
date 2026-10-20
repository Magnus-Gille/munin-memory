import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDatabase, storeEmbedding, writeState } from "../src/db.js";
import * as embeddings from "../src/embeddings.js";
import * as runner from "../benchmark/runner.js";
import { evaluate, sha256, type EvidenceReport } from "../benchmark/evidence-metric/evaluate.js";
import { main } from "../benchmark/evidence-metric/run.js";
import { packEvidence, summarize } from "../benchmark/evidence-metric/metric.js";

let dir: string;
let snapshot: string;
let queries: string;
let vectors: string;
let output: string;
let gold: string;
const model = "fixture/frozen-model";
const identity = "fixture/frozen-model@immutable-test-revision/float32";
const asOf = "2026-10-01T12:00:00.000Z";
const vector = new Float32Array(384); vector[0] = 1;
const options = () => ({ snapshot, queries, vectors, asOf });
const args = (baseline?: string) => ["--snapshot", snapshot, "--queries", queries, "--vectors", vectors, "--as-of", asOf, "--output", output, ...(baseline ? ["--baseline", baseline] : [])];
function parsedReport(path = output): EvidenceReport { return JSON.parse(readFileSync(path, "utf8")) as EvidenceReport; }
function mutateDb(sql: string) {
  const db = initDatabase(snapshot);
  db.exec(sql);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.close();
}
function writeQuery(value: unknown) {
  writeFileSync(queries, JSON.stringify(value) + "\n");
  const v = JSON.parse(readFileSync(vectors, "utf8")) as Record<string, unknown>;
  v.query_set_sha256 = sha256(readFileSync(queries));
  writeFileSync(vectors, JSON.stringify(v));
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "munin-evidence-fixture-"));
  snapshot = join(dir, "snapshot.db"); queries = join(dir, "queries.jsonl"); vectors = join(dir, "vectors.json"); output = join(dir, "report.json");
  const db = initDatabase(snapshot);
  const result = writeState(db, "fixture/a", "gold", "The needle answer is cobalt.", []);
  if (!result.id) throw new Error("Fixture entry was not created");
  gold = result.id;
  db.prepare("UPDATE entries SET created_at = ?, updated_at = ?, valid_from = ?").run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  storeEmbedding(db, gold, Buffer.from(vector.buffer), model, identity);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.close();
  writeFileSync(queries, JSON.stringify({ id: "q1", query: "needle", source: "synthetic", expected_ids: [gold], scope_namespace: "fixture/a", search_mode: "hybrid" }) + "\n");
  writeFileSync(vectors, JSON.stringify({ schema_version: 1, query_set_sha256: sha256(readFileSync(queries)), model, identity, dimensions: 384, vectors: { q1: Array.from(vector) } }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("offline production retrieval and CLI contract", () => {
  it("retrieves read-only with exact frozen model/identity and never initializes/generates a model", async () => {
    const init = vi.spyOn(embeddings, "initEmbeddings");
    const generate = vi.spyOn(embeddings, "generateEmbedding");
    const production = vi.spyOn(runner, "runBenchmark");
    const before = sha256(readFileSync(snapshot));
    const { report, exitCode } = await evaluate(options());
    expect(exitCode).toBe(2);
    expect(report.quality_state).toBe("not_measured");
    expect(report.rows[0].packed_ids).toEqual([gold]);
    expect(report.summary.all_gold_rate).toBe(1);
    expect(production).toHaveBeenCalledWith(realpathSync(snapshot), expect.arrayContaining([expect.objectContaining({ scope_namespace: "fixture/a" })]), expect.objectContaining({ queryEmbeddingModel: model, queryEmbeddingIdentity: identity, runnerMode: "production_ranker", searchRecencyWeight: 0, queryEmbeddingProvider: expect.any(Function) }));
    expect(init).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(sha256(readFileSync(snapshot))).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(["queries.jsonl", "snapshot.db", "vectors.json"]);
    expect(report.lineage.source_revision).toMatch(/^[a-f0-9]{40}$/);
    expect(report.lineage.source_sha256["benchmark/runner.ts"]).toMatch(/^[a-f0-9]{64}$/);
  });
  it("writes a candidate with exit2 then compares a matching baseline with exit0", async () => {
    expect(await main(args())).toBe(2);
    expect(parsedReport().quality_state).toBe("not_measured");
    const baseline = join(dir, "baseline.json");
    const report = parsedReport();
    // Code lineage may differ: pinned inputs/config permit measuring quality changes.
    report.lineage.source_sha256["benchmark/runner.ts"] = "0".repeat(64);
    writeFileSync(baseline, JSON.stringify(report));
    expect(await main(args(baseline))).toBe(0);
    expect(parsedReport().quality_state).toBe("unchanged");
  });
  it("reports improvement and pairs multiple queries by ID regardless of row order", async () => {
    const first = JSON.parse(readFileSync(queries, "utf8")) as Record<string, unknown>;
    writeFileSync(queries, JSON.stringify(first) + "\n" + JSON.stringify({ ...first, id: "q2" }) + "\n");
    const v = JSON.parse(readFileSync(vectors, "utf8")) as Record<string, unknown>;
    v.query_set_sha256 = sha256(readFileSync(queries));
    v.vectors = { q1: Array.from(vector), q2: Array.from(vector) }; writeFileSync(vectors, JSON.stringify(v));
    const { report } = await evaluate(options());
    report.rows = [packEvidence("q2", [gold], []), report.rows[0]];
    report.summary = summarize(report.rows);
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    expect(await main(args(baseline))).toBe(0);
    expect(parsedReport().quality_state).toBe("improved");
    expect(parsedReport().comparison?.gained_question_ids).toEqual(["q2"]);
    expect(parsedReport().comparison?.lost_question_ids).toEqual([]);
  });
  it("reproduces a paired regression on a second identical evaluation and exits1", async () => {
    writeQuery({ id: "q1", query: "needle", source: "synthetic", expected_ids: [gold], scope_namespace: "fixture/other", search_mode: "hybrid" });
    const { report } = await evaluate(options());
    const db = new Database(snapshot, { readonly: true });
    const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(gold) as Parameters<typeof packEvidence>[2][0]; db.close();
    report.rows = [packEvidence("q1", [gold], [entry])]; report.summary = summarize(report.rows);
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    const production = vi.spyOn(runner, "runBenchmark");
    expect(await main(args(baseline))).toBe(1);
    expect(production).toHaveBeenCalledTimes(2);
    expect(parsedReport().comparison).toMatchObject({ regression: true, reproduced: true, queries: [{ lost_ids: [gold] }] });
  });
  it("returns invalid when a regression changes per query on the repeat", async () => {
    const { report } = await evaluate(options());
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    const real = runner.runBenchmark;
    let calls = 0;
    vi.spyOn(runner, "runBenchmark").mockImplementation(async (...params) => {
      const result = await real(...params);
      if (++calls === 1) result.queries[0].result_ids = [];
      return result;
    });
    expect(await main(args(baseline))).toBe(2);
    expect(calls).toBe(2);
    expect(parsedReport().quality_state).toBe("invalid");
  });
  it("rejects baseline bindings, malformed rows and missing IDs with exit2", async () => {
    const { report } = await evaluate(options());
    const baseline = join(dir, "baseline.json");
    writeFileSync(baseline, JSON.stringify({ ...report, bindings: { ...report.bindings, as_of: "2020-01-01T00:00:00Z" } }));
    expect(await main(args(baseline))).toBe(2);
    writeFileSync(baseline, JSON.stringify({ ...report, rows: [report.rows[0], report.rows[0]] }));
    expect(await main(args(baseline))).toBe(2);
    writeFileSync(baseline, JSON.stringify({ ...report, rows: [{ ...report.rows[0], query_id: "different" }] }));
    expect(await main(args(baseline))).toBe(2);
    expect(parsedReport().quality_state).toBe("invalid");
  });
  it("rejects legacy metadata, mismatched identity and unsupported schema", async () => {
    mutateDb("UPDATE entries SET embedding_identity = NULL");
    await expect(evaluate(options())).rejects.toThrow(/provenance/);
    mutateDb("UPDATE entries SET embedding_identity = 'different'");
    await expect(evaluate(options())).rejects.toThrow(/provenance/);
    mutateDb("ALTER TABLE entries RENAME COLUMN embedding_identity TO legacy_identity");
    await expect(evaluate(options())).rejects.toThrow(/schema/);
    writeQuery({ id: "q1", query: "needle", source: "synthetic", expected_ids: ["absent"], search_mode: "hybrid" });
    await expect(evaluate(options())).rejects.toThrow();
  });
  it("rejects missing gold entries independently of schema validation", async () => {
    writeQuery({ id: "q1", query: "needle", source: "synthetic", expected_ids: ["absent"], search_mode: "hybrid" });
    await expect(evaluate(options())).rejects.toThrow(/Gold entry missing/);
  });
  it("rejects a WAL-header snapshot before opening it or creating sidecars", async () => {
    const bytes = readFileSync(snapshot); bytes[18] = 2; bytes[19] = 2;
    writeFileSync(snapshot, bytes);
    const before = readdirSync(dir).sort();
    expect(await main(args())).toBe(2);
    expect(parsedReport().quality_state).toBe("invalid");
    expect(readdirSync(dir).filter((p) => p !== "report.json").sort()).toEqual(before);
    expect(readFileSync(snapshot).equals(bytes)).toBe(true);
  });
  it("rejects corpus vector dimensions that differ from frozen queries", async () => {
    const value = JSON.parse(readFileSync(vectors, "utf8")) as Record<string, unknown>;
    value.dimensions = 2; value.vectors = { q1: [1, 0] }; writeFileSync(vectors, JSON.stringify(value));
    await expect(evaluate(options())).rejects.toThrow(/dimensions/);
  });
  it("rejects effective mode downgrade and restores Date", async () => {
    const real = runner.runBenchmark;
    vi.spyOn(runner, "runBenchmark").mockImplementation(async (...params) => {
      const result = await real(...params); result.queries[0].actual_mode = "lexical"; return result;
    });
    const nativeDate = Date;
    await expect(evaluate(options())).rejects.toThrow(/degraded/);
    expect(Date).toBe(nativeDate);
  });
  it("detects raw input mutation during evaluation", async () => {
    const real = runner.runBenchmark;
    vi.spyOn(runner, "runBenchmark").mockImplementation(async (...params) => {
      const result = await real(...params); writeFileSync(queries, readFileSync(queries, "utf8") + "\n"); return result;
    });
    await expect(evaluate(options())).rejects.toThrow(/input changed/);
  });
  it("refuses report collisions including symlinks, hardlinks and the baseline", async () => {
    const originals = [snapshot, queries, vectors].map((p) => readFileSync(p));
    for (const input of [snapshot, queries, vectors]) {
      output = input; expect(await main(args())).toBe(2);
    }
    output = join(dir, "alias.json"); symlinkSync(queries, output);
    expect(await main(args())).toBe(2);
    rmSync(output); linkSync(snapshot, output);
    expect(await main(args())).toBe(2);
    [snapshot, queries, vectors].forEach((p, i) => expect(readFileSync(p).equals(originals[i])).toBe(true));
    rmSync(output); output = join(dir, "report.json"); expect(await main(args())).toBe(2);
    expect(await main(args(output))).toBe(2);
    expect(parsedReport().quality_state).toBe("not_measured");
  });
  it("rejects WAL state, missing args and unwritable output with exit2", async () => {
    writeFileSync(snapshot + "-wal", "uncheckpointed fixture");
    expect(await main(args())).toBe(2);
    expect(await main([])).toBe(2);
    rmSync(snapshot + "-wal"); output = join(dir, "missing-parent", "report.json");
    expect(await main(args())).toBe(2);
  });
});


describe("paired packing comparison CLI", () => {
  it("requires the explicit supported strategy and baseline before evaluating", async () => {
    const production = vi.spyOn(runner, "runBenchmark");
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main([...args(), "--packing-comparison", "skip-oversized"])).toBe(2);
    expect(error.mock.calls.flat().join(" ")).toContain("requires --baseline");
    expect(await main([...args(), "--packing-comparison", "invented"])).toBe(2);
    expect(production).not.toHaveBeenCalled();
  });
  it("requires every frozen control row and keeps candidate findings separate from exit policy", async () => {
    const { report } = await evaluate(options());
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    const before = sha256(readFileSync(baseline));
    const production = vi.spyOn(runner, "runBenchmark");
    expect(await main([...args(baseline), "--packing-comparison", "skip-oversized"])).toBe(0);
    expect(production).toHaveBeenCalledTimes(1);
    const result = parsedReport();
    expect(result.rows).toEqual(report.rows);
    expect(result.quality_state).toBe("unchanged");
    expect(result.packing_comparison).toMatchObject({ strategy: "skip-oversized", control_reproduced: true, gained_question_ids: [], lost_question_ids: [], stages: { retrieval: { all_gold: 1 }, legacy_packed: { all_gold: 1 }, candidate_packed: { all_gold: 1 } } });
    expect(result.packing_comparison?.queries[0].candidate_packed_ids).toEqual([gold]);
    expect(sha256(readFileSync(baseline))).toBe(before);
    const altered = { ...report, rows: [packEvidence("q1", [gold], [])] }; altered.summary = summarize(altered.rows);
    writeFileSync(baseline, JSON.stringify(altered));
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main([...args(baseline), "--packing-comparison", "skip-oversized"])).toBe(2);
    expect(error.mock.calls.flat().join(" ")).toContain("control rows do not reproduce");
    expect(parsedReport().quality_state).toBe("invalid");
  });
  it("rejects control budget drift even when aggregate coverage and IDs are identical", async () => {
    const { report } = await evaluate(options());
    report.rows[0].budget.estimated_tokens++;
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main([...args(baseline), "--packing-comparison", "skip-oversized"])).toBe(2);
    expect(error.mock.calls.flat().join(" ")).toContain("control rows do not reproduce");
    expect(parsedReport().quality_state).toBe("invalid");
  });
  it("records candidate gold losses without changing primary baseline status or exit0", async () => {
    mutateDb("UPDATE entries SET content = 'needle ' || printf('%.*c', 40000, 'x')");
    const { report } = await evaluate(options());
    expect(report.rows[0].all_gold).toBe(true);
    expect(report.rows[0].budget).toMatchObject({ estimated_tokens: 8192, truncated: true });
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    expect(await main([...args(baseline), "--packing-comparison", "skip-oversized"])).toBe(0);
    expect(parsedReport()).toMatchObject({ quality_state: "unchanged", comparison: { regression: false }, packing_comparison: { regression: true, gained_question_ids: [], lost_question_ids: ["q1"], stages: { retrieval: { all_gold: 1 }, legacy_packed: { all_gold: 1 }, candidate_packed: { no_gold: 1 } } } });
    expect(parsedReport().packing_comparison?.queries[0]).toMatchObject({ lost_ids: [gold], candidate_packed_ids: [], candidate_budget: { estimated_tokens: 0, included_entry_count: 0, dropped_entry_count: 1 } });
  });
  it("protects the baseline path with packing comparison enabled", async () => {
    const { report } = await evaluate(options());
    const baseline = join(dir, "baseline.json"); writeFileSync(baseline, JSON.stringify(report));
    const bytes = readFileSync(baseline); output = baseline;
    expect(await main([...args(baseline), "--packing-comparison", "skip-oversized"])).toBe(2);
    expect(readFileSync(baseline).equals(bytes)).toBe(true);
  });
});
