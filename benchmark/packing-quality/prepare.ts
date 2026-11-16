/** Offline preparation only: no model initialisation, embeddings, credentials or network. */
import Database from "better-sqlite3";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry } from "../../src/types.js";
import { serializeContext, estimateContextTokens } from "../answer-quality/serialize.js";
import { serializeMessageCores } from "../answer-quality/core-packing.js";
import { evaluate, hashFile, sha256 } from "../evidence-metric/evaluate.js";
import { canonical, validateQueries, object, CONFIG } from "../evidence-metric/metric.js";
import { validateMessageBoundaries, type MessageBoundaryEntry } from "../evidence-metric/message-boundaries.js";
import { normalizeAsOf } from "../evidence-metric/clock.js";
import { assertSafeParents } from "../evidence-metric/shared-artifacts.js";
import type { QualityManifest, PackedContext, FileBinding } from "./types.js";
export const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXTRA_SOURCES = ["benchmark/answer-quality/core-packing.ts", "benchmark/answer-quality/message-packing.ts", "benchmark/evidence-metric/message-boundaries.ts", "benchmark/answer-quality/judge.ts", "benchmark/packing-quality/types.ts", "benchmark/packing-quality/prepare.ts", "benchmark/packing-quality/run.ts", "benchmark/packing-quality/summary.ts", "benchmark/packing-quality/m5-transport.ts", "benchmark/packing-quality/protocols/longmemeval-s-closeout-20261021-json-decoding-amendment.json"];
export function packPair(query: string, entries: Entry[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>): { baseline: PackedContext; core: PackedContext } {
  const budget = { maxEstimatedTokens: 8192, estimator: CONFIG.estimator };
  const baseline = serializeContext(entries, "linear", { ...budget, overflowPolicy: "stop" });
  const core = serializeMessageCores(query, entries, boundaries, budget);
  const pack = (value: typeof baseline): PackedContext => ({ text: value.text, sha256: sha256(value.text), ordered_ids: value.orderedIds, budget: value.budget });
  return { baseline: pack(baseline), core: { ...pack(core), selected_message_indices: core.selectedMessageIndices, selected_ranges: core.selectedRanges } };
}
export function sealManifest(value: Omit<QualityManifest, "manifest_sha256">): QualityManifest {
  const { manifest_sha256: _old, ...body } = value as QualityManifest; void _old;
  const sorted = { ...body, queries: [...body.queries].sort((a, b) => a.query_id < b.query_id ? -1 : a.query_id > b.query_id ? 1 : 0) };
  return { ...sorted, manifest_sha256: sha256(canonical(sorted)) };
}
export function validateManifest(value: QualityManifest): QualityManifest {
  const { manifest_sha256: digest, ...body } = value;
  if (sha256(canonical(body)) !== digest) throw new Error("Manifest hash mismatch");
  if (value.schema_version !== 1 || value.report_kind !== "packing_quality_manifest" || value.evidence_scope !== "development_set_not_held_out"
    || value.rule !== "query-message-cores-v1" || !value.identity?.trim()
    || canonical(value.retrieval) !== canonical({ runner_mode: "production_ranker", search_mode: "hybrid", top_k: 10, search_recency_weight: 0, context_token_budget: 8192 })
    || normalizeAsOf(value.as_of) !== value.as_of || !/^[a-f0-9]{40}$/.test(value.source_revision)
    || !Array.isArray(value.queries) || value.queries.length === 0 || new Set(value.queries.map((q) => q.query_id)).size !== value.queries.length) throw new Error("Invalid quality manifest contract");
  if (value.queries.some((q, index) => index > 0 && value.queries[index - 1].query_id >= q.query_id)) throw new Error("Manifest queries must be sorted by query ID");
  for (const query of value.queries) {
    if (![query.query_id, query.question, query.category, query.reference_answer].every((v) => typeof v === "string" && v.trim().length > 0)
      || query.retrieved_ids.length > 10 || new Set(query.retrieved_ids).size !== query.retrieved_ids.length) throw new Error("Invalid manifest query");
    for (const context of [query.baseline, query.core]) {
      if (sha256(context.text) !== context.sha256 || context.budget.estimated_tokens !== estimateContextTokens(context.text)
        || context.budget.estimated_tokens > 8192 || context.budget.max_estimated_tokens !== 8192
        || context.budget.estimator !== CONFIG.estimator || context.ordered_ids.some((id) => !query.retrieved_ids.includes(id))
        || new Set(context.ordered_ids).size !== context.ordered_ids.length) throw new Error("Context hash/budget/IDs mismatch");
    }
  }
  return value;
}
export function regularFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("Explicit absolute file path required");
  assertSafeParents(path); if (!lstatSync(path).isFile()) throw new Error("Expected regular input file"); return resolve(path);
}
export function assertManifestFiles(manifest: QualityManifest): void {
  for (const pin of Object.values(manifest.inputs)) {
    const path = regularFile(pin.path);
    if (lstatSync(path).size !== pin.bytes || hashFile(path) !== pin.sha256) throw new Error("Manifest input hash mismatch");
  }
  for (const [path, hash] of Object.entries(manifest.source_sha256)) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || hashFile(join(SOURCE_ROOT, path)) !== hash) throw new Error("Manifest source hash mismatch");
  }
}
export interface PrepareOptions {
  snapshot: string; queries: string; vectors: string; sourceManifest: string; messageBoundaries: string;
  /** Explicit expected hashes bind the owner's frozen public artifacts; no trust-on-first-use. */
  expected: { snapshot: string; queries: string; vectors: string; sourceManifest: string; messageBoundaries: string };
  asOf: string; identity: string; output: string;
  /** Latest retained evidence report: exact input lineage and baseline packed IDs/budgets must reproduce. */
  reproduction?: { path: string; sha256: string };
}
export async function prepareQualityManifest(options: PrepareOptions): Promise<QualityManifest> {
  const names = ["snapshot", "queries", "vectors", "sourceManifest", "messageBoundaries"] as const;
  const inputs: Record<string, FileBinding> = {};
  for (const name of names) {
    const path = regularFile(options[name]); const hash = hashFile(path);
    if (!/^[a-f0-9]{64}$/.test(options.expected[name]) || hash !== options.expected[name]) throw new Error(`Frozen ${name} hash mismatch`);
    inputs[name] = { path, sha256: hash, bytes: lstatSync(path).size };
  }
  const out = resolve(options.output); assertSafeParents(out);
  if (Object.values(inputs).some((pin) => out === pin.path)) throw new Error("Output overlaps input");
  const sourceManifest = object(JSON.parse(readFileSync(options.sourceManifest, "utf8")) as unknown);
  if (sourceManifest.schema_version !== 1 || sourceManifest.status !== "prepared" || sourceManifest.as_of !== normalizeAsOf(options.asOf)) throw new Error("Frozen source manifest clock/status mismatch");
  const datasetHash = object(sourceManifest.input).sha256;
  if (typeof datasetHash !== "string" || !/^[a-f0-9]{64}$/.test(datasetHash)) throw new Error("Missing frozen dataset lineage");
  const queries = validateQueries(readFileSync(options.queries, "utf8").split("\n").filter((line) => line.trim() && !line.trim().startsWith("//")).map((line) => JSON.parse(line) as unknown));
  if (queries.some((q) => typeof q.reference_answer !== "string" || !q.reference_answer.trim())) throw new Error("All paired quality queries need reference answers");
  // Existing evaluator enforces detached DELETE-mode DB, corpus/vector identities,
  // complete production hybrid retrieval and before/after input/source hashes.
  const { report } = await evaluate({ snapshot: options.snapshot, queries: options.queries, vectors: options.vectors, asOf: options.asOf });
  const embedding = object(sourceManifest.embedding);
  if (canonical(report.bindings.embedding) !== canonical({ model: embedding.model, identity: embedding.identity, dimensions: embedding.dimensions })) throw new Error("Frozen embedding lineage mismatch");
  let priorCoreRows: Map<string, Record<string, unknown>> | undefined;
  if (options.reproduction) {
    const path = regularFile(options.reproduction.path); const buffer = readFileSync(path);
    if (sha256(buffer) !== options.reproduction.sha256) throw new Error("Reproduction report hash mismatch");
    inputs.reproduction = { path, sha256: options.reproduction.sha256, bytes: buffer.length };
    const prior = object(JSON.parse(buffer.toString("utf8")) as unknown);
    if (canonical(prior.bindings) !== canonical(report.bindings) || canonical(prior.rows) !== canonical(report.rows)) throw new Error("Frozen retrieval/control reproduction mismatch");
    const oldSources = object(object(prior.lineage).source_sha256);
    if (canonical(oldSources) !== canonical(report.lineage.source_sha256)) throw new Error("Frozen retrieval source lineage mismatch");
    const core = object(prior.core_comparison); const pins = object(core.lineage);
    if (core.strategy !== "query-message-cores-v1" || core.control_reproduced !== true || pins.message_boundaries_sha256 !== inputs.messageBoundaries.sha256) throw new Error("Frozen core comparison lineage mismatch");
    for (const [key, sourcePath] of Object.entries({ message_boundaries_source_sha256: "benchmark/evidence-metric/message-boundaries.ts", message_packing_source_sha256: "benchmark/answer-quality/message-packing.ts", core_packing_source_sha256: "benchmark/answer-quality/core-packing.ts" })) {
      if (pins[key] !== hashFile(join(SOURCE_ROOT, sourcePath))) throw new Error("Frozen core source hash mismatch");
    }
    if (!Array.isArray(core.queries) || core.queries.length !== queries.length) throw new Error("Frozen core query set mismatch");
    priorCoreRows = new Map(core.queries.map((row: unknown) => { const q = object(row); if (typeof q.query_id !== "string") throw new Error("Invalid frozen core query ID"); return [q.query_id, q]; }));
    if (priorCoreRows.size !== queries.length) throw new Error("Duplicate frozen core query IDs");
  }
  const source_sha256 = { ...report.lineage.source_sha256, ...Object.fromEntries(EXTRA_SOURCES.map((p) => [p, hashFile(join(SOURCE_ROOT, p))])) };
  const db = new Database(options.snapshot, { readonly: true, fileMustExist: true });
  let prepared: QualityManifest;
  try {
    db.pragma("query_only = ON");
    const allEntries = db.prepare("SELECT id, content FROM entries").all() as { id: string; content: string }[];
    const boundaries = validateMessageBoundaries(JSON.parse(readFileSync(options.messageBoundaries, "utf8")) as unknown, new Map(allEntries.map((e) => [e.id, e])), { dataset_sha256: datasetHash, snapshot_sha256: inputs.snapshot.sha256 });
    const byId = new Map(report.rows.map((row) => [row.query_id, row]));
    const rows = queries.map((q) => {
      const row = byId.get(q.id)!;
      const entries = row.retrieved_ids.map((id) => { const entry = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Entry | undefined; if (!entry) throw new Error("Retrieved entry disappeared"); return entry; });
      const pair = packPair(q.query, entries, boundaries.entriesById);
      if (canonical(pair.baseline.ordered_ids) !== canonical(row.packed_ids) || canonical(pair.baseline.budget) !== canonical(row.budget)) throw new Error("Baseline packing did not reproduce");
      if (priorCoreRows) {
        const prior = priorCoreRows.get(q.id);
        if (!prior || canonical(prior.selected_message_indices) !== canonical(pair.core.selected_message_indices)
          || canonical(prior.candidate_ranges) !== canonical(pair.core.selected_ranges) || canonical(prior.candidate_budget) !== canonical(pair.core.budget)) throw new Error("Frozen core packing did not reproduce");
      }
      return { query_id: q.id, question: q.query, ...(q.question_date === undefined ? {} : { question_date: q.question_date }), category: q.category, reference_answer: q.reference_answer!, retrieved_ids: row.retrieved_ids, ...pair };
    });
    prepared = sealManifest({ schema_version: 1, report_kind: "packing_quality_manifest", evidence_scope: "development_set_not_held_out", as_of: normalizeAsOf(options.asOf), identity: options.identity, rule: "query-message-cores-v1", retrieval: { runner_mode: "production_ranker", search_mode: "hybrid", top_k: 10, search_recency_weight: 0, context_token_budget: 8192 }, inputs, source_revision: report.lineage.source_revision, source_sha256, queries: rows });
  } finally { db.close(); }
  validateManifest(prepared); assertManifestFiles(prepared);
  writeFileSync(out, `${JSON.stringify(prepared)}\n`, { flag: "wx", mode: 0o600 });
  return prepared;
}
