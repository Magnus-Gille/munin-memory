// Entry types stored in the database

export type EntryType = "state" | "log";
export type EmbeddingStatus = "pending" | "processing" | "generated" | "failed";
export type SearchMode = "lexical" | "semantic" | "hybrid";
export type OrientDetail = "compact" | "standard" | "full";
export type AuditAction = "write" | "update" | "patch" | "delete" | "namespace_delete" | "log_append";
export type CommitmentStatus = "open" | "done" | "cancelled";
export type ClassificationLevel =
  | "public"
  | "internal"
  | "client-confidential"
  | "client-restricted";
export type TransportType = "local" | "dpa_covered" | "consumer";
export type AuthMethod = "stdio" | "legacy_bearer" | "bearer" | "oauth" | "agent_token";

export interface EntryProvenance {
  principal_id: string;
  owner_principal_id?: string;
}

export interface Entry {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: EntryType;
  content: string;
  tags: string; // JSON array string
  agent_id: string;
  owner_principal_id: string | null;
  created_at: string;
  updated_at: string;
  valid_until: string | null;
  classification: ClassificationLevel;
  embedding_status: EmbeddingStatus;
  embedding_model: string | null;
}

// Parsed entry with tags as array
export interface ParsedEntry extends Omit<Entry, "tags"> {
  tags: string[];
}

// Tool parameter types

export interface WriteParams {
  namespace: string;
  key: string;
  content?: string;
  tags?: string[];
  valid_until?: string | null;
  classification?: ClassificationLevel;
  classification_override?: boolean;
}

export interface StatusUpdateParams {
  namespace: string;
  phase?: string;
  current_work?: string;
  blockers?: string;
  next_steps?: string[];
  notes?: string;
  lifecycle?: "active" | "blocked" | "completed" | "stopped" | "maintenance" | "archived";
  expected_updated_at?: string;
  classification?: ClassificationLevel;
  classification_override?: boolean;
}

export interface ReadParams {
  namespace: string;
  key: string;
}

export interface ReadBatchParams {
  reads: Array<{ namespace: string; key: string }>;
}

export interface GetParams {
  id: string;
}

export interface QueryParams {
  query?: string;
  namespace?: string;
  entry_type?: EntryType;
  tags?: string[];
  limit?: number;
  search_mode?: SearchMode;
  search_recency_weight?: number;
  include_expired?: boolean;
  explain?: boolean;
  since?: string;
  until?: string;
}

export interface OrientParams extends ListParams {
  detail?: OrientDetail;
  include_full_conventions?: boolean;
  dashboard_limit_per_group?: number;
  namespace_limit?: number;
  include_namespaces?: boolean;
}

export interface ResumeParams {
  opener?: string;
  namespace?: string;
  project?: string;
  limit?: number;
  include_history?: boolean;
  include_attention?: boolean;
}

export interface ExtractParams {
  conversation_text: string;
  namespace_hint?: string;
  project_hint?: string;
  max_suggestions?: number;
}

export interface NarrativeParams {
  namespace: string;
  since?: string;
  limit?: number;
  include_sources?: boolean;
}

export interface CommitmentsParams {
  namespace?: string;
  since?: string;
  limit?: number;
}

export interface PatternsParams {
  namespace?: string;
  topic?: string;
  since?: string;
  limit?: number;
}

export interface HandoffParams {
  namespace: string;
  since?: string;
  limit?: number;
}

export interface LogParams {
  namespace: string;
  content: string;
  tags?: string[];
  classification?: ClassificationLevel;
  classification_override?: boolean;
}

export interface ListParams {
  namespace?: string;
  include_demo?: boolean;
  include_completed_tasks?: boolean;
  limit?: number;
  offset?: number;
}

export interface DeleteParams {
  namespace: string;
  key?: string;
  confirm?: boolean;
  delete_token?: string;
}

export interface AttentionParams {
  namespace_prefix?: string;
  include_blocked?: boolean;
  include_stale?: boolean;
  include_upcoming_events?: boolean;
  include_expiring?: boolean;
  include_missing_status?: boolean;
  include_conflicting_lifecycle?: boolean;
  include_missing_lifecycle?: boolean;
  limit?: number;
}

export interface AuditSyncParams {
  namespace?: string;
  action?: AuditAction | "delete_namespace" | "log";
  cursor?: number;
  limit?: number;
}

// Tool response types

export interface WriteResponse {
  status: "created" | "updated" | "conflict";
  id?: string;
  namespace: string;
  key: string;
  hint?: string;
  message?: string;
  current_updated_at?: string;
  warnings?: string[];
}

export interface StatusUpdateResponse extends WriteResponse {
  content?: string;
  updated_at?: string;
  structured_status?: {
    phase: string;
    current_work: string;
    blockers: string;
    next_steps: string[];
    notes?: string;
  };
}

export interface DashboardSynthesis {
  summary?: string;
  updated_at: string;
  updated_at_local?: string;
  synthesis_age_days: number;
  logs_incorporated: number | null;
  origin: "auto" | "manual";
  stale?: true;
  cross_references: Array<{
    target_namespace: string;
    reference_type: string;
    context: string | null;
    confidence: number;
  }>;
}

export interface DashboardEntry {
  namespace: string;
  summary: string;
  updated_at: string;
  updated_at_local?: string;
  lifecycle: string;
  needs_attention?: true;
  synthesis?: DashboardSynthesis;
  classification?: ClassificationLevel;
  redacted?: boolean;
  redaction_reason?: string;
}

export interface MaintenanceItem {
  namespace: string;
  issue: "active_but_stale" | "missing_status" | "conflicting_lifecycle" | "missing_lifecycle" | "upcoming_event_stale" | "expiring_soon" | "expired";
  suggestion: string;
}

export interface TrackedStatusRow {
  id: string;
  namespace: string;
  key: string;
  content_preview: string;
  content: string;
  tags: string;
  agent_id: string;
  owner_principal_id: string | null;
  created_at: string;
  updated_at: string;
  valid_until: string | null;
  classification: ClassificationLevel;
}

export interface ReadResponse {
  found: boolean;
  id?: string;
  namespace: string;
  key: string;
  content?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  valid_until?: string | null;
  classification?: ClassificationLevel;
  expired?: boolean;
  provenance?: EntryProvenance;
  redacted?: boolean;
  redaction_reason?: string;
  message?: string;
  hint?: string;
}

export interface GetResponse {
  found: boolean;
  id?: string;
  namespace?: string;
  key?: string | null;
  entry_type?: EntryType;
  content?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  valid_until?: string | null;
  classification?: ClassificationLevel;
  expired?: boolean;
  provenance?: EntryProvenance;
  redacted?: boolean;
  redaction_reason?: string;
  message?: string;
}

export interface QueryResult {
  id?: string;
  namespace: string;
  key?: string | null;
  entry_type?: EntryType;
  content_preview?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  updated_at_local?: string;
  valid_until?: string | null;
  classification?: ClassificationLevel;
  expired?: boolean;
  provenance?: EntryProvenance;
  redacted?: boolean;
  redaction_reason?: string;
  match?: {
    heuristic_score: number;
    freshness_score?: number;
    lexical_rank?: number;
    lexical_score?: number;
    semantic_rank?: number;
    semantic_distance?: number;
    hybrid_score?: number;
    reasons: string[];
  };
}

export interface QueryResponse {
  results: QueryResult[];
  total: number;
  redacted_count?: number;
  query?: string;
  search_mode: SearchMode | "filter";
  search_mode_actual?: SearchMode;
  warning?: string;
  retrieval?: {
    reranked: boolean;
    relaxed_lexical: boolean;
    fallback_reason: string | null;
    recency_applied: boolean;
    search_recency_weight: number;
    expired_filtered_count: number;
  };
}

export interface LogResponse {
  status: "logged";
  id: string;
  namespace: string;
  timestamp: string;
  classification?: ClassificationLevel;
  provenance?: EntryProvenance;
}

export interface NamespaceSummary {
  namespace: string;
  state_count: number;
  log_count: number;
  last_activity_at: string;
}

export interface LogPreview {
  id?: string;
  content_preview?: string;
  tags?: string[];
  created_at?: string;
  classification?: ClassificationLevel;
  provenance?: EntryProvenance;
  redacted?: boolean;
  redaction_reason?: string;
}

export interface NamespaceDetail {
  state_entries: Array<{
    id?: string;
    key?: string;
    preview?: string;
    tags?: string[];
    updated_at?: string;
    classification?: ClassificationLevel;
    provenance?: EntryProvenance;
    redacted?: boolean;
    redaction_reason?: string;
  }>;
  log_summary: {
    log_count: number;
    earliest: string | null;
    latest: string | null;
    recent: LogPreview[];
  };
}

export interface ListResponse {
  namespaces?: NamespaceSummary[];
  namespace?: string;
  state_entries?: NamespaceDetail["state_entries"];
  log_summary?: NamespaceDetail["log_summary"];
}

export interface DeletePreview {
  action: "preview";
  namespace: string;
  key?: string;
  will_delete: {
    state_count: number;
    log_count: number;
    keys?: string[];
  };
  delete_token: string;
  message: string;
}

export interface DeleteConfirmation {
  action: "deleted";
  namespace: string;
  key?: string;
  deleted_count: number;
  message: string;
}

export type DeleteResponse = DeletePreview | DeleteConfirmation;

export interface AttentionItem {
  namespace: string;
  category: MaintenanceItem["issue"] | "blocked";
  severity: "high" | "medium" | "low";
  updated_at: string;
  preview: string;
  reason: string;
  suggested_action: string;
  classification?: ClassificationLevel;
  redacted?: boolean;
  redaction_reason?: string;
}

export interface AttentionResponse {
  generated_at: string;
  summary: {
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  items: AttentionItem[];
  redacted_sources?: RedactedSourcesSummary;
}

export interface RedactedSourcesSummary {
  count: number;
  reason: string;
  namespaces?: string[];
}

export interface LibrarianRuntimeSummary {
  enabled: boolean;
  transport_type: TransportType;
  max_classification: ClassificationLevel;
  redacted_dashboard_count?: number;
  redacted_source_count?: number;
  access_guidance?: string;
}

export interface ResumeItem {
  namespace: string;
  key?: string | null;
  entry_id?: string;
  category: "status" | "state" | "decision_log" | "history" | "reference";
  preview: string;
  updated_at: string;
  reason: string;
  suggested_action: string;
}

export interface ResumeOpenLoop {
  namespace: string;
  type: "blocker" | "next_step" | "attention";
  summary: string;
  suggested_action: string;
}

export interface ResumeSuggestedRead {
  tool: "memory_read" | "memory_get" | "memory_history";
  namespace?: string;
  key?: string;
  id?: string;
  reason: string;
}

export interface ResumeResponse {
  summary: string;
  target_namespace?: string;
  items: ResumeItem[];
  open_loops: ResumeOpenLoop[];
  suggested_reads: ResumeSuggestedRead[];
  why_this_set: string[];
  redacted_sources?: RedactedSourcesSummary;
}

export interface ExtractSuggestion {
  action: "memory_write" | "memory_log" | "memory_update_status";
  namespace: string;
  key?: string;
  content?: string;
  tags?: string[];
  status_patch?: {
    phase?: string;
    current_work?: string;
    blockers?: string;
    next_steps?: string[];
    notes?: string;
    lifecycle?: "active" | "blocked" | "completed" | "stopped" | "maintenance" | "archived";
  };
  rationale: string;
  confidence: number;
}

export interface ExtractRelatedEntry {
  id: string;
  namespace: string;
  key?: string | null;
  entry_type: EntryType;
  preview: string;
  updated_at: string;
  reason: string;
}

export interface ExtractResponse {
  suggestions: ExtractSuggestion[];
  candidate_namespaces: string[];
  related_entries: ExtractRelatedEntry[];
  capture_warnings: string[];
  redacted_sources?: RedactedSourcesSummary;
}

export interface NarrativeSignal {
  category: "time_in_phase" | "blocker_age" | "reversal_pattern" | "decision_churn" | "long_gap";
  severity: "high" | "medium" | "low";
  summary: string;
  reason: string;
  source_entry_ids: string[];
  source_audit_ids: number[];
}

export interface NarrativeTimelineItem {
  timestamp: string;
  category: "status" | "log" | "audit";
  summary: string;
  source_entry_id?: string;
  source_audit_id?: number;
}

export interface NarrativeSource {
  kind: "entry" | "audit";
  id: string | number;
  namespace: string;
  key?: string | null;
  timestamp: string;
  preview: string;
}

export interface NarrativeResponse {
  namespace: string;
  summary: string;
  signals: NarrativeSignal[];
  timeline: NarrativeTimelineItem[];
  sources?: NarrativeSource[];
  redacted_sources?: RedactedSourcesSummary;
}

export interface CommitmentItem {
  id: string;
  namespace: string;
  text: string;
  due_at: string | null;
  status: CommitmentStatus;
  confidence: number;
  source_type: string;
  source_entry_id: string;
  source_key: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  source_excerpt?: string;
  source_classification?: ClassificationLevel;
  reason?: string;
}

export interface CommitmentsResponse {
  open: CommitmentItem[];
  at_risk: CommitmentItem[];
  overdue: CommitmentItem[];
  completed_recently: CommitmentItem[];
  redacted_sources?: RedactedSourcesSummary;
}

export interface PatternItem {
  kind: "decision_theme" | "commitment_slip" | "blocked_followthrough" | "undated_next_steps";
  summary: string;
  confidence: number;
  source_entry_ids: string[];
  source_namespaces: string[];
}

export interface HeuristicItem {
  summary: string;
  rationale: string;
  source_entry_ids: string[];
}

export interface PatternSource {
  entry_id: string;
  namespace: string;
  key: string | null;
  preview: string;
  updated_at: string;
}

export interface PatternsResponse {
  patterns: PatternItem[];
  heuristics: HeuristicItem[];
  supporting_sources: PatternSource[];
  redacted_sources?: RedactedSourcesSummary;
}

export interface HandoffDecision {
  timestamp: string;
  summary: string;
  source_entry_id: string;
}

export interface HandoffActor {
  principal_id: string;
  last_seen_at: string;
  actions: string[];
}

export interface HandoffState {
  namespace: string;
  summary: string;
  updated_at: string;
  source_entry_id?: string;
}

export interface HandoffResponse {
  found: boolean;
  namespace: string;
  current_state: HandoffState | null;
  recent_decisions: HandoffDecision[];
  open_loops: string[];
  recent_actors: HandoffActor[];
  recommended_next_actions: string[];
  redacted_sources?: RedactedSourcesSummary;
}

// Retrieval insights types

export interface InsightsParams {
  namespace?: string;
  min_impressions?: number;
  limit?: number;
}

export interface EntryInsight {
  entry_id: string;
  namespace: string | null;
  key: string | null;
  content_preview: string | null;
  impressions: number;
  opens: number;
  followthrough_rate: number;
  staleness_pressure: number;
  learned_signals: string[];
}

export interface InsightsResponse {
  entries: EntryInsight[];
  total: number;
  min_impressions: number;
  aggregates?: RetrievalAggregates;
}

// Retrieval feedback types

export type RetrievalFeedbackType =
  | "bad_results"
  | "missing_result"
  | "wrong_order"
  | "stale_results"
  | "good_results";

export interface RetrievalFeedbackParams {
  feedback_type: RetrievalFeedbackType;
  query?: string;
  expected_namespace?: string;
  expected_key?: string;
  expected_entry_id?: string;
  detail?: string;
}

export interface RetrievalFeedbackRow {
  id: string;
  retrieval_event_id: string | null;
  session_id: string;
  feedback_type: RetrievalFeedbackType;
  query_text: string | null;
  expected_namespace: string | null;
  expected_key: string | null;
  expected_entry_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface RetrievalAggregates {
  period_start: string;
  period_end: string;
  total_events: number;
  total_outcomes: number;
  reformulation_rate: number;
  positive_outcome_rate: number;
  feedback_counts: Record<RetrievalFeedbackType, number>;
  total_feedback: number;
}

// Security types

export interface SecurityResult {
  valid: boolean;
  error?: string;
}

// Audit history tool params
export interface AuditHistoryParams {
  namespace?: string;
  since?: string;
  action?: AuditAction | "delete_namespace" | "log";
  limit?: number;
  cursor?: number;
}

// Intake / quality-gate types

export type IntakeMode = "strict" | "advisory" | "passthrough";

export interface IntakeFlag {
  check:
    | "duplicate_key"
    | "content_overlap"
    | "consolidation_candidate"
    | "low_relevance"
    | "tag_inconsistency"
    | "namespace_depth";
  severity: "error" | "warning" | "info";
  message: string;
  related_entry_id?: string;
}

export interface RelatedKeyRef {
  namespace: string;
  key: string | null;
  relationship: string;
}

export interface RedundancyInfo {
  existing_key: string | null;
  similarity: number;
}

export interface IntakeMetadata {
  intake_score: number;
  intake_mode: IntakeMode;
  related_keys: RelatedKeyRef[];
  redundancy_flag: RedundancyInfo | null;
  intake_timestamp: string;
}

export interface IntakeResult {
  status: "accepted" | "flagged" | "rejected";
  flags: IntakeFlag[];
  metadata: IntakeMetadata;
  rejection_reason?: string;
}

// Consolidation types

export interface ConsolidationMetadata {
  namespace: string;
  last_consolidated_at: string;
  last_log_id: string | null;
  last_log_created_at: string | null;
  synthesis_model: string;
  synthesis_token_count: number | null;
  run_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface CrossReference {
  id: string;
  source_namespace: string;
  target_namespace: string;
  reference_type: "depends_on" | "blocks" | "related_to" | "supersedes" | "feeds_into";
  context: string | null;
  confidence: number;
  extracted_at: string;
  source_synthesis_id: string | null;
}

export type CrossReferenceType = CrossReference["reference_type"];

export interface ConsolidationCandidate {
  namespace: string;
  unincorporated_log_count: number;
  last_consolidated_at: string | null;
}

export interface SynthesisResult {
  status_content: string;
  tags: string[];
  cross_references: Array<{
    target_namespace: string;
    reference_type: CrossReferenceType;
    context: string;
    confidence: number;
  }>;
}

export interface ConsolidationRunResult {
  namespace: string;
  logs_processed: number;
  synthesis_model: string;
  token_count: number | null;
  duration_ms: number;
  cross_references_found: number;
  error?: string;
}

// Audit log entry
export interface AuditEntry {
  id: number;
  timestamp: string;
  agent_id: string;
  action: AuditAction | "delete_namespace" | "log";
  namespace: string;
  key: string | null;
  entry_id: string | null;
  detail: string | null;
  classification?: ClassificationLevel;
  redacted?: boolean;
  redaction_reason?: string;
  provenance?: EntryProvenance;
}

export interface AuditHistoryResponse {
  generated_at: string;
  count: number;
  entries: AuditEntry[];
  next_cursor: number | null;
  has_more: boolean;
}
