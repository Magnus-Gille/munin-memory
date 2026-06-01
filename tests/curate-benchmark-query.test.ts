import { describe, it, expect } from "vitest";
import {
  blessCandidate,
  mergeIntoQuerySet,
  formatCandidateForReview,
} from "../scripts/curate-benchmark-query.js";
import type { DerivedCandidate } from "../scripts/derive-benchmark-queries.js";
import type { BenchmarkQuery } from "../benchmark/types.js";

function candidate(over: Partial<DerivedCandidate> = {}): DerivedCandidate {
  return {
    id: "derived-abc123",
    query: "atlas phase two status",
    source: "derived",
    category: "project-status",
    search_mode: "hybrid",
    expected_ids: ["entry-atlas"],
    negatives: ["bad-1"],
    support: 3,
    signals: { opened_result: 3, namespace_action: 0, good_feedback: 0, corrective_feedback: 0, reformulated: 1 },
    notes: "derived (support 3): 3 opened_result, 1 reformulation",
    ...over,
  };
}

describe("blessCandidate", () => {
  it("strips provenance fields but keeps the benchmark query shape", () => {
    const blessed = blessCandidate(candidate());
    expect(blessed).not.toHaveProperty("support");
    expect(blessed).not.toHaveProperty("signals");
    expect(blessed.id).toBe("derived-abc123");
    expect(blessed.query).toBe("atlas phase two status");
    expect(blessed.source).toBe("derived");
    expect(blessed.expected_ids).toEqual(["entry-atlas"]);
    expect(blessed.negatives).toEqual(["bad-1"]);
  });

  it("applies edits passed in (category, search_mode, query)", () => {
    const blessed = blessCandidate(candidate(), {
      category: "decision-lookup",
      search_mode: "lexical",
      query: "edited query",
    });
    expect(blessed.category).toBe("decision-lookup");
    expect(blessed.search_mode).toBe("lexical");
    expect(blessed.query).toBe("edited query");
  });
});

describe("mergeIntoQuerySet", () => {
  const existing: BenchmarkQuery[] = [
    { id: "m-1", query: "existing", source: "manual", category: "project-status", search_mode: "hybrid" },
  ];

  it("appends new queries and reports what was added", () => {
    const { merged, added, skipped } = mergeIntoQuerySet(existing, [blessCandidate(candidate())]);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
    expect(skipped).toBe(0);
    expect(merged.map((q) => q.id)).toContain("derived-abc123");
  });

  it("skips a candidate whose id already exists (idempotent re-bless)", () => {
    const dup = blessCandidate(candidate({ id: "m-1" }));
    const { merged, added, skipped } = mergeIntoQuerySet(existing, [dup]);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });
});

describe("formatCandidateForReview", () => {
  it("renders the query, ground truth, and signal provenance", () => {
    const text = formatCandidateForReview(candidate(), 1, 4);
    expect(text).toContain("[1/4]");
    expect(text).toContain("atlas phase two status");
    expect(text).toContain("entry-atlas");
    expect(text).toContain("support 3");
  });
});
