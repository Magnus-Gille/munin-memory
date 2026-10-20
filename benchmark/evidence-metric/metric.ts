import { coalesceSourceRanges, serializeContext, serializeContextWithRanges, serializeQueryPassages, type EntrySourceRange, type SerializedContextBudget, type ContextOverflowPolicy } from "../answer-quality/serialize.js";
import type { BenchmarkQuery } from "../types.js";
import type { Entry } from "../../src/types.js";
import type { GoldTurnQuery } from "./gold-turns.js";

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
export function packEvidence(queryId: string, expectedIds: string[], entries: Entry[], overflowPolicy: ContextOverflowPolicy = "stop"): EvidenceRow {
  const packed = serializeContext(entries, "linear", { maxEstimatedTokens: 8192, estimator: CONFIG.estimator, overflowPolicy });
  const present = expectedIds.filter((id) => packed.orderedIds.includes(id));
  return {
    query_id: queryId, expected_ids: [...expectedIds], retrieved_ids: entries.map((e) => e.id),
    packed_ids: packed.orderedIds, present_gold_ids: present,
    all_gold: present.length === expectedIds.length, budget: packed.budget,
  };
}
export interface PassageEvidenceRow extends EvidenceRow {
  selected_ranges: EntrySourceRange[];
  legacy_ranges: EntrySourceRange[];
  retrieval_ranges: EntrySourceRange[];
}
/** Selection finishes before any gold labels are inspected. */
export function packPassageEvidence(queryId: string, query: string, expectedIds: string[], entries: Entry[]): PassageEvidenceRow {
  const budget = { maxEstimatedTokens: CONFIG.max_estimated_tokens, estimator: CONFIG.estimator };
  const packed = serializeQueryPassages(query, entries, budget);
  const legacy = serializeContextWithRanges(entries, "linear", budget);
  const present = expectedIds.filter((id) => packed.orderedIds.includes(id));
  return {
    query_id: queryId, expected_ids: [...expectedIds], retrieved_ids: entries.map((e) => e.id),
    packed_ids: packed.orderedIds, present_gold_ids: present,
    all_gold: present.length === expectedIds.length, budget: packed.budget,
    selected_ranges: packed.selectedRanges, legacy_ranges: legacy.selectedRanges,
    retrieval_ranges: entries.map((entry) => ({ entry_id: entry.id, start: 0, end: entry.content.length })),
  };
}

export interface CoveredGoldTurn extends EntrySourceRange { message_index: number }
/** A snippet earns credit only when the range union covers the complete original message. */
export function coveredGoldTurns(labels: GoldTurnQuery, ranges: EntrySourceRange[]): CoveredGoldTurn[] {
  return labels.entries.flatMap((entry) => {
    const union = coalesceSourceRanges(ranges.filter((range) => range.entry_id === entry.entry_id));
    return entry.turns.filter((turn) => union.some((range) => range.start <= turn.start && range.end >= turn.end))
      .map((turn) => ({ entry_id: entry.entry_id, ...turn }));
  });
}

/** Paired diagnostics; the primary legacy metric and exit policy stay separate. */
export function comparePassageRows(control: EvidenceRow[], candidate: PassageEvidenceRow[], labels: ReadonlyMap<string, GoldTurnQuery>) {
  const proxy = comparePackingRows(control, candidate);
  const byId = new Map(candidate.map((row) => [row.query_id, row]));
  const turnKey = (turn: CoveredGoldTurn) => canonical(turn);
  const queries = proxy.queries.map((row) => {
    const after = byId.get(row.query_id)!;
    const gold = labels.get(row.query_id);
    if (!gold || canonical(gold.entries.map((entry) => entry.entry_id).sort()) !== canonical([...row.expected_ids].sort())) {
      throw new Error("Passage comparison requires exact query/entry annotations");
    }
    const eligible = gold.entries.every((entry) => entry.turns.length > 0);
    const goldTurnCount = gold.entries.reduce((sum, entry) => sum + entry.turns.length, 0);
    const retrieval = coveredGoldTurns(gold, after.retrieval_ranges);
    const legacy = coveredGoldTurns(gold, after.legacy_ranges);
    const selected = coveredGoldTurns(gold, after.selected_ranges);
    const beforeKeys = new Set(legacy.map(turnKey));
    const afterKeys = new Set(selected.map(turnKey));
    return {
      ...row,
      legacy_budget: { ...control.find((before) => before.query_id === row.query_id)!.budget },
      legacy_ranges: after.legacy_ranges.map((range) => ({ ...range })),
      candidate_ranges: after.selected_ranges.map((range) => ({ ...range })),
      annotated_messages: {
        eligible, gold_turn_count: goldTurnCount,
        retrieval_covered_turns: retrieval, legacy_covered_turns: legacy, candidate_covered_turns: selected,
        retrieval_all_turns: eligible ? retrieval.length === goldTurnCount : null,
        legacy_all_turns: eligible ? legacy.length === goldTurnCount : null,
        candidate_all_turns: eligible ? selected.length === goldTurnCount : null,
        gained_turns: selected.filter((turn) => !beforeKeys.has(turnKey(turn))),
        lost_turns: legacy.filter((turn) => !afterKeys.has(turnKey(turn))),
      },
    };
  });
  const eligible = queries.filter((row) => row.annotated_messages.eligible);
  const gained = eligible.filter((row) => !row.annotated_messages.legacy_all_turns && row.annotated_messages.candidate_all_turns).map((row) => row.query_id);
  const lost = eligible.filter((row) => row.annotated_messages.legacy_all_turns && !row.annotated_messages.candidate_all_turns).map((row) => row.query_id);
  const stage = (all: "retrieval_all_turns" | "legacy_all_turns" | "candidate_all_turns", covered: "retrieval_covered_turns" | "legacy_covered_turns" | "candidate_covered_turns") => {
    const count = eligible.filter((row) => row.annotated_messages[all]).length;
    return {
      all_turn_count: count, all_turn_rate: eligible.length === 0 ? null : count / eligible.length,
      covered_message_count: queries.reduce((sum, row) => sum + row.annotated_messages[covered].length, 0),
    };
  };
  return {
    entry_id_proxy: { regression: proxy.regression, gained_question_ids: proxy.gained_question_ids, lost_question_ids: proxy.lost_question_ids, stages: proxy.stages },
    annotated_message_coverage: {
      metric: "full_original_annotated_message_coverage_v1" as const,
      eligible_question_count: eligible.length, eligible_question_ids: eligible.map((row) => row.query_id),
      excluded_question_ids: queries.filter((row) => !row.annotated_messages.eligible).map((row) => row.query_id),
      annotated_message_count: queries.reduce((sum, row) => sum + row.annotated_messages.gold_turn_count, 0),
      retrieval: stage("retrieval_all_turns", "retrieval_covered_turns"),
      legacy_packed: stage("legacy_all_turns", "legacy_covered_turns"),
      candidate_packed: stage("candidate_all_turns", "candidate_covered_turns"),
      regression: lost.length > 0, gained_question_ids: gained, lost_question_ids: lost,
    },
    queries,
  };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function validateEvidenceRows(value: unknown, order: "prefix" | "subsequence"): EvidenceRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Report rows must be nonempty");
  for (const raw of value) {
    const row = object(raw);
    if (!nonblank(row.query_id)) throw new Error("Invalid report query ID");
    const expected = ids(row.expected_ids, "report expected_ids");
    const retrieved = ids(row.retrieved_ids, "report retrieved_ids", true);
    const packed = ids(row.packed_ids, "report packed_ids", true);
    const present = ids(row.present_gold_ids, "report present_gold_ids", true);
    let lastIndex = -1;
    const validOrder = order === "prefix"
      ? canonical(packed) === canonical(retrieved.slice(0, packed.length))
      : packed.every((id) => {
        const index = retrieved.indexOf(id, lastIndex + 1);
        if (index === -1) return false;
        lastIndex = index;
        return true;
      });
    if (retrieved.length > 10 || !validOrder
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
/** Legacy v1 reports require a retrieval prefix, including a truncated first item. */
export function validateRows(value: unknown): EvidenceRow[] { return validateEvidenceRows(value, "prefix"); }
/** Whole-entry skip packing permits only an ordered subsequence of retrieval. */
export function validateCandidateRows(value: unknown): EvidenceRow[] { return validateEvidenceRows(value, "subsequence"); }
/** Bind strategy comparisons to the exact frozen control, not only aggregate rates. */
export function assertControlReproduced(baseline: EvidenceRow[], control: EvidenceRow[]): void {
  validateRows(baseline); validateRows(control);
  const sorted = (rows: EvidenceRow[]) => [...rows].sort((a, b) => a.query_id.localeCompare(b.query_id));
  if (canonical(sorted(baseline)) !== canonical(sorted(control))) {
    throw new Error("Packing comparison control rows do not reproduce the frozen baseline exactly");
  }
}
export type GoldStage = "all_gold" | "partial_gold" | "no_gold";
function goldStage(expected: string[], actual: string[]): GoldStage {
  const count = expected.filter((id) => actual.includes(id)).length;
  return count === expected.length ? "all_gold" : count > 0 ? "partial_gold" : "no_gold";
}
/** Gold labels measure the result only; both packers have already consumed the same ranked entries. */
export function comparePackingRows(control: EvidenceRow[], candidate: EvidenceRow[]) {
  validateRows(control); validateCandidateRows(candidate);
  const byId = new Map(candidate.map((row) => [row.query_id, row]));
  if (control.length !== candidate.length) throw new Error("Packing comparisons require the same query IDs");
  const stages = {
    retrieval: { all_gold: 0, partial_gold: 0, no_gold: 0 },
    legacy_packed: { all_gold: 0, partial_gold: 0, no_gold: 0 },
    candidate_packed: { all_gold: 0, partial_gold: 0, no_gold: 0 },
  };
  const queries = control.map((before) => {
    const after = byId.get(before.query_id);
    if (!after || canonical(before.retrieved_ids) !== canonical(after.retrieved_ids)
      || canonical(before.expected_ids) !== canonical(after.expected_ids)) {
      throw new Error("Packing comparisons require the same retrieved order and gold IDs per query");
    }
    const retrieval_stage = goldStage(before.expected_ids, before.retrieved_ids);
    const legacy_packed_stage = goldStage(before.expected_ids, before.packed_ids);
    const candidate_packed_stage = goldStage(after.expected_ids, after.packed_ids);
    stages.retrieval[retrieval_stage]++;
    stages.legacy_packed[legacy_packed_stage]++;
    stages.candidate_packed[candidate_packed_stage]++;
    return {
      query_id: before.query_id, expected_ids: [...before.expected_ids], retrieved_ids: [...before.retrieved_ids],
      legacy_packed_ids: [...before.packed_ids], candidate_packed_ids: [...after.packed_ids],
      candidate_budget: { ...after.budget }, retrieval_stage, legacy_packed_stage, candidate_packed_stage,
      legacy_all_gold: before.all_gold, candidate_all_gold: after.all_gold,
      gained_ids: after.present_gold_ids.filter((id) => !before.present_gold_ids.includes(id)),
      lost_ids: before.present_gold_ids.filter((id) => !after.present_gold_ids.includes(id)),
    };
  });
  const gained_question_ids = queries.filter((q) => !q.legacy_all_gold && q.candidate_all_gold).map((q) => q.query_id);
  const lost_question_ids = queries.filter((q) => q.legacy_all_gold && !q.candidate_all_gold).map((q) => q.query_id);
  return { regression: lost_question_ids.length > 0, gained_question_ids, lost_question_ids, stages, queries };
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
