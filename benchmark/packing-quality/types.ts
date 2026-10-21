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
const failureCategories = ["busy", "rate_limited", "upstream_error", "authentication", "timeout", "unknown"] as const;
const failureCodes = ["tool_error", "authentication_error", "upstream_error", "rate_limited", "timeout"] as const;
export interface TransportFailureDiagnostic {
  category: typeof failureCategories[number]; cli_code?: typeof failureCodes[number];
  retryable?: boolean; retry_after_seconds?: number; exit_code?: number;
}
/** Copy only content-free primitives; never preserve arbitrary CLI text or fields. */
export function sanitizeTransportFailureDiagnostic(value: unknown): TransportFailureDiagnostic {
  const input = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    category: failureCategories.includes(input.category as TransportFailureDiagnostic["category"]) ? input.category as TransportFailureDiagnostic["category"] : "unknown",
    ...(failureCodes.includes(input.cli_code as NonNullable<TransportFailureDiagnostic["cli_code"]>) ? { cli_code: input.cli_code as NonNullable<TransportFailureDiagnostic["cli_code"]> } : {}),
    ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {}),
    ...(typeof input.retry_after_seconds === "number" && Number.isSafeInteger(input.retry_after_seconds) && input.retry_after_seconds >= 0 && input.retry_after_seconds <= 3600 ? { retry_after_seconds: input.retry_after_seconds } : {}),
    ...(typeof input.exit_code === "number" && Number.isSafeInteger(input.exit_code) && input.exit_code >= 1 && input.exit_code <= 255 ? { exit_code: input.exit_code } : {}),
  };
}
/** A diagnostic cannot establish whether inference or charging occurred. */
export class TransportFailure extends Error {
  readonly diagnostic: Readonly<TransportFailureDiagnostic>;
  constructor(diagnostic: unknown) {
    super("Transport failed; outcome unknown, no automatic retry"); this.name = "TransportFailure";
    this.diagnostic = Object.freeze(sanitizeTransportFailureDiagnostic(diagnostic));
  }
}
export interface CallCheckpoint {
  schema_version: 1; binding_sha256: string; call_id: string; query_id: string; variant: Variant; stage: Stage;
  request_sha256: string; status: "pending" | "complete" | "invalid" | "malformed" | "unknown";
  reserved_usd: number | null; cost_usd: number | null; cost_basis: "self_hosted_assumption" | "provider_receipt" | "unreconciled_reservation";
  response?: QualityResponse; answer?: string; verdict?: JudgeVerdict; error?: string; finish_reason?: string | null;
  truncated?: boolean; duration_ms?: number; transport_diagnostic?: TransportFailureDiagnostic; checkpoint_sha256: string;
}
export interface PairOutcome { query_id: string; category: string; baseline: { correct: boolean; abstained: boolean } | null; core: { correct: boolean; abstained: boolean } | null }
