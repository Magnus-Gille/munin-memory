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
): SerializedContext {
  if (entries.length === 0) {
    return { text: "(no relevant context found)", orderedIds: [] };
  }

  const displayEntries = serializeOrder(entries, mode);
  const orderedIds = displayEntries.map((e) => e.id);

  const blocks = displayEntries.map((entry, idx) => {
    const label = entry.key
      ? `${entry.namespace}/${entry.key}`
      : entry.namespace;
    const timestamp = entry.updated_at ?? entry.created_at;
    const header = `[${idx + 1}] ${label} (${timestamp})`;
    return `${header}\n${entry.content}`;
  });

  return {
    text: blocks.join("\n\n"),
    orderedIds,
  };
}
