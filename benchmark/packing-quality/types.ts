import type { OpenRouterCallOptions, ChatCompletionResponse } from "../../src/internal/openrouter.js";
import type { SerializedContextBudget } from "../answer-quality/serialize.js";
import type { JudgeVerdict } from "../answer-quality/types.js";

export type Variant = "baseline" | "core";
export type Stage = "reader" | "judge";
export interface PackedContext { text: string; sha256: string; ordered_ids: string[]; budget: SerializedContextBudget; selected_message_indices?: Array<{ entry_id: string; message_indices: number[] }>; selected_ranges?: Array<{ entry_id: string; start: number; end: number }> }
export interface QualityQuery {
  query_id: string; question: string; question_date?: string; reference_answer: string; category: string;
  retrieved_ids: string[]; baseline: PackedContext; core: PackedContext;
}
export interface FileBinding { path: string; sha256: string; bytes: number }
export interface QualityManifest {
  schema_version: 1; report_kind: "packing_quality_manifest"; evidence_scope: "development_set_not_held_out";
  as_of: string; identity: string; rule: "query-message-cores-v1";
  retrieval: { runner_mode: "production_ranker"; search_mode: "hybrid"; top_k: 10; search_recency_weight: 0; context_token_budget: 8192 };
  inputs: Record<string, FileBinding>; source_revision: string; source_sha256: Record<string, string>;
  queries: QualityQuery[]; manifest_sha256: string;
}
export interface ModelProfile {
  model: string; identity: string; provider_kind: "local_self_hosted" | "paid_api";
  max_output_tokens: number; temperature: number;
  pricing?: { input_usd_per_million: number; output_usd_per_million: number; source: string };
}
export interface RunConfig {
  schema_version: 1; reader: ModelProfile; judge: ModelProfile; timeout_ms: number;
  cost: { mode: "local"; api_charge_assumption: "self_hosted_no_paid_api" } | { mode: "paid"; max_total_usd: number };
}
/** Finish reason is required for success even though the legacy ChatFn type omits it. */
export interface QualityResponse extends ChatCompletionResponse {
  choices: Array<{ message: { content: string }; finish_reason?: string | null }>;
}
export interface CallControl {
  call_id: string; query_id: string; variant: Variant; stage: Stage; signal: AbortSignal; timeout_ms: number;
  provider_kind: ModelProfile["provider_kind"];
}
/** The caller owns endpoint/credentials. This harness never supplies or reads credentials. */
export type Transport = (opts: OpenRouterCallOptions, control: CallControl) => Promise<QualityResponse>;
export interface CallCheckpoint {
  schema_version: 1; binding_sha256: string; call_id: string; query_id: string; variant: Variant; stage: Stage;
  request_sha256: string; status: "pending" | "complete" | "invalid" | "malformed" | "unknown";
  reserved_usd: number | null; cost_usd: number | null; cost_basis: "self_hosted_assumption" | "provider_receipt" | "unreconciled_reservation";
  response?: QualityResponse; answer?: string; verdict?: JudgeVerdict; error?: string; finish_reason?: string | null;
  truncated?: boolean; duration_ms?: number; checkpoint_sha256: string;
}
export interface PairOutcome { query_id: string; category: string; baseline: { correct: boolean; abstained: boolean } | null; core: { correct: boolean; abstained: boolean } | null }
