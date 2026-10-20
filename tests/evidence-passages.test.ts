import { describe, expect, it } from "vitest";
import type { Entry } from "../src/types.js";
import { estimateContextTokens, serializeContext, serializeQueryPassages, serializeContextWithRanges, splitSourcePassages } from "../benchmark/answer-quality/serialize.js";
import { comparePassageRows, coveredGoldTurns, packEvidence, packPassageEvidence } from "../benchmark/evidence-metric/metric.js";
import type { GoldTurnQuery } from "../benchmark/evidence-metric/gold-turns.js";

const entry = (id: string, content: string): Entry => ({
  id, content, namespace: "fixture", key: id, entry_type: "state", tags: "[]", agent_id: "test",
  owner_principal_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  valid_from: "2026-01-01T00:00:00Z", valid_until: null, is_current: 1, classification: "internal",
  embedding_status: "generated", embedding_model: "fake/model", embedding_identity: "fake-identity",
});

describe("full original annotated-message coverage", () => {
  it("requires every character and accepts the union of adjacent selected spans", () => {
    const gold: GoldTurnQuery = { query_id: "q", entries: [{ entry_id: "a", content_sha256: "a".repeat(64), turns: [{ message_index: 2, start: 10, end: 30 }] }] };
    expect(coveredGoldTurns(gold, [{ entry_id: "a", start: 10, end: 29 }])).toEqual([]);
    expect(coveredGoldTurns(gold, [{ entry_id: "a", start: 11, end: 30 }])).toEqual([]);
    expect(coveredGoldTurns(gold, [{ entry_id: "a", start: 10, end: 20 }, { entry_id: "a", start: 20, end: 30 }])).toEqual([{ entry_id: "a", message_index: 2, start: 10, end: 30 }]);
    expect(coveredGoldTurns(gold, [{ entry_id: "a", start: 10, end: 19 }, { entry_id: "a", start: 20, end: 30 }])).toEqual([]);
  });
  it("reports paired turn gains and regressions independently of unchanged entry-ID proxy", () => {
    const entries = [entry("a", "needle\n" + "x".repeat(40000))];
    const control = ["gain", "loss", "unlabelled"].map((q) => packEvidence(q, ["a"], entries));
    const candidates = ["gain", "loss", "unlabelled"].map((q) => packPassageEvidence(q, "needle", ["a"], entries));
    // Use exact source provenance as inputs to exercise scorer separately from selection.
    candidates[0].selected_ranges = [{ entry_id: "a", start: 35000, end: 35010 }];
    candidates[1].selected_ranges = [{ entry_id: "a", start: 35000, end: 35010 }];
    const label = (id: string, turns: { message_index: number; start: number; end: number }[]): GoldTurnQuery => ({ query_id: id, entries: [{ entry_id: "a", content_sha256: "a".repeat(64), turns }] });
    const labels = new Map([
      ["gain", label("gain", [{ message_index: 0, start: 35000, end: 35010 }])],
      ["loss", label("loss", [{ message_index: 1, start: 0, end: 6 }])],
      ["unlabelled", label("unlabelled", [])],
    ]);
    const report = comparePassageRows(control, candidates, labels);
    expect(report.entry_id_proxy).toMatchObject({ gained_question_ids: [], lost_question_ids: [], regression: false });
    expect(report.annotated_message_coverage).toMatchObject({
      eligible_question_count: 2, eligible_question_ids: ["gain", "loss"], excluded_question_ids: ["unlabelled"],
      gained_question_ids: ["gain"], lost_question_ids: ["loss"], regression: true,
      retrieval: { all_turn_count: 2, all_turn_rate: 1, covered_message_count: 2 },
      legacy_packed: { all_turn_count: 1, all_turn_rate: 0.5, covered_message_count: 1 },
      candidate_packed: { all_turn_count: 1, all_turn_rate: 0.5, covered_message_count: 1 },
    });
    expect(report.queries[0].annotated_messages.gained_turns).toEqual([{ entry_id: "a", message_index: 0, start: 35000, end: 35010 }]);
    expect(report.queries[1].annotated_messages.lost_turns).toEqual([{ entry_id: "a", message_index: 1, start: 0, end: 6 }]);
    expect(report.queries[2].annotated_messages.legacy_all_turns).toBeNull();
    expect(report.queries[0].legacy_ranges[0].end).toBeLessThan(entries[0].content.length);
    expect(() => comparePassageRows(control, candidates, new Map())).toThrow(/annotation/i);
  });
});
const budget = { maxEstimatedTokens: 8192, estimator: "utf8_bytes_div4_ceil_v1" as const };

describe("query-passages-v1 serialization", () => {
  it("partitions exact source text at newline boundaries and Unicode-safe overlong lines", () => {
    const text = "å".repeat(1023) + "\n" + "😀".repeat(1300) + "\r\nlast\n";
    const ranges = splitSourcePassages(text);
    expect(ranges[0]).toEqual({ start: 0, end: 1024 });
    expect(ranges.map(({ start, end }) => text.slice(start, end)).join("")).toBe(text);
    expect(ranges.every(({ start, end }) => Buffer.byteLength(text.slice(start, end), "utf8") <= 2048)).toBe(true);
    expect(ranges.every(({ start, end }, i) => start === (i === 0 ? 0 : ranges[i - 1].end) && end > start)).toBe(true);
    expect(ranges.map(({ start, end }) => text.slice(start, end)).join("")).not.toContain("�");
    expect(splitSourcePassages("x".repeat(2048) + "y")).toEqual([{ start: 0, end: 2048 }, { start: 2048, end: 2049 }]);
    expect(splitSourcePassages("")).toEqual([]);
  });
  it("uses query terms only and ranks unique overlap with length normalization", () => {
    const entries = [entry("id-needle", "needle noise clutter"), entry("b", "needle needle needle")];
    const one = serializeQueryPassages("NEEDLE needle", entries, { ...budget, maxEstimatedTokens: 30 });
    expect(one.orderedIds).toEqual(["b"]);
    expect(one.text).toContain("needle needle needle");
    const metadata = [entry("needle", "plain"), entry("b", "needle")];
    expect(serializeQueryPassages("needle", metadata, { ...budget, maxEstimatedTokens: 25 }).orderedIds).toEqual(["b"]);
    // Neither repeated query terms nor metadata IDs influence the selected source.
    expect(serializeQueryPassages("needle", entries, { ...budget, maxEstimatedTokens: 30 })).toEqual(one);
  });
  it("charges every UTF8 byte including headers and source-range labels", () => {
    const entries = [entry("å", "😀 nål")];
    const whole = serializeQueryPassages("nål", entries, budget);
    const tokens = estimateContextTokens(whole.text);
    expect(serializeQueryPassages("nål", entries, { ...budget, maxEstimatedTokens: tokens })).toEqual({ ...whole, budget: { ...whole.budget, max_estimated_tokens: tokens } });
    const short = serializeQueryPassages("nål", entries, { ...budget, maxEstimatedTokens: tokens - 1 });
    expect(short.text).toBe("");
    expect(short.selectedRanges).toEqual([]);
    expect(short.estimatedTokens).toBe(0);
    expect(() => serializeQueryPassages("x", entries, { ...budget, maxEstimatedTokens: 0 })).toThrow(/budget/i);
    expect(() => serializeQueryPassages("x", entries, { ...budget, maxEstimatedTokens: 8193 })).toThrow(/budget/i);
    expect(serializeQueryPassages("x", [], { ...budget, maxEstimatedTokens: 1 }).estimatedTokens).toBeLessThanOrEqual(1);
  });
  it("coalesces adjacent chunks, then renders in retrieval/source order deterministically", () => {
    const a = "first\n" + "x".repeat(2040) + "\nneedle\n" + "second\n";
    const entries = [entry("a", a), entry("b", "needle needle")];
    const result = serializeQueryPassages("needle", entries, budget);
    expect(result.orderedIds).toEqual(["a", "b"]);
    expect(result.selectedRanges).toEqual([{ entry_id: "a", start: 0, end: a.length }, { entry_id: "b", start: 0, end: 13 }]);
    expect(result.text.indexOf("first")).toBeLessThan(result.text.indexOf("needle needle"));
    expect(result.text).toContain(`[source utf16 0:${a.length}]\n${a}`);
    expect(result.estimatedTokens).toBe(estimateContextTokens(result.text));
    expect(serializeQueryPassages("needle", entries, budget)).toEqual(result);
    const tied = serializeQueryPassages("absent", [entry("z", "first"), entry("a", "second")], { ...budget, maxEstimatedTokens: 25 });
    expect(tied.orderedIds).toEqual(["z"]);
  });
  it("keeps legacy output bit-identical while exposing the actual truncated content prefix", () => {
    const entries = [entry("a", "😀".repeat(10000)), entry("b", "answer")];
    const before = serializeContext(entries, "linear", budget);
    const { context, selectedRanges } = serializeContextWithRanges(entries, "linear", budget);
    expect(context).toEqual(before);
    expect(selectedRanges).toHaveLength(1);
    const range = selectedRanges[0];
    expect(range.entry_id).toBe("a");
    expect(range.start).toBe(0);
    expect(range.end).toBeLessThan(entries[0].content.length);
    expect(context.text.endsWith(entries[0].content.slice(0, range.end))).toBe(true);
    expect(Buffer.byteLength(context.text, "utf8")).toBeLessThanOrEqual(8192 * 4);
    expect(context.text).not.toContain("�");
  });
  it("preserves source order for discontiguous selections and ignores gold IDs during selection", () => {
    const first = "needle " + "a".repeat(2040) + "\n";
    const middle = "x".repeat(2047) + "\n";
    const last = "needle target " + "b".repeat(2033) + "\n";
    const entries = [entry("a", first + middle + last)];
    const result = serializeQueryPassages("needle target", entries, { ...budget, maxEstimatedTokens: 1100 });
    expect(result.selectedRanges).toEqual([{ entry_id: "a", start: 0, end: 2048 }, { entry_id: "a", start: 4096, end: 6144 }]);
    expect(result.text.indexOf(first)).toBeLessThan(result.text.indexOf(last));
    expect(result.text).not.toContain(middle);
    expect(packPassageEvidence("q", "needle", ["a"], entries).selected_ranges).toEqual(packPassageEvidence("q", "needle", ["different-gold"], entries).selected_ranges);
  });
});
