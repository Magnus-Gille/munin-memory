import type { SearchMode } from "../../src/types.js";
import type { AnswerQualityReport, SerializationMode } from "../answer-quality/types.js";
import type { BenchmarkReport, RunnerMode } from "../types.js";

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
  publication_eligible: false;
}

export interface ScorecardContract {
  contract_schema_version: 1;
  contract_id: "munin-longmemeval-s-e2e-v1";
  publication_status: "unpublished_foundation";
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
    unit: "entries";
    top_k: number;
    retrieved_token_budget: null;
    limitation: string;
  };
  grading: {
    rubric_version: "answer-quality-v1";
    correct_signal: "judge_boolean";
  };
  profiles: Record<ScorecardProfileName, ScorecardProfileContract>;
  required_before_publication: string[];
}

export interface MuninAgentMemoryScorecardReport {
  report_kind: "munin_agent_memory_scorecard";
  report_schema_version: 1;
  run_at: string;
  contract_id: ScorecardContract["contract_id"];
  contract_schema_version: ScorecardContract["contract_schema_version"];
  contract_sha256: string;
  profile: ScorecardProfileContract["profile_id"];
  publication_status: "unpublished_foundation";
  publication_eligible: false;
  retrieval: BenchmarkReport;
  answer_quality: AnswerQualityReport;
  limitations: string[];
}
