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
    expect(names).toContain("idx_audit_timestamp");
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
    expect(getSchemaVersion(db)).toBe(3);

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
