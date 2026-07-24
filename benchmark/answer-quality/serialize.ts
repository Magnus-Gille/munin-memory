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
import { serializeOrder, type SerializationMode } from "../../src/internal/retrieval-shared.js";

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

export interface SerializeContextBudgetOptions {
  maxEstimatedTokens: number;
  estimator: "utf8_bytes_div4_ceil_v1";
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
