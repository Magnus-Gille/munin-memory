/**
 * Frozen, public-safe fixtures for answer-quality calibration.
 *
 * Historical answers and expected verdicts come from the public 2026-07-24
 * LongMemEval-S scorecard. Synthetic controls below are rubric checks, not
 * human annotations of benchmark examples.
 */

export const CALIBRATION_SEED = 227;
export const LONGMEMEVAL_PREFERENCE_CATEGORY = "longmemeval/single-session-preference";

export const LONGMEMEVAL_NONPREFERENCE_CATEGORIES = [
  "longmemeval/knowledge-update",
  "longmemeval/multi-session",
  "longmemeval/single-session-assistant",
  "longmemeval/single-session-user",
  "longmemeval/temporal-reasoning",
] as const;

export interface SyntheticCalibrationControl {
  readonly caseId: string;
  readonly category: string;
  readonly question: string;
  readonly referenceAnswer: string;
  readonly candidateAnswer: string;
  readonly expectedCorrect: boolean;
  readonly expectedScore: 0 | 0.5 | 1;
}

/** Six deterministic controls for answer-quality-v1 factual/abstention behavior. */
export const SYNTHETIC_CALIBRATION_CONTROLS: readonly SyntheticCalibrationControl[] = [
  {
    caseId: "control-factual-exact",
    category: "calibration/factual",
    question: "What color was the folder?",
    referenceAnswer: "The folder was blue.",
    candidateAnswer: "The folder was blue.",
    expectedCorrect: true,
    expectedScore: 1,
  },
  {
    caseId: "control-factual-paraphrase",
    category: "calibration/factual",
    question: "What color was the folder?",
    referenceAnswer: "The folder was blue.",
    candidateAnswer: "It was a blue folder.",
    expectedCorrect: true,
    expectedScore: 1,
  },
  {
    caseId: "control-factual-partial",
    category: "calibration/factual",
    question: "Where and when was the meeting held?",
    referenceAnswer: "The meeting was in Room 12 at 3 p.m.",
    candidateAnswer: "The meeting was in Room 12.",
    expectedCorrect: false,
    expectedScore: 0.5,
  },
  {
    caseId: "control-factual-contradiction",
    category: "calibration/factual",
    question: "What color was the folder?",
    referenceAnswer: "The folder was blue.",
    candidateAnswer: "The folder was red.",
    expectedCorrect: false,
    expectedScore: 0,
  },
  {
    caseId: "control-answerable-abstention",
    category: "calibration/factual",
    question: "What color was the folder?",
    referenceAnswer: "The folder was blue.",
    candidateAnswer: "I cannot find the answer in the provided context.",
    expectedCorrect: false,
    expectedScore: 0,
  },
  {
    caseId: "control-unanswerable-abstention",
    category: "locomo/adversarial",
    question: "What color was an object that was never described?",
    referenceAnswer: "",
    candidateAnswer: "I do not know; that information is not available.",
    expectedCorrect: true,
    expectedScore: 1,
  },
];

/**
 * Frozen preference-rubric wording for sensitivity analysis only. The
 * answer-quality-v1 rubric remains the primary comparator.
 */
export const PREFERENCE_AWARE_JUDGE_RUBRIC = `You are judging a LongMemEval-S single-session-preference answer. You receive only the question, reference, and candidate answer. In this category, the reference describes the user's preferences and constraints; it is not canonical wording that the candidate must repeat and may not itself be a direct answer to the question. Judge whether the candidate answers the user's question in a useful way that is consistent with the preferences stated in the reference. Do not require the candidate to name every preference or use the same recommendation as the reference. Score 1.0 when it gives a direct, useful, materially personalized answer without contradicting a stated preference. Score 0.5 when it is relevant but generic or materially incomplete, only restates the preference profile instead of answering, or includes an unnecessary partial abstention while still giving useful, supported content. Score 0.0 when it is irrelevant, totally abstains despite the preference reference supplying enough direction to answer, or materially contradicts an explicit preference. Do not infer personal facts beyond the question and reference. Because retrieved context is not provided to you, do not claim that it contains or omits evidence, or judge whether retrieval found evidence. Set correct=true only for score 1.0; set correct=false for scores 0.5 and 0.0. Return only the required JSON object with correct, score, and brief reasoning.`;

/** Optional synthetic preference-rubric controls; excluded from the primary gate. */
export const PREFERENCE_RUBRIC_SYNTHETIC_CONTROLS: readonly SyntheticCalibrationControl[] = [
  {
    caseId: "preference-control-personalized",
    category: LONGMEMEVAL_PREFERENCE_CATEGORY,
    question: "What can I listen to during my commute?",
    referenceAnswer:
      "Prefers history podcasts or audiobooks; does not want true crime or self-improvement; needs audio suitable for a commute.",
    candidateAnswer:
      "Try a history podcast or audiobook for the trip; it fits your interest and works without looking at a screen.",
    expectedCorrect: true,
    expectedScore: 1,
  },
  {
    caseId: "preference-control-generic",
    category: LONGMEMEVAL_PREFERENCE_CATEGORY,
    question: "What can I listen to during my commute?",
    referenceAnswer:
      "Prefers history podcasts or audiobooks; does not want true crime or self-improvement; needs audio suitable for a commute.",
    candidateAnswer: "Try a popular podcast or make a music playlist.",
    expectedCorrect: false,
    expectedScore: 0.5,
  },
  {
    caseId: "preference-control-conflict",
    category: LONGMEMEVAL_PREFERENCE_CATEGORY,
    question: "What can I listen to during my commute?",
    referenceAnswer:
      "Prefers history podcasts or audiobooks; does not want true crime or self-improvement; needs audio suitable for a commute.",
    candidateAnswer: "Try a true-crime podcast or a self-improvement show.",
    expectedCorrect: false,
    expectedScore: 0,
  },
  {
    caseId: "preference-control-profile-only",
    category: LONGMEMEVAL_PREFERENCE_CATEGORY,
    question: "Which cocktail should I make for a gathering?",
    referenceAnswer:
      "Has taken a mixology class; prefers inventive twists on classic drinks such as a Pimm's Cup and dislikes basic recipes.",
    candidateAnswer: "You prefer creative twists on classic cocktails and do not want a basic recipe.",
    expectedCorrect: false,
    expectedScore: 0.5,
  },
  {
    caseId: "preference-control-partial-abstention",
    category: LONGMEMEVAL_PREFERENCE_CATEGORY,
    question: "Can you suggest an accessory for my camera?",
    referenceAnswer:
      "The user owns a fictional ExampleCam S1, prefers compatible accessories, and has raised battery-life concerns.",
    candidateAnswer:
      "I can't give a complete list without knowing your lenses, but an ExampleCam S1-compatible spare battery is a useful starting point.",
    expectedCorrect: false,
    expectedScore: 0.5,
  },
  {
    caseId: "preference-control-total-abstention",
    category: LONGMEMEVAL_PREFERENCE_CATEGORY,
    question: "Can you suggest an accessory for my camera?",
    referenceAnswer:
      "The user owns a fictional ExampleCam S1, prefers compatible accessories, and has raised battery-life concerns.",
    candidateAnswer: "I can't suggest anything until you tell me which camera you own.",
    expectedCorrect: false,
    expectedScore: 0,
  },
];
