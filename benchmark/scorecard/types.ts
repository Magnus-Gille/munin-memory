import type { SearchMode } from "../../src/types.js";
import type { AnswerQualityReport, SerializationMode } from "../answer-quality/types.js";
import type { BenchmarkReport, RunnerMode } from "../types.js";
import type { ScorecardTrustLaneReport } from "./trust-lanes.js";

export type ScorecardProfileName = "smoke" | "full";

export interface ScorecardModelContract {
  model: string;
  temperature: number;
  temperature_policy: "fixed_zero";
  max_output_tokens: number;
}

export interface ScorecardProfileContract {
  profile_id: "deterministic_pipeline_smoke" | "longmemeval_s_full_on_demand";
  input_path: string;
  expected_question_count: number;
  limit: number | null;
  granularity: "session" | "round";
  runner_mode: RunnerMode;
  search_mode: SearchMode;
  serialization: SerializationMode;
  top_k: number;
  reader: ScorecardModelContract;
  judge: ScorecardModelContract;
  repetitions: number;
  seed_policy: "fixed_fixture_stub" | "temperature_zero_provider_no_seed";
  publication_eligible: boolean;
}

export interface ScorecardContract {
  contract_schema_version: 2;
  contract_id: "munin-longmemeval-s-e2e-v2";
  publication_status: "publication_candidate";
  dataset: {
    adapter: "longmemeval";
    split: "s";
    source_url: string;
    expected_full_question_count: 500;
    haystack_policy: "per_question_namespace";
  };
  ingestion: {
    entry_type: "state";
    classification: "public";
    answer_labels_stored_in_corpus: false;
  };
  context_budget: {
    unit: "estimated_tokens";
    top_k: number;
    retrieved_token_budget: number;
    estimator: "utf8_bytes_div4_ceil_v1";
    limitation: string;
  };
  grading: {
    rubric_version: "answer-quality-v1";
    correct_signal: "judge_boolean";
  };
  uncertainty: {
    method: "deterministic_bootstrap_percentile_95";
    confidence: 0.95;
    resamples: number;
    seed: number;
  };
  provider_policy: {
    gateway: "openrouter";
    routing: "zdr_balanced";
    require_response_model: true;
    require_provider: true;
    require_provider_reported_cost: true;
  };
  trust_lanes: {
    authorization: "deterministic_production_primitives_v1";
    instruction_shaped_content: "deterministic_structure_plus_live_reader_v1";
    full_profile_requires_live_poison_pass: true;
  };
  profiles: Record<ScorecardProfileName, ScorecardProfileContract>;
  limitations: string[];
}

export interface ScorecardEnvironmentEvidence {
  node_version: string;
  platform: NodeJS.Platform;
  arch: string;
  os_release: string;
  cpu_model: string;
  cpu_count: number;
  total_memory_bytes: number;
  git_commit: string | null;
  git_dirty: boolean | null;
  package_json_sha256: string;
  package_lock_sha256: string;
}

export interface ScorecardInterval {
  point_estimate: number;
  lower: number;
  upper: number;
  confidence: number;
  method: "deterministic_bootstrap_percentile";
  resamples: number;
  seed: number;
}

export interface MuninAgentMemoryScorecardReport {
  report_kind: "munin_agent_memory_scorecard";
  report_schema_version: 2;
  run_at: string;
  contract_id: ScorecardContract["contract_id"];
  contract_schema_version: ScorecardContract["contract_schema_version"];
  contract_sha256: string;
  profile: ScorecardProfileContract["profile_id"];
  publication_status: "pipeline_smoke" | "publication_candidate";
  publication_eligible: boolean;
  retrieval: BenchmarkReport;
  answer_quality: AnswerQualityReport;
  uncertainty: {
    answer_accuracy: ScorecardInterval;
    retrieval_recall_at_5: ScorecardInterval;
  };
  evidence: {
    environment: ScorecardEnvironmentEvidence;
    stage_duration_ms: {
      ingestion: number;
      embedding: number;
      retrieval: number;
      answer_quality: number;
      trust_lanes: number;
      total: number;
    };
    resources: {
      initial_rss_bytes: number;
      final_rss_bytes: number;
      peak_rss_bytes: number;
    };
    disk: {
      database_bytes: number;
      query_bytes: number;
      provenance_bytes: number;
      total_artifact_bytes: number;
    };
    cost_usd: number | null;
    trust_lanes: ScorecardTrustLaneReport;
  };
  limitations: string[];
}
