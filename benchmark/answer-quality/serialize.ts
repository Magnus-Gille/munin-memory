/**
 * Context serialization for the answer-quality eval harness.
 *
 * Takes the reranked entries and formats them into a numbered block string
 * that is passed to the answer model. The serialization mode controls the
 * display order: "linear" preserves rank order, "boundary" reorders for the
 * LLM primacy/recency effect.
 *
 * Crucially, the RETURNED `orderedIds` records what the model actually saw,
 * while the caller retains the linear `retrieved_ids` for provenance.
 */

import type { Entry } from "../../src/types.js";
import { serializeOrder, splitUnicodeTerms, type SerializationMode } from "../../src/internal/retrieval-shared.js";

export interface SerializedContext {
  /** The text block passed to the answer model. */
  text: string;
  /**
   * Entry IDs in the display order that was fed to the model.
   * Differs from retrieved_ids when mode = "boundary".
   */
  orderedIds: string[];
  /** Deterministic estimate used to enforce the retrieved-context budget. */
  estimatedTokens: number;
  budget: SerializedContextBudget;
}

export type ContextOverflowPolicy = "stop" | "skip-oversized";

export interface SerializeContextBudgetOptions {
  maxEstimatedTokens: number;
  estimator: "utf8_bytes_div4_ceil_v1";
  /** Default preserves stop-on-overflow and first-entry truncation. */
  overflowPolicy?: ContextOverflowPolicy;
}

export interface SerializedContextBudget {
  max_estimated_tokens: number | null;
  estimated_tokens: number;
  estimator: "utf8_bytes_div4_ceil_v1";
  truncated: boolean;
  candidate_entry_count: number;
  included_entry_count: number;
  dropped_entry_count: number;
}

/** Conservative, dependency-free estimator pinned by the scorecard contract. */
export function estimateContextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let result = "";
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

/**
 * Serialize retrieval results into a numbered context block.
 *
 * Each entry becomes:
 * ```
 * [n] namespace/key (updated_at)
 * <content>
 * ```
 * separated by blank lines.
 *
 * The display order is determined by `mode` (linear = rank order, boundary =
 * boundary-priority reorder). `orderedIds` reflects the display order so the
 * report can distinguish retrieved_ids (provenance) from what the model saw.
 */
export function serializeContext(
  entries: Entry[],
  mode: SerializationMode,
  budgetOptions?: SerializeContextBudgetOptions,
): SerializedContext {
  const estimator = "utf8_bytes_div4_ceil_v1" as const;
  const overflowPolicy = budgetOptions?.overflowPolicy ?? "stop";
  if (overflowPolicy !== "stop" && overflowPolicy !== "skip-oversized") {
    throw new Error("Unsupported context overflow policy.");
  }
  if (
    budgetOptions !== undefined
    && (
      budgetOptions.estimator !== estimator
      || !Number.isSafeInteger(budgetOptions.maxEstimatedTokens)
      || budgetOptions.maxEstimatedTokens <= 0
      || budgetOptions.maxEstimatedTokens > Math.floor(Number.MAX_SAFE_INTEGER / 4)
    )
  ) {
    throw new Error(
      "Context budget requires a positive safe-integer maxEstimatedTokens and utf8_bytes_div4_ceil_v1.",
    );
  }
  if (entries.length === 0) {
    const text = "(no relevant context found)";
    const estimatedTokens = estimateContextTokens(text);
    return {
      text,
      orderedIds: [],
      estimatedTokens,
      budget: {
        max_estimated_tokens: budgetOptions?.maxEstimatedTokens ?? null,
        estimated_tokens: estimatedTokens,
        estimator,
        truncated: false,
        candidate_entry_count: 0,
        included_entry_count: 0,
        dropped_entry_count: 0,
      },
    };
  }

  const displayEntries = serializeOrder(entries, mode);
  const blocks: string[] = [];
  const orderedIds: string[] = [];
  let contentTruncated = false;
  const maxBytes = budgetOptions === undefined
    ? null
    : budgetOptions.maxEstimatedTokens * 4;

  for (const entry of displayEntries) {
    const idx = blocks.length;
    const label = entry.key
      ? `${entry.namespace}/${entry.key}`
      : entry.namespace;
    const timestamp = entry.updated_at ?? entry.created_at;
    const header = `[${idx + 1}] ${label} (${timestamp})`;
    const block = `${header}\n${entry.content}`;
    const separator = blocks.length === 0 ? "" : "\n\n";
    const candidate = `${blocks.join("\n\n")}${separator}${block}`;

    if (maxBytes === null || Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      blocks.push(block);
      orderedIds.push(entry.id);
      continue;
    }

    // The experimental policy keeps whole entries only, in the same display order.
    if (overflowPolicy === "skip-oversized") continue;

    if (blocks.length === 0 && maxBytes > 0) {
      const prefix = `${header}\n`;
      const remainingBytes = maxBytes - Buffer.byteLength(prefix, "utf8");
      if (remainingBytes >= 0) {
        const truncatedContent = truncateUtf8ToBytes(entry.content, remainingBytes);
        blocks.push(`${prefix}${truncatedContent}`);
        orderedIds.push(entry.id);
        contentTruncated = truncatedContent !== entry.content;
      }
    }
    break;
  }

  const text = blocks.join("\n\n");
  const estimatedTokens = estimateContextTokens(text);
  const droppedEntryCount = displayEntries.length - orderedIds.length;

  return {
    text,
    orderedIds,
    estimatedTokens,
    budget: {
      max_estimated_tokens: budgetOptions?.maxEstimatedTokens ?? null,
      estimated_tokens: estimatedTokens,
      estimator,
      truncated: contentTruncated || droppedEntryCount > 0,
      candidate_entry_count: displayEntries.length,
      included_entry_count: orderedIds.length,
      dropped_entry_count: droppedEntryCount,
    },
  };
}

/** Half-open offsets into the original Entry.content, measured in UTF-16 code units. */
export interface SourceRange { start: number; end: number }
export interface EntrySourceRange extends SourceRange { entry_id: string }
export interface SerializedPassageContext extends SerializedContext {
  selectedRanges: EntrySourceRange[];
}

/** Expose provenance without changing any legacy serialization bytes or return fields. */
export function serializeContextWithRanges(
  entries: Entry[], mode: SerializationMode, budgetOptions?: SerializeContextBudgetOptions,
): { context: SerializedContext; selectedRanges: EntrySourceRange[] } {
  const context = serializeContext(entries, mode, budgetOptions);
  const display = serializeOrder(entries, mode);
  const selectedRanges: EntrySourceRange[] = [];
  let offset = 0;
  for (const [index, id] of context.orderedIds.entries()) {
    const entry = display.find((candidate) => candidate.id === id)!;
    const label = entry.key ? `${entry.namespace}/${entry.key}` : entry.namespace;
    const header = `[${index + 1}] ${label} (${entry.updated_at ?? entry.created_at})\n`;
    if (index > 0) offset += 2;
    offset += header.length;
    const length = Math.min(entry.content.length, context.text.length - offset);
    selectedRanges.push({ entry_id: id, start: 0, end: length });
    offset += length;
  }
  return { context, selectedRanges };
}

export const PASSAGE_MAX_UTF8_BYTES = 2048;
/** Partition source exactly, preferring complete newline-terminated lines. */
export function splitSourcePassages(content: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let start = 0;
  let end = 0;
  let used = 0;
  const flush = () => {
    if (end > start) ranges.push({ start, end });
    start = end;
    used = 0;
  };
  while (end < content.length) {
    const newline = content.indexOf("\n", end);
    const lineEnd = newline === -1 ? content.length : newline + 1;
    const line = content.slice(end, lineEnd);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes <= PASSAGE_MAX_UTF8_BYTES) {
      if (used + lineBytes > PASSAGE_MAX_UTF8_BYTES) flush();
      end = lineEnd;
      used += lineBytes;
      continue;
    }
    // An oversized line cannot share its initial chunk with the preceding line.
    flush();
    for (const character of line) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (used + bytes > PASSAGE_MAX_UTF8_BYTES) flush();
      end += character.length;
      used += bytes;
    }
  }
  flush();
  return ranges;
}

/** Source order union; adjacent chunks become one exact source slice. */
export function coalesceSourceRanges(ranges: SourceRange[]): SourceRange[] {
  const result: SourceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

function renderPassages(entries: Entry[], selected: Map<number, SourceRange[]>): { text: string; orderedIds: string[]; selectedRanges: EntrySourceRange[] } {
  const blocks: string[] = [];
  const orderedIds: string[] = [];
  const selectedRanges: EntrySourceRange[] = [];
  for (const [index, entry] of entries.entries()) {
    const ranges = coalesceSourceRanges(selected.get(index) ?? []);
    if (ranges.length === 0) continue;
    const label = entry.key ? `${entry.namespace}/${entry.key}` : entry.namespace;
    const header = `[${blocks.length + 1}] ${label} (${entry.updated_at ?? entry.created_at})`;
    const body = ranges.map(({ start, end }) => `[source utf16 ${start}:${end}]\n${entry.content.slice(start, end)}`).join("\n");
    blocks.push(`${header}\n${body}`);
    orderedIds.push(entry.id);
    selectedRanges.push(...ranges.map((range) => ({ entry_id: entry.id, ...range })));
  }
  return { text: blocks.join("\n\n"), orderedIds, selectedRanges };
}

/**
 * Frozen query-passages-v1 candidate. Labels and answers are deliberately absent
 * from the API: selection uses only query terms and ranked retrieved source text.
 */
export function serializeQueryPassages(
  query: string, entries: Entry[], budgetOptions: SerializeContextBudgetOptions,
): SerializedPassageContext {
  if (budgetOptions.estimator !== "utf8_bytes_div4_ceil_v1"
    || !Number.isSafeInteger(budgetOptions.maxEstimatedTokens) || budgetOptions.maxEstimatedTokens <= 0
    || budgetOptions.maxEstimatedTokens > 8192) {
    throw new Error("Passage budget requires a positive safe-integer maxEstimatedTokens <= 8192 and utf8_bytes_div4_ceil_v1.");
  }
  const queryTerms = new Set(splitUnicodeTerms(query));
  const passages = entries.flatMap((entry, retrievalRank) => splitSourcePassages(entry.content).map((range) => {
    const terms = new Set(splitUnicodeTerms(entry.content.slice(range.start, range.end)));
    const overlap = [...terms].filter((term) => queryTerms.has(term)).length;
    return { ...range, retrievalRank, score: overlap / Math.sqrt(Math.max(1, terms.size)) };
  })).sort((a, b) => b.score - a.score || a.retrievalRank - b.retrievalRank || a.start - b.start);
  const selected = new Map<number, SourceRange[]>();
  let rendered = renderPassages(entries, selected);
  for (const passage of passages) {
    const previous = selected.get(passage.retrievalRank) ?? [];
    selected.set(passage.retrievalRank, [...previous, { start: passage.start, end: passage.end }]);
    const candidate = renderPassages(entries, selected);
    if (Buffer.byteLength(candidate.text, "utf8") <= budgetOptions.maxEstimatedTokens * 4) rendered = candidate;
    else selected.set(passage.retrievalRank, previous);
  }
  const estimatedTokens = estimateContextTokens(rendered.text);
  const selectedContentLength = rendered.selectedRanges.reduce((sum, range) => sum + range.end - range.start, 0);
  return {
    ...rendered,
    estimatedTokens,
    budget: {
      max_estimated_tokens: budgetOptions.maxEstimatedTokens, estimated_tokens: estimatedTokens,
      estimator: "utf8_bytes_div4_ceil_v1",
      truncated: selectedContentLength < entries.reduce((sum, entry) => sum + entry.content.length, 0)
        || rendered.orderedIds.length < entries.length,
      candidate_entry_count: entries.length, included_entry_count: rendered.orderedIds.length,
      dropped_entry_count: entries.length - rendered.orderedIds.length,
    },
  };
}
