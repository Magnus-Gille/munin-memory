import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import {
  initDatabase,
  writeState,
  readState,
  getById,
  appendLog,
  queryEntries,
  listNamespaces,
  listNamespaceContents,
  previewDelete,
  executeDelete,
  getOtherKeysInNamespace,
  getCompletedTaskNamespaces,
  rebuildFTS,
} from "../src/db.js";

const TEST_DB_PATH = "/tmp/munin-memory-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

let db: Database.Database;

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

describe("initDatabase", () => {
  it("creates tables and indexes", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("entries");
    expect(tableNames).toContain("audit_log");
    expect(tableNames).toContain("entries_fts");
  });

  it("sets WAL journal mode", () => {
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });
});

describe("writeState + readState", () => {
  it("creates a new state entry", () => {
    const result = writeState(db, "projects/test", "status", "All systems go", ["active"]);
    expect(result.status).toBe("created");
    expect(result.id).toBeTruthy();

    const entry = readState(db, "projects/test", "status");
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("All systems go");
    expect(JSON.parse(entry!.tags)).toEqual(["active"]);
    expect(entry!.entry_type).toBe("state");
  });

  it("updates an existing state entry (preserves id and created_at)", () => {
    const first = writeState(db, "projects/test", "status", "Version 1", []);
    expect(first.status).toBe("created");

    const second = writeState(db, "projects/test", "status", "Version 2", ["updated"]);
    expect(second.status).toBe("updated");
    expect(second.id).toBe(first.id);

    const entry = readState(db, "projects/test", "status");
    expect(entry!.content).toBe("Version 2");
    expect(JSON.parse(entry!.tags)).toEqual(["updated"]);
    expect(entry!.id).toBe(first.id);
  });

  it("returns null for non-existent entry", () => {
    const entry = readState(db, "projects/missing", "nope");
    expect(entry).toBeNull();
  });

  it("stores multiple entries in same namespace", () => {
    writeState(db, "projects/test", "status", "active", []);
    writeState(db, "projects/test", "architecture", "SQLite + FTS5", []);

    const status = readState(db, "projects/test", "status");
    const arch = readState(db, "projects/test", "architecture");
    expect(status!.content).toBe("active");
    expect(arch!.content).toBe("SQLite + FTS5");
  });

  it("writes audit log on create and update", () => {
    writeState(db, "projects/test", "status", "v1", []);
    writeState(db, "projects/test", "status", "v2", []);

    const audits = db
      .prepare("SELECT * FROM audit_log ORDER BY id")
      .all() as Array<{ action: string; detail: string | null }>;
    expect(audits).toHaveLength(2);
    expect(audits[0].action).toBe("write");
    expect(audits[1].action).toBe("update");
    expect(audits[1].detail).toMatch(/^updated \(\d+ → \d+ chars\)$/);
  });
});

describe("getById", () => {
  it("retrieves state entry by ID", () => {
    const { id } = writeState(db, "projects/test", "status", "content", []);
    const entry = getById(db, id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.content).toBe("content");
  });

  it("retrieves log entry by ID", () => {
    const { id } = appendLog(db, "projects/test", "something happened", []);
    const entry = getById(db, id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.entry_type).toBe("log");
  });

  it("returns null for unknown ID", () => {
    expect(getById(db, "nonexistent-uuid")).toBeNull();
  });
});

describe("appendLog", () => {
  it("creates a log entry", () => {
    const result = appendLog(db, "projects/test", "Started the project", ["milestone"]);
    expect(result.id).toBeTruthy();
    expect(result.timestamp).toBeTruthy();

    const entry = getById(db, result.id);
    expect(entry!.entry_type).toBe("log");
    expect(entry!.key).toBeNull();
    expect(entry!.content).toBe("Started the project");
  });

  it("appends multiple log entries in order", () => {
    appendLog(db, "projects/test", "Event 1", []);
    appendLog(db, "projects/test", "Event 2", []);
    appendLog(db, "projects/test", "Event 3", []);

    const entries = db
      .prepare(
        "SELECT content FROM entries WHERE namespace = ? AND entry_type = 'log' ORDER BY rowid",
      )
      .all("projects/test") as Array<{ content: string }>;
    expect(entries.map((e) => e.content)).toEqual(["Event 1", "Event 2", "Event 3"]);
  });
});

describe("queryEntries (FTS5)", () => {
  beforeEach(() => {
    writeState(db, "projects/hugin-munin", "architecture", "SQLite with FTS5 for full-text search", ["architecture", "decision"]);
    writeState(db, "projects/hugin-munin", "status", "In development, targeting Raspberry Pi 5", ["active"]);
    writeState(db, "projects/gille-website", "tech-stack", "Astro and Tailwind CSS", ["decision"]);
    appendLog(db, "projects/hugin-munin", "Decided on SQLite over alternatives", ["decision"]);
  });

  it("finds entries by content keyword", () => {
    const results = queryEntries(db, { query: "SQLite" });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by namespace", () => {
    const results = queryEntries(db, { query: "SQLite", namespace: "projects/hugin-munin" });
    expect(results.every((r) => r.namespace === "projects/hugin-munin")).toBe(true);
  });

  it("filters by namespace prefix", () => {
    const results = queryEntries(db, { query: "decision", namespace: "projects/" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.namespace.startsWith("projects/"))).toBe(true);
  });

  it("filters by entry type", () => {
    const results = queryEntries(db, { query: "SQLite", entryType: "log" });
    expect(results.every((r) => r.entry_type === "log")).toBe(true);
  });

  it("filters by tags", () => {
    const results = queryEntries(db, { query: "SQLite OR Astro", tags: ["decision"] });
    for (const r of results) {
      const tags = JSON.parse(r.tags) as string[];
      expect(tags).toContain("decision");
    }
  });

  it("respects limit", () => {
    const results = queryEntries(db, { query: "SQLite OR Raspberry OR Astro", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("handles hyphenated terms without FTS5 syntax errors (#1)", () => {
    writeState(db, "projects/hugin-munin", "tools", "Uses better-sqlite3 and nano-banana", ["tools"]);
    const results = queryEntries(db, { query: "nano-banana" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("nano-banana");
  });

  it("handles colons in query terms without FTS5 column filter errors", () => {
    writeState(db, "projects/test", "note", "Check localhost:3000 for dev server", []);
    const results = queryEntries(db, { query: "localhost:3000" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("passes through explicitly quoted FTS5 phrases", () => {
    const results = queryEntries(db, { query: '"full-text search"' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("full-text search");
  });
});

describe("listNamespaces", () => {
  it("returns empty array when no entries", () => {
    expect(listNamespaces(db)).toEqual([]);
  });

  it("returns namespace counts", () => {
    writeState(db, "projects/a", "status", "active", []);
    writeState(db, "projects/a", "arch", "monolith", []);
    appendLog(db, "projects/a", "started", []);
    writeState(db, "people/magnus", "prefs", "vim", []);

    const ns = listNamespaces(db);
    expect(ns).toHaveLength(2);

    const projA = ns.find((n) => n.namespace === "projects/a");
    expect(projA!.state_count).toBe(2);
    expect(projA!.log_count).toBe(1);

    const people = ns.find((n) => n.namespace === "people/magnus");
    expect(people!.state_count).toBe(1);
    expect(people!.log_count).toBe(0);
  });

  it("returns last_activity_at per namespace", () => {
    writeState(db, "projects/a", "status", "active", []);
    writeState(db, "projects/b", "status", "active", []);

    const ns = listNamespaces(db);
    const projA = ns.find((n) => n.namespace === "projects/a");
    const projB = ns.find((n) => n.namespace === "projects/b");

    expect(projA!.last_activity_at).toBeDefined();
    expect(projB!.last_activity_at).toBeDefined();
    // Timestamps are ISO 8601
    expect(projA!.last_activity_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("last_activity_at reflects most recent write", () => {
    writeState(db, "projects/a", "status", "v1", []);
    const ns1 = listNamespaces(db);
    const t1 = ns1.find((n) => n.namespace === "projects/a")!.last_activity_at;

    // Update the entry — last_activity_at should advance
    writeState(db, "projects/a", "status", "v2", []);
    const ns2 = listNamespaces(db);
    const t2 = ns2.find((n) => n.namespace === "projects/a")!.last_activity_at;

    expect(t2 >= t1).toBe(true);
  });

  it("last_activity_at includes log entries", () => {
    writeState(db, "projects/a", "status", "active", []);
    const ns1 = listNamespaces(db);
    const t1 = ns1.find((n) => n.namespace === "projects/a")!.last_activity_at;

    appendLog(db, "projects/a", "something happened", []);
    const ns2 = listNamespaces(db);
    const t2 = ns2.find((n) => n.namespace === "projects/a")!.last_activity_at;

    expect(t2 >= t1).toBe(true);
  });
});

describe("getCompletedTaskNamespaces", () => {
  it("returns empty set when no tasks exist", () => {
    expect(getCompletedTaskNamespaces(db).size).toBe(0);
  });

  it("returns completed task namespaces", () => {
    writeState(db, "tasks/20260327-test-a", "status", "done", ["completed"]);
    writeState(db, "tasks/20260327-test-b", "status", "done", ["failed"]);
    writeState(db, "tasks/20260327-test-c", "status", "running", ["pending"]);

    const completed = getCompletedTaskNamespaces(db);
    expect(completed.has("tasks/20260327-test-a")).toBe(true);
    expect(completed.has("tasks/20260327-test-b")).toBe(true);
    expect(completed.has("tasks/20260327-test-c")).toBe(false);
  });

  it("excludes tasks/admin and tasks/_heartbeat", () => {
    writeState(db, "tasks/admin", "status", "index", ["completed"]);
    writeState(db, "tasks/_heartbeat", "last", "ok", ["completed"]);
    writeState(db, "tasks/20260327-real", "status", "done", ["completed"]);

    const completed = getCompletedTaskNamespaces(db);
    expect(completed.has("tasks/admin")).toBe(false);
    expect(completed.has("tasks/_heartbeat")).toBe(false);
    expect(completed.has("tasks/20260327-real")).toBe(true);
  });

  it("does not match non-tasks namespaces", () => {
    writeState(db, "projects/foo", "status", "done", ["completed"]);
    writeState(db, "tasks/20260327-bar", "status", "done", ["completed"]);

    const completed = getCompletedTaskNamespaces(db);
    expect(completed.has("projects/foo")).toBe(false);
    expect(completed.has("tasks/20260327-bar")).toBe(true);
  });

  it("only matches status key", () => {
    writeState(db, "tasks/20260327-x", "result", "DONE", ["completed"]);
    // No status key with completed tag
    const completed = getCompletedTaskNamespaces(db);
    expect(completed.has("tasks/20260327-x")).toBe(false);

    // Now add the status key
    writeState(db, "tasks/20260327-x", "status", "done", ["completed"]);
    const completed2 = getCompletedTaskNamespaces(db);
    expect(completed2.has("tasks/20260327-x")).toBe(true);
  });
});

describe("listNamespaceContents", () => {
  it("returns state entries and log summary", () => {
    writeState(db, "projects/test", "status", "active", ["active"]);
    writeState(db, "projects/test", "architecture", "microservices", []);
    appendLog(db, "projects/test", "Day 1", []);
    appendLog(db, "projects/test", "Day 2", []);

    const { stateEntries, logSummary } = listNamespaceContents(db, "projects/test");
    expect(stateEntries).toHaveLength(2);
    expect(stateEntries.map((e) => e.key).sort()).toEqual(["architecture", "status"]);
    expect(logSummary.log_count).toBe(2);
    expect(logSummary.earliest).toBeTruthy();
    expect(logSummary.latest).toBeTruthy();
  });

  it("handles empty namespace", () => {
    const { stateEntries, logSummary } = listNamespaceContents(db, "empty/ns");
    expect(stateEntries).toEqual([]);
    expect(logSummary.log_count).toBe(0);
    expect(logSummary.recent).toEqual([]);
  });

  it("includes recent log previews ordered by newest first", () => {
    appendLog(db, "projects/test", "First log", ["milestone"]);
    appendLog(db, "projects/test", "Second log", []);
    appendLog(db, "projects/test", "Third log", ["decision"]);

    const { logSummary } = listNamespaceContents(db, "projects/test");
    expect(logSummary.log_count).toBe(3);
    expect(logSummary.recent).toHaveLength(3);
    expect(logSummary.recent[0].content_preview).toBe("Third log");
    expect(logSummary.recent[1].content_preview).toBe("Second log");
    expect(logSummary.recent[2].content_preview).toBe("First log");
    expect(logSummary.recent[0].id).toBeTruthy();
    expect(logSummary.recent[0].created_at).toBeTruthy();
  });

  it("limits recent log previews to 5", () => {
    for (let i = 0; i < 8; i++) {
      appendLog(db, "projects/test", `Event ${i}`, []);
    }

    const { logSummary } = listNamespaceContents(db, "projects/test");
    expect(logSummary.log_count).toBe(8);
    expect(logSummary.recent).toHaveLength(5);
  });

  it("truncates long log content in preview", () => {
    const longContent = "A".repeat(500);
    appendLog(db, "projects/test", longContent, []);

    const { logSummary } = listNamespaceContents(db, "projects/test");
    expect(logSummary.recent[0].content_preview.length).toBe(200);
  });
});

describe("previewDelete + executeDelete", () => {
  it("previews single key deletion", () => {
    writeState(db, "projects/test", "status", "active", []);
    const preview = previewDelete(db, "projects/test", "status");
    expect(preview.stateCount).toBe(1);
    expect(preview.logCount).toBe(0);
    expect(preview.keys).toEqual(["status"]);
  });

  it("previews namespace deletion", () => {
    writeState(db, "projects/test", "status", "active", []);
    writeState(db, "projects/test", "arch", "mono", []);
    appendLog(db, "projects/test", "event 1", []);

    const preview = previewDelete(db, "projects/test");
    expect(preview.stateCount).toBe(2);
    expect(preview.logCount).toBe(1);
  });

  it("executes single key deletion", () => {
    writeState(db, "projects/test", "status", "active", []);
    writeState(db, "projects/test", "arch", "mono", []);

    const count = executeDelete(db, "projects/test", "status");
    expect(count).toBe(1);

    expect(readState(db, "projects/test", "status")).toBeNull();
    expect(readState(db, "projects/test", "arch")).not.toBeNull();
  });

  it("executes namespace deletion", () => {
    writeState(db, "projects/test", "status", "active", []);
    appendLog(db, "projects/test", "event", []);

    const count = executeDelete(db, "projects/test");
    expect(count).toBe(2);

    const ns = listNamespaces(db);
    expect(ns.find((n) => n.namespace === "projects/test")).toBeUndefined();
  });

  it("writes audit log on delete", () => {
    writeState(db, "projects/test", "status", "active", []);
    executeDelete(db, "projects/test", "status");

    const audits = db
      .prepare("SELECT action FROM audit_log ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(audits.at(-1)!.action).toBe("delete");
  });
});

describe("getOtherKeysInNamespace", () => {
  it("returns other keys excluding specified one", () => {
    writeState(db, "projects/test", "status", "a", []);
    writeState(db, "projects/test", "arch", "b", []);
    writeState(db, "projects/test", "config", "c", []);

    const keys = getOtherKeysInNamespace(db, "projects/test", "status");
    expect(keys).toEqual(["arch", "config"]);
  });

  it("returns all keys when no exclusion", () => {
    writeState(db, "projects/test", "status", "a", []);
    writeState(db, "projects/test", "arch", "b", []);

    const keys = getOtherKeysInNamespace(db, "projects/test");
    expect(keys).toEqual(["arch", "status"]);
  });
});

describe("rebuildFTS", () => {
  it("rebuilds FTS index without error", () => {
    writeState(db, "projects/test", "status", "searchable content", []);
    expect(() => rebuildFTS(db)).not.toThrow();

    // Verify search still works after rebuild
    const results = queryEntries(db, { query: "searchable" });
    expect(results.length).toBe(1);
  });
});

describe("embedding_status on entries", () => {
  it("new entries get embedding_status = 'pending'", () => {
    const { id } = writeState(db, "projects/test", "status", "test content", []);
    const entry = db
      .prepare("SELECT embedding_status, embedding_model FROM entries WHERE id = ?")
      .get(id) as { embedding_status: string; embedding_model: string | null };
    expect(entry.embedding_status).toBe("pending");
    expect(entry.embedding_model).toBeNull();
  });

  it("updates reset embedding_status to pending", () => {
    const { id } = writeState(db, "projects/test", "status", "v1", []);
    db.prepare("UPDATE entries SET embedding_status = 'generated', embedding_model = 'test' WHERE id = ?").run(id);

    writeState(db, "projects/test", "status", "v2", []);

    const entry = db
      .prepare("SELECT embedding_status, embedding_model FROM entries WHERE id = ?")
      .get(id) as { embedding_status: string; embedding_model: string | null };
    expect(entry.embedding_status).toBe("pending");
    expect(entry.embedding_model).toBeNull();
  });

  it("log entries get embedding_status = 'pending'", () => {
    const { id } = appendLog(db, "projects/test", "some event", []);
    const entry = db
      .prepare("SELECT embedding_status FROM entries WHERE id = ?")
      .get(id) as { embedding_status: string };
    expect(entry.embedding_status).toBe("pending");
  });
});

describe("edge cases", () => {
  it("handles unicode content", () => {
    writeState(db, "projects/test", "status", "Projektet är aktivt och fungerar bra 🚀", []);
    const entry = readState(db, "projects/test", "status");
    expect(entry!.content).toBe("Projektet är aktivt och fungerar bra 🚀");
  });

  it("handles very long content", () => {
    const longContent = "A".repeat(50000);
    writeState(db, "projects/test", "big-entry", longContent, []);
    const entry = readState(db, "projects/test", "big-entry");
    expect(entry!.content.length).toBe(50000);
  });

  it("CHECK constraint rejects state entry without key", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
         VALUES ('test-id', 'ns', NULL, 'state', 'content', '[]', 'default', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
  });

  it("CHECK constraint rejects log entry with key", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
         VALUES ('test-id', 'ns', 'somekey', 'log', 'content', '[]', 'default', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
  });

  it("CHECK constraint rejects invalid tags JSON", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
         VALUES ('test-id', 'ns', 'k', 'state', 'content', 'not-json', 'default', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
  });

  it("CHECK constraint rejects non-array JSON tags", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
         VALUES ('test-id', 'ns', 'k', 'state', 'content', '{"a":1}', 'default', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      ).run();
    }).toThrow();
  });
});
