/** Frozen, label-free complete-message neighbor packing for the offline benchmark. */
import type { Entry } from "../../src/types.js";
import { splitUnicodeTerms } from "../../src/internal/retrieval-shared.js";
import { validateMessageBoundaryEntry, type MessageBoundaryEntry } from "../evidence-metric/message-boundaries.js";
import { estimateContextTokens, type EntrySourceRange, type SerializedContext, type SerializeContextBudgetOptions } from "./serialize.js";

export interface SelectedEntryMessages { entry_id: string; message_indices: number[] }
export interface SerializedMessageContext extends SerializedContext {
  selectedRanges: EntrySourceRange[];
  selectedMessageIndices: SelectedEntryMessages[];
}

function renderMessages(entries: Entry[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>, selected: ReadonlyMap<number, ReadonlySet<number>>) {
  const blocks: string[] = [];
  const orderedIds: string[] = [];
  const selectedRanges: EntrySourceRange[] = [];
  const selectedMessageIndices: SelectedEntryMessages[] = [];
  for (const [rank, entry] of entries.entries()) {
    const indices = [...(selected.get(rank) ?? [])].sort((a, b) => a - b);
    if (indices.length === 0) continue;
    const boundary = boundaries.get(entry.id)!;
    const ranges: EntrySourceRange[] = boundary.prefix_end > 0 ? [{ entry_id: entry.id, start: 0, end: boundary.prefix_end }] : [];
    let lastIndex = -2;
    for (const index of indices) {
      const [start, , end] = boundary.messages[index];
      if (index === lastIndex + 1) ranges.at(-1)!.end = end;
      else ranges.push({ entry_id: entry.id, start, end });
      lastIndex = index;
    }
    const label = entry.key ? `${entry.namespace}/${entry.key}` : entry.namespace;
    const header = `[${blocks.length + 1}] ${label} (${entry.updated_at ?? entry.created_at})`;
    const body = ranges.map(({ start, end }) => `[source utf16 ${start}:${end}]\n${entry.content.slice(start, end)}`).join("\n");
    blocks.push(`${header}\n${body}`);
    orderedIds.push(entry.id);
    selectedRanges.push(...ranges);
    selectedMessageIndices.push({ entry_id: entry.id, message_indices: indices });
  }
  return { text: blocks.join("\n\n"), orderedIds, selectedRanges, selectedMessageIndices };
}

/**
 * Every anchor proposes its complete predecessor/anchor/successor bundle. The
 * union is accepted only if its complete rendered context fits. No labels,
 * answer text, query objects or partial-message fallbacks enter this API.
 */
export function serializeMessageNeighbors(
  query: string, entries: Entry[], boundaries: ReadonlyMap<string, MessageBoundaryEntry>, budgetOptions: SerializeContextBudgetOptions,
): SerializedMessageContext {
  if (budgetOptions.estimator !== "utf8_bytes_div4_ceil_v1"
    || !Number.isSafeInteger(budgetOptions.maxEstimatedTokens) || budgetOptions.maxEstimatedTokens <= 0
    || budgetOptions.maxEstimatedTokens > 8192 || budgetOptions.overflowPolicy !== undefined) {
    throw new Error("Message budget requires a positive safe-integer maxEstimatedTokens <= 8192 and utf8_bytes_div4_ceil_v1.");
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Message packing requires unique entry IDs");
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
  })).sort((a, b) => b.score - a.score || a.retrievalRank - b.retrievalRank || a.messageIndex - b.messageIndex);
  const selected = new Map<number, ReadonlySet<number>>();
  let rendered = renderMessages(entries, boundaries, selected);
  for (const anchor of anchors) {
    const previous = selected.get(anchor.retrievalRank) ?? new Set<number>();
    const proposed = new Set(previous);
    const messageCount = boundaries.get(entries[anchor.retrievalRank].id)!.messages.length;
    for (let index = Math.max(0, anchor.messageIndex - 1); index <= Math.min(messageCount - 1, anchor.messageIndex + 1); index++) proposed.add(index);
    if (proposed.size === previous.size) continue;
    selected.set(anchor.retrievalRank, proposed);
    const candidate = renderMessages(entries, boundaries, selected);
    if (Buffer.byteLength(candidate.text, "utf8") <= budgetOptions.maxEstimatedTokens * 4) rendered = candidate;
    else selected.set(anchor.retrievalRank, previous);
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
