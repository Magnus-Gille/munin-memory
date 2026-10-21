/** Optional complete-message diagnostics; selectors never receive annotations. */
import type { Entry } from "../../src/types.js";
import type { BenchmarkQuery } from "../types.js";
import { serializeMessageNeighbors, type SelectedEntryMessages } from "../answer-quality/message-packing.js";
import { coalesceSourceRanges, serializeContextWithRanges, type EntrySourceRange, type SerializedContextBudget } from "../answer-quality/serialize.js";
import type { MessageBoundaryEntry } from "./message-boundaries.js";
import type { GoldTurnQuery } from "./gold-turns.js";
import { canonical, comparePassageRows, CONFIG, coveredGoldTurns, validateCandidateRows, type CoveredGoldTurn, type EvidenceRow, type PassageEvidenceRow } from "./metric.js";

export interface WholeMessageConservation { selected_message_count: number; partial_message_count: number }
export interface MessageEvidenceRow extends PassageEvidenceRow {
  selected_message_indices: SelectedEntryMessages[];
  whole_message_conservation: WholeMessageConservation;
}
/** Derive conservation from source ranges, independent of the selector's indices. */
export function wholeMessageConservation(ranges: EntrySourceRange[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>): WholeMessageConservation {
  let selected = 0; let partial = 0;
  for (const [id, boundary] of boundaries) {
    const union = coalesceSourceRanges(ranges.filter((range) => range.entry_id === id));
    for (const [start, , end] of boundary.messages) {
      if (union.some((range) => range.start <= start && range.end >= end)) selected++;
      else if (union.some((range) => range.start < end && range.end > start)) partial++;
    }
  }
  return { selected_message_count: selected, partial_message_count: partial };
}
/** Selection completes before expected IDs are consulted for measurement. */
export function packMessageEvidence(
  queryId: string, query: string, expectedIds: string[], entries: Entry[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>,
): MessageEvidenceRow {
  const budget = { maxEstimatedTokens: CONFIG.max_estimated_tokens, estimator: CONFIG.estimator };
  const packed = serializeMessageNeighbors(query, entries, boundaries, budget);
  const legacy = serializeContextWithRanges(entries, "linear", budget);
  const present = expectedIds.filter((id) => packed.orderedIds.includes(id));
  const retrievedBoundaries = new Map(entries.map((entry) => [entry.id, boundaries.get(entry.id)!]));
  const conservation = wholeMessageConservation(packed.selectedRanges, retrievedBoundaries);
  if (conservation.partial_message_count !== 0 || conservation.selected_message_count !== packed.selectedMessageIndices.reduce((sum, entry) => sum + entry.message_indices.length, 0)) throw new Error("Message packing did not conserve complete original messages");
  return {
    query_id: queryId, expected_ids: [...expectedIds], retrieved_ids: entries.map((entry) => entry.id),
    packed_ids: packed.orderedIds, present_gold_ids: present, all_gold: present.length === expectedIds.length,
    budget: packed.budget, selected_ranges: packed.selectedRanges, selected_message_indices: packed.selectedMessageIndices,
    legacy_ranges: legacy.selectedRanges, retrieval_ranges: entries.map((entry) => ({ entry_id: entry.id, start: 0, end: entry.content.length })),
    whole_message_conservation: conservation,
  };
}
type Stage = "all_gold" | "partial_gold" | "no_gold";
interface PairQuery {
  query_id: string; category: string; expected_ids: string[]; retrieved_ids: string[];
  reference_packed_ids: string[]; candidate_packed_ids: string[];
  reference_budget: SerializedContextBudget; candidate_budget: SerializedContextBudget;
  reference_ranges: EntrySourceRange[]; candidate_ranges: EntrySourceRange[];
  retrieval_stage: Stage; reference_packed_stage: Stage; candidate_packed_stage: Stage;
  reference_all_gold: boolean; candidate_all_gold: boolean; gained_ids: string[]; lost_ids: string[];
  annotated_messages: {
    eligible: boolean; gold_turn_count: number; no_positive_entry_count: number;
    retrieval_covered_turns: CoveredGoldTurn[]; reference_covered_turns: CoveredGoldTurn[]; candidate_covered_turns: CoveredGoldTurn[];
    retrieval_all_turns: boolean | null; reference_all_turns: boolean | null; candidate_all_turns: boolean | null;
    gained_turns: CoveredGoldTurn[]; lost_turns: CoveredGoldTurn[];
  };
}
const stageOf = (expected: string[], packed: string[]): Stage => {
  const present = expected.filter((id) => packed.includes(id)).length;
  return present === expected.length ? "all_gold" : present > 0 ? "partial_gold" : "no_gold";
};
function summarizePair(queries: PairQuery[]) {
  const stages = {
    retrieval: { all_gold: 0, partial_gold: 0, no_gold: 0 }, reference_packed: { all_gold: 0, partial_gold: 0, no_gold: 0 }, candidate_packed: { all_gold: 0, partial_gold: 0, no_gold: 0 },
  };
  for (const row of queries) { stages.retrieval[row.retrieval_stage]++; stages.reference_packed[row.reference_packed_stage]++; stages.candidate_packed[row.candidate_packed_stage]++; }
  const eligible = queries.filter((row) => row.annotated_messages.eligible);
  const gained = eligible.filter((row) => !row.annotated_messages.reference_all_turns && row.annotated_messages.candidate_all_turns).map((row) => row.query_id);
  const lost = eligible.filter((row) => row.annotated_messages.reference_all_turns && !row.annotated_messages.candidate_all_turns).map((row) => row.query_id);
  const coverage = (all: "retrieval_all_turns" | "reference_all_turns" | "candidate_all_turns", covered: "retrieval_covered_turns" | "reference_covered_turns" | "candidate_covered_turns") => {
    const count = eligible.filter((row) => row.annotated_messages[all]).length;
    return { all_turn_count: count, all_turn_rate: eligible.length ? count / eligible.length : null, covered_message_count: queries.reduce((sum, row) => sum + row.annotated_messages[covered].length, 0) };
  };
  const gainedIds = queries.filter((row) => !row.reference_all_gold && row.candidate_all_gold).map((row) => row.query_id);
  const lostIds = queries.filter((row) => row.reference_all_gold && !row.candidate_all_gold).map((row) => row.query_id);
  const excluded = queries.filter((row) => !row.annotated_messages.eligible);
  return {
    query_count: queries.length,
    entry_id_proxy: { regression: lostIds.length > 0, gained_question_ids: gainedIds, lost_question_ids: lostIds, any_gold_loss_question_ids: queries.filter((row) => row.lost_ids.length > 0).map((row) => row.query_id), gained_id_count: queries.reduce((sum, row) => sum + row.gained_ids.length, 0), lost_id_count: queries.reduce((sum, row) => sum + row.lost_ids.length, 0), stages },
    annotated_message_coverage: {
      metric: "full_original_annotated_message_coverage_v1" as const,
      eligible_question_count: eligible.length, eligible_question_ids: eligible.map((row) => row.query_id), excluded_question_ids: excluded.map((row) => row.query_id),
      annotated_message_count: queries.reduce((sum, row) => sum + row.annotated_messages.gold_turn_count, 0),
      retrieval: coverage("retrieval_all_turns", "retrieval_covered_turns"), reference_packed: coverage("reference_all_turns", "reference_covered_turns"), candidate_packed: coverage("candidate_all_turns", "candidate_covered_turns"),
      regression: lost.length > 0, gained_question_ids: gained, lost_question_ids: lost,
      gained_message_count: queries.reduce((sum, row) => sum + row.annotated_messages.gained_turns.length, 0), lost_message_count: queries.reduce((sum, row) => sum + row.annotated_messages.lost_turns.length, 0),
    },
    excluded_labels: { question_count: excluded.length, annotated_message_count: excluded.reduce((sum, row) => sum + row.annotated_messages.gold_turn_count, 0), no_positive_entry_count: excluded.reduce((sum, row) => sum + row.annotated_messages.no_positive_entry_count, 0) },
  };
}
function finishPair(referenceStrategy: "legacy" | "query-passages-v1", queries: PairQuery[]) {
  const categories = Object.fromEntries([...new Set(queries.map((row) => row.category))].sort().map((category) => [category, summarizePair(queries.filter((row) => row.category === category))]));
  return { reference_strategy: referenceStrategy, ...summarizePair(queries), categories, queries };
}
function pairAgainstPassages(reference: PassageEvidenceRow[], candidate: MessageEvidenceRow[], labels: ReadonlyMap<string, GoldTurnQuery>, categories: ReadonlyMap<string, string>): PairQuery[] {
  validateCandidateRows(reference); validateCandidateRows(candidate);
  if (reference.length !== candidate.length) throw new Error("Message comparisons require the same query IDs");
  const byId = new Map(reference.map((row) => [row.query_id, row]));
  return candidate.map((after) => {
    const before = byId.get(after.query_id); const gold = labels.get(after.query_id);
    if (!before || canonical(before.retrieved_ids) !== canonical(after.retrieved_ids) || canonical(before.expected_ids) !== canonical(after.expected_ids)
      || !gold || canonical(gold.entries.map((entry) => entry.entry_id).sort()) !== canonical([...after.expected_ids].sort())) throw new Error("Message comparisons require exact retrieved order and query/entry annotations");
    const eligible = gold.entries.every((entry) => entry.turns.length > 0);
    const count = gold.entries.reduce((sum, entry) => sum + entry.turns.length, 0);
    const retrieval = coveredGoldTurns(gold, after.retrieval_ranges); const previous = coveredGoldTurns(gold, before.selected_ranges); const selected = coveredGoldTurns(gold, after.selected_ranges);
    const previousKeys = new Set(previous.map(canonical)); const selectedKeys = new Set(selected.map(canonical));
    return {
      query_id: after.query_id, category: categories.get(after.query_id)!, expected_ids: [...after.expected_ids], retrieved_ids: [...after.retrieved_ids],
      reference_packed_ids: [...before.packed_ids], candidate_packed_ids: [...after.packed_ids], reference_budget: { ...before.budget }, candidate_budget: { ...after.budget },
      reference_ranges: before.selected_ranges.map((range) => ({ ...range })), candidate_ranges: after.selected_ranges.map((range) => ({ ...range })),
      retrieval_stage: stageOf(after.expected_ids, after.retrieved_ids), reference_packed_stage: stageOf(before.expected_ids, before.packed_ids), candidate_packed_stage: stageOf(after.expected_ids, after.packed_ids),
      reference_all_gold: before.all_gold, candidate_all_gold: after.all_gold, gained_ids: after.present_gold_ids.filter((id) => !before.present_gold_ids.includes(id)), lost_ids: before.present_gold_ids.filter((id) => !after.present_gold_ids.includes(id)),
      annotated_messages: { eligible, gold_turn_count: count, no_positive_entry_count: gold.entries.filter((entry) => entry.turns.length === 0).length, retrieval_covered_turns: retrieval, reference_covered_turns: previous, candidate_covered_turns: selected, retrieval_all_turns: eligible ? retrieval.length === count : null, reference_all_turns: eligible ? previous.length === count : null, candidate_all_turns: eligible ? selected.length === count : null, gained_turns: selected.filter((turn) => !previousKeys.has(canonical(turn))), lost_turns: previous.filter((turn) => !selectedKeys.has(canonical(turn))) },
    };
  });
}
/** Preserve the established #390 metric and use the identical labels for both pairs. */
export function compareMessageRows(control: EvidenceRow[], passages: PassageEvidenceRow[], candidate: MessageEvidenceRow[], labels: ReadonlyMap<string, GoldTurnQuery>, queries: BenchmarkQuery[]) {
  const categories = new Map(queries.map((query) => [query.id, query.category ?? "evidence"]));
  if (categories.size !== candidate.length || candidate.some((row) => !categories.has(row.query_id))) throw new Error("Message comparison query categories must match exactly");
  const legacy = comparePassageRows(control, candidate, labels);
  const versusLegacy: PairQuery[] = legacy.queries.map((row) => ({
    query_id: row.query_id, category: categories.get(row.query_id)!, expected_ids: row.expected_ids, retrieved_ids: row.retrieved_ids,
    reference_packed_ids: row.legacy_packed_ids, candidate_packed_ids: row.candidate_packed_ids, reference_budget: row.legacy_budget, candidate_budget: row.candidate_budget,
    reference_ranges: row.legacy_ranges, candidate_ranges: row.candidate_ranges, retrieval_stage: row.retrieval_stage, reference_packed_stage: row.legacy_packed_stage, candidate_packed_stage: row.candidate_packed_stage,
    reference_all_gold: row.legacy_all_gold, candidate_all_gold: row.candidate_all_gold, gained_ids: row.gained_ids, lost_ids: row.lost_ids,
    annotated_messages: { eligible: row.annotated_messages.eligible, gold_turn_count: row.annotated_messages.gold_turn_count, no_positive_entry_count: labels.get(row.query_id)!.entries.filter((entry) => entry.turns.length === 0).length, retrieval_covered_turns: row.annotated_messages.retrieval_covered_turns, reference_covered_turns: row.annotated_messages.legacy_covered_turns, candidate_covered_turns: row.annotated_messages.candidate_covered_turns, retrieval_all_turns: row.annotated_messages.retrieval_all_turns, reference_all_turns: row.annotated_messages.legacy_all_turns, candidate_all_turns: row.annotated_messages.candidate_all_turns, gained_turns: row.annotated_messages.gained_turns, lost_turns: row.annotated_messages.lost_turns },
  }));
  return {
    versus_legacy: finishPair("legacy", versusLegacy), versus_passages: finishPair("query-passages-v1", pairAgainstPassages(passages, candidate, labels, categories)),
    queries: candidate.map((row) => ({ query_id: row.query_id, selected_message_indices: row.selected_message_indices, candidate_ranges: row.selected_ranges, candidate_budget: row.budget, whole_message_conservation: row.whole_message_conservation })),
    whole_message_conservation: { selected_message_count: candidate.reduce((sum, row) => sum + row.whole_message_conservation.selected_message_count, 0), partial_message_count: candidate.reduce((sum, row) => sum + row.whole_message_conservation.partial_message_count, 0) },
  };
}
