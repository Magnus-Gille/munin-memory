/**
 * Deterministic calibration selection and scoring for the answer-quality
 * closeout. Model calls remain one-at-a-time through the caller-supplied ChatFn
 * so the caller owns durable request journaling and transport policy.
 */

import { createHash } from "node:crypto";
import {
  JUDGE_SYSTEM_SENTINEL,
  judgeAnswer,
  type ChatFn,
} from "../answer-quality/judge.js";
import type { JudgeVerdict } from "../answer-quality/types.js";
import {
  CALIBRATION_SEED,
  LONGMEMEVAL_NONPREFERENCE_CATEGORIES,
  LONGMEMEVAL_PREFERENCE_CATEGORY,
  PREFERENCE_AWARE_JUDGE_RUBRIC,
  SYNTHETIC_CALIBRATION_CONTROLS,
  type SyntheticCalibrationControl,
} from "./calibration-fixtures.js";

export const EXPECTED_PUBLIC_SCORECARD_RESULT_COUNT = 500;
export const CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY = 12;
export const CALIBRATION_HISTORICAL_NONPREFERENCE_COUNT = 60;
export const CALIBRATION_PREFERENCE_COUNT = 30;
export const CALIBRATION_BLIND_DUPLICATE_COUNT = 10;
export const CALIBRATION_CONTROL_COUNT = 6;
export const MIN_CALIBRATION_AGREEMENT = 0.9;
export const MIN_DUPLICATE_CONSISTENCY = 0.9;

export type CalibrationGroup = "nonpreference" | "preference" | "blind_duplicate" | "control";
export type CalibrationRubric = "answer-quality-v1" | "preference-aware-sensitivity-v1";

/**
 * A calibration case contains assessment metadata alongside judge inputs.
 * `judgeCalibrationCase` explicitly projects only the public prompt fields.
 */
export interface CalibrationCase {
  caseId: string;
  category: string;
  question: string;
  referenceAnswer: string;
  candidateAnswer: string;
  group: CalibrationGroup;
  /** Historic comparator verdict or synthetic expectation, never human truth or judge input. */
  expectedCorrect?: boolean;
  /** Set only for deterministic controls; never sent to a judge. */
  expectedScore?: 0 | 0.5 | 1;
  /** Set only for a blind duplicate; never sent to a judge. */
  duplicateOf?: string;
}

export interface CalibrationSourceResult {
  query_id: string;
  category: string;
  question: string;
  reference_answer: string;
  candidate_answer: string;
  verdict: { correct: boolean };
}

export interface CalibrationSelection {
  nonpreference: CalibrationCase[];
  preferences: CalibrationCase[];
  blindDuplicates: CalibrationCase[];
  controls: CalibrationCase[];
  /** Deterministic call order for the unchanged answer-quality-v1 arm. */
  baselineCases: CalibrationCase[];
}

/** Only the case identifier and model verdict belong in a result record. */
export interface CalibrationJudgment {
  caseId: string;
  verdict: JudgeVerdict;
}

export interface CalibrationAgreementMetric {
  count: number;
  matching: number;
  rate: number;
  passed: boolean;
}

export interface CalibrationGateMetrics {
  nonpreferenceAgreement: CalibrationAgreementMetric;
  blindDuplicateConsistency: CalibrationAgreementMetric;
  controls: {
    count: number;
    passed: number;
    allPassed: boolean;
  };
  /** Descriptive only; historic preference verdicts are ambiguous comparators. */
  preferenceBaseline: {
    count: number;
    judgedCorrect: number;
  };
  passed: boolean;
}

export interface PreferenceRubricSensitivityMetrics {
  count: number;
  baselineCorrect: number;
  preferenceRubricCorrect: number;
  changed: number;
  gainedCorrect: string[];
  lostCorrect: string[];
}

export interface CalibrationJudgeOptions {
  model: string;
  maxTokens?: number;
  rubric?: CalibrationRubric;
}

interface HashedResult {
  result: CalibrationSourceResult;
  hash: string;
}

function hashForQueryId(queryId: string): string {
  return createHash("sha256").update(`${CALIBRATION_SEED}|${queryId}`).digest("hex");
}

function compareHashed(a: HashedResult, b: HashedResult): number {
  return a.hash.localeCompare(b.hash) || a.result.query_id.localeCompare(b.result.query_id);
}

function toHistoricalCase(
  result: CalibrationSourceResult,
  group: "nonpreference" | "preference",
): CalibrationCase {
  return {
    caseId: result.query_id,
    category: result.category,
    question: result.question,
    referenceAnswer: result.reference_answer,
    candidateAnswer: result.candidate_answer,
    group,
    expectedCorrect: result.verdict.correct,
  };
}

function validatePublicScorecard(results: readonly CalibrationSourceResult[]): void {
  if (results.length !== EXPECTED_PUBLIC_SCORECARD_RESULT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_PUBLIC_SCORECARD_RESULT_COUNT} public scorecard results; received ${results.length}.`,
    );
  }

  const expectedCategories = new Set<string>([
    LONGMEMEVAL_PREFERENCE_CATEGORY,
    ...LONGMEMEVAL_NONPREFERENCE_CATEGORIES,
  ]);
  const seenIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const result of results) {
    if (typeof result.query_id !== "string" || result.query_id.trim().length === 0) {
      throw new Error("Public scorecard result has an empty query_id.");
    }
    if (seenIds.has(result.query_id)) {
      throw new Error(`Duplicate public scorecard query_id: ${result.query_id}.`);
    }
    seenIds.add(result.query_id);
    if (!expectedCategories.has(result.category)) {
      throw new Error(`Unexpected LongMemEval category: ${String(result.category)}.`);
    }
    if (
      typeof result.question !== "string"
      || result.question.trim().length === 0
      || typeof result.reference_answer !== "string"
      || typeof result.candidate_answer !== "string"
      || typeof result.verdict?.correct !== "boolean"
    ) {
      throw new Error(`Incomplete public scorecard result: ${result.query_id}.`);
    }
    counts.set(result.category, (counts.get(result.category) ?? 0) + 1);
  }

  const preferenceCount = counts.get(LONGMEMEVAL_PREFERENCE_CATEGORY) ?? 0;
  if (preferenceCount !== CALIBRATION_PREFERENCE_COUNT) {
    throw new Error(
      `Expected all ${CALIBRATION_PREFERENCE_COUNT} preference cases; received ${preferenceCount}.`,
    );
  }
  for (const category of LONGMEMEVAL_NONPREFERENCE_CATEGORIES) {
    const count = counts.get(category) ?? 0;
    if (count < CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY) {
      throw new Error(
        `Category ${category} has ${count} cases; at least ${CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY} are required.`,
      );
    }
  }
}

function selectCategorySample(results: readonly CalibrationSourceResult[]): CalibrationSourceResult[] {
  const hashed: HashedResult[] = results.map((result) => ({ result, hash: hashForQueryId(result.query_id) }));
  const correct = hashed.filter(({ result }) => result.verdict.correct).sort(compareHashed);
  const incorrect = hashed.filter(({ result }) => !result.verdict.correct).sort(compareHashed);
  const picked = new Set<string>();

  for (const candidate of correct.slice(0, 6)) picked.add(candidate.result.query_id);
  for (const candidate of incorrect.slice(0, 6)) picked.add(candidate.result.query_id);

  for (const candidate of hashed.sort(compareHashed)) {
    if (picked.size >= CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY) break;
    picked.add(candidate.result.query_id);
  }

  if (picked.size !== CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY) {
    throw new Error(`Could not select ${CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY} calibration cases.`);
  }

  return hashed
    .filter(({ result }) => picked.has(result.query_id))
    .sort(compareHashed)
    .map(({ result }) => result);
}

function toControlCase(control: SyntheticCalibrationControl): CalibrationCase {
  return {
    caseId: control.caseId,
    category: control.category,
    question: control.question,
    referenceAnswer: control.referenceAnswer,
    candidateAnswer: control.candidateAnswer,
    group: "control",
    expectedCorrect: control.expectedCorrect,
    expectedScore: control.expectedScore,
  };
}

/**
 * Select the frozen 60/30/10/6 calibration set from the public July report.
 * Historic correctness is retained only as out-of-prompt assessment metadata.
 */
export function prepareCalibrationCases(
  results: readonly CalibrationSourceResult[],
): CalibrationSelection {
  validatePublicScorecard(results);

  const nonpreference: CalibrationCase[] = LONGMEMEVAL_NONPREFERENCE_CATEGORIES
    .flatMap((category) => selectCategorySample(results.filter((result) => result.category === category)))
    .map((result) => toHistoricalCase(result, "nonpreference"))
    .sort((a, b) => hashForQueryId(a.caseId).localeCompare(hashForQueryId(b.caseId)) || a.caseId.localeCompare(b.caseId));

  if (nonpreference.length !== CALIBRATION_HISTORICAL_NONPREFERENCE_COUNT) {
    throw new Error(
      `Expected ${CALIBRATION_HISTORICAL_NONPREFERENCE_COUNT} nonpreference cases; received ${nonpreference.length}.`,
    );
  }

  const preferences = results
    .filter((result) => result.category === LONGMEMEVAL_PREFERENCE_CATEGORY)
    .map((result) => toHistoricalCase(result, "preference"))
    .sort((a, b) => hashForQueryId(a.caseId).localeCompare(hashForQueryId(b.caseId)) || a.caseId.localeCompare(b.caseId));

  const blindDuplicates = [...nonpreference]
    .sort((a, b) => hashForQueryId(a.caseId).localeCompare(hashForQueryId(b.caseId)) || a.caseId.localeCompare(b.caseId))
    .slice(0, CALIBRATION_BLIND_DUPLICATE_COUNT)
    .map((source) => ({
      caseId: `blind-duplicate:${source.caseId}`,
      category: source.category,
      question: source.question,
      referenceAnswer: source.referenceAnswer,
      candidateAnswer: source.candidateAnswer,
      group: "blind_duplicate" as const,
      duplicateOf: source.caseId,
    }));

  if (preferences.length !== CALIBRATION_PREFERENCE_COUNT) {
    throw new Error(`Expected ${CALIBRATION_PREFERENCE_COUNT} preference cases; received ${preferences.length}.`);
  }
  if (blindDuplicates.length !== CALIBRATION_BLIND_DUPLICATE_COUNT) {
    throw new Error(`Expected ${CALIBRATION_BLIND_DUPLICATE_COUNT} blind duplicates; received ${blindDuplicates.length}.`);
  }

  const controls = SYNTHETIC_CALIBRATION_CONTROLS.map(toControlCase);
  if (controls.length !== CALIBRATION_CONTROL_COUNT) {
    throw new Error(`Expected ${CALIBRATION_CONTROL_COUNT} synthetic controls; received ${controls.length}.`);
  }

  return {
    nonpreference,
    preferences,
    blindDuplicates,
    controls,
    baselineCases: [...nonpreference, ...preferences, ...blindDuplicates, ...controls],
  };
}

function withPreferenceAwareRubric(chat: ChatFn): ChatFn {
  return (options) => chat({
    ...options,
    messages: options.messages.map((message) => message.role === "system"
      ? { ...message, content: `${JUDGE_SYSTEM_SENTINEL}\n${PREFERENCE_AWARE_JUDGE_RUBRIC}` }
      : message),
  });
}

/**
 * Judge one selected case through the existing parser and a caller-owned chat
 * transport. Expected labels, case IDs, selection groups, and rubric-arm names
 * are omitted from the model request.
 */
export async function judgeCalibrationCase(
  calibrationCase: CalibrationCase,
  chat: ChatFn,
  options: CalibrationJudgeOptions,
): Promise<CalibrationJudgment> {
  if (options.model.trim().length === 0) {
    throw new Error("Calibration judge model must be non-empty.");
  }
  if (
    options.rubric === "preference-aware-sensitivity-v1"
    && calibrationCase.category !== LONGMEMEVAL_PREFERENCE_CATEGORY
  ) {
    throw new Error("The preference-aware sensitivity rubric only accepts preference cases.");
  }

  const judgeChat = options.rubric === "preference-aware-sensitivity-v1"
    ? withPreferenceAwareRubric(chat)
    : chat;
  const verdict = await judgeAnswer({
    question: calibrationCase.question,
    referenceAnswer: calibrationCase.referenceAnswer,
    candidateAnswer: calibrationCase.candidateAnswer,
    category: calibrationCase.category,
    model: options.model,
    apiKey: "",
    temperature: 0,
    maxTokens: options.maxTokens,
  }, judgeChat);

  return { caseId: calibrationCase.caseId, verdict };
}

function validateJudgments(
  expectedCases: readonly CalibrationCase[],
  judgments: readonly CalibrationJudgment[],
  label: string,
): Map<string, JudgeVerdict> {
  const expectedIds = new Set(expectedCases.map((entry) => entry.caseId));
  if (expectedIds.size !== expectedCases.length) {
    throw new Error(`${label} selection contains duplicate case IDs.`);
  }
  if (judgments.length !== expectedCases.length) {
    throw new Error(`${label} requires ${expectedCases.length} judgments; received ${judgments.length}.`);
  }

  const byId = new Map<string, JudgeVerdict>();
  for (const judgment of judgments) {
    if (!expectedIds.has(judgment.caseId)) {
      throw new Error(`${label} contains an unexpected case ID: ${judgment.caseId}.`);
    }
    if (byId.has(judgment.caseId)) {
      throw new Error(`${label} contains duplicate judgment: ${judgment.caseId}.`);
    }
    const verdict = judgment.verdict;
    if (
      verdict.parse_ok !== true
      || typeof verdict.correct !== "boolean"
      || !Number.isFinite(verdict.score)
      || verdict.score < 0
      || verdict.score > 1
    ) {
      throw new Error(`${label} has a malformed, truncated, or incomplete verdict for ${judgment.caseId}.`);
    }
    byId.set(judgment.caseId, verdict);
  }

  for (const caseId of expectedIds) {
    if (!byId.has(caseId)) throw new Error(`${label} is missing judgment: ${caseId}.`);
  }
  return byId;
}

function validateFrozenSelection(selection: CalibrationSelection): void {
  if (
    selection.nonpreference.length !== CALIBRATION_HISTORICAL_NONPREFERENCE_COUNT
    || selection.preferences.length !== CALIBRATION_PREFERENCE_COUNT
    || selection.blindDuplicates.length !== CALIBRATION_BLIND_DUPLICATE_COUNT
    || selection.controls.length !== CALIBRATION_CONTROL_COUNT
  ) {
    throw new Error("Calibration selection is incomplete or differs from the frozen 60/30/10/6 protocol.");
  }

  const expectedOrder = [
    ...selection.nonpreference,
    ...selection.preferences,
    ...selection.blindDuplicates,
    ...selection.controls,
  ].map((entry) => entry.caseId);
  const actualOrder = selection.baselineCases.map((entry) => entry.caseId);
  if (expectedOrder.length !== 106 || JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error("Baseline calibration cases are incomplete or out of frozen order.");
  }
  if (new Set(expectedOrder).size !== expectedOrder.length) {
    throw new Error("Calibration selection contains duplicate case IDs.");
  }

  for (const category of LONGMEMEVAL_NONPREFERENCE_CATEGORIES) {
    if (selection.nonpreference.filter((entry) => entry.category === category).length !== CALIBRATION_CASES_PER_NONPREFERENCE_CATEGORY) {
      throw new Error(`Calibration selection has an incomplete category: ${category}.`);
    }
  }
}

function agreementMetric(matching: number, count: number, threshold: number): CalibrationAgreementMetric {
  const required = Math.ceil(count * threshold);
  return {
    count,
    matching,
    rate: count === 0 ? 0 : matching / count,
    passed: matching >= required,
  };
}

/**
 * Enforce complete baseline coverage and calculate only the frozen calibration
 * gate. Historic preference verdicts are never treated as labels here.
 */
export function computeCalibrationGateMetrics(
  selection: CalibrationSelection,
  judgments: readonly CalibrationJudgment[],
): CalibrationGateMetrics {
  validateFrozenSelection(selection);
  const verdicts = validateJudgments(selection.baselineCases, judgments, "Baseline calibration");
  const nonpreferenceMatching = selection.nonpreference.filter((entry) =>
    verdicts.get(entry.caseId)?.correct === entry.expectedCorrect).length;
  const nonpreferenceAgreement = agreementMetric(
    nonpreferenceMatching,
    selection.nonpreference.length,
    MIN_CALIBRATION_AGREEMENT,
  );

  const duplicateMatching = selection.blindDuplicates.filter((entry) =>
    verdicts.get(entry.caseId)?.correct === verdicts.get(entry.duplicateOf ?? "")?.correct).length;
  const blindDuplicateConsistency = agreementMetric(
    duplicateMatching,
    selection.blindDuplicates.length,
    MIN_DUPLICATE_CONSISTENCY,
  );

  const controlsPassed = selection.controls.filter((entry) => {
    const verdict = verdicts.get(entry.caseId);
    if (verdict === undefined || verdict.correct !== entry.expectedCorrect) return false;
    return entry.expectedScore === undefined || Math.abs(verdict.score - entry.expectedScore) < 1e-9;
  }).length;
  const controls = {
    count: selection.controls.length,
    passed: controlsPassed,
    allPassed: controlsPassed === CALIBRATION_CONTROL_COUNT,
  };

  const preferenceBaseline = {
    count: selection.preferences.length,
    judgedCorrect: selection.preferences.filter((entry) => verdicts.get(entry.caseId)?.correct === true).length,
  };
  const passed = nonpreferenceAgreement.passed
    && blindDuplicateConsistency.passed
    && controls.allPassed;

  return {
    nonpreferenceAgreement,
    blindDuplicateConsistency,
    controls,
    preferenceBaseline,
    passed,
  };
}

/**
 * Compare the unchanged rubric and frozen preference rubric on the same 30
 * saved preference answers. This is descriptive sensitivity, never a gate
 * against the historic preference verdicts.
 */
export function computePreferenceRubricSensitivity(
  selection: CalibrationSelection,
  baselineJudgments: readonly CalibrationJudgment[],
  sensitivityJudgments: readonly CalibrationJudgment[],
): PreferenceRubricSensitivityMetrics {
  validateFrozenSelection(selection);
  const baselineById = validateJudgments(selection.baselineCases, baselineJudgments, "Baseline calibration");
  const sensitivityById = validateJudgments(
    selection.preferences,
    sensitivityJudgments,
    "Preference-rubric sensitivity",
  );
  const gainedCorrect: string[] = [];
  const lostCorrect: string[] = [];
  let changed = 0;
  let baselineCorrect = 0;
  let preferenceRubricCorrect = 0;

  for (const entry of selection.preferences) {
    const baselineCorrectForCase = baselineById.get(entry.caseId)?.correct === true;
    const preferenceCorrectForCase = sensitivityById.get(entry.caseId)?.correct === true;
    if (baselineCorrectForCase) baselineCorrect += 1;
    if (preferenceCorrectForCase) preferenceRubricCorrect += 1;
    if (baselineCorrectForCase !== preferenceCorrectForCase) {
      changed += 1;
      (preferenceCorrectForCase ? gainedCorrect : lostCorrect).push(entry.caseId);
    }
  }

  return {
    count: selection.preferences.length,
    baselineCorrect,
    preferenceRubricCorrect,
    changed,
    gainedCorrect,
    lostCorrect,
  };
}
