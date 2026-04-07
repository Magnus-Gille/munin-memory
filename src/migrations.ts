import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { nowUTC } from "./db.js";
import {
  DEFAULT_NAMESPACE_CLASSIFICATION_FLOORS,
  FALLBACK_RESTRICTED_CLASSIFICATION,
  parseExplicitClassification,
  resolveNamespaceClassificationFloorFromRows,
  syncClassificationTag,
} from "./librarian.js";

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
  {
    version: 5,
    description: "Add principals table for multi-principal access control",
    up: (db) => {
      db.exec(`
        CREATE TABLE principals (
          id              TEXT PRIMARY KEY,
          principal_id    TEXT NOT NULL UNIQUE,
          principal_type  TEXT NOT NULL CHECK(principal_type IN ('owner','family','agent','external')),
          oauth_client_id TEXT UNIQUE,
          token_hash      TEXT,
          namespace_rules TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(namespace_rules)),
          created_at      TEXT NOT NULL,
          revoked_at      TEXT,
          expires_at      TEXT
        );
        CREATE INDEX idx_principals_oauth_client ON principals(oauth_client_id) WHERE oauth_client_id IS NOT NULL;
        CREATE INDEX idx_principals_token_hash ON principals(token_hash) WHERE token_hash IS NOT NULL;
      `);
    },
  },
  {
    version: 6,
    description: "Multi-user OAuth: email on principals, principal_oauth_clients mapping table, principal_id on tokens",
    up: (db) => {
      // 1. Add identity columns to principals
      db.exec(`
        ALTER TABLE principals ADD COLUMN email TEXT;
        ALTER TABLE principals ADD COLUMN email_lower TEXT;
        CREATE UNIQUE INDEX idx_principals_email_lower ON principals(email_lower) WHERE email_lower IS NOT NULL;
      `);

      // 2. Insert owner row if not already present.
      // The owner's email comes from MUNIN_OAUTH_TRUSTED_USER_VALUE env var (may be unset in dev).
      const ownerEmail = process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE?.trim() || null;
      const existingOwner = db
        .prepare("SELECT id FROM principals WHERE principal_id = 'owner'")
        .get();

      if (!existingOwner) {
        db.prepare(
          `INSERT INTO principals (id, principal_id, principal_type, email, email_lower, namespace_rules, created_at)
           VALUES (?, 'owner', 'owner', ?, ?, '[]', ?)`,
        ).run(
          randomUUID(),
          ownerEmail,
          ownerEmail ? ownerEmail.trim().toLowerCase() : null,
          nowUTC(),
        );
      }

      // 3. Create mapping table (device inventory)
      db.exec(`
        CREATE TABLE principal_oauth_clients (
          oauth_client_id TEXT PRIMARY KEY REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
          principal_id    TEXT NOT NULL,
          mapped_at       TEXT NOT NULL,
          mapped_by       TEXT NOT NULL DEFAULT 'consent',
          revoked_at      TEXT,
          last_used_at    TEXT
        );
        CREATE INDEX idx_poc_principal ON principal_oauth_clients(principal_id);
      `);

      // 4. Backfill from existing oauth_client_id data
      db.exec(`
        INSERT INTO principal_oauth_clients (oauth_client_id, principal_id, mapped_at, mapped_by)
          SELECT oauth_client_id, principal_id, created_at, 'migration'
          FROM principals WHERE oauth_client_id IS NOT NULL;
      `);

      // 5. Add principal_id to token tables (THE KEY CHANGE from Codex debate)
      db.exec(`
        ALTER TABLE oauth_auth_codes ADD COLUMN principal_id TEXT;
        ALTER TABLE oauth_tokens ADD COLUMN principal_id TEXT;
      `);

      // 6. Leave principals.oauth_client_id in place (removed in future v7)
    },
  },
  {
    version: 7,
    description: "Harden audit/history contract: canonical actions, audit entry_id, and backfill missing entry IDs",
    up: (db) => {
      db.exec(`
        ALTER TABLE audit_log ADD COLUMN entry_id TEXT;
        CREATE INDEX idx_audit_entry_id ON audit_log(entry_id) WHERE entry_id IS NOT NULL;
      `);

      const missingIds = db
        .prepare("SELECT rowid FROM entries WHERE id IS NULL OR TRIM(id) = ''")
        .all() as Array<{ rowid: number }>;
      const updateEntryId = db.prepare("UPDATE entries SET id = ? WHERE rowid = ?");
      for (const row of missingIds) {
        updateEntryId.run(randomUUID(), row.rowid);
      }

      const hasVecTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries_vec'")
        .get();
      if (hasVecTable) {
        db.prepare("DELETE FROM entries_vec WHERE entry_id IS NULL").run();
      }

      db.exec(`
        UPDATE audit_log SET action = 'log_append' WHERE action = 'log';
        UPDATE audit_log SET action = 'namespace_delete' WHERE action = 'delete_namespace';

        UPDATE audit_log
        SET entry_id = (
          SELECT e.id
          FROM entries e
          WHERE e.namespace = audit_log.namespace
            AND e.key = audit_log.key
            AND e.entry_type = 'state'
        )
        WHERE entry_id IS NULL
          AND action IN ('write', 'update')
          AND key IS NOT NULL;

        UPDATE audit_log
        SET entry_id = (
          SELECT e.id
          FROM entries e
          WHERE e.namespace = audit_log.namespace
            AND e.entry_type = 'log'
            AND e.created_at = audit_log.timestamp
          ORDER BY e.rowid DESC
          LIMIT 1
        )
        WHERE entry_id IS NULL
          AND action = 'log_append';
      `);
    },
  },
  {
    version: 8,
    description: "Add valid_until to state entries for soft expiry",
    up: (db) => {
      db.exec(`
        ALTER TABLE entries ADD COLUMN valid_until TEXT;
        CREATE INDEX idx_entries_state_valid_until
          ON entries(valid_until)
          WHERE entry_type = 'state' AND valid_until IS NOT NULL;
      `);
    },
  },
  {
    version: 9,
    description: "Add derived commitments table for explicit follow-through signals",
    up: (db) => {
      db.exec(`
        CREATE TABLE commitments (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          source_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          text TEXT NOT NULL,
          due_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('open', 'done', 'cancelled')),
          confidence REAL NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT,
          UNIQUE(source_entry_id, source_fingerprint)
        );
        CREATE INDEX idx_commitments_namespace_status_due
          ON commitments(namespace, status, due_at);
        CREATE INDEX idx_commitments_source_entry
          ON commitments(source_entry_id);
        CREATE INDEX idx_commitments_updated_at
          ON commitments(updated_at DESC);
      `);
    },
  },
  {
    version: 10,
    description: "Add immutable owner_principal_id to entries",
    up: (db) => {
      db.exec(`
        ALTER TABLE entries ADD COLUMN owner_principal_id TEXT;
        UPDATE entries
        SET owner_principal_id = COALESCE(NULLIF(TRIM(agent_id), ''), 'default')
        WHERE owner_principal_id IS NULL;
        CREATE INDEX idx_entries_ns_owner
          ON entries(namespace, owner_principal_id)
          WHERE owner_principal_id IS NOT NULL;
      `);
    },
  },
  {
    version: 11,
    description: "Add Librarian classification schema and backfill entry + commitment classifications",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS namespace_classification (
          namespace_pattern TEXT PRIMARY KEY,
          min_classification TEXT NOT NULL
            CHECK(min_classification IN ('public', 'internal', 'client-confidential', 'client-restricted')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        ALTER TABLE entries ADD COLUMN classification TEXT NOT NULL DEFAULT 'internal'
          CHECK(classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));

        CREATE INDEX idx_entries_classification ON entries(classification);
        CREATE INDEX idx_entries_ns_classification ON entries(namespace, classification);

        CREATE TABLE IF NOT EXISTS redaction_log (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          principal_id TEXT NOT NULL,
          transport_type TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          entry_namespace TEXT NOT NULL,
          entry_classification TEXT NOT NULL,
          connection_max_classification TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX idx_redaction_log_created ON redaction_log(created_at DESC);
        CREATE INDEX idx_redaction_log_entry ON redaction_log(entry_id);
      `);

      const hasPrincipals = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'principals'")
        .get();
      if (hasPrincipals) {
        db.exec(`
          ALTER TABLE principals ADD COLUMN max_classification TEXT DEFAULT NULL
            CHECK(max_classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));

          ALTER TABLE principals ADD COLUMN transport_type TEXT DEFAULT NULL
            CHECK(transport_type IN ('local', 'dpa_covered', 'consumer'));
        `);
      }

      const hasCommitments = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'commitments'")
        .get();
      if (hasCommitments) {
        db.exec(`
          ALTER TABLE commitments ADD COLUMN source_classification TEXT DEFAULT 'internal'
            CHECK(source_classification IN ('public', 'internal', 'client-confidential', 'client-restricted'));
        `);
      }

      const now = nowUTC();
      const insertFloor = db.prepare(
        `INSERT OR IGNORE INTO namespace_classification
           (namespace_pattern, min_classification, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const floor of DEFAULT_NAMESPACE_CLASSIFICATION_FLOORS) {
        insertFloor.run(floor.pattern, floor.minClassification, now, now);
      }

      const floorRows = db.prepare(
        `SELECT namespace_pattern, min_classification
         FROM namespace_classification
         ORDER BY LENGTH(namespace_pattern) DESC, namespace_pattern ASC`,
      ).all() as Array<{ namespace_pattern: string; min_classification: "public" | "internal" | "client-confidential" | "client-restricted" }>;

      const entries = db.prepare(
        "SELECT id, namespace, tags FROM entries",
      ).all() as Array<{ id: string; namespace: string; tags: string }>;
      const updateEntry = db.prepare(
        "UPDATE entries SET classification = ?, tags = ? WHERE id = ?",
      );

      for (const entry of entries) {
        let parsedTags: string[] = [];
        try {
          const raw = JSON.parse(entry.tags) as unknown;
          if (Array.isArray(raw)) {
            parsedTags = raw.filter((tag): tag is string => typeof tag === "string");
          }
        } catch {
          parsedTags = [];
        }

        let classification = resolveNamespaceClassificationFloorFromRows(entry.namespace, floorRows);
        try {
          const explicitClassification = parseExplicitClassification({ tags: parsedTags });
          if (explicitClassification) {
            classification = explicitClassification;
          }
        } catch {
          classification = FALLBACK_RESTRICTED_CLASSIFICATION;
        }

        const syncedTags = syncClassificationTag(parsedTags, classification);
        updateEntry.run(classification, JSON.stringify(syncedTags), entry.id);
      }

      if (hasCommitments) {
        db.exec(`
          UPDATE commitments
          SET source_classification = COALESCE(
            (SELECT classification FROM entries WHERE entries.id = commitments.source_entry_id),
            source_classification
          );

          DELETE FROM commitments
          WHERE source_entry_id IN (
            SELECT id FROM entries WHERE classification = 'client-restricted'
          );
        `);
      }
    },
  },
  {
    version: 12,
    description: "Add consolidation_metadata and cross_references tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS consolidation_metadata (
          namespace TEXT PRIMARY KEY,
          last_consolidated_at TEXT NOT NULL,
          last_log_id TEXT,
          last_log_created_at TEXT,
          synthesis_model TEXT NOT NULL,
          synthesis_token_count INTEGER,
          run_duration_ms INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cross_references (
          id TEXT PRIMARY KEY,
          source_namespace TEXT NOT NULL,
          target_namespace TEXT NOT NULL,
          reference_type TEXT NOT NULL CHECK(reference_type IN (
            'depends_on', 'blocks', 'related_to', 'supersedes', 'feeds_into'
          )),
          context TEXT,
          confidence REAL NOT NULL DEFAULT 1.0,
          extracted_at TEXT NOT NULL,
          source_synthesis_id TEXT,
          UNIQUE(source_namespace, target_namespace, reference_type)
        );

        CREATE INDEX IF NOT EXISTS idx_cross_refs_source ON cross_references(source_namespace);
        CREATE INDEX IF NOT EXISTS idx_cross_refs_target ON cross_references(target_namespace);
      `);
    },
  },
  {
    version: 13,
    description: "Add retrieval_feedback table for explicit quality feedback",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS retrieval_feedback (
          id TEXT PRIMARY KEY,
          retrieval_event_id TEXT REFERENCES retrieval_events(id) ON DELETE SET NULL,
          session_id TEXT NOT NULL,
          feedback_type TEXT NOT NULL CHECK(feedback_type IN (
            'bad_results', 'missing_result', 'wrong_order', 'stale_results', 'good_results'
          )),
          query_text TEXT,
          expected_namespace TEXT,
          expected_key TEXT,
          expected_entry_id TEXT,
          detail TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_event
          ON retrieval_feedback(retrieval_event_id) WHERE retrieval_event_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_session
          ON retrieval_feedback(session_id);
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_created
          ON retrieval_feedback(created_at);
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_type
          ON retrieval_feedback(feedback_type);
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
