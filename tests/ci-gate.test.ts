import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareToBaseline,
  formatVerdict,
  validateBaseline,
  GATED_METRICS,
  DEFAULT_GATE_TOLERANCE,
  type GateBaseline,
  type GatedScores,
} from "../benchmark/ci-gate-policy.js";
import {
  runCiGate,
  makeBaseline,
  isVecAvailable,
  DEFAULT_HYBRID_PATHS,
} from "../benchmark/ci-gate.js";

interface FrozenFixture {
  model: string;
  dim: number;
  generated_at: string;
  corpus: Record<string, number[]>;
  queries: Record<string, number[]>;
}

// Probe vec at collection time, mirroring tests/embeddings.test.ts. The hybrid
// gate skips (not fails) where sqlite-vec is unavailable, so its tests do too.
const vecAvailable = isVecAvailable();

const PERFECT: GatedScores = {
  recallAt1: 1,
  recallAt5: 1,
  recallAt10: 1,
  ndcgAt5: 1,
  mrr: 1,
};

function baselineOf(overall: GatedScores): GateBaseline {
  return {
    baseline_schema_version: 1,
    generated_at: "2026-01-01T00:00:00.000Z",
    corpus_sha256: "corpus-hash",
    query_set_checksum: "query-hash",
    query_count: 15,
    overall,
  };
}

describe("compareToBaseline policy", () => {
  it("passes when current equals baseline", () => {
    const v = compareToBaseline(PERFECT, baselineOf(PERFECT));
    expect(v.pass).toBe(true);
    expect(v.regressions).toHaveLength(0);
  });

  it("passes when current improves over baseline", () => {
    const baseline = baselineOf({ ...PERFECT, recallAt5: 0.8, mrr: 0.7 });
    const v = compareToBaseline(PERFECT, baseline);
    expect(v.pass).toBe(true);
    expect(v.regressions).toHaveLength(0);
    // The improved metrics show a positive delta.
    expect(v.deltas.find((d) => d.metric === "mrr")!.delta).toBeCloseTo(0.3, 6);
  });

  it("fails when any single metric regresses beyond tolerance", () => {
    const current = { ...PERFECT, recallAt5: 0.9 };
    const v = compareToBaseline(current, baselineOf(PERFECT));
    expect(v.pass).toBe(false);
    expect(v.regressions.map((r) => r.metric)).toEqual(["recallAt5"]);
  });

  it("fails when multiple metrics regress", () => {
    const current = { recallAt1: 0.9, recallAt5: 0.9, recallAt10: 1, ndcgAt5: 0.8, mrr: 0.85 };
    const v = compareToBaseline(current, baselineOf(PERFECT));
    expect(v.pass).toBe(false);
    expect(v.regressions.map((r) => r.metric).sort()).toEqual(
      ["mrr", "ndcgAt5", "recallAt1", "recallAt5"].sort(),
    );
  });

  it("treats a drop within tolerance as not a regression (FP noise)", () => {
    const current = { ...PERFECT, mrr: 1 - DEFAULT_GATE_TOLERANCE / 2 };
    const v = compareToBaseline(current, baselineOf(PERFECT));
    expect(v.pass).toBe(true);
    expect(v.regressions).toHaveLength(0);
  });

  it("treats a drop just beyond tolerance as a regression", () => {
    const current = { ...PERFECT, mrr: 1 - DEFAULT_GATE_TOLERANCE * 2 };
    const v = compareToBaseline(current, baselineOf(PERFECT));
    expect(v.pass).toBe(false);
    expect(v.regressions.map((r) => r.metric)).toEqual(["mrr"]);
  });

  it("respects a custom tolerance", () => {
    const current = { ...PERFECT, recallAt5: 0.95 };
    // 5pp drop passes under a 10pp tolerance...
    expect(compareToBaseline(current, baselineOf(PERFECT), { tolerance: 0.1 }).pass).toBe(true);
    // ...but fails under the strict default.
    expect(compareToBaseline(current, baselineOf(PERFECT)).pass).toBe(false);
  });

  it("emits a lineage warning on corpus drift without failing on score", () => {
    const v = compareToBaseline(PERFECT, baselineOf(PERFECT), {
      lineage: { corpus_sha256: "different", query_set_checksum: "query-hash", query_count: 15 },
    });
    expect(v.pass).toBe(true); // scores unchanged
    expect(v.warnings.some((w) => w.toLowerCase().includes("corpus changed"))).toBe(true);
  });

  it("emits a lineage warning on query-set drift", () => {
    const v = compareToBaseline(PERFECT, baselineOf(PERFECT), {
      lineage: { corpus_sha256: "corpus-hash", query_set_checksum: "different", query_count: 15 },
    });
    expect(v.warnings.some((w) => w.toLowerCase().includes("query set changed"))).toBe(true);
  });

  it("covers every gated metric in the deltas", () => {
    const v = compareToBaseline(PERFECT, baselineOf(PERFECT));
    expect(v.deltas.map((d) => d.metric).sort()).toEqual([...GATED_METRICS].sort());
  });

  it("formats a readable verdict with a RESULT line", () => {
    const passText = formatVerdict(compareToBaseline(PERFECT, baselineOf(PERFECT)));
    expect(passText).toContain("RESULT: PASS");
    const failText = formatVerdict(
      compareToBaseline({ ...PERFECT, mrr: 0.5 }, baselineOf(PERFECT)),
    );
    expect(failText).toContain("RESULT: FAIL");
    expect(failText).toContain("mrr");
  });

  it("does not fail on a regression in a NON-enforced metric (hybrid subset)", () => {
    // mrr drops hard, but with only R@5/R@10 enforced the gate must still pass.
    const dropped: GatedScores = { ...PERFECT, mrr: 0.1, recallAt1: 0.2 };
    const v = compareToBaseline(dropped, baselineOf(PERFECT), {
      enforcedMetrics: ["recallAt5", "recallAt10"],
    });
    expect(v.pass).toBe(true);
    expect(v.regressions).toEqual([]);
    // The dropped metric is still reported, just marked non-enforced.
    const mrrDelta = v.deltas.find((d) => d.metric === "mrr")!;
    expect(mrrDelta.enforced).toBe(false);
    expect(mrrDelta.regressed).toBe(false);
  });

  it("fails when an ENFORCED metric regresses under a subset", () => {
    const v = compareToBaseline({ ...PERFECT, recallAt5: 0.8 }, baselineOf(PERFECT), {
      enforcedMetrics: ["recallAt5", "recallAt10"],
    });
    expect(v.pass).toBe(false);
    expect(v.regressions.map((r) => r.metric)).toEqual(["recallAt5"]);
  });

  it("formats the enforced footer + info status for a subset verdict", () => {
    const text = formatVerdict(
      compareToBaseline({ ...PERFECT, mrr: 0.5 }, baselineOf(PERFECT), {
        enforcedMetrics: ["recallAt5", "recallAt10"],
      }),
      "hybrid",
    );
    expect(text).toContain("hybrid");
    expect(text).toContain("enforced: recallAt5, recallAt10");
    expect(text).toContain("info"); // the dropped, non-enforced mrr renders as info
    expect(text).toContain("RESULT: PASS");
  });
});

describe("validateBaseline", () => {
  function validBaseline(): GateBaseline {
    return {
      baseline_schema_version: 1,
      generated_at: "2026-01-01T00:00:00.000Z",
      corpus_sha256: "abc",
      query_set_checksum: "def",
      query_count: 15,
      overall: { ...PERFECT },
    };
  }

  it("accepts a well-formed baseline", () => {
    expect(() => validateBaseline(validBaseline())).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateBaseline(null)).toThrow();
    expect(() => validateBaseline(42)).toThrow();
  });

  it("rejects an unknown schema version", () => {
    expect(() => validateBaseline({ ...validBaseline(), baseline_schema_version: 2 })).toThrow(
      /baseline_schema_version/,
    );
  });

  it("rejects a missing metric (the NaN-masking hole Codex flagged)", () => {
    const b = validBaseline();
    // @ts-expect-error — intentionally drop a metric to simulate a corrupt file
    delete b.overall.mrr;
    expect(() => validateBaseline(b)).toThrow(/overall\.mrr/);
  });

  it("rejects a non-finite metric", () => {
    const b = validBaseline();
    (b.overall as Record<string, unknown>).recallAt5 = Number.NaN;
    expect(() => validateBaseline(b)).toThrow(/recallAt5/);
  });

  it("rejects a non-positive query_count", () => {
    expect(() => validateBaseline({ ...validBaseline(), query_count: 0 })).toThrow(/query_count/);
  });

  it("rejects empty lineage hashes", () => {
    expect(() => validateBaseline({ ...validBaseline(), corpus_sha256: "" })).toThrow(/corpus_sha256/);
  });
});

describe("ci-gate end-to-end (committed fixture + baseline)", () => {
  it("builds the synthetic fixture, runs raw/lexical, and passes the committed baseline", async () => {
    const result = await runCiGate();

    // A baseline must be committed.
    expect(result.baseline).not.toBeNull();
    expect(result.verdict).not.toBeNull();

    // The committed baseline must still hold — a regression here means a
    // retrieval/ranking change degraded recall on the deterministic corpus.
    expect(result.verdict!.pass).toBe(true);

    // The baseline must be measured on the SAME corpus + query set that ship
    // in the repo. If you intentionally changed either, re-bless with
    //   npm run benchmark:ci-gate -- --update-baseline
    // which keeps these hashes in sync.
    expect(result.verdict!.warnings).toEqual([]);
    expect(result.lineage.corpus_sha256).toBe(result.baseline!.corpus_sha256);
    expect(result.lineage.query_set_checksum).toBe(result.baseline!.query_set_checksum);

    // Sanity: the run actually evaluated every committed query in raw mode.
    expect(result.report.runner_mode).toBe("raw");
    expect(result.report.query_count).toBe(result.baseline!.query_count);
  }, 30_000);

  it("makeBaseline round-trips the current scores and lineage", async () => {
    const result = await runCiGate();
    const fresh = makeBaseline(result, "2026-01-01T00:00:00.000Z");
    expect(fresh.overall).toEqual(result.current);
    expect(fresh.corpus_sha256).toBe(result.lineage.corpus_sha256);
    expect(fresh.query_set_checksum).toBe(result.lineage.query_set_checksum);
    // Re-comparing the fresh baseline against itself is a clean pass.
    const v = compareToBaseline(result.current, fresh, { lineage: result.lineage });
    expect(v.pass).toBe(true);
    expect(v.warnings).toEqual([]);
  }, 30_000);
});

describe.skipIf(!vecAvailable)("ci-gate hybrid end-to-end (frozen vectors + committed baseline)", () => {
  it("runs FTS5 + vector RRF over frozen vectors and passes the committed hybrid baseline", async () => {
    const result = await runCiGate({ mode: "hybrid" });

    expect(result.mode).toBe("hybrid");
    expect(result.baseline).not.toBeNull();
    expect(result.verdict).not.toBeNull();
    // The committed hybrid baseline must still hold — a regression here means a
    // change degraded the vector + RRF ranking path the lexical gate can't see.
    expect(result.verdict!.pass).toBe(true);
    expect(result.verdict!.warnings).toEqual([]);

    // Lineage must match the committed corpus, frozen embeddings, AND query set.
    // Re-bless with: npm run benchmark:ci-gate -- --hybrid --update-baseline
    expect(result.lineage.corpus_sha256).toBe(result.baseline!.corpus_sha256);
    expect(result.lineage.embeddings_sha256).toBe(result.baseline!.embeddings_sha256);
    expect(result.lineage.query_set_checksum).toBe(result.baseline!.query_set_checksum);

    // The frozen provider supplied a vector for EVERY query, so none degraded to
    // lexical — actual_mode is only set when the effective mode differs from the
    // requested one. This proves the run was genuinely hybrid (no silent model).
    for (const q of result.report.queries) {
      expect(q.search_mode).toBe("hybrid");
      expect(q.actual_mode).toBeUndefined();
    }

    // R@5/R@10 sit at the robust 1.0 ceiling: every target is reachable via the
    // hybrid path with margin, so the baseline is stable against FP noise while
    // a real regression (a target dropping out of top-5) trips it.
    expect(result.current.recallAt5).toBe(1);
    expect(result.current.recallAt10).toBe(1);
  }, 30_000);

  it("is deterministic — two runs over the frozen vectors produce identical scores", async () => {
    const a = await runCiGate({ mode: "hybrid" });
    const b = await runCiGate({ mode: "hybrid" });
    expect(b.current).toEqual(a.current);
  }, 30_000);

  it("trips when the vector arm is neutralized (the enforced R@5/R@10 genuinely depend on vectors)", async () => {
    const fixture = JSON.parse(
      readFileSync(DEFAULT_HYBRID_PATHS.embeddingsPath, "utf-8"),
    ) as FrozenFixture;

    // Zero every query vector while leaving the query TEXT intact: the KNN arm is
    // neutralized (all corpus vectors are ~equidistant from the origin) and only
    // FTS5 remains. The vector-dependent queries lose their target from the
    // window, so R@5 — an ENFORCED hybrid metric — drops below 1.0 and the gate
    // must fail. If R@5 held, the vectors wouldn't be contributing to retrieval.
    const dim = fixture.dim;
    const zeroed: Record<string, number[]> = {};
    for (const id of Object.keys(fixture.queries)) zeroed[id] = new Array(dim).fill(0);
    const neutralized: FrozenFixture = { ...fixture, queries: zeroed };

    const dir = mkdtempSync(join(tmpdir(), "ci-gate-hybrid-novec-"));
    try {
      const p = join(dir, "embeddings.json");
      writeFileSync(p, JSON.stringify(neutralized));
      const result = await runCiGate({ mode: "hybrid", paths: { embeddingsPath: p } });
      expect(result.current.recallAt5).toBeLessThan(1);
      expect(result.verdict!.pass).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails loud when a query is missing its frozen vector (no silent lexical degrade)", async () => {
    const fixture = JSON.parse(
      readFileSync(DEFAULT_HYBRID_PATHS.embeddingsPath, "utf-8"),
    ) as FrozenFixture;
    const ids = Object.keys(fixture.queries);
    const queries = { ...fixture.queries };
    delete queries[ids[0]];
    const broken: FrozenFixture = { ...fixture, queries };

    const dir = mkdtempSync(join(tmpdir(), "ci-gate-hybrid-missing-"));
    try {
      const p = join(dir, "embeddings.json");
      writeFileSync(p, JSON.stringify(broken));
      await expect(
        runCiGate({ mode: "hybrid", paths: { embeddingsPath: p } }),
      ).rejects.toThrow(/missing query/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
