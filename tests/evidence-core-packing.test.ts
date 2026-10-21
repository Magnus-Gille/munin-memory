import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Entry } from "../src/types.js";
import type { BenchmarkQuery } from "../benchmark/types.js";
import { serializeMessageCores } from "../benchmark/answer-quality/core-packing.js";
import { serializeMessageNeighbors } from "../benchmark/answer-quality/message-packing.js";
import type { MessageBoundaryEntry } from "../benchmark/evidence-metric/message-boundaries.js";
import { compareCoreRows, packCoreEvidence } from "../benchmark/evidence-metric/core-comparison.js";
import { packMessageEvidence, wholeMessageConservation } from "../benchmark/evidence-metric/message-comparison.js";
import { packEvidence, packPassageEvidence } from "../benchmark/evidence-metric/metric.js";

const budget = (maxEstimatedTokens = 8192) => ({ maxEstimatedTokens, estimator: "utf8_bytes_div4_ceil_v1" as const });
function fixture(id: string, messages: string[], roles = messages.map(() => "user")) {
  const prefix = `Session ID: ${id}\nConversation:${messages.length ? "\n" : ""}`;
  let content = prefix;
  const tuples: [number, number, number][] = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0) content += "\n";
    const start = content.length; content += `${roles[index]}: `;
    const contentStart = content.length; content += message;
    tuples.push([start, contentStart, content.length]);
  }
  const entry = { id, namespace: "fixture", key: id, content, created_at: "2026-01-01", updated_at: "2026-01-01" } as Entry;
  const boundary: MessageBoundaryEntry = { entry_id: id, content_sha256: createHash("sha256").update(content).digest("hex"), prefix_end: prefix.length, messages: tuples };
  return { entry, boundary };
}
const boundaries = (...items: ReturnType<typeof fixture>[]) => new Map(items.map((item) => [item.entry.id, item.boundary]));

describe("query-message-cores-v1 frozen admission policy", () => {
  it("admits a whole positive core blocked by the original compulsory expensive neighbors", () => {
    const item = fixture("one", ["a".repeat(40000), "needle", "b".repeat(40000)]);
    const sources = boundaries(item);
    expect(serializeMessageNeighbors("needle", [item.entry], sources, budget()).selectedMessageIndices).toEqual([]);
    const packed = serializeMessageCores("needle", [item.entry], sources, budget());
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "one", message_indices: [1] }]);
    expect(packed.text).toContain("user: needle");
    expect(wholeMessageConservation(packed.selectedRanges, sources)).toEqual({ selected_message_count: 1, partial_message_count: 0 });
  });
  it("admits later positive anchors before optional context and admits each neighbor independently", () => {
    const first = fixture("a", ["left ".repeat(100), "needle", "right"]);
    const second = fixture("b", ["needle"]);
    const packed = serializeMessageCores("needle", [first.entry, second.entry], boundaries(first, second), budget(115));
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "a", message_indices: [1, 2] }, { entry_id: "b", message_indices: [0] }]);
    expect(packed.orderedIds).toEqual(["a", "b"]);
    expect(packed.text).not.toContain("left left");
  });
  it("expands only admitted phase-one anchors and never cascades through neighbors", () => {
    const item = fixture("one", ["outside-before", "before", "needle", "after", "outside-after"]);
    const packed = serializeMessageCores("needle", [item.entry], boundaries(item), budget());
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "one", message_indices: [1, 2, 3] }]);
    const rejected = fixture("rejected", ["outside-before", "needle ".repeat(10000), "outside-after"]);
    const admitted = fixture("admitted", ["needle"]);
    expect(serializeMessageCores("needle", [rejected.entry, admitted.entry], boundaries(rejected, admitted), budget()).selectedMessageIndices).toEqual([{ entry_id: "admitted", message_indices: [0] }]);
  });
  it("uses positive body overlap only, NFC Unicode terms, and no zero-score fallback", () => {
    const item = fixture("zero", ["ordinary"], ["needle"]);
    expect(serializeMessageCores("needle", [item.entry], boundaries(item), budget()).text).toBe("");
    expect(serializeMessageCores("", [item.entry], boundaries(item), budget()).selectedMessageIndices).toEqual([]);
    const unicode = fixture("unicode", ["ra\u0308v needle needle", "", "ordinary"]);
    const packed = serializeMessageCores("RÄV needle needle", [unicode.entry], boundaries(unicode), budget());
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "unicode", message_indices: [0, 1] }]);
    expect(packed.text).toContain("user: ra\u0308v needle needle\nuser: ");
  });
  it("retains retrieval-rank and message-index ties, regardless of score processing display order", () => {
    const first = fixture("a", ["needle ".repeat(10), "needle ".repeat(10)]);
    const second = fixture("b", ["needle ".repeat(10)]);
    const packed = serializeMessageCores("needle", [first.entry, second.entry], boundaries(first, second), budget(55));
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "a", message_indices: [0] }]);
    const low = fixture("low", ["needle ordinary"]);
    const high = fixture("high", ["needle"]);
    expect(serializeMessageCores("needle", [low.entry, high.entry], boundaries(low, high), budget()).orderedIds).toEqual(["low", "high"]);
  });
  it("counts UTF-8 render overhead while retaining complete UTF-16 source ranges", () => {
    const item = fixture("räv😀", ["needle 😀 ".repeat(100)]);
    const full = serializeMessageCores("needle", [item.entry], boundaries(item), budget());
    const tokens = Math.ceil(Buffer.byteLength(full.text, "utf8") / 4);
    expect(serializeMessageCores("needle", [item.entry], boundaries(item), budget(tokens)).selectedMessageIndices).toEqual(full.selectedMessageIndices);
    const tooSmall = serializeMessageCores("needle", [item.entry], boundaries(item), budget(tokens - 1));
    expect(tooSmall.selectedMessageIndices).toEqual([]);
    expect(full.selectedRanges.at(-1)?.end).toBe(item.entry.content.length);
    expect(Buffer.byteLength(full.text, "utf8")).toBeGreaterThan(full.text.length);
    const many = Array.from({ length: 10 }, (_, index) => fixture(`entry-${index}`, Array.from({ length: 9 }, () => "räv😀 needle ".repeat(100))));
    const packed = serializeMessageCores("räv needle", many.map((x) => x.entry), boundaries(...many), budget());
    expect(Buffer.byteLength(packed.text, "utf8")).toBeLessThanOrEqual(32768);
    expect(packed.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(packed.text, "utf8") / 4));
    expect(wholeMessageConservation(packed.selectedRanges, boundaries(...many)).partial_message_count).toBe(0);
  });
  it("handles empty sessions and rejects invalid budgets, duplicate IDs and boundary metadata", () => {
    const empty = fixture("empty", []);
    expect(serializeMessageCores("needle", [], new Map(), budget()).text).toBe("");
    expect(serializeMessageCores("needle", [empty.entry], boundaries(empty), budget()).text).toBe("");
    for (const n of [0, -1, 1.5, NaN, 8193]) expect(() => serializeMessageCores("needle", [], new Map(), budget(n))).toThrow(/budget/i);
    expect(() => serializeMessageCores("needle", [], new Map(), { ...budget(), overflowPolicy: "stop" })).toThrow(/budget/i);
    expect(() => serializeMessageCores("needle", [], new Map(), { ...budget(), estimator: "wrong" as never })).toThrow(/budget/i);
    expect(() => serializeMessageCores("needle", [empty.entry, empty.entry], boundaries(empty), budget())).toThrow(/unique/i);
    expect(() => serializeMessageCores("needle", [empty.entry], new Map(), budget())).toThrow(/boundar/i);
    expect(() => serializeMessageCores("needle", [empty.entry], new Map([["empty", { ...empty.boundary, entry_id: "other" }]]), budget())).toThrow(/boundar/i);
    expect(() => serializeMessageCores("needle", [empty.entry], new Map([["empty", { ...empty.boundary, content_sha256: "0".repeat(64) }]]), budget())).toThrow(/hash|content/i);
    const item = fixture("one", ["needle 😀"]);
    const invalid = { ...item.boundary, messages: [[item.boundary.prefix_end, item.boundary.prefix_end + 6, item.entry.content.length - 1]] as [number, number, number][] };
    expect(() => serializeMessageCores("needle", [item.entry], new Map([["one", invalid]]), budget())).toThrow(/boundar/i);
  });
});

it("measures all three pairs only after label-blind selection and keeps excluded-label accounting", () => {
  const gold = fixture("gold", ["a".repeat(40000), "needle", "b".repeat(40000)]);
  const unannotated = fixture("unannotated", ["ordinary"]);
  const entries = [gold.entry, unannotated.entry], source = boundaries(gold, unannotated), ids = entries.map((x) => x.id);
  const candidate = packCoreEvidence("q", "needle", ids, entries, source);
  const changedLabels = packCoreEvidence("q", "needle", ["different"], entries, source);
  expect(changedLabels.selected_ranges).toEqual(candidate.selected_ranges);
  expect(changedLabels.selected_message_indices).toEqual(candidate.selected_message_indices);
  const [, start, end] = gold.boundary.messages[1];
  const labels = new Map([["q", { query_id: "q", entries: [
    { entry_id: "gold", content_sha256: gold.boundary.content_sha256, turns: [{ message_index: 1, start, end }] },
    { entry_id: "unannotated", content_sha256: unannotated.boundary.content_sha256, turns: [] },
  ] }]]);
  const result = compareCoreRows([packEvidence("q", ids, entries)], [packPassageEvidence("q", "needle", ids, entries)], [packMessageEvidence("q", "needle", ids, entries, source)], [candidate], labels, [{ id: "q", category: "synthetic" } as BenchmarkQuery]);
  expect(result.versus_legacy.reference_strategy).toBe("legacy");
  expect(result.versus_passages.reference_strategy).toBe("query-passages-v1");
  expect(result.versus_neighbors.reference_strategy).toBe("query-message-neighbors-v1");
  expect(result.versus_neighbors.annotated_message_coverage).toMatchObject({ eligible_question_count: 0, excluded_question_ids: ["q"], gained_message_count: 1, lost_message_count: 0, candidate_packed: { all_turn_rate: null, covered_message_count: 1 } });
  expect(result.versus_neighbors.excluded_labels).toEqual({ question_count: 1, annotated_message_count: 1, no_positive_entry_count: 1 });
  expect(result.queries[0].selected_message_indices).toEqual(candidate.selected_message_indices);
  expect(result.whole_message_conservation).toEqual({ selected_message_count: 1, partial_message_count: 0 });
});
