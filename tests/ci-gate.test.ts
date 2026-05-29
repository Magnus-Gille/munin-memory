import { describe, it, expect } from "vitest";
import {
  compareToBaseline,
  formatVerdict,
  GATED_METRICS,
  DEFAULT_GATE_TOLERANCE,
  type GateBaseline,
  type GatedScores,
} from "../benchmark/ci-gate-policy.js";
import { runCiGate, makeBaseline } from "../benchmark/ci-gate.js";

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
