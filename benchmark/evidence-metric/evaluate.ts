/** Offline, model-free packed-entry-ID evaluation. This module never populates a DB. */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "../runner.js";
import type { BenchmarkQuery } from "../types.js";
import type { Entry } from "../../src/types.js";
import { getSemanticMaxDistance } from "../../src/embeddings.js";
import { normalizeAsOf, withFrozenClock } from "./clock.js";
import { CONFIG, canonical, assertControlReproduced, comparePackingRows, compareRows, object, packEvidence, summarize, validateQueries, validateRows, validateVectors, type EvidenceRow, type FrozenVectors } from "./metric.js";

export interface EvaluationOptions {
  snapshot: string;
  queries: string;
  vectors: string;
  asOf: string;
  baseline?: string;
  packingComparison?: "skip-oversized";
}
export interface Bindings {
  snapshot_sha256: string;
  queries_sha256: string;
  vectors_sha256: string;
  as_of: string;
  config: typeof CONFIG & { semantic_max_distance: number | null };
  embedding: { model: string; identity: string; dimensions: number };
}
export interface EvidenceReport {
  schema_version: 1;
  bindings: Bindings;
  lineage: { source_revision: string; source_sha256: Record<string, string>; baseline_sha256?: string };
  metric_limitation: string;
  quality_state: "not_measured" | "unchanged" | "improved" | "regressed";
  summary: ReturnType<typeof summarize>;
  rows: EvidenceRow[];
  packing_comparison?: ReturnType<typeof comparePackingRows> & { strategy: "skip-oversized"; control_reproduced: true };
  comparison?: ReturnType<typeof compareRows> & { baseline_all_gold_rate: number; current_all_gold_rate: number; reproduced?: boolean };
}
export const LIMITATION = "Entry-ID presence in packed context is a proxy, not full content/span coverage. A truncated first block still counts as present; budget.truncated exposes this limitation.";
export function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Bound memory use even for multi-hundred-MB snapshots. */
export function hashFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let length: number;
    while ((length = readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, length));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_FILES = [
  "benchmark/evidence-metric/clock.ts", "benchmark/evidence-metric/metric.ts", "benchmark/evidence-metric/evaluate.ts", "benchmark/evidence-metric/run.ts",
  "benchmark/runner.ts", "benchmark/scorer.ts", "benchmark/types.ts", "benchmark/answer-quality/serialize.ts",
  "src/db.ts", "src/migrations.ts", "src/embeddings.ts", "src/internal/reranker.ts", "src/internal/retrieval-shared.ts",
  "src/internal/hybrid-fusion.ts", "src/internal/query-probe.ts", "src/internal/namespace-filter.ts",
];
function lineage() {
  const source_revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(source_revision)) throw new Error("Missing source revision provenance");
  return { source_revision, source_sha256: Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(readFileSync(join(ROOT, file)))])) };
}
/** A detached snapshot must not require replay or creation of SQLite sidecars. */
function checkSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${path}${suffix}`)) throw new Error(`Snapshot must have no WAL/SHM/journal sidecars (${suffix})`);
  }
}
function openSnapshot(path: string): Database.Database {
  checkSidecars(path);
  // Inspect the header before SQLite touches the file: opening WAL-mode files can
  // create sidecars even when the connection itself is readonly.
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("Invalid SQLite snapshot header");
    if (header[18] !== 1 || header[19] !== 1) throw new Error("Snapshot must use DELETE journal mode; prepare a detached offline copy first");
  } finally { closeSync(fd); }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    // A WAL-mode header can create sidecars even on a readonly connection.
    if (db.pragma("journal_mode", { simple: true }) === "wal") throw new Error("Snapshot must use DELETE journal mode; prepare a detached offline copy first");
    db.pragma("query_only = ON");
    sqliteVec.load(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function validateSnapshot(db: Database.Database, queries: BenchmarkQuery[], vectors: FrozenVectors): void {
  const columns = new Set((db.prepare("PRAGMA table_info(entries)").all() as { name: string }[]).map((c) => c.name));
  for (const col of ["embedding_model", "embedding_identity", "embedding_status"]) {
    if (!columns.has(col)) throw new Error(`Snapshot lacks required embedding schema: ${col}`);
  }
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'entries_vec'").get()) throw new Error("Snapshot lacks vector support");
  const rows = db.prepare(`WITH vector_rows AS MATERIALIZED (SELECT entry_id, vec_length(embedding) AS dimensions FROM entries_vec)
    SELECT e.id, e.namespace, e.is_current, e.embedding_status, e.embedding_model, e.embedding_identity,
    v.entry_id AS vector_id, v.dimensions FROM entries e
    LEFT JOIN vector_rows v ON e.id = v.entry_id`).all() as {
      id: string; namespace: string; is_current: number; embedding_status: string; embedding_model: string | null;
      embedding_identity: string | null; vector_id: string | null; dimensions: number | null;
    }[];
  const gold = new Set(queries.flatMap((q) => q.expected_ids ?? []));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of gold) {
    const row = byId.get(id);
    if (!row) throw new Error(`Gold entry missing from snapshot: ${id}`);
    if (row.vector_id === null || row.embedding_status !== "generated") throw new Error(`Gold entry lacks a generated vector: ${id}`);
  }
  const scopes = queries.map((q) => q.scope_namespace);
  for (const row of rows) {
    // Production namespace filtering includes descendants for a plain namespace.
    const inScope = scopes.some((scope) => scope === undefined || (scope.endsWith("/") ? row.namespace.startsWith(scope) : row.namespace === scope || row.namespace.startsWith(`${scope}/`)));
    if (!gold.has(row.id) && !(inScope && row.is_current === 1 && row.vector_id !== null)) continue;
    if (row.embedding_model !== vectors.model || row.embedding_identity !== vectors.identity || row.dimensions !== vectors.dimensions) {
      throw new Error(`Missing or mixed corpus embedding provenance/dimensions: ${row.id}`);
    }
  }
}
function validateBaseline(value: unknown, bindings: Bindings): EvidenceReport {
  const report = object(value);
  if (report.schema_version !== 1 || canonical(report.bindings) !== canonical(bindings)) throw new Error("Baseline schema/bindings mismatch");
  const priorSource = object(report.lineage);
  const hashes = object(priorSource.source_sha256);
  if (typeof priorSource.source_revision !== "string" || !/^[a-f0-9]{40}$/.test(priorSource.source_revision)
    || SOURCE_FILES.some((file) => typeof hashes[file] !== "string" || !/^[a-f0-9]{64}$/.test(hashes[file] as string))) throw new Error("Baseline lacks source lineage");
  const rows = validateRows(report.rows);
  if (canonical(report.summary) !== canonical(summarize(rows))) throw new Error("Baseline summary does not match rows");
  if (!["not_measured", "unchanged", "improved", "regressed"].includes(report.quality_state as string)) throw new Error("Invalid baseline quality state");
  return report as unknown as EvidenceReport;
}
export function assertOutputSafe(output: string, inputs: string[]): void {
  const canonicalOutput = existsSync(output) ? realpathSync(output) : join(realpathSync(dirname(output)), basename(output));
  for (const input of inputs) {
    const canonicalInput = realpathSync(input);
    if (canonicalOutput === canonicalInput) throw new Error("Report output collides with an input/baseline path");
    if (existsSync(output)) {
      const a = statSync(output); const b = statSync(input);
      if (a.dev === b.dev && a.ino === b.ino) throw new Error("Report output aliases an input/baseline inode");
    }
  }
}
export async function evaluate(options: EvaluationOptions): Promise<{ report: EvidenceReport; exitCode: 0 | 1 | 2 }> {
  if (options.packingComparison !== undefined && options.packingComparison !== "skip-oversized") throw new Error("Unsupported packing comparison strategy");
  if (options.packingComparison && !options.baseline) throw new Error("Packing comparison requires --baseline");
  const paths = [options.snapshot, options.queries, options.vectors, ...(options.baseline ? [options.baseline] : [])].map((p) => realpathSync(p));
  const inputHashes = paths.map(hashFile);
  const asOf = normalizeAsOf(options.asOf);
  const queryBytes = readFileSync(paths[1]);
  const queries = validateQueries(queryBytes.toString("utf8").split("\n").filter((line) => line.trim() && !line.trim().startsWith("//")).map((line) => JSON.parse(line) as unknown));
  const vectors = validateVectors(JSON.parse(readFileSync(paths[2], "utf8")) as unknown, queries, inputHashes[1]);
  const bindings: Bindings = {
    snapshot_sha256: inputHashes[0], queries_sha256: inputHashes[1], vectors_sha256: inputHashes[2], as_of: asOf, config: { ...CONFIG, semantic_max_distance: getSemanticMaxDistance() ?? null },
    embedding: { model: vectors.model, identity: vectors.identity, dimensions: vectors.dimensions },
  };
  const source = lineage();
  const baseline = options.baseline ? validateBaseline(JSON.parse(readFileSync(paths[3], "utf8")) as unknown, bindings) : undefined;
  const db = openSnapshot(paths[0]);
  try {
    validateSnapshot(db, queries, vectors);
    const byText = new Map(queries.map((q) => [q.query, Float32Array.from(vectors.vectors[q.id])]));
    const run = async () => withFrozenClock(asOf, async () => {
      const result = await runBenchmark(paths[0], queries, {
        runnerMode: "production_ranker", searchRecencyWeight: 0, manifestPath: null,
        queryEmbeddingProvider: (text) => {
          const vector = byText.get(text);
          if (!vector) throw new Error("Missing frozen query vector");
          return vector;
        },
        queryEmbeddingModel: vectors.model, queryEmbeddingIdentity: vectors.identity,
        querySetSources: [{ path: paths[1], filename: "explicit-query-set.jsonl", record_count: queries.length, sha256: inputHashes[1], bytes: queryBytes.length, manifest_match: "manifest_not_provided" }],
      });
      if (result.runner_mode !== "production_ranker" || result.search_recency_weight !== 0 || result.queries.length !== queries.length
        || result.queries.some((row) => row.search_mode !== "hybrid" || (row.actual_mode ?? row.search_mode) !== "hybrid")
        || (result.warnings?.length ?? 0) > 0) throw new Error("Invalid/degraded production hybrid evaluation");
      const expected = new Map(queries.map((q) => [q.id, q.expected_ids!]));
      const candidateRows: EvidenceRow[] = [];
      const rows = result.queries.map((row) => {
        const gold = expected.get(row.query_id);
        if (!gold) throw new Error("Unexpected retrieval query ID");
        const entries = row.result_ids.map((id) => {
          const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Entry | undefined;
          if (!entry) throw new Error("Retrieved entry disappeared from snapshot");
          return entry;
        });
        // Both policies receive this one retrieved Entry[] in its original order.
        if (options.packingComparison) candidateRows.push(packEvidence(row.query_id, gold, entries, options.packingComparison));
        return packEvidence(row.query_id, gold, entries);
      });
      validateRows(rows);
      return { rows, candidateRows };
    });
    const { rows, candidateRows } = await run();
    const report: EvidenceReport = { schema_version: 1, bindings, lineage: { ...source, ...(baseline ? { baseline_sha256: inputHashes[3] } : {}) }, metric_limitation: LIMITATION, quality_state: "not_measured", rows, summary: summarize(rows) };
    if (options.packingComparison && baseline) {
      assertControlReproduced(baseline.rows, rows);
      report.packing_comparison = { strategy: options.packingComparison, control_reproduced: true, ...comparePackingRows(rows, candidateRows) };
    }
    let exitCode: 0 | 1 | 2 = 2;
    if (baseline) {
      const comparison = compareRows(baseline.rows, rows);
      report.comparison = { ...comparison, baseline_all_gold_rate: baseline.summary.all_gold_rate, current_all_gold_rate: report.summary.all_gold_rate };
      if (comparison.regression) {
        const { rows: repeated } = await run();
        // Compare every deterministic row, including packed/retrieved order and truncation.
        if (canonical([...rows].sort((a, b) => a.query_id.localeCompare(b.query_id))) !== canonical([...repeated].sort((a, b) => a.query_id.localeCompare(b.query_id)))) throw new Error("Regression did not reproduce per query");
        report.comparison.reproduced = true;
        report.quality_state = "regressed"; exitCode = 1;
      } else { report.quality_state = comparison.gained_question_ids.length > 0 ? "improved" : "unchanged"; exitCode = 0; }
    }
    for (let i = 0; i < paths.length; i++) {
      if (hashFile(paths[i]) !== inputHashes[i]) throw new Error("An evaluation input changed during the run");
    }
    checkSidecars(paths[0]);
    if (canonical(lineage()) !== canonical(source)) throw new Error("Evaluator source changed during the run");
    return { report, exitCode };
  } finally {
    db.close();
  }
}
