import type Database from "better-sqlite3";
import { nowUTC } from "./db.js";

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema — entries, audit_log, FTS5",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          key TEXT,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('state', 'log')),
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
          agent_id TEXT DEFAULT 'default',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(
            (entry_type = 'state' AND key IS NOT NULL) OR
            (entry_type = 'log' AND key IS NULL)
          )
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_ns_key
          ON entries(namespace, key) WHERE entry_type = 'state';

        CREATE INDEX IF NOT EXISTS idx_entries_ns_type_key
          ON entries(namespace, entry_type, key);

        CREATE INDEX IF NOT EXISTS idx_entries_ns_type_created
          ON entries(namespace, entry_type, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_entries_created
          ON entries(created_at);

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT 'default',
          action TEXT NOT NULL,
          namespace TEXT NOT NULL,
          key TEXT,
          detail TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      `);

      // FTS5 virtual table — CREATE VIRTUAL TABLE doesn't support IF NOT EXISTS,
      // so check existence first
      const hasFts = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'",
        )
        .get();

      if (!hasFts) {
        db.exec(`
          CREATE VIRTUAL TABLE entries_fts USING fts5(
            content,
            namespace,
            key,
            tags,
            content='entries',
            content_rowid='rowid'
          );

          CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
            INSERT INTO entries_fts(rowid, content, namespace, key, tags)
            VALUES (new.rowid, new.content, new.namespace, new.key, new.tags);
          END;

          CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, content, namespace, key, tags)
            VALUES('delete', old.rowid, old.content, old.namespace, old.key, old.tags);
          END;

          CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
            INSERT INTO entries_fts(entries_fts, rowid, content, namespace, key, tags)
            VALUES('delete', old.rowid, old.content, old.namespace, old.key, old.tags);
            INSERT INTO entries_fts(rowid, content, namespace, key, tags)
            VALUES (new.rowid, new.content, new.namespace, new.key, new.tags);
          END;
        `);
      }
    },
  },
  {
    version: 2,
    description: "Add embedding columns for semantic search",
    up: (db) => {
      db.exec(`
        ALTER TABLE entries ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(embedding_status IN ('pending', 'processing', 'generated', 'failed'));
        ALTER TABLE entries ADD COLUMN embedding_model TEXT;
        CREATE INDEX idx_entries_embedding_status ON entries(embedding_status, created_at ASC);
      `);
    },
  },
  {
    version: 3,
    description: "Add OAuth tables for client registration, auth codes, and tokens",
    up: (db) => {
      db.exec(`
        CREATE TABLE oauth_clients (
          client_id TEXT PRIMARY KEY,
          client_secret TEXT,
          client_id_issued_at INTEGER,
          client_secret_expires_at INTEGER,
          redirect_uris TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(redirect_uris)),
          client_name TEXT,
          client_uri TEXT,
          logo_uri TEXT,
          scope TEXT,
          token_endpoint_auth_method TEXT,
          grant_types TEXT DEFAULT '[]' CHECK(json_valid(grant_types)),
          response_types TEXT DEFAULT '[]' CHECK(json_valid(response_types)),
          metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE oauth_auth_codes (
          code TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
          code_challenge TEXT NOT NULL,
          redirect_uri TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes)),
          resource TEXT,
          state TEXT,
          expires_at INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_oauth_auth_codes_expires ON oauth_auth_codes(expires_at);

        CREATE TABLE oauth_tokens (
          token TEXT PRIMARY KEY,
          token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
          client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
          scopes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes)),
          resource TEXT,
          expires_at INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          refresh_token_ref TEXT
        );

        CREATE INDEX idx_oauth_tokens_client ON oauth_tokens(client_id);
        CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);
        CREATE INDEX idx_oauth_tokens_refresh_ref ON oauth_tokens(refresh_token_ref);
      `);
    },
  },
  {
    version: 4,
    description: "Add retrieval analytics tables (events, outcomes, sessions)",
    up: (db) => {
      db.exec(`
        CREATE TABLE retrieval_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          tool_name TEXT NOT NULL CHECK(tool_name IN ('memory_query', 'memory_orient', 'memory_attention')),
          query_text TEXT,
          requested_mode TEXT,
          actual_mode TEXT,
          result_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(result_ids)),
          result_namespaces TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(result_namespaces)),
          result_ranks TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(result_ranks)),
          detail TEXT CHECK(detail IS NULL OR json_valid(detail))
        );

        CREATE INDEX idx_retrieval_events_session ON retrieval_events(session_id, timestamp);
        CREATE INDEX idx_retrieval_events_timestamp ON retrieval_events(timestamp);

        CREATE TABLE retrieval_outcomes (
          id TEXT PRIMARY KEY,
          retrieval_event_id TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL,
          outcome_type TEXT NOT NULL CHECK(outcome_type IN (
            'opened_result','opened_namespace_context','write_in_result_namespace',
            'log_in_result_namespace','query_reformulated','no_followup_timeout'
          )),
          entry_id TEXT,
          namespace TEXT,
          detail TEXT CHECK(detail IS NULL OR json_valid(detail))
        );

        CREATE INDEX idx_retrieval_outcomes_event ON retrieval_outcomes(retrieval_event_id);
        CREATE INDEX idx_retrieval_outcomes_entry ON retrieval_outcomes(entry_id)
          WHERE entry_id IS NOT NULL;
        CREATE INDEX idx_retrieval_outcomes_timestamp ON retrieval_outcomes(timestamp);

        CREATE TABLE retrieval_sessions (
          session_id TEXT PRIMARY KEY,
          last_event_id TEXT,
          last_event_timestamp TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_retrieval_sessions_timestamp
          ON retrieval_sessions(last_event_timestamp);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  // Create the schema_version table (the migration framework's own table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // Get already-applied versions
  const applied = new Set(
    (
      db.prepare("SELECT version FROM schema_version").all() as Array<{
        version: number;
      }>
    ).map((r) => r.version),
  );

  // Run pending migrations in order
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    const run = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, nowUTC());
    });
    run();
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT MAX(version) as version FROM schema_version",
    )
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}
