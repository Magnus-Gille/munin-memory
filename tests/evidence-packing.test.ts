import { describe, expect, it } from "vitest";
import type { Entry } from "../src/types.js";
import { estimateContextTokens, serializeContext } from "../benchmark/answer-quality/serialize.js";
import { comparePackingRows, packEvidence, validateCandidateRows, validateRows } from "../benchmark/evidence-metric/metric.js";
const entry = (id: string, content: string): Entry => ({
  id, content, namespace: "fixture", key: id, entry_type: "state", tags: "[]", agent_id: "test",
  owner_principal_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  valid_from: "2026-01-01T00:00:00Z", valid_until: null, is_current: 1, classification: "internal",
  embedding_status: "generated", embedding_model: "fake/model", embedding_identity: "fake-identity",
});
const budget = { maxEstimatedTokens: 8192, estimator: "utf8_bytes_div4_ceil_v1" as const };
const candidate = (entries: Entry[]) => serializeContext(entries, "linear", { ...budget, overflowPolicy: "skip-oversized" });
describe("opt-in whole-entry packing", () => {
  it("skips oversized first entries whole and preserves the default first-item truncation", () => {
    const entries = [entry("large", "x".repeat(40000)), entry("small", "needle")];
    const legacy = serializeContext(entries, "linear", budget);
    expect(legacy).toEqual(serializeContext(entries, "linear", { ...budget, overflowPolicy: "stop" }));
    expect(legacy.orderedIds).toEqual(["large"]);
    expect(legacy.budget.estimated_tokens).toBe(8192);
    expect(candidate(entries).orderedIds).toEqual(["small"]);
    expect(candidate(entries).text).toContain("[1] fixture/small");
    expect(candidate(entries).text).not.toContain("xxx");
    expect(candidate(entries).budget).toMatchObject({ truncated: true, candidate_entry_count: 2, included_entry_count: 1, dropped_entry_count: 1 });
    expect(candidate([entries[0]]).text).toBe("");
    expect(candidate([entries[0]]).orderedIds).toEqual([]);
  });
  it("continues after a middle overflow preserving order and previously packed entries", () => {
    const entries = [entry("a", "a".repeat(20000)), entry("big", "x".repeat(20000)), entry("b", "b")];
    expect(serializeContext(entries, "linear", budget).orderedIds).toEqual(["a"]);
    expect(candidate(entries).orderedIds).toEqual(["a", "b"]);
    expect(candidate(entries).text).toContain("[2] fixture/b");
    expect(candidate(entries).estimatedTokens).toBeLessThanOrEqual(8192);
  });
  it("preserves all-fit/empty behavior and charges exact UTF8 headers and separators", () => {
    const entries = [entry("a", "å😀"), entry("b", "ö😀")];
    expect(candidate(entries)).toEqual(serializeContext(entries, "linear", budget));
    expect(candidate([])).toEqual(serializeContext([], "linear", budget));
    const tokens = Math.ceil(Buffer.byteLength(serializeContext(entries, "linear").text, "utf8") / 4);
    const exact = serializeContext(entries, "linear", { ...budget, maxEstimatedTokens: tokens, overflowPolicy: "skip-oversized" });
    expect(exact.orderedIds).toEqual(["a", "b"]);
    expect(estimateContextTokens(exact.text)).toBe(tokens);
    expect(serializeContext(entries, "linear", { ...budget, maxEstimatedTokens: tokens - 1, overflowPolicy: "skip-oversized" }).orderedIds).toEqual(["a"]);
    expect(() => serializeContext(entries, "linear", { ...budget, overflowPolicy: "invented" as "stop" })).toThrow(/policy/i);
  });
  it("validates candidate ordered subsequences separately from unchanged v1 prefix rows", () => {
    const row = packEvidence("q", ["gold"], [entry("large", "x".repeat(40000)), entry("gold", "needle")], "skip-oversized");
    expect(() => validateRows([row])).toThrow(/evidence IDs/);
    expect(validateCandidateRows([row])).toEqual([row]);
    const all = packEvidence("q", ["gold"], [entry("a", "a"), entry("gold", "needle")], "skip-oversized");
    expect(() => validateCandidateRows([{ ...all, packed_ids: ["gold", "a"] }])).toThrow(/evidence IDs/);
    expect(() => validateCandidateRows([{ ...all, budget: { ...all.budget, estimated_tokens: 8193 } }])).toThrow(/budget/);
  });
  it("reports stage counts and paired losses despite a net gain", () => {
    const cases = [
      { id: "gain1", gold: ["small"], entries: [entry("large", "x".repeat(40000)), entry("small", "s")] },
      { id: "gain2", gold: ["small"], entries: [entry("large", "x".repeat(40000)), entry("small", "s")] },
      { id: "loss", gold: ["large"], entries: [entry("large", "x".repeat(40000)), entry("small", "s")] },
      { id: "partial", gold: ["small", "absent"], entries: [entry("large", "x".repeat(40000)), entry("small", "s")] },
      { id: "none", gold: ["absent"], entries: [] },
    ];
    const control = cases.map(({ id, gold, entries }) => packEvidence(id, gold, entries));
    const alternate = cases.map(({ id, gold, entries }) => packEvidence(id, gold, entries, "skip-oversized"));
    const comparison = comparePackingRows(control, alternate);
    expect(comparison.stages).toEqual({ retrieval: { all_gold: 3, partial_gold: 1, no_gold: 1 }, legacy_packed: { all_gold: 1, partial_gold: 0, no_gold: 4 }, candidate_packed: { all_gold: 2, partial_gold: 1, no_gold: 2 } });
    expect(comparison.gained_question_ids).toEqual(["gain1", "gain2"]);
    expect(comparison.lost_question_ids).toEqual(["loss"]);
    expect(comparison.regression).toBe(true);
    expect(comparison.queries.find((q) => q.query_id === "loss")).toMatchObject({ gained_ids: [], lost_ids: ["large"], candidate_packed_ids: ["small"], candidate_budget: { max_estimated_tokens: 8192 } });
    expect(comparison.queries.find((q) => q.query_id === "partial")).toMatchObject({ retrieval_stage: "partial_gold", legacy_packed_stage: "no_gold", candidate_packed_stage: "partial_gold", gained_ids: ["small"] });
    expect(() => comparePackingRows(control, alternate.map((r, i) => i === 0 ? { ...r, retrieved_ids: ["small", "large"] } : r))).toThrow(/same retrieved/i);
  });
});
