import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import {
  initDatabase,
  writeState,
  logRetrievalEvent,
  logRetrievalOutcome,
  getInsightsByEntry,
  pruneRetrievalAnalytics,
  nowUTC,
} from "../src/db.js";

const TEST_DB_PATH = "/tmp/munin-memory-retrieval-test.db";

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

describe("logRetrievalEvent", () => {
  it("inserts a retrieval event and returns an event ID", () => {
    const eventId = logRetrievalEvent(db, {
      sessionId: "session-1",
      toolName: "memory_query",
      queryText: "test query",
      requestedMode: "hybrid",
      actualMode: "hybrid",
      resultIds: ["id-1", "id-2"],
      resultNamespaces: ["projects/foo", "projects/bar"],
      resultRanks: [1, 2],
    });

    expect(eventId).toBeTruthy();

    const row = db
      .prepare("SELECT * FROM retrieval_events WHERE id = ?")
      .get(eventId) as Record<string, unknown>;

    expect(row).toBeTruthy();
    expect(row.session_id).toBe("session-1");
    expect(row.tool_name).toBe("memory_query");
    expect(row.query_text).toBe("test query");
    expect(row.requested_mode).toBe("hybrid");
    expect(row.actual_mode).toBe("hybrid");
    expect(JSON.parse(row.result_ids as string)).toEqual(["id-1", "id-2"]);
    expect(JSON.parse(row.result_namespaces as string)).toEqual(["projects/foo", "projects/bar"]);
    expect(JSON.parse(row.result_ranks as string)).toEqual([1, 2]);
  });

  it("upserts the session cursor after inserting an event", () => {
    const eventId1 = logRetrievalEvent(db, {
      sessionId: "session-2",
      toolName: "memory_orient",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    const session1 = db
      .prepare("SELECT * FROM retrieval_sessions WHERE session_id = ?")
      .get("session-2") as Record<string, unknown>;

    expect(session1.last_event_id).toBe(eventId1);

    const eventId2 = logRetrievalEvent(db, {
      sessionId: "session-2",
      toolName: "memory_query",
      queryText: "follow-up",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    const session2 = db
      .prepare("SELECT * FROM retrieval_sessions WHERE session_id = ?")
      .get("session-2") as Record<string, unknown>;

    expect(session2.last_event_id).toBe(eventId2);
  });

  it("records query_reformulated on the prior event when it has no positive outcomes", () => {
    // Insert first event (no outcomes)
    const eventId1 = logRetrievalEvent(db, {
      sessionId: "session-3",
      toolName: "memory_query",
      queryText: "first query",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    // Insert second event — should trigger query_reformulated on the first
    logRetrievalEvent(db, {
      sessionId: "session-3",
      toolName: "memory_query",
      queryText: "refined query",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    const outcomes = db
      .prepare(
        "SELECT * FROM retrieval_outcomes WHERE retrieval_event_id = ? AND outcome_type = 'query_reformulated'",
      )
      .all(eventId1) as Record<string, unknown>[];

    expect(outcomes).toHaveLength(1);
  });

  it("does NOT record query_reformulated when the prior event has positive outcomes", () => {
    const eventId1 = logRetrievalEvent(db, {
      sessionId: "session-4",
      toolName: "memory_query",
      queryText: "first query",
      resultIds: ["e1"],
      resultNamespaces: ["projects/foo"],
      resultRanks: [1],
    });

    // Add a positive outcome on the first event
    logRetrievalOutcome(db, "session-4", {
      outcomeType: "opened_result",
      entryId: "e1",
      namespace: "projects/foo",
    });

    // Insert second event — should NOT trigger query_reformulated
    logRetrievalEvent(db, {
      sessionId: "session-4",
      toolName: "memory_query",
      queryText: "different query",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    const outcomes = db
      .prepare(
        "SELECT * FROM retrieval_outcomes WHERE retrieval_event_id = ? AND outcome_type = 'query_reformulated'",
      )
      .all(eventId1) as Record<string, unknown>[];

    expect(outcomes).toHaveLength(0);
  });

  it("never throws even with invalid input", () => {
    // Should not throw
    const result = logRetrievalEvent(db, {
      sessionId: "s",
      toolName: "memory_query",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });
    expect(result).toBeTruthy();
  });
});

describe("logRetrievalOutcome", () => {
  it("inserts an outcome tied to the most recent event in the session", () => {
    const eventId = logRetrievalEvent(db, {
      sessionId: "session-out-1",
      toolName: "memory_query",
      queryText: "test",
      resultIds: ["entry-abc"],
      resultNamespaces: ["projects/test"],
      resultRanks: [1],
    });

    logRetrievalOutcome(db, "session-out-1", {
      outcomeType: "opened_result",
      entryId: "entry-abc",
      namespace: "projects/test",
    });

    const outcomes = db
      .prepare("SELECT * FROM retrieval_outcomes WHERE retrieval_event_id = ?")
      .all(eventId) as Record<string, unknown>[];

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome_type).toBe("opened_result");
    expect(outcomes[0].entry_id).toBe("entry-abc");
    expect(outcomes[0].namespace).toBe("projects/test");
  });

  it("does not insert an outcome when no session cursor exists", () => {
    logRetrievalOutcome(db, "nonexistent-session", {
      outcomeType: "opened_result",
      entryId: "e1",
    });

    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM retrieval_outcomes").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });

  it("does not insert an outcome outside the 5-minute correlation window", () => {
    // Insert event with a timestamp far in the past
    const pastTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 mins ago
    const eventId = "evt-old";
    db.prepare(
      `INSERT INTO retrieval_events
         (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
       VALUES (?, ?, ?, 'memory_query', '[]', '[]', '[]')`,
    ).run(eventId, "session-old", pastTimestamp);

    db.prepare(
      `INSERT INTO retrieval_sessions (session_id, last_event_id, last_event_timestamp, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run("session-old", eventId, pastTimestamp, pastTimestamp);

    logRetrievalOutcome(db, "session-old", {
      outcomeType: "opened_result",
      entryId: "e1",
    });

    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM retrieval_outcomes").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });

  it("never throws even when called with unknown session", () => {
    // Should complete without error
    expect(() => {
      logRetrievalOutcome(db, "ghost-session", {
        outcomeType: "write_in_result_namespace",
        namespace: "projects/test",
      });
    }).not.toThrow();
  });
});

describe("getInsightsByEntry", () => {
  it("returns empty array when no retrieval events exist", () => {
    const rows = getInsightsByEntry(db, undefined, 1, 20);
    expect(rows).toHaveLength(0);
  });

  it("computes impressions for memory_query events", () => {
    // Create an entry in the entries table
    writeState(db, "projects/foo", "status", "active project", ["active"]);
    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/foo' AND key = 'status'")
      .get() as { id: string };

    const eventId = logRetrievalEvent(db, {
      sessionId: "session-ins-1",
      toolName: "memory_query",
      queryText: "test",
      resultIds: [entry.id],
      resultNamespaces: ["projects/foo"],
      resultRanks: [1],
    });

    expect(eventId).toBeTruthy();

    // Should show up with 1 impression
    const rows = getInsightsByEntry(db, undefined, 1, 20);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => r.entry_id === entry.id);
    expect(row).toBeTruthy();
    expect(row!.impressions).toBe(1);
    expect(row!.opens).toBe(0);
  });

  it("counts opens when opened_result outcomes exist", () => {
    writeState(db, "projects/bar", "status", "running", ["active"]);
    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/bar' AND key = 'status'")
      .get() as { id: string };

    logRetrievalEvent(db, {
      sessionId: "session-ins-2",
      toolName: "memory_query",
      queryText: "bar",
      resultIds: [entry.id],
      resultNamespaces: ["projects/bar"],
      resultRanks: [1],
    });

    logRetrievalOutcome(db, "session-ins-2", {
      outcomeType: "opened_result",
      entryId: entry.id,
      namespace: "projects/bar",
    });

    const rows = getInsightsByEntry(db, undefined, 1, 20);
    const row = rows.find((r) => r.entry_id === entry.id);
    expect(row).toBeTruthy();
    expect(row!.impressions).toBe(1);
    expect(row!.opens).toBe(1);
  });

  it("filters by namespace prefix", () => {
    writeState(db, "projects/alpha", "status", "alpha", ["active"]);
    writeState(db, "clients/beta", "status", "beta", ["active"]);

    const entryA = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/alpha' AND key = 'status'")
      .get() as { id: string };
    const entryB = db
      .prepare("SELECT id FROM entries WHERE namespace = 'clients/beta' AND key = 'status'")
      .get() as { id: string };

    logRetrievalEvent(db, {
      sessionId: "session-ns-1",
      toolName: "memory_query",
      queryText: "multi",
      resultIds: [entryA.id, entryB.id],
      resultNamespaces: ["projects/alpha", "clients/beta"],
      resultRanks: [1, 2],
    });

    const projectsOnly = getInsightsByEntry(db, "projects/", 1, 20);
    const namespaces = projectsOnly.map((r) => r.namespace);
    expect(namespaces.every((ns) => ns.startsWith("projects/"))).toBe(true);
    expect(projectsOnly.some((r) => r.entry_id === entryB.id)).toBe(false);
  });

  it("respects min_impressions threshold", () => {
    writeState(db, "projects/low-impressions", "status", "low", ["active"]);
    const entry = db
      .prepare(
        "SELECT id FROM entries WHERE namespace = 'projects/low-impressions' AND key = 'status'",
      )
      .get() as { id: string };

    // Only 1 impression
    logRetrievalEvent(db, {
      sessionId: "session-min-1",
      toolName: "memory_query",
      queryText: "low",
      resultIds: [entry.id],
      resultNamespaces: ["projects/low-impressions"],
      resultRanks: [1],
    });

    // With min_impressions = 3, should not appear
    const rows = getInsightsByEntry(db, undefined, 3, 20);
    expect(rows.find((r) => r.entry_id === entry.id)).toBeUndefined();

    // With min_impressions = 1, should appear
    const rows2 = getInsightsByEntry(db, undefined, 1, 20);
    expect(rows2.find((r) => r.entry_id === entry.id)).toBeDefined();
  });

  it("does NOT count memory_orient events in impressions", () => {
    writeState(db, "projects/orient-test", "status", "orient", ["active"]);
    const entry = db
      .prepare(
        "SELECT id FROM entries WHERE namespace = 'projects/orient-test' AND key = 'status'",
      )
      .get() as { id: string };

    // Orient event has empty result_ids (as per instrumentation design)
    logRetrievalEvent(db, {
      sessionId: "session-orient",
      toolName: "memory_orient",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    const rows = getInsightsByEntry(db, undefined, 1, 20);
    expect(rows.find((r) => r.entry_id === entry.id)).toBeUndefined();
  });
});

describe("pruneRetrievalAnalytics", () => {
  it("deletes events older than retention period", () => {
    // Insert an old event (200 days ago)
    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO retrieval_events
         (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
       VALUES ('old-event', 'sess', ?, 'memory_query', '[]', '[]', '[]')`,
    ).run(oldTs);

    // Insert a recent event
    logRetrievalEvent(db, {
      sessionId: "sess",
      toolName: "memory_query",
      resultIds: [],
      resultNamespaces: [],
      resultRanks: [],
    });

    const beforeCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM retrieval_events").get() as { cnt: number }
    ).cnt;
    expect(beforeCount).toBe(2);

    pruneRetrievalAnalytics(db, 90);

    const afterCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM retrieval_events").get() as { cnt: number }
    ).cnt;
    expect(afterCount).toBe(1);

    const remaining = db
      .prepare("SELECT id FROM retrieval_events")
      .all() as Array<{ id: string }>;
    expect(remaining[0].id).not.toBe("old-event");
  });

  it("cascade-deletes outcomes when their event is pruned", () => {
    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO retrieval_events
         (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
       VALUES ('old-evt-2', 'sess-2', ?, 'memory_query', '[]', '[]', '[]')`,
    ).run(oldTs);

    db.prepare(
      `INSERT INTO retrieval_outcomes
         (id, retrieval_event_id, timestamp, outcome_type)
       VALUES ('old-outcome', 'old-evt-2', ?, 'opened_result')`,
    ).run(oldTs);

    pruneRetrievalAnalytics(db, 90);

    const outcomesCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM retrieval_outcomes").get() as { cnt: number }
    ).cnt;
    expect(outcomesCount).toBe(0);
  });

  it("prunes stale session cursors (older than 7 days)", () => {
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO retrieval_sessions
         (session_id, last_event_id, last_event_timestamp, created_at)
       VALUES ('old-session', NULL, ?, ?)`,
    ).run(oldTs, oldTs);

    // Insert a recent session
    db.prepare(
      `INSERT INTO retrieval_sessions
         (session_id, last_event_id, last_event_timestamp, created_at)
       VALUES ('recent-session', NULL, ?, ?)`,
    ).run(nowUTC(), nowUTC());

    pruneRetrievalAnalytics(db, 90);

    const sessions = db
      .prepare("SELECT session_id FROM retrieval_sessions")
      .all() as Array<{ session_id: string }>;

    expect(sessions.map((s) => s.session_id)).not.toContain("old-session");
    expect(sessions.map((s) => s.session_id)).toContain("recent-session");
  });

  it("never throws", () => {
    expect(() => pruneRetrievalAnalytics(db, 90)).not.toThrow();
  });
});
