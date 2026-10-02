import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateDecisionFixture } from "../benchmark/continuous/generator.js";
import {
  assertEvidenceRemoved,
  assertGoldRow,
  runContinuousEval,
} from "../benchmark/continuous/evaluator.js";
import type { ContinuousEvalQueryResult } from "../benchmark/continuous/types.js";

describe("generated decision retrieval fixture", () => {
  it("uses a validated uint32 seed and generates deterministically", () => {
    const first = generateDecisionFixture();
    const second = generateDecisionFixture(0x4d554e49);

    expect(first).toEqual(second);
    expect(first.seed).toBe(0x4d554e49);
    expect(first.facts).toHaveLength(12);
    expect(first.questions).toHaveLength(24);
    expect(generateDecisionFixture(0).facts.map((fact) => fact.chosen_option))
      .not.toEqual(generateDecisionFixture(1).facts.map((fact) => fact.chosen_option));

    for (const seed of [-1, 1.25, Number.NaN, 0x1_0000_0000]) {
      expect(() => generateDecisionFixture(seed)).toThrow(RangeError);
    }
  });

  it("derives each expected reference from a fact supported by its decision row", () => {
    const fixture = generateDecisionFixture();

    for (const fact of fixture.facts) {
      const evidence = fixture.corpus_rows.find((row) => row.corpus_ref === fact.correct_evidence_id);
      expect(evidence?.entry_type).toBe("log");
      expect(evidence?.write_api).toBe("appendLog");
      expect(evidence?.content).toContain(fact.chosen_option);
      expect(evidence?.content).toContain(fact.rejected_option);
      expect(evidence?.content).toContain(fact.rationale);

      const questions = fixture.questions.filter((question) => question.case_id === fact.case_id);
      expect(questions).toHaveLength(2);
      expect(questions.every((question) => question.expected_corpus_refs[0] === fact.correct_evidence_id)).toBe(true);

      const oldDecision = fixture.corpus_rows.find((row) => row.corpus_ref === `${fact.case_id}:superseded-decision`);
      expect(oldDecision?.content).toContain("uttryckligen ersatt");
      expect(oldDecision?.content).toContain(fact.superseded_option);
    }
  });
});

function negativeResult(refs: string[]): ContinuousEvalQueryResult {
  return {
    query_id: "q",
    case_id: "decision-00",
    variant: "keyword",
    expected_corpus_ref: "decision-00:current-decision",
    ranked_corpus_refs: refs,
    rank: null,
    scores: {} as ContinuousEvalQueryResult["scores"],
  };
}

describe("evidence-removed control check", () => {
  const evidenceRefs = new Set(["decision-00:current-decision"]);

  it("passes for non-empty decoy-only results and reports the minimum result count", () => {
    const results = [negativeResult(["decision-00:decoy", "decision-01:decoy"]), negativeResult(["decision-02:decoy"])];
    expect(assertEvidenceRemoved(results, evidenceRefs, "raw")).toBe(1);
  });

  it("throws when a removed evidence ref is still returned", () => {
    const results = [negativeResult(["decision-00:decoy", "decision-00:current-decision"])];
    expect(() => assertEvidenceRemoved(results, evidenceRefs, "raw")).toThrow(/evidence/);
  });

  it("throws when a question returned no results", () => {
    expect(() => assertEvidenceRemoved([negativeResult([])], evidenceRefs, "raw")).toThrow(/no results/);
  });
});

describe("gold row integrity check", () => {
  const fact = generateDecisionFixture().facts[0];
  const goodRow = {
    namespace: fact.namespace,
    entry_type: "log",
    content: `${fact.case_id} ${fact.chosen_option} ${fact.rejected_option}`,
  };

  it("passes for a correct log row", () => {
    expect(() => assertGoldRow(fact, goodRow)).not.toThrow();
  });

  it("throws for a wrong namespace", () => {
    expect(() => assertGoldRow(fact, { ...goodRow, namespace: "projects/other" })).toThrow(/namespace/);
  });

  it("throws for a non-log row", () => {
    expect(() => assertGoldRow(fact, { ...goodRow, entry_type: "state" })).toThrow(/log/);
  });

  it("throws when content misses the chosen option", () => {
    const content = goodRow.content.replace(fact.chosen_option, "");
    expect(() => assertGoldRow(fact, { ...goodRow, content })).toThrow(/chosen/);
  });
});

describe("continuous decision retrieval evaluation", () => {
  it("measures both runners and proves the evidence-removal and scorer controls", async () => {
    const report = await runContinuousEval();

    expect(report.status).toBe("measured");
    expect(report.question_count).toBe(24);
    expect(report.fixture_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.modes.raw.effective_search_mode).toBe("lexical");
    expect(report.modes.raw.search_recency_weight).toBeNull();
    expect(report.modes.production_ranker.effective_search_mode).toBe("lexical");
    expect(report.modes.production_ranker.search_recency_weight).toBe(0.2);
    expect(report.modes.raw.per_case).toHaveLength(24);
    expect(report.modes.production_ranker.per_case).toHaveLength(24);
    expect(report.controls.evidence_removed).toMatchObject({ passed: true, question_count: 24 });
    expect(report.controls.evidence_removed.raw.recallAt10).toBe(0);
    expect(report.controls.evidence_removed.production_ranker.recallAt10).toBe(0);
    expect(report.controls.evidence_removed.min_results_per_question).toEqual({
      raw: expect.any(Number),
      production_ranker: expect.any(Number),
    });
    expect(report.controls.evidence_removed.min_results_per_question.raw).toBeGreaterThan(0);
    expect(report.controls.evidence_removed.min_results_per_question.production_ranker).toBeGreaterThan(0);
    expect(report.controls.gold_integrity).toEqual({ passed: true, checked_row_count: 12 });
    const baseline = JSON.parse(readFileSync(new URL("../benchmark/continuous/baseline.json", import.meta.url), "utf8")) as {
      metrics: Record<string, number>;
    };
    expect(report.metrics).toEqual(baseline.metrics);
    expect(report.controls.scorer_oracle).toMatchObject({ passed: true, question_count: 24 });
    expect(report.controls.scorer_oracle.scores.recallAt1).toBe(1);
    expect(report.controls.scorer_oracle.scores.recallAt5).toBe(1);
    expect(report.controls.scorer_oracle.scores.mrr).toBe(1);

    for (const mode of Object.values(report.modes)) {
      for (const result of mode.per_case) {
        expect(result.expected_corpus_ref).toMatch(/^decision-\d{2}:current-decision$/);
        expect(result.ranked_corpus_refs.every((ref) => ref.startsWith("decision-"))).toBe(true);
        expect(result.rank === null || result.rank > 0).toBe(true);
      }
    }
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("duration_ms");
    expect(serialized).not.toContain("snapshot_path");
    expect(serialized).not.toContain("result_ids");
  }, 120_000);
  it("returns deep-equal reports on consecutive runs", async () => {
    const first = await runContinuousEval();
    const second = await runContinuousEval();
    expect(second).toEqual(first);
  }, 120_000);
});
