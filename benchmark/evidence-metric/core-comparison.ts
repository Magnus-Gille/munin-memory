/** Optional complete-message core diagnostics; selection never receives annotations. */
import type { Entry } from "../../src/types.js";
import type { BenchmarkQuery } from "../types.js";
import { serializeMessageCores } from "../answer-quality/core-packing.js";
import { serializeContextWithRanges } from "../answer-quality/serialize.js";
import type { MessageBoundaryEntry } from "./message-boundaries.js";
import type { GoldTurnQuery } from "./gold-turns.js";
import { compareMessageRows, wholeMessageConservation, type MessageEvidenceRow } from "./message-comparison.js";
import { CONFIG, type EvidenceRow, type PassageEvidenceRow } from "./metric.js";

/** Complete label-blind selection before expected IDs are consulted for measurement. */
export function packCoreEvidence(
  queryId: string, query: string, expectedIds: string[], entries: Entry[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>,
): MessageEvidenceRow {
  const budget = { maxEstimatedTokens: CONFIG.max_estimated_tokens, estimator: CONFIG.estimator };
  const packed = serializeMessageCores(query, entries, boundaries, budget);
  const legacy = serializeContextWithRanges(entries, "linear", budget);
  const present = expectedIds.filter((id) => packed.orderedIds.includes(id));
  const retrievedBoundaries = new Map(entries.map((entry) => [entry.id, boundaries.get(entry.id)!]));
  const conservation = wholeMessageConservation(packed.selectedRanges, retrievedBoundaries);
  if (conservation.partial_message_count !== 0 || conservation.selected_message_count !== packed.selectedMessageIndices.reduce((sum, entry) => sum + entry.message_indices.length, 0)) throw new Error("Core packing did not conserve complete original messages");
  return {
    query_id: queryId, expected_ids: [...expectedIds], retrieved_ids: entries.map((entry) => entry.id),
    packed_ids: packed.orderedIds, present_gold_ids: present, all_gold: present.length === expectedIds.length,
    budget: packed.budget, selected_ranges: packed.selectedRanges, selected_message_indices: packed.selectedMessageIndices,
    legacy_ranges: legacy.selectedRanges, retrieval_ranges: entries.map((entry) => ({ entry_id: entry.id, start: 0, end: entry.content.length })),
    whole_message_conservation: conservation,
  };
}

/** Reuse the established metric for all three frozen controls and the same annotations. */
export function compareCoreRows(
  control: EvidenceRow[], passages: PassageEvidenceRow[], neighbors: MessageEvidenceRow[], candidate: MessageEvidenceRow[],
  labels: ReadonlyMap<string, GoldTurnQuery>, queries: BenchmarkQuery[],
) {
  const paired = compareMessageRows(control, passages, candidate, labels, queries);
  const neighborPair = compareMessageRows(control, neighbors, candidate, labels, queries).versus_passages;
  return {
    versus_legacy: paired.versus_legacy, versus_passages: paired.versus_passages,
    versus_neighbors: { ...neighborPair, reference_strategy: "query-message-neighbors-v1" as const },
    queries: paired.queries, whole_message_conservation: paired.whole_message_conservation,
  };
}
