import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { runMigrations, getSchemaVersion, migrations } from "../src/migrations.js";
import { initDatabase, writeState, readState, queryEntries } from "../src/db.js";

const TEST_DB_PATH = "/tmp/munin-memory-migrations-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

function openRawDb(): Database.Database {
  const db = new Database(TEST_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

beforeEach(() => {
  cleanupTestDb();
});

afterEach(() => {
  cleanupTestDb();
});

describe("runMigrations", () => {
  it("creates schema_version table", () => {
    const db = openRawDb();
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("applies all migrations and records them", () => {
    const db = openRawDb();
    runMigrations(db);

    const version = getSchemaVersion(db);
    expect(version).toBe(migrations.length);

    const records = db
      .prepare("SELECT * FROM schema_version ORDER BY version")
      .all() as Array<{ version: number; applied_at: string }>;
    expect(records.length).toBe(migrations.length);
    expect(records[0].version).toBe(1);
    expect(records[0].applied_at).toBeTruthy();
    db.close();
  });

  it("creates all expected tables", () => {
    const db = openRawDb();
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("entries");
    expect(names).toContain("audit_log");
    expect(names).toContain("entries_fts");
    expect(names).toContain("schema_version");
    db.close();
  });

  it("creates expected indexes", () => {
    const db = openRawDb();
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_entries_ns_key");
    expect(names).toContain("idx_entries_ns_type_key");
    expect(names).toContain("idx_entries_ns_type_created");
    expect(names).toContain("idx_entries_created");
    expect(names).toContain("idx_entries_state_valid_until");
    expect(names).toContain("idx_commitments_namespace_status_due");
    expect(names).toContain("idx_commitments_source_entry");
    expect(names).toContain("idx_entries_ns_owner");
    expect(names).toContain("idx_audit_timestamp");
    expect(names).toContain("idx_audit_entry_id");
    db.close();
  });

  it("creates FTS5 triggers", () => {
    const db = openRawDb();
    runMigrations(db);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name);
    expect(names).toContain("entries_ai");
    expect(names).toContain("entries_ad");
    expect(names).toContain("entries_au");
    db.close();
  });

  it("is idempotent — running twice does not error or duplicate", () => {
    const db = openRawDb();
    runMigrations(db);
    runMigrations(db);

    const version = getSchemaVersion(db);
    expect(version).toBe(migrations.length);

    const records = db
      .prepare("SELECT * FROM schema_version")
      .all() as Array<{ version: number }>;
    expect(records).toHaveLength(migrations.length);
    db.close();
  });

  it("skips already-applied migrations", () => {
    const db = openRawDb();
    runMigrations(db);

    // Manually insert a row to prove migration 1 didn't re-run
    db.prepare(
      "INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at) VALUES (?, ?, ?, 'state', ?, '[]', 'test', ?, ?)",
    ).run("test-id", "test/ns", "marker", "survives re-migration", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

    // Run again — should not drop/recreate tables
    runMigrations(db);

    const entry = db
      .prepare("SELECT content FROM entries WHERE id = 'test-id'")
      .get() as { content: string } | undefined;
    expect(entry?.content).toBe("survives re-migration");
    db.close();
  });
});

describe("getSchemaVersion", () => {
  it("returns 0 for empty schema_version table", () => {
    const db = openRawDb();
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    expect(getSchemaVersion(db)).toBe(0);
    db.close();
  });

  it("returns highest applied version", () => {
    const db = openRawDb();
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(migrations[migrations.length - 1].version);
    db.close();
  });
});

describe("migration upgrades existing databases", () => {
  it("handles pre-migration database (schema exists, no schema_version)", () => {
    // Simulate a pre-migration database by creating the schema directly
    const db = openRawDb();
    db.exec(`
      CREATE TABLE entries (
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
      CREATE UNIQUE INDEX idx_entries_ns_key ON entries(namespace, key) WHERE entry_type = 'state';
      CREATE INDEX idx_entries_ns_type_key ON entries(namespace, entry_type, key);
      CREATE INDEX idx_entries_ns_type_created ON entries(namespace, entry_type, created_at DESC);
      CREATE INDEX idx_entries_created ON entries(created_at);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'default',
        action TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT,
        detail TEXT
      );
      CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
    `);
    db.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        content, namespace, key, tags,
        content='entries', content_rowid='rowid'
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

    // Insert some data that should survive the migration
    db.prepare(
      "INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at) VALUES (?, ?, ?, 'state', ?, '[]', 'default', ?, ?)",
    ).run("existing-id", "projects/old", "status", "pre-migration data", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

    // Now run migrations — should not fail and should preserve data
    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(migrations.length);

    const entry = db
      .prepare("SELECT content FROM entries WHERE id = 'existing-id'")
      .get() as { content: string };
    expect(entry.content).toBe("pre-migration data");
    db.close();
  });
});

describe("migration v2 — embedding columns", () => {
  it("adds embedding_status and embedding_model columns", () => {
    const db = openRawDb();
    runMigrations(db);

    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(2);

    // Verify columns exist
    const cols = db
      .prepare("PRAGMA table_info(entries)")
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("embedding_status");
    expect(colNames).toContain("embedding_model");
    db.close();
  });

  it("adds embedding_status index", () => {
    const db = openRawDb();
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_entries_embedding_status'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
    db.close();
  });

  it("CHECK constraint rejects invalid embedding_status", () => {
    const db = openRawDb();
    runMigrations(db);

    expect(() => {
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at, embedding_status)
         VALUES ('test-id', 'ns', 'k', 'state', 'content', '[]', 'default', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 'invalid')`,
      ).run();
    }).toThrow();
    db.close();
  });

  it("defaults embedding_status to 'pending' for new rows", () => {
    const db = openRawDb();
    runMigrations(db);

    db.prepare(
      `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
       VALUES ('test-id', 'ns', 'k', 'state', 'content', '[]', 'default', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const row = db
      .prepare("SELECT embedding_status, embedding_model FROM entries WHERE id = 'test-id'")
      .get() as { embedding_status: string; embedding_model: string | null };
    expect(row.embedding_status).toBe("pending");
    expect(row.embedding_model).toBeNull();
    db.close();
  });
});

describe("initDatabase uses migrations", () => {
  it("creates a fully functional database via migration framework", () => {
    const db = initDatabase(TEST_DB_PATH);

    // schema_version exists and has latest version
    expect(getSchemaVersion(db)).toBe(migrations[migrations.length - 1].version);

    // Full CRUD works
    const result = writeState(db, "test/ns", "key1", "hello from migrations", ["test"]);
    expect(result.status).toBe("created");

    const entry = readState(db, "test/ns", "key1");
    expect(entry?.content).toBe("hello from migrations");

    // FTS works
    const results = queryEntries(db, { query: "migrations" });
    expect(results.length).toBe(1);

    db.close();
  });
});

describe("migration v7 — contract hardening", () => {
  it("adds audit_log.entry_id and canonicalizes legacy actions", () => {
    const db = openRawDb();
    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(audit_log)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("entry_id");

    writeState(db, "projects/v7", "status", "hello", []);
    db.prepare(
      `INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail, entry_id)
       VALUES ('2026-04-01T00:00:00.000Z', 'default', 'log_append', 'projects/v7', NULL, NULL, NULL)`,
    ).run();

    const actions = db
      .prepare("SELECT action FROM audit_log ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(actions.some((row) => row.action === "write")).toBe(true);
    expect(actions.some((row) => row.action === "log_append")).toBe(true);
    db.close();
  });

  it("backfills missing entry IDs during migration", () => {
    const db = openRawDb();
    db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        key TEXT,
        entry_type TEXT NOT NULL CHECK(entry_type IN ('state', 'log')),
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
        agent_id TEXT DEFAULT 'default',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        embedding_model TEXT,
        CHECK(
          (entry_type = 'state' AND key IS NOT NULL) OR
          (entry_type = 'log' AND key IS NULL)
        )
      );
      CREATE UNIQUE INDEX idx_entries_ns_key ON entries(namespace, key) WHERE entry_type = 'state';
      CREATE INDEX idx_entries_ns_type_key ON entries(namespace, entry_type, key);
      CREATE INDEX idx_entries_ns_type_created ON entries(namespace, entry_type, created_at DESC);
      CREATE INDEX idx_entries_created ON entries(created_at);
      CREATE INDEX idx_entries_embedding_status ON entries(embedding_status, created_at ASC);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'default',
        action TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT,
        detail TEXT
      );
      CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    for (let version = 1; version <= 6; version++) {
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(version, "2026-04-01T00:00:00.000Z");
    }

    db.prepare(
      `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at, embedding_status, embedding_model)
       VALUES (NULL, 'projects/legacy', 'status', 'state', 'legacy status', '[]', 'default', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 'pending', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail)
       VALUES ('2026-04-01T00:00:00.000Z', 'default', 'write', 'projects/legacy', 'status', NULL)`,
    ).run();

    runMigrations(db);

    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/legacy' AND key = 'status'")
      .get() as { id: string };
    const audit = db
      .prepare("SELECT action, entry_id FROM audit_log WHERE namespace = 'projects/legacy'")
      .get() as { action: string; entry_id: string | null };

    expect(entry.id).toBeTruthy();
    expect(audit.action).toBe("write");
    expect(audit.entry_id).toBe(entry.id);
    db.close();
  });
});

describe("migration v8 — valid_until", () => {
  it("adds valid_until column to entries", () => {
    const db = openRawDb();
    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(entries)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("valid_until");
    db.close();
  });

  it("adds partial index for expiring state entries", () => {
    const db = openRawDb();
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_entries_state_valid_until'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
    db.close();
  });
});

describe("migration v9 — commitments", () => {
  it("creates the commitments table and indexes", () => {
    const db = openRawDb();
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'commitments'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    const cols = db
      .prepare("PRAGMA table_info(commitments)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining([
      "source_entry_id",
      "source_type",
      "source_fingerprint",
      "status",
      "resolved_at",
    ]));
    db.close();
  });
});

describe("migration v10 — owner_principal_id", () => {
  it("adds owner_principal_id to entries", () => {
    const db = openRawDb();
    runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info(entries)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("owner_principal_id");
    db.close();
  });

  it("backfills owner_principal_id from agent_id on upgrade", () => {
    const db = openRawDb();
    db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        key TEXT,
        entry_type TEXT NOT NULL CHECK(entry_type IN ('state', 'log')),
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
        agent_id TEXT DEFAULT 'default',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        embedding_model TEXT,
        valid_until TEXT,
        CHECK(
          (entry_type = 'state' AND key IS NOT NULL) OR
          (entry_type = 'log' AND key IS NULL)
        )
      );
      CREATE UNIQUE INDEX idx_entries_ns_key ON entries(namespace, key) WHERE entry_type = 'state';
      CREATE INDEX idx_entries_ns_type_key ON entries(namespace, entry_type, key);
      CREATE INDEX idx_entries_ns_type_created ON entries(namespace, entry_type, created_at DESC);
      CREATE INDEX idx_entries_created ON entries(created_at);
      CREATE INDEX idx_entries_embedding_status ON entries(embedding_status, created_at ASC);
      CREATE INDEX idx_entries_state_valid_until ON entries(valid_until) WHERE entry_type = 'state' AND valid_until IS NOT NULL;
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'default',
        action TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT,
        detail TEXT,
        entry_id TEXT
      );
      CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX idx_audit_entry_id ON audit_log(entry_id) WHERE entry_id IS NOT NULL;
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
      CREATE INDEX idx_commitments_namespace_status_due ON commitments(namespace, status, due_at);
      CREATE INDEX idx_commitments_source_entry ON commitments(source_entry_id);
      CREATE INDEX idx_commitments_updated_at ON commitments(updated_at DESC);
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    for (let version = 1; version <= 9; version++) {
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(version, "2026-04-01T00:00:00.000Z");
    }

    db.prepare(
      `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at, embedding_status, embedding_model, valid_until)
       VALUES ('owned-entry', 'shared/family/board', 'note', 'state', 'hello', '[]', 'sara', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 'pending', NULL, NULL)`,
    ).run();

    runMigrations(db);

    const row = db
      .prepare("SELECT owner_principal_id FROM entries WHERE id = 'owned-entry'")
      .get() as { owner_principal_id: string | null };
    expect(row.owner_principal_id).toBe("sara");
    db.close();
  });
});

describe("migration v11 — librarian classification", () => {
  it("adds classification metadata tables and columns", () => {
    const db = openRawDb();
    runMigrations(db);

    const entryCols = db
      .prepare("PRAGMA table_info(entries)")
      .all() as Array<{ name: string }>;
    expect(entryCols.map((col) => col.name)).toContain("classification");

    const principalCols = db
      .prepare("PRAGMA table_info(principals)")
      .all() as Array<{ name: string }>;
    expect(principalCols.map((col) => col.name)).toEqual(expect.arrayContaining([
      "max_classification",
      "transport_type",
    ]));

    const commitmentCols = db
      .prepare("PRAGMA table_info(commitments)")
      .all() as Array<{ name: string }>;
    expect(commitmentCols.map((col) => col.name)).toContain("source_classification");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toContain("namespace_classification");
    expect(names).toContain("redaction_log");

    db.close();
  });

  it("backfills entry classification and synced tag from namespace defaults", () => {
    const db = openRawDb();
    runMigrations(db);

    writeState(db, "clients/acme", "status", "active", ["active"]);
    const entry = readState(db, "clients/acme", "status");
    expect(entry?.classification).toBe("client-confidential");
    expect(JSON.parse(entry!.tags)).toContain("classification:client-confidential");

    db.close();
  });
});

describe("migration v5 — principals table", () => {
  it("creates the principals table", () => {
    const db = openRawDb();
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='principals'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("creates the expected indexes on principals", () => {
    const db = openRawDb();
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_principals_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_principals_oauth_client");
    expect(names).toContain("idx_principals_token_hash");
    db.close();
  });

  it("enforces principal_type CHECK constraint", () => {
    const db = openRawDb();
    runMigrations(db);

    expect(() => {
      db.prepare(
        `INSERT INTO principals (id, principal_id, principal_type, namespace_rules, created_at)
         VALUES ('p1', 'alice', 'invalid', '[]', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
    db.close();
  });

  it("enforces UNIQUE constraint on principal_id", () => {
    const db = openRawDb();
    runMigrations(db);

    db.prepare(
      `INSERT INTO principals (id, principal_id, principal_type, namespace_rules, created_at)
       VALUES ('p1', 'alice', 'owner', '[]', '2025-01-01T00:00:00.000Z')`,
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO principals (id, principal_id, principal_type, namespace_rules, created_at)
         VALUES ('p2', 'alice', 'family', '[]', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
    db.close();
  });

  it("enforces UNIQUE constraint on oauth_client_id", () => {
    const db = openRawDb();
    runMigrations(db);

    db.prepare(
      `INSERT INTO principals (id, principal_id, principal_type, oauth_client_id, namespace_rules, created_at)
       VALUES ('p1', 'alice', 'owner', 'client-abc', '[]', '2025-01-01T00:00:00.000Z')`,
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO principals (id, principal_id, principal_type, oauth_client_id, namespace_rules, created_at)
         VALUES ('p2', 'bob', 'external', 'client-abc', '[]', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
    db.close();
  });

  it("accepts all valid principal_type values", () => {
    const db = openRawDb();
    runMigrations(db);

    // Migration v6 auto-inserts an owner row, so skip 'owner' in our inserts
    const types = ["family", "agent", "external"];
    for (let i = 0; i < types.length; i++) {
      db.prepare(
        `INSERT INTO principals (id, principal_id, principal_type, namespace_rules, created_at)
         VALUES (?, ?, ?, '[]', '2025-01-01T00:00:00.000Z')`,
      ).run(`p${i}`, `principal-${i}`, types[i]);
    }

    const rows = db.prepare("SELECT principal_type FROM principals ORDER BY id").all() as Array<{ principal_type: string }>;
    // Auto-inserted owner + family + agent + external
    expect(rows.map((r) => r.principal_type)).toEqual(["owner", "family", "agent", "external"]);
    db.close();
  });

  it("defaults namespace_rules to empty JSON array", () => {
    const db = openRawDb();
    runMigrations(db);

    db.prepare(
      `INSERT INTO principals (id, principal_id, principal_type, created_at)
       VALUES ('p1', 'alice', 'owner', '2025-01-01T00:00:00.000Z')`,
    ).run();

    const row = db
      .prepare("SELECT namespace_rules FROM principals WHERE id = 'p1'")
      .get() as { namespace_rules: string };
    expect(row.namespace_rules).toBe("[]");
    db.close();
  });
});
