/**
 * Answer-quality eval report types.
 *
 * Deliberately a SEPARATE schema family from BenchmarkReport — answer-quality
 * is non-deterministic, paid, on-demand, and must never be confused with IR
 * metric reports or enter the CI gate parser.
 *
 * Reuses QuerySetSource, DurationSummary, RunnerMode, SearchMode from the
 * shared benchmark types.
 */

import type { QuerySetSource, DurationSummary, RunnerMode } from "../types.js";
import type { SearchMode } from "../../src/types.js";
import type { SerializationMode } from "../../src/internal/retrieval-shared.js";
import type { CorpusEmbeddingSummary } from "../adapters/shared.js";
import type { SerializedContextBudget } from "./serialize.js";

export type { SerializationMode };

/** Token usage for a single LLM call. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Provider-reported charged amount in US dollars/credits, when available. */
  cost?: number;
}

export interface LlmCallIdentity {
  requested_model: string;
  response_model?: string;
  provider?: string;
  generation_id?: string;
}

/** Judge verdict for one answer. */
export interface JudgeVerdict {
  /** Primary binary signal — correct = true, incorrect = false. */
  correct: boolean;
  /** Continuous score 0..1, where 1 = perfect. */
  score: number;
  /** Brief reasoning from the judge. */
  reasoning: string;
  /**
   * Whether the judge response parsed cleanly. When false, the response was
   * malformed (no JSON, wrong shape, etc.) and the verdict was degraded to
   * `correct:false, score:0`.
   */
  parse_ok: boolean;
  /** Raw judge output when parse_ok is false. */
  raw?: string;
  /** Token usage of the judge call, when the provider reported it. */
  usage?: TokenUsage;
  call_identity?: LlmCallIdentity;
}

/** Result for one evaluated query. */
export interface AnswerQualityResult {
  query_id: string;
  category: string;
  question: string;
  /** Dataset-supplied evaluation timestamp shown to the answer model, when present. */
  question_date?: string;
  reference_answer: string;
  candidate_answer: string;
  /** Present when answer generation threw; scorecard runs treat this as fatal. */
  answer_error?: string;
  /** Present when judging threw; scorecard runs treat this as fatal. */
  judge_error?: string;
  /** IDs in true linear rank order from the retrieval pipeline. Provenance. */
  retrieved_ids: string[];
  /** IDs in the display order that was fed to the answer model. */
  serialized_order_ids: string[];
  serialization: SerializationMode;
  /** Actual search mode used for retrieval (may differ from global searchMode when query overrides it). */
  effective_search_mode: string;
  verdict: JudgeVerdict;
  /** End-to-end wall time (retrieve + answer + judge) in milliseconds. */
  duration_ms: number;
  stage_duration_ms: {
    retrieval: number;
    serialization: number;
    reader: number;
    judge: number;
  };
  context_budget: SerializedContextBudget;
  answer_call?: LlmCallIdentity;
  judge_call?: LlmCallIdentity;
  answer_usage?: TokenUsage;
  judge_usage?: TokenUsage;
}

/** Per-category aggregate. */
export interface AnswerQualityCategorySummary {
  category: string;
  query_count: number;
  /** Mean of `verdict.correct` for this category. */
  accuracy: number;
  /** Mean of `verdict.score` for this category. */
  mean_score: number;
  /** Number of queries where judge parse failed. */
  judge_parse_failures: number;
  duration: DurationSummary;
}

/** Full answer-quality eval report for one serialization variant. */
export interface AnswerQualityReport {
  /** Discriminator — distinguishes from BenchmarkReport. */
  report_kind: "answer_quality";
  /**
   * Independent version line, separate from BenchmarkReport.report_schema_version.
   * v3 adds retrieved-context budgeting, stage timings, provider/model identity,
   * and complete provider-native usage/cost accounting.
   */
  report_schema_version: 3;
  /** ISO 8601 run timestamp. */
  run_at: string;
  snapshot_path: string;
  snapshot_schema_version: number;
  entry_count: number;
  // Experiment knobs
  serialization: SerializationMode;
  runner_mode: RunnerMode;
  search_mode: SearchMode;
  search_recency_weight: number | null;
  top_k: number;
  context_token_budget: number | null;
  context_token_estimator: "utf8_bytes_div4_ceil_v1";
  answer_model: string;
  /** Null means the provider/model default was used. */
  answer_temperature: number | null;
  answer_max_output_tokens: number;
  judge_model: string;
  judge_temperature: number;
  judge_max_output_tokens: number;
  // Lineage
  query_set_sources: QuerySetSource[];
  query_set_checksum: string;
  query_count: number;
  /** Queries skipped because they had no `reference_answer`. */
  skipped_no_reference: number;
  // Aggregates
  overall_accuracy: number;
  overall_mean_score: number;
  judge_parse_failures: number;
  overall_duration: DurationSummary;
  by_category: AnswerQualityCategorySummary[];
  results: AnswerQualityResult[];
  total_usage?: TokenUsage;
  usage_accounting: {
    expected_calls: number;
    usage_reported_calls: number;
    cost_reported_calls: number;
  };
  execution_identity: {
    requested_answer_model: string;
    requested_judge_model: string;
    response_models: string[];
    providers: string[];
    missing_identity_calls: number;
  };
  warnings?: string[];
  /** Summary of corpus embedding pre-population (populated for hybrid/semantic runs). */
  embedding_summary?: CorpusEmbeddingSummary | null;
  // Graceful skip (when OPENROUTER_API_KEY is unset)
  skipped?: boolean;
  skip_reason?: string;
}

/** A/B comparison report: linear vs boundary serialization. */
export interface AnswerQualityAbReport {
  report_kind: "answer_quality_ab";
  report_schema_version: 3;
  run_at: string;
  /** The A/B variable being tested. */
  variable: "serialization";
  // Identity contract — both variants MUST share these
  snapshot_path: string;
  query_set_checksum: string;
  snapshot_schema_version: number;
  answer_model: string;
  judge_model: string;
  variant_linear: AnswerQualityReport;
  variant_boundary: AnswerQualityReport;
  delta: {
    /** boundary accuracy − linear accuracy. Positive = boundary wins. */
    overall_accuracy: number;
    /** boundary mean_score − linear mean_score. */
    overall_mean_score: number;
    by_category: Array<{
      category: string;
      accuracy_delta: number;
      score_delta: number;
    }>;
  };
}
