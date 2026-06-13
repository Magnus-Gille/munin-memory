import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import {
  initDatabase,
  writeState,
  readState,
  getById,
  appendLog,
  syncCommitmentsForEntry,
  listCommitments,
  queryEntries,
  queryEntriesByFilter,
  filterIdsMatchingFts,
  listNamespaces,
  listNamespaceContents,
  previewDelete,
  executeDelete,
  getOtherKeysInNamespace,
  getNamespaceStateEntries,
  getNamespaceTagVocabulary,
  getCompletedTaskNamespaces,
  getTrackedStatuses,
  getAuditHistoryPage,
  rebuildFTS,
  logToolCall,
  getToolCallAggregates,
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

describe("getTrackedStatuses ordering (#74)", () => {
  it("returns a total, connection-independent order when updated_at ties", () => {
    // Seed several tracked statuses, then force identical updated_at to
    // simulate same-millisecond bulk writes (test fixtures, seeds). Without a
    // total-order tie-break, two connections can return tied rows in different
    // order — the root cause of the runner-parity flake (#74).
    writeState(db, "projects/alpha", "status", "Active alpha.", ["active"]);
    writeState(db, "projects/bravo", "status", "Blocked bravo.", ["blocked"]);
    writeState(db, "clients/delta", "status", "Active delta.", ["active"]);
    writeState(db, "projects/charlie", "status", "Active charlie.", ["active"]);
    db.prepare(
      "UPDATE entries SET updated_at = '2026-01-01T00:00:00.000Z' WHERE key = 'status'",
    ).run();

    // Insertion order (rowid) is the documented tie-break.
    const expected = ["projects/alpha", "projects/bravo", "clients/delta", "projects/charlie"];

    // Stable across repeated calls AND across a fresh connection to the same DB.
    const first = getTrackedStatuses(db).map((r) => r.namespace);
    const second = getTrackedStatuses(db).map((r) => r.namespace);
    const other = initDatabase(TEST_DB_PATH);
    const third = getTrackedStatuses(other).map((r) => r.namespace);
    other.close();

    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(third).toEqual(expected);
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
    expect(JSON.parse(entry!.tags)).toEqual(["active", "classification:internal"]);
    expect(entry!.classification).toBe("internal");
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
    expect(JSON.parse(entry!.tags)).toEqual(["updated", "classification:internal"]);
    expect(entry!.classification).toBe("internal");
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

  it("supports explicit classification above the namespace floor", () => {
    writeState(
      db,
      "projects/test",
      "status",
      "sensitive",
      ["active"],
      "default",
      undefined,
      undefined,
      { classification: "client-confidential" },
    );

    const entry = readState(db, "projects/test", "status");
    expect(entry?.classification).toBe("client-confidential");
    expect(JSON.parse(entry!.tags)).toContain("classification:client-confidential");
  });

  it("defaults client namespaces to client-confidential", () => {
    writeState(db, "clients/acme", "notes", "hello", []);
    const entry = readState(db, "clients/acme", "notes");
    expect(entry?.classification).toBe("client-confidential");
    expect(JSON.parse(entry!.tags)).toContain("classification:client-confidential");
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

  it("defaults log classification from the namespace floor", () => {
    const result = appendLog(db, "clients/acme", "Started the project", []);
    const entry = getById(db, result.id);
    expect(entry?.classification).toBe("client-confidential");
    expect(JSON.parse(entry!.tags)).toContain("classification:client-confidential");
  });
});

describe("commitment classification lifecycle", () => {
  it("propagates source classification and scrubs client-restricted derivatives", () => {
    const { id } = appendLog(
      db,
      "projects/test",
      "Need to send update by 2026-04-10.",
      [],
      "default",
      { classification: "client-confidential" },
    );

    syncCommitmentsForEntry(db, id, [{
      sourceType: "explicit_dated_commitment",
      fingerprint: "due:2026-04-10",
      text: "Need to send update by 2026-04-10.",
      dueAt: "2026-04-10T23:59:59.000Z",
      confidence: 0.9,
    }]);

    let rows = listCommitments(db, { namespace: "projects/test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].source_classification).toBe("client-confidential");

    writeState(
      db,
      "projects/test",
      "notes",
      "restricted source",
      [],
      "default",
      undefined,
      undefined,
      { classification: "client-restricted" },
    );

    const source = readState(db, "projects/test", "notes");
    syncCommitmentsForEntry(db, source!.id, [{
      sourceType: "explicit_dated_commitment",
      fingerprint: "restricted",
      text: "Restricted commitment",
      dueAt: "2026-04-11T23:59:59.000Z",
      confidence: 0.8,
    }]);

    rows = listCommitments(db, { namespace: "projects/test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].source_entry_id).toBe(id);
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

  it("matches accented tokens against unaccented queries and vice versa (#40)", () => {
    writeState(db, "decisions/jarvis-architecture", "overview", "Mímir is the wise councillor in Norse mythology.", ["decision"]);
    writeState(db, "decisions/jarvis-architecture", "plain", "Mimir appears in many sagas.", ["decision"]);

    const accentedHits = queryEntries(db, { query: "Mimir" });
    const accentedContents = accentedHits.map((r) => r.content);
    expect(accentedContents.some((c) => c.includes("Mímir"))).toBe(true);
    expect(accentedContents.some((c) => c.includes("Mimir"))).toBe(true);

    const plainHits = queryEntries(db, { query: "Mímir" });
    const plainContents = plainHits.map((r) => r.content);
    expect(plainContents.some((c) => c.includes("Mímir"))).toBe(true);
    expect(plainContents.some((c) => c.includes("Mimir"))).toBe(true);
  });

  it("matches camelCase tokens against separated-word queries (#42)", () => {
    writeState(
      db,
      "projects/test",
      "tools",
      "Used the WebFetch tool to scrape the page",
      ["tools"],
    );

    const camelHits = queryEntries(db, { query: "WebFetch" });
    expect(camelHits.some((r) => r.content.includes("WebFetch"))).toBe(true);

    const separatedHits = queryEntries(db, { query: "web fetch" });
    expect(separatedHits.some((r) => r.content.includes("WebFetch"))).toBe(true);

    const lowerHits = queryEntries(db, { query: "fetch" });
    expect(lowerHits.some((r) => r.content.includes("WebFetch"))).toBe(true);
  });

  it("matches slash- and digit-separated tokens like 90/10 (#42)", () => {
    // Regression guard: unicode61 tokenizes both the indexed content and the
    // query phrase identically (`90/10` -> adjacent tokens `90`, `10`), so the
    // ratio survives as a searchable phrase. No query-side expansion needed —
    // this locks in that the slash case keeps working. The camelCase half is
    // covered by the tests above (migration v17 / munin_split_tokens).
    writeState(
      db,
      "projects/test",
      "ratios",
      "The split was 90/10 in favor of recall; a separate 80/20 rule applies",
      ["notes"],
    );

    // Bare, quoted-phrase, and space-separated forms all find the 90/10 entry.
    for (const q of ["90/10", '"90/10"', "90 10"]) {
      expect(
        queryEntries(db, { query: q }).some((r) => r.content.includes("90/10")),
        `query ${JSON.stringify(q)} should match content containing 90/10`,
      ).toBe(true);
    }

    // A different ratio in the same entry is independently findable.
    expect(
      queryEntries(db, { query: "80/20" }).some((r) => r.content.includes("80/20")),
    ).toBe(true);

    // And an absent ratio does not match (no over-eager false positive).
    expect(
      queryEntries(db, { query: "90/11" }).some((r) => r.content.includes("90/10")),
    ).toBe(false);
  });

  it("matches PascalCase identifiers and acronym boundaries (#42)", () => {
    writeState(
      db,
      "projects/test",
      "patterns",
      "XMLParser handles parseXML and IOError events",
      ["code"],
    );

    expect(
      queryEntries(db, { query: "XML parser" }).some((r) =>
        r.content.includes("XMLParser"),
      ),
    ).toBe(true);

    expect(
      queryEntries(db, { query: "parse XML" }).some((r) =>
        r.content.includes("parseXML"),
      ),
    ).toBe(true);

    expect(
      queryEntries(db, { query: "io error" }).some((r) =>
        r.content.includes("IOError"),
      ),
    ).toBe(true);
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

  it("preserves split-token (camelCase) matches across rebuild (#42)", () => {
    writeState(
      db,
      "projects/test",
      "tools",
      "Used the WebFetch tool to scrape",
      ["tools"],
    );
    expect(
      queryEntries(db, { query: "web fetch" }).some((r) =>
        r.content.includes("WebFetch"),
      ),
    ).toBe(true);

    rebuildFTS(db);

    expect(
      queryEntries(db, { query: "web fetch" }).some((r) =>
        r.content.includes("WebFetch"),
      ),
    ).toBe(true);
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

describe("getToolCallAggregates p95_response_size_bytes", () => {
  function insertOldRow(toolName: string, sizeBytes: number | null, daysAgo: number) {
    // logToolCall hardcodes nowUTC(); for cutoff tests we need backdated rows,
    // so write directly through the same prepared statement shape.
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO tool_calls (id, timestamp, session_id, principal_id, tool_name, success, error_type, response_size_bytes, duration_ms)
       VALUES (?, ?, NULL, NULL, ?, 1, NULL, ?, NULL)`,
    ).run(`old-${Math.random()}`, ts, toolName, sizeBytes);
  }

  it("returns no rows when no tool calls exist", () => {
    expect(getToolCallAggregates(db, 7)).toEqual([]);
  });

  it("single row: p95 equals that row's size", () => {
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 42 });
    const row = getToolCallAggregates(db, 7).find((r) => r.tool_name === "memory_read")!;
    expect(row).toBeDefined();
    expect(row.total_calls).toBe(1);
    expect(row.p95_response_size_bytes).toBe(42);
  });

  it("two rows: p95 is the larger (ceil(0.95*2)-1 = 1)", () => {
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 10 });
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 90 });
    const row = getToolCallAggregates(db, 7).find((r) => r.tool_name === "memory_read")!;
    expect(row.p95_response_size_bytes).toBe(90);
  });

  it("1..100 shuffled: p95 is exactly 95 (distinguishes p95 from max)", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    // Fisher–Yates with deterministic seed-ish shuffle isn't necessary; insert order
    // doesn't matter because the function sorts. But shuffle anyway to be defensive.
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    for (const v of values) {
      logToolCall(db, { toolName: "memory_query", success: true, responseSizeBytes: v });
    }
    const row = getToolCallAggregates(db, 7).find((r) => r.tool_name === "memory_query")!;
    expect(row.total_calls).toBe(100);
    expect(row.p95_response_size_bytes).toBe(95);
  });

  it("null sizes are excluded; p95 computed over non-null subset", () => {
    logToolCall(db, { toolName: "memory_write", success: true, responseSizeBytes: 10 });
    logToolCall(db, { toolName: "memory_write", success: true, responseSizeBytes: 20 });
    logToolCall(db, { toolName: "memory_write", success: true }); // null size
    logToolCall(db, { toolName: "memory_write", success: true }); // null size
    logToolCall(db, { toolName: "memory_write", success: true, responseSizeBytes: 30 });
    const row = getToolCallAggregates(db, 7).find((r) => r.tool_name === "memory_write")!;
    expect(row.total_calls).toBe(5);
    // sorted non-null: [10,20,30]; p95 idx = ceil(0.95*3)-1 = 2 → 30
    expect(row.p95_response_size_bytes).toBe(30);
  });

  it("all-null group: row present, p95 is null", () => {
    logToolCall(db, { toolName: "memory_list", success: true }); // no size
    logToolCall(db, { toolName: "memory_list", success: true });
    const row = getToolCallAggregates(db, 7).find((r) => r.tool_name === "memory_list")!;
    expect(row).toBeDefined();
    expect(row.total_calls).toBe(2);
    expect(row.p95_response_size_bytes).toBeNull();
  });

  it("multi-tool: p95 isolated per tool", () => {
    for (let i = 1; i <= 100; i++) {
      logToolCall(db, { toolName: "tool_a", success: true, responseSizeBytes: i });
    }
    logToolCall(db, { toolName: "tool_b", success: true, responseSizeBytes: 500 });
    logToolCall(db, { toolName: "tool_b", success: true, responseSizeBytes: 600 });
    const rows = getToolCallAggregates(db, 7);
    const a = rows.find((r) => r.tool_name === "tool_a")!;
    const b = rows.find((r) => r.tool_name === "tool_b")!;
    expect(a.p95_response_size_bytes).toBe(95);
    expect(b.p95_response_size_bytes).toBe(600);
  });

  it("cutoff parity: old rows outside the window affect neither p95 nor total_calls", () => {
    // Recent: small distribution
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 10 });
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 20 });
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 30 });
    // Old (40 days ago): one huge value that would dominate p95 if not filtered
    insertOldRow("memory_read", 999_999_999, 40);

    const row = getToolCallAggregates(db, 7).find((r) => r.tool_name === "memory_read")!;
    expect(row.total_calls).toBe(3);
    // sorted recent: [10,20,30]; p95 idx = 2 → 30
    expect(row.p95_response_size_bytes).toBe(30);
  });

  it("shape regression: row has exact expected keys", () => {
    logToolCall(db, { toolName: "memory_read", success: true, responseSizeBytes: 1 });
    const row = getToolCallAggregates(db, 7)[0];
    expect(Object.keys(row).sort()).toEqual([
      "avg_duration_ms",
      "error_count",
      "p95_response_size_bytes",
      "tool_name",
      "total_calls",
    ]);
  });
});

describe("queryEntriesByFilter (no FTS)", () => {
  beforeEach(() => {
    writeState(db, "projects/a", "status", "active project alpha", ["active"]);
    writeState(db, "projects/a", "notes", "some notes", ["decision"]);
    writeState(db, "projects/b", "status", "blocked beta", ["blocked"]);
    appendLog(db, "projects/a", "log entry one", ["milestone"]);
    writeState(db, "clients/acme", "status", "client status", ["active"]);
  });

  it("returns all entries when no filters given", () => {
    const results = queryEntriesByFilter(db, {});
    expect(results.length).toBeGreaterThanOrEqual(5);
  });

  it("filters by exact namespace", () => {
    const results = queryEntriesByFilter(db, { namespace: "projects/a" });
    expect(results.every((r) => r.namespace === "projects/a")).toBe(true);
    expect(results.length).toBe(3); // status, notes, log
  });

  it("filters by namespace prefix (trailing slash)", () => {
    const results = queryEntriesByFilter(db, { namespace: "projects/" });
    expect(results.every((r) => r.namespace.startsWith("projects/"))).toBe(true);
    expect(results.length).toBe(4); // projects/a and projects/b entries
  });

  it("filters by entry type", () => {
    const results = queryEntriesByFilter(db, { entryType: "log" });
    expect(results.every((r) => r.entry_type === "log")).toBe(true);
    expect(results.length).toBe(1);
  });

  it("filters by tag", () => {
    const results = queryEntriesByFilter(db, { tags: ["active"] });
    for (const r of results) {
      const tags = JSON.parse(r.tags) as string[];
      expect(tags).toContain("active");
    }
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("respects limit", () => {
    const results = queryEntriesByFilter(db, { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("clamps limit to minimum 1 and maximum 50", () => {
    const zeroLimit = queryEntriesByFilter(db, { limit: 0 });
    expect(zeroLimit.length).toBeGreaterThanOrEqual(1);
    const bigLimit = queryEntriesByFilter(db, { limit: 1000 });
    expect(bigLimit.length).toBeLessThanOrEqual(50);
  });

  it("filters by since and until timestamps", () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const after = new Date(Date.now() + 1000).toISOString();
    const results = queryEntriesByFilter(db, { since: before, until: after });
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns expired state entries when includeExpired is true", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    writeState(db, "projects/a", "expiring", "will expire", [], "default", undefined, past);
    const withExpired = queryEntriesByFilter(db, { includeExpired: true, namespace: "projects/a" });
    const withoutExpired = queryEntriesByFilter(db, { includeExpired: false, namespace: "projects/a" });
    expect(withExpired.length).toBeGreaterThan(withoutExpired.length);
  });

  it("combines namespace prefix with entry type", () => {
    const results = queryEntriesByFilter(db, { namespace: "projects/", entryType: "state" });
    expect(results.every((r) => r.namespace.startsWith("projects/") && r.entry_type === "state")).toBe(true);
  });
});

describe("filterIdsMatchingFts", () => {
  beforeEach(() => {
    writeState(db, "projects/alpha", "status", "SQLite full-text search", ["active"]);
    writeState(db, "projects/beta", "status", "Raspberry Pi deployment target", ["active"]);
  });

  it("returns matching IDs from the given set", () => {
    const alphaId = (db.prepare("SELECT id FROM entries WHERE namespace='projects/alpha'").get() as { id: string }).id;
    const betaId = (db.prepare("SELECT id FROM entries WHERE namespace='projects/beta'").get() as { id: string }).id;

    const matched = filterIdsMatchingFts(db, "SQLite", [alphaId, betaId]);
    expect(matched.has(alphaId)).toBe(true);
    expect(matched.has(betaId)).toBe(false);
  });

  it("returns empty set when ids array is empty", () => {
    const result = filterIdsMatchingFts(db, "SQLite", []);
    expect(result.size).toBe(0);
  });

  it("returns empty set when no ids match", () => {
    const alphaId = (db.prepare("SELECT id FROM entries WHERE namespace='projects/alpha'").get() as { id: string }).id;
    const result = filterIdsMatchingFts(db, "nonexistent-term-xyz", [alphaId]);
    expect(result.size).toBe(0);
  });
});

describe("getAuditHistoryPage", () => {
  beforeEach(() => {
    writeState(db, "projects/test", "status", "v1", []);
    writeState(db, "projects/test", "status", "v2", []);
    appendLog(db, "projects/other", "event", []);
  });

  it("returns entries without filters", () => {
    const page = getAuditHistoryPage(db, {});
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
  });

  it("filters by exact namespace and includes child namespaces", () => {
    writeState(db, "projects/test/sub", "notes", "subproject notes", []);
    const page = getAuditHistoryPage(db, { namespace: "projects/test" });
    // Should include projects/test AND projects/test/sub entries
    expect(page.entries.every((e) =>
      e.namespace === "projects/test" || e.namespace.startsWith("projects/test/"),
    )).toBe(true);
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it("filters by namespace prefix (trailing slash) — covers the endsWith('/') branch", () => {
    const page = getAuditHistoryPage(db, { namespace: "projects/" });
    expect(page.entries.every((e) => e.namespace.startsWith("projects/"))).toBe(true);
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it("filters by since timestamp", () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const page = getAuditHistoryPage(db, { since });
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it("filters by action type", () => {
    const page = getAuditHistoryPage(db, { action: "write" });
    expect(page.entries.every((e) => e.action === "write")).toBe(true);
  });

  it("throws on invalid since timestamp", () => {
    expect(() => getAuditHistoryPage(db, { since: "not-a-date" })).toThrow(/Invalid "since"/);
  });

  it("throws on non-integer cursor", () => {
    expect(() => getAuditHistoryPage(db, { cursor: 1.5 })).toThrow(/Invalid "cursor"/);
  });

  it("throws on negative cursor", () => {
    expect(() => getAuditHistoryPage(db, { cursor: -1 })).toThrow(/Invalid "cursor"/);
  });

  it("supports ascending cursor pagination", () => {
    // Insert enough entries to span multiple pages
    for (let i = 0; i < 5; i++) {
      writeState(db, "projects/paginate", `key-${i}`, `content-${i}`, []);
    }
    const first = getAuditHistoryPage(db, { limit: 3, cursor: 0 });
    expect(first.entries.length).toBe(3);
    // With cursor: ascending order, nextCursor advances
    const second = getAuditHistoryPage(db, { limit: 3, cursor: first.nextCursor! });
    expect(second.entries.length).toBeGreaterThanOrEqual(1);
    // IDs must be strictly increasing (ascending order)
    const allIds = [...first.entries, ...second.entries].map((e) => e.id);
    for (let i = 1; i < allIds.length; i++) {
      expect(allIds[i]).toBeGreaterThan(allIds[i - 1]);
    }
  });

  it("hasMore is true when more entries exist beyond limit", () => {
    for (let i = 0; i < 5; i++) {
      writeState(db, "projects/paginate", `k${i}`, `v${i}`, []);
    }
    const page = getAuditHistoryPage(db, { limit: 2 });
    expect(page.hasMore).toBe(true);
  });
});

describe("getNamespaceStateEntries", () => {
  it("returns all state entries in a namespace ordered by key", () => {
    writeState(db, "projects/ns-test", "status", "active", ["active"]);
    writeState(db, "projects/ns-test", "arch", "microservices", []);
    appendLog(db, "projects/ns-test", "some log", []);

    const entries = getNamespaceStateEntries(db, "projects/ns-test");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key)).toEqual(["arch", "status"]);
    expect(entries.every((e) => e.entry_type === "state")).toBe(true);
  });

  it("excludes log entries", () => {
    appendLog(db, "projects/log-only", "log1", []);
    const entries = getNamespaceStateEntries(db, "projects/log-only");
    expect(entries).toHaveLength(0);
  });

  it("returns empty array for nonexistent namespace", () => {
    expect(getNamespaceStateEntries(db, "nonexistent/ns")).toEqual([]);
  });
});

describe("getNamespaceTagVocabulary", () => {
  it("returns unique tags from all state entries in namespace", () => {
    writeState(db, "projects/vocab", "status", "active", ["active", "decision"]);
    writeState(db, "projects/vocab", "arch", "notes", ["decision", "architecture"]);
    appendLog(db, "projects/vocab", "log with tag", ["log-tag"]); // should be excluded

    const vocab = getNamespaceTagVocabulary(db, "projects/vocab");
    // Should include tags from state entries; the full set includes auto-added classification tags
    expect(vocab).toContain("active");
    expect(vocab).toContain("decision");
    expect(vocab).toContain("architecture");
    // log-tag from log entry should NOT appear
    expect(vocab).not.toContain("log-tag");
    // Should be unique (no duplicates for "decision")
    expect(vocab.filter((t) => t === "decision")).toHaveLength(1);
  });

  it("returns empty array for nonexistent namespace", () => {
    expect(getNamespaceTagVocabulary(db, "nonexistent/ns")).toEqual([]);
  });
});
