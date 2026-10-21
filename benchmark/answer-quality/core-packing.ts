/** Frozen label-free complete-message cores, followed by optional immediate context. */
import type { Entry } from "../../src/types.js";
import { splitUnicodeTerms } from "../../src/internal/retrieval-shared.js";
import { validateMessageBoundaryEntry, type MessageBoundaryEntry } from "../evidence-metric/message-boundaries.js";
import { renderMessages, type SerializedMessageContext } from "./message-packing.js";
import { estimateContextTokens, type SerializeContextBudgetOptions } from "./serialize.js";

/**
 * Scoring and ties match query-message-neighbors-v1. Only admission changes:
 * positive anchors first, then independent neighbors of admitted phase-one seeds.
 * Labels, expected IDs and answer text are absent from this selector's API.
 */
export function serializeMessageCores(
  query: string, entries: Entry[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>, budgetOptions: SerializeContextBudgetOptions,
): SerializedMessageContext {
  if (budgetOptions.estimator !== "utf8_bytes_div4_ceil_v1"
    || !Number.isSafeInteger(budgetOptions.maxEstimatedTokens) || budgetOptions.maxEstimatedTokens <= 0
    || budgetOptions.maxEstimatedTokens > 8192 || budgetOptions.overflowPolicy !== undefined) {
    throw new Error("Core message budget requires a positive safe-integer maxEstimatedTokens <= 8192 and utf8_bytes_div4_ceil_v1.");
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Core message packing requires unique entry IDs");
  for (const entry of entries) {
    const boundary = boundaries.get(entry.id);
    if (!boundary || boundary.entry_id !== entry.id) throw new Error(`Missing message boundaries for ${entry.id}`);
    validateMessageBoundaryEntry(boundary, entry.content);
  }
  const queryTerms = new Set(splitUnicodeTerms(query));
  const anchors = entries.flatMap((entry, retrievalRank) => boundaries.get(entry.id)!.messages.map(([, contentStart, end], messageIndex) => {
    const terms = new Set(splitUnicodeTerms(entry.content.slice(contentStart, end)));
    const overlap = [...terms].filter((term) => queryTerms.has(term)).length;
    return { retrievalRank, messageIndex, score: overlap / Math.sqrt(Math.max(1, terms.size)) };
  })).filter((anchor) => anchor.score > 0)
    .sort((a, b) => b.score - a.score || a.retrievalRank - b.retrievalRank || a.messageIndex - b.messageIndex);
  const selected = new Map<number, ReadonlySet<number>>();
  let rendered = renderMessages(entries, boundaries, selected);
  const admit = (retrievalRank: number, messageIndex: number): boolean => {
    const previous = selected.get(retrievalRank) ?? new Set<number>();
    if (previous.has(messageIndex)) return false;
    selected.set(retrievalRank, new Set([...previous, messageIndex]));
    const candidate = renderMessages(entries, boundaries, selected);
    if (Buffer.byteLength(candidate.text, "utf8") <= budgetOptions.maxEstimatedTokens * 4) {
      rendered = candidate;
      return true;
    }
    selected.set(retrievalRank, previous);
    return false;
  };
  const phaseOneSeeds = anchors.filter((anchor) => admit(anchor.retrievalRank, anchor.messageIndex));
  // This seed list is complete before expansion. Phase-two additions never seed it.
  for (const anchor of phaseOneSeeds) {
    const count = boundaries.get(entries[anchor.retrievalRank].id)!.messages.length;
    if (anchor.messageIndex > 0) admit(anchor.retrievalRank, anchor.messageIndex - 1);
    if (anchor.messageIndex + 1 < count) admit(anchor.retrievalRank, anchor.messageIndex + 1);
  }
  const estimatedTokens = estimateContextTokens(rendered.text);
  const selectedCount = rendered.selectedMessageIndices.reduce((sum, entry) => sum + entry.message_indices.length, 0);
  return {
    ...rendered, estimatedTokens,
    budget: {
      max_estimated_tokens: budgetOptions.maxEstimatedTokens, estimated_tokens: estimatedTokens,
      estimator: "utf8_bytes_div4_ceil_v1",
      truncated: selectedCount < entries.reduce((sum, entry) => sum + boundaries.get(entry.id)!.messages.length, 0) || rendered.orderedIds.length < entries.length,
      candidate_entry_count: entries.length, included_entry_count: rendered.orderedIds.length,
      dropped_entry_count: entries.length - rendered.orderedIds.length,
    },
  };
}
