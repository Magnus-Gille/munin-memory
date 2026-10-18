import { describe, expect, it } from "vitest";
import type { Entry } from "../src/types.js";
import { packEvidence, validateQueries, validateVectors, compareRows } from "../benchmark/evidence-metric/metric.js";
import { withFrozenClock } from "../benchmark/evidence-metric/clock.js";

const entry = (id: string, content: string): Entry => ({
  id, content, namespace: "fixture", key: id, entry_type: "state", tags: "[]", agent_id: "test",
  owner_principal_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  valid_from: "2026-01-01T00:00:00Z", valid_until: null, is_current: 1, classification: "internal",
  embedding_status: "generated", embedding_model: "fake/model", embedding_identity: "fake-identity",
});
const query = { id: "q1", query: "needle", source: "synthetic", expected_ids: ["gold"], search_mode: "hybrid" };

describe("packed entry-ID evidence", () => {
  it("distinguishes retrieval from gold outside the packing budget", () => {
    const row = packEvidence("q1", ["gold"], [entry("big", "x".repeat(32700)), entry("gold", "needle")]);
    expect(row.retrieved_ids).toEqual(["big", "gold"]);
    expect(row.packed_ids).toEqual(["big"]);
    expect(row.all_gold).toBe(false);
    expect(row.budget.truncated).toBe(true);
  });
  it("counts a partial first block as ID presence and reports truncation", () => {
    const row = packEvidence("q1", ["gold"], [entry("gold", "x".repeat(40000))]);
    expect(row.all_gold).toBe(true);
    expect(row.budget.truncated).toBe(true);
    expect(row.budget.estimated_tokens).toBeLessThanOrEqual(8192);
  });
  it.each([
    [], [{ ...query, expected_ids: [] }], [{ ...query, expected_ids: undefined, expected_namespaces: ["fixture"] }],
    [query, query], [{ ...query, id: " " }], [{ ...query, expected_ids: ["gold", "gold"] }],
    [{ ...query, search_mode: "lexical" }], [{ ...query, query: " " }], [{ ...query, source: undefined }], [{ ...query, source: "invented" }],
  ])("rejects invalid or absent explicit gold %#", (value) => {
    expect(() => validateQueries(value)).toThrow();
  });
  it("reports partial ID changes without claiming a lost all-gold question", () => {
    const before = packEvidence("q1", ["a", "b"], [entry("a", "needle")]);
    const after = packEvidence("q1", ["a", "b"], []);
    const comparison = compareRows([before], [after]);
    expect(comparison.regression).toBe(false);
    expect(comparison.lost_question_ids).toEqual([]);
    expect(comparison.queries[0].lost_ids).toEqual(["a"]);
  });
  it("requires frozen vectors with raw query hash and exact provenance", () => {
    const queries = validateQueries([query]);
    const valid = { schema_version: 1, query_set_sha256: "a".repeat(64), model: "fake/model", identity: "identity", dimensions: 2, vectors: { q1: [1, 0] } };
    expect(validateVectors(valid, queries, "a".repeat(64)).identity).toBe("identity");
    for (const invalid of [
      { ...valid, schema_version: 2 }, { ...valid, identity: " " }, { ...valid, query_set_sha256: "b".repeat(64) },
      { ...valid, dimensions: 3 }, { ...valid, vectors: {} }, { ...valid, vectors: { q1: [Infinity, 0] } }, { ...valid, vectors: { q1: [1e300, 0] } },
    ]) expect(() => validateVectors(invalid, queries, "a".repeat(64))).toThrow();
    expect(() => validateVectors({ ...valid, vectors: { q1: [1, 0], q2: [0, 1] } }, validateQueries([query, { ...query, id: "q2" }]), "a".repeat(64))).toThrow(/identical/);
  });
  it("pairs by ID and treats per-question losses as regression despite offsetting gains", () => {
    const a = packEvidence("a", ["gold"], [entry("gold", "needle")]);
    const b = packEvidence("b", ["gold"], []);
    expect(compareRows([a, b], [b, a]).regression).toBe(false);
    const comparison = compareRows([a, b], [{ ...b, query_id: "a" }, { ...a, query_id: "b" }]);
    expect(comparison.regression).toBe(true);
    expect(comparison.lost_question_ids).toEqual(["a"]);
    expect(comparison.gained_question_ids).toEqual(["b"]);
    expect(comparison.queries.find((q) => q.query_id === "a")?.lost_ids).toEqual(["gold"]);
    expect(comparison.queries.find((q) => q.query_id === "b")?.gained_ids).toEqual(["gold"]);
    expect(() => compareRows([a], [a, a])).toThrow();
    expect(() => compareRows([a], [b])).toThrow();
  });
});

describe("benchmark-only frozen clock", () => {
  it("freezes construction, calls and now, restores after failure, and rejects overlap", async () => {
    const nativeDate = Date;
    const asOf = "2026-01-01T12:00:00.000Z";
    await expect(withFrozenClock(asOf, async () => {
      expect(new Date().toISOString()).toBe(asOf);
      expect(Date.now()).toBe(nativeDate.parse(asOf));
      expect(Date()).toBe(new nativeDate(asOf).toString());
      expect(new Date("2000-01-01").getUTCFullYear()).toBe(2000);
      await expect(withFrozenClock(asOf, async () => undefined)).rejects.toThrow(/overlap/);
      throw new Error("fixture failure");
    })).rejects.toThrow("fixture failure");
    expect(Date).toBe(nativeDate);
  });
});
