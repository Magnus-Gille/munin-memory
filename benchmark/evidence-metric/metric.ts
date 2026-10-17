import { serializeContext, type SerializedContextBudget } from "../answer-quality/serialize.js";
import type { BenchmarkQuery } from "../types.js";
import type { Entry } from "../../src/types.js";

export const CONFIG = {
  metric: "packed_gold_entry_id_presence_v1",
  runner_mode: "production_ranker", search_mode: "hybrid", search_recency_weight: 0,
  top_k: 10, serialization: "linear", max_estimated_tokens: 8192, estimator: "utf8_bytes_div4_ceil_v1",
} as const;
export interface EvidenceRow {
  query_id: string;
  expected_ids: string[];
  retrieved_ids: string[];
  packed_ids: string[];
  present_gold_ids: string[];
  all_gold: boolean;
  budget: SerializedContextBudget;
}
export interface FrozenVectors {
  schema_version: 1;
  query_set_sha256: string;
  model: string;
  identity: string;
  dimensions: number;
  vectors: Record<string, number[]>;
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function ids(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every(nonblank)
    || new Set(value).size !== value.length) throw new Error(`${label} must contain unique nonempty IDs`);
  return value as string[];
}
export function validateQueries(value: unknown): BenchmarkQuery[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("A nonempty query set is required");
  const queries = value.map((raw) => {
    const q = object(raw);
    if (!nonblank(q.id) || !nonblank(q.query) || q.search_mode !== "hybrid" || !["manual", "derived", "synthetic"].includes(q.source as string)) {
      throw new Error("Queries require nonempty id/query, explicit valid source and search_mode hybrid");
    }
    if (q.category !== undefined && !nonblank(q.category)) throw new Error("Invalid category");
    if (q.scope_namespace !== undefined && !nonblank(q.scope_namespace)) throw new Error("Invalid scope_namespace");
    return { ...q, expected_ids: ids(q.expected_ids, "expected_ids"), category: q.category ?? "evidence" } as unknown as BenchmarkQuery;
  });
  ids(queries.map((q) => q.id), "query IDs");
  return queries;
}
export function validateVectors(value: unknown, queries: BenchmarkQuery[], sha: string): FrozenVectors {
  const v = object(value);
  if (v.schema_version !== 1 || v.query_set_sha256 !== sha || !nonblank(v.model) || !nonblank(v.identity)
    || !Number.isSafeInteger(v.dimensions) || (v.dimensions as number) < 1) {
    throw new Error("Invalid frozen vector schema, query hash, dimensions or model/identity provenance");
  }
  const vectors = object(v.vectors);
  const byText = new Map<string, string>();
  for (const q of queries) {
    const vector = vectors[q.id];
    if (!Array.isArray(vector) || vector.length !== v.dimensions
      || !vector.every((n) => typeof n === "number" && Number.isFinite(n) && Number.isFinite(Math.fround(n)))) {
      throw new Error(`Missing or invalid frozen vector for query ${q.id}`);
    }
    const encoded = JSON.stringify(vector);
    if (byText.has(q.query) && byText.get(q.query) !== encoded) throw new Error("Duplicate query texts require identical vectors");
    byText.set(q.query, encoded);
  }
  if (Object.keys(vectors).length !== queries.length) throw new Error("Frozen vectors must match the query IDs exactly");
  return v as unknown as FrozenVectors;
}
export function packEvidence(queryId: string, expectedIds: string[], entries: Entry[]): EvidenceRow {
  const packed = serializeContext(entries, "linear", { maxEstimatedTokens: 8192, estimator: CONFIG.estimator });
  const present = expectedIds.filter((id) => packed.orderedIds.includes(id));
  return {
    query_id: queryId, expected_ids: [...expectedIds], retrieved_ids: entries.map((e) => e.id),
    packed_ids: packed.orderedIds, present_gold_ids: present,
    all_gold: present.length === expectedIds.length, budget: packed.budget,
  };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validateRows(value: unknown): EvidenceRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Report rows must be nonempty");
  for (const raw of value) {
    const row = object(raw);
    if (!nonblank(row.query_id)) throw new Error("Invalid report query ID");
    const expected = ids(row.expected_ids, "report expected_ids");
    const retrieved = ids(row.retrieved_ids, "report retrieved_ids", true);
    const packed = ids(row.packed_ids, "report packed_ids", true);
    const present = ids(row.present_gold_ids, "report present_gold_ids", true);
    if (retrieved.length > 10 || canonical(packed) !== canonical(retrieved.slice(0, packed.length))
      || canonical(present) !== canonical(expected.filter((id) => packed.includes(id)))
      || row.all_gold !== (present.length === expected.length)) throw new Error("Inconsistent report evidence IDs");
    const budget = object(row.budget);
    if (budget.estimator !== CONFIG.estimator || budget.max_estimated_tokens !== 8192
      || typeof budget.truncated !== "boolean" || !Number.isSafeInteger(budget.estimated_tokens)
      || (budget.estimated_tokens as number) < 0 || (budget.estimated_tokens as number) > 8192
      || budget.candidate_entry_count !== retrieved.length || budget.included_entry_count !== packed.length
      || budget.dropped_entry_count !== retrieved.length - packed.length
      || (packed.length < retrieved.length && !budget.truncated)) throw new Error("Invalid report packing budget");
  }
  ids(value.map((r: EvidenceRow) => r.query_id), "report query IDs");
  return value as EvidenceRow[];
}
export function compareRows(baseline: EvidenceRow[], current: EvidenceRow[]) {
  validateRows(baseline); validateRows(current);
  const previous = new Map(baseline.map((row) => [row.query_id, row]));
  if (baseline.length !== current.length) throw new Error("Baseline query IDs do not match");
  const queries = current.map((row) => {
    const before = previous.get(row.query_id);
    if (!before || canonical([...before.expected_ids].sort()) !== canonical([...row.expected_ids].sort())) throw new Error("Baseline query IDs or gold IDs do not match");
    return {
      query_id: row.query_id, baseline_all_gold: before.all_gold, current_all_gold: row.all_gold,
      gained_ids: row.present_gold_ids.filter((id) => !before.present_gold_ids.includes(id)),
      lost_ids: before.present_gold_ids.filter((id) => !row.present_gold_ids.includes(id)),
    };
  });
  const gained_question_ids = queries.filter((q) => !q.baseline_all_gold && q.current_all_gold).map((q) => q.query_id);
  const lost_question_ids = queries.filter((q) => q.baseline_all_gold && !q.current_all_gold).map((q) => q.query_id);
  return { regression: lost_question_ids.length > 0, gained_question_ids, lost_question_ids, queries };
}
export function summarize(rows: EvidenceRow[]) {
  const count = rows.filter((r) => r.all_gold).length;
  return { query_count: rows.length, all_gold_count: count, all_gold_rate: count / rows.length, truncated_query_count: rows.filter((r) => r.budget.truncated).length };
}
