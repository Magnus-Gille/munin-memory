import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeCalibrationGateMetrics,
  computePreferenceRubricSensitivity,
  judgeCalibrationCase,
  prepareCalibrationCases,
  type CalibrationJudgment,
  type CalibrationSourceResult,
} from "../benchmark/packing-quality/calibration.js";
import {
  CALIBRATION_SEED,
  LONGMEMEVAL_NONPREFERENCE_CATEGORIES,
  LONGMEMEVAL_PREFERENCE_CATEGORY,
  PREFERENCE_AWARE_JUDGE_RUBRIC,
  PREFERENCE_RUBRIC_SYNTHETIC_CONTROLS,
} from "../benchmark/packing-quality/calibration-fixtures.js";
import type { ChatFn } from "../benchmark/answer-quality/judge.js";

const EXPECTED_COUNTS = [78, 133, 56, 70, 133] as const;

function publicScorecardFixture(): CalibrationSourceResult[] {
  const rows: CalibrationSourceResult[] = [];
  for (const [categoryIndex, category] of LONGMEMEVAL_NONPREFERENCE_CATEGORIES.entries()) {
    const count = EXPECTED_COUNTS[categoryIndex]!;
    for (let index = 0; index < count; index += 1) {
      const correct = category === "longmemeval/single-session-assistant" || index % 2 === 0;
      rows.push({
        query_id: `public-${categoryIndex}-${String(index).padStart(3, "0")}`,
        category,
        question: `Question ${categoryIndex}-${index}?`,
        reference_answer: `Reference ${categoryIndex}-${index}.`,
        candidate_answer: `Candidate ${categoryIndex}-${index}.`,
        verdict: { correct },
      });
    }
  }
  for (let index = 0; index < 30; index += 1) {
    rows.push({
      query_id: `public-preference-${String(index).padStart(2, "0")}`,
      category: LONGMEMEVAL_PREFERENCE_CATEGORY,
      question: `Preference question ${index}?`,
      reference_answer: `Preference reference ${index}.`,
      candidate_answer: `Preference candidate ${index}.`,
      verdict: { correct: index % 10 === 0 },
    });
  }
  return rows;
}

function hashId(id: string): string {
  return createHash("sha256").update(`${CALIBRATION_SEED}|${id}`).digest("hex");
}

function completeJudgments(selection: ReturnType<typeof prepareCalibrationCases>): CalibrationJudgment[] {
  const expectedNonpreference = new Map(selection.nonpreference.map((entry) => [entry.caseId, entry.expectedCorrect]));
  return selection.baselineCases.map((entry) => {
    let correct = entry.expectedCorrect ?? false;
    if (entry.group === "blind_duplicate") correct = expectedNonpreference.get(entry.duplicateOf ?? "") ?? false;
    return {
      caseId: entry.caseId,
      verdict: {
        correct,
        score: entry.expectedScore ?? (correct ? 1 : 0),
        reasoning: "synthetic test verdict",
        parse_ok: true,
      },
    };
  });
}

const fakeChat: ChatFn = async () => ({
  choices: [{ message: { content: JSON.stringify({ correct: true, score: 1, reasoning: "synthetic response" }) } }],
});

describe("packing-quality calibration preparation", () => {
  it("selects the frozen 60/30/10/6 cases deterministically and balances verdicts where available", () => {
    const source = publicScorecardFixture();
    const first = prepareCalibrationCases(source);
    const second = prepareCalibrationCases(source);

    expect(first.nonpreference).toHaveLength(60);
    expect(first.preferences).toHaveLength(30);
    expect(first.blindDuplicates).toHaveLength(10);
    expect(first.controls).toHaveLength(6);
    expect(first.baselineCases).toHaveLength(106);
    expect(first).toEqual(second);

    for (const category of LONGMEMEVAL_NONPREFERENCE_CATEGORIES) {
      const selected = first.nonpreference.filter((entry) => entry.category === category);
      expect(selected).toHaveLength(12);
      if (category === "longmemeval/single-session-assistant") {
        expect(selected.every((entry) => entry.expectedCorrect === true)).toBe(true);
      } else {
        expect(selected.filter((entry) => entry.expectedCorrect === true)).toHaveLength(6);
        expect(selected.filter((entry) => entry.expectedCorrect === false)).toHaveLength(6);
      }
    }

    const expectedDuplicateSources = [...first.nonpreference]
      .sort((a, b) => hashId(a.caseId).localeCompare(hashId(b.caseId)) || a.caseId.localeCompare(b.caseId))
      .slice(0, 10)
      .map((entry) => entry.caseId);
    expect(first.blindDuplicates.map((entry) => entry.duplicateOf)).toEqual(expectedDuplicateSources);
    expect(first.blindDuplicates.every((entry) => entry.expectedCorrect === undefined)).toBe(true);
  });

  it("fails closed for incomplete, malformed, or duplicate source data", () => {
    const source = publicScorecardFixture();
    expect(() => prepareCalibrationCases(source.slice(1))).toThrow(/Expected 500/);

    const duplicateId = source.map((entry) => ({ ...entry }));
    duplicateId[1]!.query_id = duplicateId[0]!.query_id;
    expect(() => prepareCalibrationCases(duplicateId)).toThrow(/Duplicate public scorecard query_id/);

    const missingField = source.map((entry) => ({ ...entry }));
    (missingField[0] as unknown as { question: undefined }).question = undefined;
    expect(() => prepareCalibrationCases(missingField)).toThrow(/Incomplete public scorecard result/);
  });

  it("keeps the six preference controls available outside the primary gate", () => {
    expect(PREFERENCE_RUBRIC_SYNTHETIC_CONTROLS).toHaveLength(6);
    expect(PREFERENCE_RUBRIC_SYNTHETIC_CONTROLS.map((control) => control.expectedScore)).toEqual([
      1, 0.5, 0, 0.5, 0.5, 0,
    ]);
    expect(PREFERENCE_RUBRIC_SYNTHETIC_CONTROLS.every(
      (control) => control.category === LONGMEMEVAL_PREFERENCE_CATEGORY,
    )).toBe(true);
  });
});

describe("packing-quality calibration judge adapter", () => {
  it("uses only question/reference/candidate for the baseline request", async () => {
    const selection = prepareCalibrationCases(publicScorecardFixture());
    const calibrationCase = selection.nonpreference[0]!;
    const calls: Parameters<ChatFn>[0][] = [];
    const capture: ChatFn = async (options) => {
      calls.push(options);
      return fakeChat(options);
    };

    const judgment = await judgeCalibrationCase(calibrationCase, capture, { model: "test-judge" });
    expect(judgment.caseId).toBe(calibrationCase.caseId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toContain("factual correctness.");
    expect(calls[0]!.apiKey).toBe("");
    const userPayload = JSON.parse(
      calls[0]!.messages[1]!.content.match(/\n\n([\s\S]*?)\n\nJudge the candidate answer against the reference answer:/)![1]!,
    ) as Record<string, unknown>;
    expect(Object.keys(userPayload).sort()).toEqual(["candidate_answer", "question", "reference_answer"]);
    expect(JSON.stringify(userPayload)).not.toContain(calibrationCase.caseId);
    expect(JSON.stringify(userPayload)).not.toContain("expectedCorrect");
    expect(JSON.stringify(userPayload)).not.toContain("blind_duplicate");
    expect(JSON.stringify(userPayload)).not.toContain("preference-aware-sensitivity-v1");
  });

  it("injects the frozen preference rubric only for preference sensitivity calls", async () => {
    const selection = prepareCalibrationCases(publicScorecardFixture());
    const calibrationCase = selection.preferences[0]!;
    const calls: Parameters<ChatFn>[0][] = [];
    const capture: ChatFn = async (options) => {
      calls.push(options);
      return fakeChat(options);
    };

    await judgeCalibrationCase(calibrationCase, capture, {
      model: "test-judge",
      rubric: "preference-aware-sensitivity-v1",
    });
    expect(calls[0]!.messages[0]!.content).toContain(PREFERENCE_AWARE_JUDGE_RUBRIC);
    expect(calls[0]!.messages[0]!.content).toContain("__MUNIN_ANSWER_QUALITY_JUDGE__");
    expect(calls[0]!.messages[1]!.content).not.toContain("preference-aware-sensitivity-v1");
    expect(calls[0]!.messages[1]!.content).not.toContain(calibrationCase.caseId);

    await expect(judgeCalibrationCase(selection.nonpreference[0]!, capture, {
      model: "test-judge",
      rubric: "preference-aware-sensitivity-v1",
    })).rejects.toThrow(/only accepts preference cases/);
  });
});

describe("packing-quality calibration metrics", () => {
  it("passes the frozen thresholds and reports preference scores descriptively", () => {
    const selection = prepareCalibrationCases(publicScorecardFixture());
    const metrics = computeCalibrationGateMetrics(selection, completeJudgments(selection));

    expect(metrics.nonpreferenceAgreement).toEqual({ count: 60, matching: 60, rate: 1, passed: true });
    expect(metrics.blindDuplicateConsistency).toEqual({ count: 10, matching: 10, rate: 1, passed: true });
    expect(metrics.controls).toEqual({ count: 6, passed: 6, allPassed: true });
    expect(metrics.preferenceBaseline.count).toBe(30);
    expect(metrics.passed).toBe(true);
  });

  it("requires complete, parseable results and never counts failures as passes", () => {
    const selection = prepareCalibrationCases(publicScorecardFixture());
    const complete = completeJudgments(selection);
    expect(() => computeCalibrationGateMetrics(selection, complete.slice(1))).toThrow(/requires 106 judgments/);

    const incompleteSelection = {
      ...selection,
      preferences: selection.preferences.slice(1),
      baselineCases: selection.baselineCases.filter((entry) => entry.group !== "preference" || entry.caseId !== selection.preferences[0]!.caseId),
    };
    expect(() => computeCalibrationGateMetrics(incompleteSelection, complete.slice(1))).toThrow(/selection is incomplete/);

    const malformed = complete.map((entry) => ({ ...entry, verdict: { ...entry.verdict } }));
    malformed[0]!.verdict.parse_ok = false;
    expect(() => computeCalibrationGateMetrics(selection, malformed)).toThrow(/malformed, truncated, or incomplete/);

    const extra = [...complete, { ...complete[0]!, caseId: "unselected-case" }];
    expect(() => computeCalibrationGateMetrics(selection, extra)).toThrow(/requires 106 judgments/);
  });

  it("enforces 90% historical agreement, 90% duplicate consistency, and every control", () => {
    const selection = prepareCalibrationCases(publicScorecardFixture());
    const belowAgreement = completeJudgments(selection);
    for (const entry of selection.nonpreference.slice(0, 7)) {
      const judgment = belowAgreement.find((result) => result.caseId === entry.caseId)!;
      judgment.verdict.correct = !judgment.verdict.correct;
    }
    expect(computeCalibrationGateMetrics(selection, belowAgreement).nonpreferenceAgreement.passed).toBe(false);

    const oneDuplicateMismatch = completeJudgments(selection);
    oneDuplicateMismatch.find((entry) => entry.caseId === selection.blindDuplicates[0]!.caseId)!.verdict.correct =
      !oneDuplicateMismatch.find((entry) => entry.caseId === selection.blindDuplicates[0]!.duplicateOf)!.verdict.correct;
    expect(computeCalibrationGateMetrics(selection, oneDuplicateMismatch).blindDuplicateConsistency.passed).toBe(true);

    const twoDuplicateMismatches = completeJudgments(selection);
    for (const duplicate of selection.blindDuplicates.slice(0, 2)) {
      const duplicateVerdict = twoDuplicateMismatches.find((entry) => entry.caseId === duplicate.caseId)!.verdict;
      duplicateVerdict.correct = !duplicateVerdict.correct;
    }
    expect(computeCalibrationGateMetrics(selection, twoDuplicateMismatches).blindDuplicateConsistency.passed).toBe(false);

    const oneControlFailure = completeJudgments(selection);
    oneControlFailure.find((entry) => entry.caseId === selection.controls[0]!.caseId)!.verdict.score = 0;
    const controlMetrics = computeCalibrationGateMetrics(selection, oneControlFailure);
    expect(controlMetrics.controls.allPassed).toBe(false);
    expect(controlMetrics.passed).toBe(false);
  });

  it("compares preference-rubric sensitivity only on the same complete 30 cases", () => {
    const selection = prepareCalibrationCases(publicScorecardFixture());
    const baseline = completeJudgments(selection);
    const historicCorrect = new Set(
      selection.preferences.filter((entry) => entry.expectedCorrect === true).map((entry) => entry.caseId),
    );
    const additionalCorrect = selection.preferences
      .filter((entry) => !historicCorrect.has(entry.caseId))
      .slice(0, 9)
      .map((entry) => entry.caseId);
    const sensitivityCorrect = new Set([...historicCorrect, ...additionalCorrect]);
    const sensitivity: CalibrationJudgment[] = selection.preferences.map((entry) => ({
      caseId: entry.caseId,
      verdict: {
        correct: sensitivityCorrect.has(entry.caseId),
        score: sensitivityCorrect.has(entry.caseId) ? 1 : 0,
        reasoning: "synthetic sensitivity result",
        parse_ok: true,
      },
    }));
    const summary = computePreferenceRubricSensitivity(selection, baseline, sensitivity);

    expect(summary.count).toBe(30);
    expect(summary.baselineCorrect).toBe(3);
    expect(summary.preferenceRubricCorrect).toBe(12);
    expect(summary.changed).toBe(9);
    expect(summary.gainedCorrect).toHaveLength(9);
    expect(summary.lostCorrect).toHaveLength(0);
    expect(() => computePreferenceRubricSensitivity(selection, baseline, sensitivity.slice(1))).toThrow(/requires 30 judgments/);
  });
});
