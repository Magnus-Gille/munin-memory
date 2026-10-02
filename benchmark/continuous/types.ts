import type { ScoringResult } from "../scorer.js";
import type { RunnerMode } from "../types.js";

export const DECISION_EVAL_CONTRACT_ID = "munin-decision-retrieval-v1" as const;
export const DECISION_EVAL_SCHEMA_VERSION = 1 as const;

export type DecisionQuestionVariant = "keyword" | "swedish-natural-language";
export type DecisionMemoryEntryType = "log" | "state";
export type DecisionMemoryWriteApi = "appendLog" | "writeState";

export interface DecisionFact {
  case_id: string;
  project_name: string;
  namespace: string;
  topic: string;
  option_a: string;
  option_b: string;
  chosen_option: string;
  rejected_option: string;
  rationale: string;
  superseded_option: string;
  superseded_rationale: string;
  correct_evidence_id: string;
}

export interface DecisionMemoryRow {
  corpus_ref: string;
  case_id: string;
  namespace: string;
  key: string | null;
  entry_type: DecisionMemoryEntryType;
  write_api: DecisionMemoryWriteApi;
  tags: string[];
  timestamp: string;
  content: string;
}

export interface DecisionFixtureQuestion {
  id: string;
  case_id: string;
  variant: DecisionQuestionVariant;
  query: string;
  expected_corpus_refs: [string];
}

export interface DecisionFixture {
  schema_version: typeof DECISION_EVAL_SCHEMA_VERSION;
  contract_id: typeof DECISION_EVAL_CONTRACT_ID;
  seed: number;
  fixed_now: string;
  old_decision_time: string;
  facts: DecisionFact[];
  corpus_rows: DecisionMemoryRow[];
  questions: DecisionFixtureQuestion[];
}

export interface ContinuousEvalQueryResult {
  query_id: string;
  case_id: string;
  variant: DecisionQuestionVariant;
  expected_corpus_ref: string;
  ranked_corpus_refs: string[];
  rank: number | null;
  scores: ScoringResult;
}

export type KnownContinuousEvalWarning = "sqlite_vec_unavailable_lexical_only";

export interface ContinuousEvalModeReport {
  runner_mode: RunnerMode;
  effective_search_mode: "lexical";
  search_recency_weight: number | null;
  overall: ScoringResult;
  by_variant: Record<DecisionQuestionVariant, ScoringResult>;
  per_case: ContinuousEvalQueryResult[];
  known_warnings: KnownContinuousEvalWarning[];
}

export interface EvidenceRemovedControl {
  passed: true;
  question_count: number;
  removed_evidence_count: number;
  min_results_per_question: Record<RunnerMode, number>;
  raw: ScoringResult;
  production_ranker: ScoringResult;
}

export interface GoldIntegrityControl {
  passed: true;
  checked_row_count: number;
}

export interface ScorerOracleControl {
  passed: true;
  question_count: number;
  scores: ScoringResult;
}

export interface ContinuousEvalReport {
  schema_version: typeof DECISION_EVAL_SCHEMA_VERSION;
  status: "measured";
  contract_id: typeof DECISION_EVAL_CONTRACT_ID;
  fixture_sha256: string;
  seed: number;
  question_count: number;
  modes: Record<RunnerMode, ContinuousEvalModeReport>;
  metrics: Record<string, number>;
  controls: {
    evidence_removed: EvidenceRemovedControl;
    gold_integrity: GoldIntegrityControl;
    scorer_oracle: ScorerOracleControl;
  };
}
