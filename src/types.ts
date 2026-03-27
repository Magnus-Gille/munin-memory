// Entry types stored in the database

export type EntryType = "state" | "log";
export type EmbeddingStatus = "pending" | "processing" | "generated" | "failed";
export type SearchMode = "lexical" | "semantic" | "hybrid";
export type OrientDetail = "compact" | "standard" | "full";

export interface Entry {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: EntryType;
  content: string;
  tags: string; // JSON array string
  agent_id: string;
  created_at: string;
  updated_at: string;
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
  content: string;
  tags?: string[];
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
  query: string;
  namespace?: string;
  entry_type?: EntryType;
  tags?: string[];
  limit?: number;
  search_mode?: SearchMode;
  explain?: boolean;
}

export interface OrientParams extends ListParams {
  detail?: OrientDetail;
  include_full_conventions?: boolean;
  dashboard_limit_per_group?: number;
  namespace_limit?: number;
  include_namespaces?: boolean;
}

export interface LogParams {
  namespace: string;
  content: string;
  tags?: string[];
}

export interface ListParams {
  namespace?: string;
  include_demo?: boolean;
  include_completed_tasks?: boolean;
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
  include_missing_status?: boolean;
  include_conflicting_lifecycle?: boolean;
  include_missing_lifecycle?: boolean;
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

export interface DashboardEntry {
  namespace: string;
  summary: string;
  updated_at: string;
  lifecycle: string;
  needs_attention?: true;
}

export interface MaintenanceItem {
  namespace: string;
  issue: "active_but_stale" | "missing_status" | "conflicting_lifecycle" | "missing_lifecycle" | "upcoming_event_stale";
  suggestion: string;
}

export interface TrackedStatusRow {
  id: string;
  namespace: string;
  key: string;
  content_preview: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
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
  message?: string;
}

export interface QueryResult {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: EntryType;
  content_preview: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  match?: {
    heuristic_score: number;
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
  query: string;
  search_mode: SearchMode;
  search_mode_actual?: SearchMode;
  warning?: string;
  retrieval?: {
    reranked: boolean;
    relaxed_lexical: boolean;
    fallback_reason: string | null;
  };
}

export interface LogResponse {
  status: "logged";
  id: string;
  namespace: string;
  timestamp: string;
}

export interface NamespaceSummary {
  namespace: string;
  state_count: number;
  log_count: number;
  last_activity_at: string;
}

export interface LogPreview {
  id: string;
  content_preview: string;
  tags: string[];
  created_at: string;
}

export interface NamespaceDetail {
  state_entries: Array<{
    key: string;
    preview: string;
    tags: string[];
    updated_at: string;
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
}

// Security types

export interface SecurityResult {
  valid: boolean;
  error?: string;
}

// Audit log entry
export interface AuditEntry {
  id?: number;
  timestamp: string;
  agent_id: string;
  action: "write" | "update" | "delete" | "delete_namespace" | "log";
  namespace: string;
  key: string | null;
  detail: string | null;
}
