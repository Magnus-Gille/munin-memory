import { describe, it, expect } from "vitest";
import {
  recallAtK,
  mrr,
  ndcgAtK,
  scoreQuery,
  aggregateScores,
} from "../benchmark/scorer.js";

describe("recallAtK", () => {
  it("returns 1 when all expected entries are in top-k", () => {
    expect(recallAtK(["a", "b", "c", "d", "e"], ["a", "c"], 5)).toBe(1);
  });

  it("returns 0.5 when half of expected entries are in top-k", () => {
    expect(recallAtK(["a", "b", "c", "d", "e"], ["a", "f"], 5)).toBe(0.5);
  });

  it("returns 0 when no expected entries are in top-k", () => {
    expect(recallAtK(["a", "b", "c", "d", "e"], ["x", "y"], 5)).toBe(0);
  });

  it("respects the k cutoff", () => {
    // "c" is at position 3 — inside top-3 but the expected "d" is at position 4
    expect(recallAtK(["a", "b", "c", "d", "e"], ["c", "d"], 3)).toBe(0.5);
  });

  it("handles k=1", () => {
    expect(recallAtK(["a", "b", "c"], ["a"], 1)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["b"], 1)).toBe(0);
  });

  it("returns 0 for empty expected set (no ground truth)", () => {
    expect(recallAtK(["a", "b"], [], 5)).toBe(0);
  });

  it("handles empty result set", () => {
    expect(recallAtK([], ["a", "b"], 5)).toBe(0);
  });

  it("handles k larger than result set", () => {
    expect(recallAtK(["a", "b"], ["a", "b"], 10)).toBe(1);
  });
});

describe("mrr", () => {
  it("returns 1 when first result is relevant", () => {
    expect(mrr(["a", "b", "c"], ["a"])).toBe(1);
  });

  it("returns 0.5 when second result is first relevant", () => {
    expect(mrr(["a", "b", "c"], ["b"])).toBe(0.5);
  });

  it("returns 1/3 when third result is first relevant", () => {
    expect(mrr(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3);
  });

  it("returns 0 when no results are relevant", () => {
    expect(mrr(["a", "b", "c"], ["x"])).toBe(0);
  });

  it("returns rank of first relevant, not best relevant", () => {
    // Both b and c are relevant, but b comes first at rank 2
    expect(mrr(["a", "b", "c"], ["b", "c"])).toBe(0.5);
  });

  it("handles empty results", () => {
    expect(mrr([], ["a"])).toBe(0);
  });

  it("handles empty expected", () => {
    // No expected = nothing to find
    expect(mrr(["a", "b"], [])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("returns 1 for perfect binary ranking", () => {
    // Expected: a, b — both at top
    expect(ndcgAtK(["a", "b", "c", "d", "e"], ["a", "b"], 5)).toBe(1);
  });

  it("returns 1 when all expected are at top regardless of order", () => {
    // b before a, but both in top-2 — still perfect for binary relevance
    expect(ndcgAtK(["b", "a", "c", "d", "e"], ["a", "b"], 5)).toBe(1);
  });

  it("returns < 1 when relevant items are pushed down", () => {
    // Expected a,b but they appear at positions 3,4
    const score = ndcgAtK(["x", "y", "a", "b", "z"], ["a", "b"], 5);
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 when no expected items appear in top-k", () => {
    expect(ndcgAtK(["x", "y", "z"], ["a", "b"], 3)).toBe(0);
  });

  it("returns 0 for empty expected set (no ground truth)", () => {
    expect(ndcgAtK(["a", "b"], [], 5)).toBe(0);
  });

  it("uses graded relevance with idealRanking", () => {
    // Ideal: a at rank 1 (grade 2), b at rank 2 (grade 1)
    const idealRanking = { a: 1, b: 2 };

    // Perfect: a first, b second
    const perfect = ndcgAtK(["a", "b", "c"], ["a", "b"], 5, idealRanking);
    // Swapped: b first, a second
    const swapped = ndcgAtK(["b", "a", "c"], ["a", "b"], 5, idealRanking);

    expect(perfect).toBe(1);
    expect(swapped).toBeLessThan(1);
    expect(swapped).toBeGreaterThan(0);
  });
});

describe("scoreQuery", () => {
  it("computes all metrics at once", () => {
    const result = scoreQuery({
      resultIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      expectedIds: ["a", "c"],
    });

    expect(result.recallAt1).toBe(0.5); // a is at rank 1
    expect(result.recallAt5).toBe(1); // a and c both in top 5
    expect(result.recallAt10).toBe(1);
    // NDCG < 1 because c is at position 3, not 2 (ideal would be a,c at 1,2)
    expect(result.ndcgAt5).toBeGreaterThan(0.9);
    expect(result.ndcgAt5).toBeLessThan(1);
    expect(result.mrr).toBe(1); // a at rank 1
  });

  it("handles no results", () => {
    const result = scoreQuery({
      resultIds: [],
      expectedIds: ["a"],
    });
    expect(result.recallAt1).toBe(0);
    expect(result.recallAt5).toBe(0);
    expect(result.recallAt10).toBe(0);
    expect(result.ndcgAt5).toBe(0);
    expect(result.mrr).toBe(0);
  });
});

describe("aggregateScores", () => {
  it("computes macro-average across queries", () => {
    const scores = [
      { recallAt1: 1, recallAt5: 1, recallAt10: 1, ndcgAt5: 1, mrr: 1 },
      { recallAt1: 0, recallAt5: 0, recallAt10: 0, ndcgAt5: 0, mrr: 0 },
    ];
    const agg = aggregateScores(scores);
    expect(agg.recallAt1).toBe(0.5);
    expect(agg.recallAt5).toBe(0.5);
    expect(agg.recallAt10).toBe(0.5);
    expect(agg.ndcgAt5).toBe(0.5);
    expect(agg.mrr).toBe(0.5);
  });

  it("returns zeros for empty input", () => {
    const agg = aggregateScores([]);
    expect(agg.recallAt1).toBe(0);
    expect(agg.mrr).toBe(0);
  });

  it("handles single query", () => {
    const scores = [{ recallAt1: 0.5, recallAt5: 1, recallAt10: 1, ndcgAt5: 0.8, mrr: 0.5 }];
    const agg = aggregateScores(scores);
    expect(agg.recallAt1).toBe(0.5);
    expect(agg.ndcgAt5).toBe(0.8);
  });
});
