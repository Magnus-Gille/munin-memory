// Entry types stored in the database

export type EntryType = "state" | "log";
export type EmbeddingStatus = "pending" | "processing" | "generated" | "failed";
export type SearchMode = "lexical" | "semantic" | "hybrid";

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
}

export interface LogParams {
  namespace: string;
  content: string;
  tags?: string[];
}

export interface ListParams {
  namespace?: string;
  include_demo?: boolean;
}

export interface DeleteParams {
  namespace: string;
  key?: string;
  confirm?: boolean;
  delete_token?: string;
}

// Tool response types

export interface WriteResponse {
  status: "created" | "updated";
  id: string;
  namespace: string;
  key: string;
  hint: string;
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
}

export interface QueryResponse {
  results: QueryResult[];
  total: number;
  query: string;
  search_mode: SearchMode;
  search_mode_actual?: SearchMode;
  warning?: string;
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
}

export interface NamespaceDetail {
  state_entries: Array<{
    key: string;
    preview: string;
    tags: string[];
    updated_at: string;
  }>;
  log_summary: {
    count: number;
    earliest: string | null;
    latest: string | null;
  };
}

export interface ListResponse {
  namespaces?: NamespaceSummary[];
  namespace?: string;
  detail?: NamespaceDetail;
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
