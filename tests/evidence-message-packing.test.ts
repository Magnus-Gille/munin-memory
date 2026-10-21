import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Entry } from "../src/types.js";
import { serializeMessageNeighbors } from "../benchmark/answer-quality/message-packing.js";
import type { MessageBoundaryEntry } from "../benchmark/evidence-metric/message-boundaries.js";
import { compareMessageRows, packMessageEvidence, wholeMessageConservation } from "../benchmark/evidence-metric/message-comparison.js";
import { packEvidence, packPassageEvidence } from "../benchmark/evidence-metric/metric.js";
import type { BenchmarkQuery } from "../benchmark/types.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const budget = (maxEstimatedTokens = 8192) => ({ maxEstimatedTokens, estimator: "utf8_bytes_div4_ceil_v1" as const });
function fixture(id: string, messages: string[], roles = messages.map(() => "user")) {
  const prefix = `Session ID: ${id}\nConversation:${messages.length ? "\n" : ""}`;
  let content = prefix;
  const tuples: [number, number, number][] = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0) content += "\n";
    const start = content.length;
    content += `${roles[index]}: `;
    const contentStart = content.length;
    content += message;
    tuples.push([start, contentStart, content.length]);
  }
  const entry = { id, namespace: "fixture", key: id, content, created_at: "2026-01-01", updated_at: "2026-01-01" } as Entry;
  const boundary: MessageBoundaryEntry = { entry_id: id, content_sha256: digest(content), prefix_end: prefix.length, messages: tuples };
  return { entry, boundary };
}
const boundaries = (...items: ReturnType<typeof fixture>[]) => new Map(items.map((item) => [item.entry.id, item.boundary]));

describe("query-message-neighbors-v1", () => {
  it("keeps the full anchor and both neighbors with original multiline role-looking content", () => {
    const item = fixture("one", ["x".repeat(2000), "before", "needle\nassistant: quoted\nuser: literal 😀", "after", "y".repeat(2000)]);
    const packed = serializeMessageNeighbors("needle", [item.entry], boundaries(item), budget(130));
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "one", message_indices: [1, 2, 3] }]);
    expect(packed.text).toContain("user: before\nuser: needle\nassistant: quoted\nuser: literal 😀\nuser: after");
    expect(packed.selectedRanges).toEqual([
      { entry_id: "one", start: 0, end: item.boundary.prefix_end },
      { entry_id: "one", start: item.boundary.messages[1][0], end: item.boundary.messages[3][2] },
    ]);
  });
  it("skips an oversized bundle atomically without truncation or smaller fallback", () => {
    const huge = fixture("huge", ["a".repeat(40000), "needle", "b".repeat(40000)]);
    const small = fixture("small", ["ordinary"]);
    const packed = serializeMessageNeighbors("needle", [huge.entry, small.entry], boundaries(huge, small), budget());
    expect(packed.orderedIds).toEqual(["small"]);
    expect(packed.text).not.toContain("needle");
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "small", message_indices: [0] }]);
  });
  it("unions overlapping bundles once and preserves source order", () => {
    const item = fixture("one", ["needle", "needle", "needle", "needle"]);
    const packed = serializeMessageNeighbors("needle", [item.entry], boundaries(item), budget());
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "one", message_indices: [0, 1, 2, 3] }]);
    expect(packed.text.match(/user: needle/g)).toHaveLength(4);
    expect(packed.selectedRanges).toHaveLength(2);
  });
  it("breaks equal scores by retrieval rank and message index, including zero scores", () => {
    const first = fixture("a", ["one", "two", "z".repeat(1000)]);
    const second = fixture("b", ["one", "two"]);
    const packed = serializeMessageNeighbors("absent", [first.entry, second.entry], boundaries(first, second), budget(52));
    expect(packed.orderedIds).toEqual(["a"]);
    expect(packed.selectedMessageIndices).toEqual([{ entry_id: "a", message_indices: [0, 1] }]);
  });
  it("uses unique Unicode terms and excludes role prefixes from scores", () => {
    const roleOnly = fixture("role", ["word".repeat(50)], ["needle"]);
    const unicode = fixture("unicode", ["räv 😀 needle needle"]);
    const packed = serializeMessageNeighbors("RÄV needle needle", [roleOnly.entry, unicode.entry], boundaries(roleOnly, unicode), budget(55));
    expect(packed.orderedIds).toEqual(["unicode"]);
    expect(packed.text).toContain("räv 😀 needle needle");
  });
  it("counts every UTF-8 header, range label and separator byte within the exact budget", () => {
    const items = Array.from({ length: 10 }, (_, index) => fixture(`entry-${index}`, Array.from({ length: 9 }, () => "räv😀 ".repeat(100))));
    const packed = serializeMessageNeighbors("räv", items.map((item) => item.entry), boundaries(...items), budget());
    expect(Buffer.byteLength(packed.text, "utf8")).toBeLessThanOrEqual(8192 * 4);
    expect(packed.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(packed.text, "utf8") / 4));
    expect(packed.budget.estimated_tokens).toBe(packed.estimatedTokens);
    expect(packed.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it("renders no context for empty entries or an empty session and fails closed on invalid boundaries", () => {
    const item = fixture("empty", []);
    expect(serializeMessageNeighbors("x", [], new Map(), budget()).text).toBe("");
    expect(serializeMessageNeighbors("x", [item.entry], boundaries(item), budget()).text).toBe("");
    expect(() => serializeMessageNeighbors("x", [item.entry], new Map(), budget())).toThrow(/boundar/i);
    const wrong = new Map([["empty", { ...item.boundary, content_sha256: "0".repeat(64) }]]);
    expect(() => serializeMessageNeighbors("x", [item.entry], wrong, budget())).toThrow(/hash|content/i);
    expect(() => serializeMessageNeighbors("x", [], new Map(), budget(8193))).toThrow(/budget/i);
  });
  it("accepts an empty message as a whole source message with its role prefix", () => {
    const item = fixture("empty-message", ["", "needle", ""]);
    const packed = serializeMessageNeighbors("needle", [item.entry], boundaries(item), budget());
    expect(packed.selectedMessageIndices[0].message_indices).toEqual([0, 1, 2]);
    expect(packed.text).toContain("user: \nuser: needle\nuser: ");
    expect(wholeMessageConservation(packed.selectedRanges, boundaries(item))).toEqual({ selected_message_count: 3, partial_message_count: 0 });
  });
  it("derives partial-message conservation independently from the selected index list", () => {
    const item = fixture("one", ["first 😀", "last"]);
    expect(wholeMessageConservation([{ entry_id: "one", start: item.boundary.messages[0][0], end: item.boundary.messages[0][2] - 1 }], boundaries(item))).toEqual({ selected_message_count: 0, partial_message_count: 1 });
  });
  it("counts every labeled-message loss on excluded questions while excluding their question rate", () => {
    const gold = fixture("gold", ["a".repeat(40000), "needle", "b".repeat(40000)]);
    const unannotated = fixture("unannotated", ["ordinary"]);
    const entries = [gold.entry, unannotated.entry]; const source = boundaries(gold, unannotated);
    const ids = entries.map((entry) => entry.id);
    const legacy = [packEvidence("q", ids, entries)];
    const passages = [packPassageEvidence("q", "needle", ids, entries)];
    const candidate = [packMessageEvidence("q", "needle", ids, entries, source)];
    const [, start, end] = gold.boundary.messages[1];
    const labels = new Map([["q", { query_id: "q", entries: [
      { entry_id: "gold", content_sha256: gold.boundary.content_sha256, turns: [{ message_index: 1, start, end }] },
      { entry_id: "unannotated", content_sha256: unannotated.boundary.content_sha256, turns: [] },
    ] }]]);
    const result = compareMessageRows(legacy, passages, candidate, labels, [{ id: "q", category: "excluded-category" } as BenchmarkQuery]);
    expect(result.versus_passages.annotated_message_coverage).toMatchObject({ eligible_question_count: 0, excluded_question_ids: ["q"], annotated_message_count: 1, lost_question_ids: [], lost_message_count: 1, reference_packed: { all_turn_count: 0, all_turn_rate: null, covered_message_count: 1 } });
    expect(result.versus_passages.excluded_labels).toEqual({ question_count: 1, annotated_message_count: 1, no_positive_entry_count: 1 });
    expect(result.versus_passages.categories["excluded-category"].annotated_message_coverage.lost_message_count).toBe(1);
    expect(result.versus_passages.queries[0].annotated_messages.lost_turns).toEqual([{ entry_id: "gold", message_index: 1, start, end }]);
  });
});
