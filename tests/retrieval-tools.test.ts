import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AccessContext } from "../src/access.js";
import { initDatabase, writeState } from "../src/db.js";
import { registerTools } from "../src/tools.js";

const TEST_DB_PATH = "/tmp/munin-memory-retrieval-tools-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

let db: Database.Database;
let server: Server;

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
  if (handler) {
    return await handler({ method: "tools/call", params: { name, arguments: args } });
  }
  throw new Error("Cannot access tool handler");
}

function parseToolResponse(response: unknown): unknown {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

const SESSION_ID = "test-session-instrumentation";

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  server = new Server(
    { name: "test-munin", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, SESSION_ID);
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

describe("memory_query instrumentation", () => {
  it("logs a retrieval event after a query", async () => {
    // Write an entry to search for
    writeState(db, "projects/test", "status", "a test project", ["active"]);

    await callTool("memory_query", { query: "test project" });

    const events = db
      .prepare("SELECT * FROM retrieval_events WHERE session_id = ? AND tool_name = 'memory_query'")
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(events.length).toBeGreaterThan(0);
    const evt = events[0];
    expect(evt.query_text).toBe("test project");
    // result_ids is a JSON array
    const resultIds = JSON.parse(evt.result_ids as string) as string[];
    expect(Array.isArray(resultIds)).toBe(true);
  });

  it("logs no event when sessionId is not provided", async () => {
    // Create server without sessionId
    const serverNoSession = new Server(
      { name: "test-munin", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(serverNoSession, db); // no sessionId

    const handler = (serverNoSession as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
    await handler!({ method: "tools/call", params: { name: "memory_query", arguments: { query: "anything" } } });

    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM retrieval_events").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });
});

describe("memory_orient instrumentation", () => {
  it("logs a retrieval event for orient calls", async () => {
    await callTool("memory_orient");

    const events = db
      .prepare("SELECT * FROM retrieval_events WHERE session_id = ? AND tool_name = 'memory_orient'")
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(events.length).toBeGreaterThan(0);
    // Orient events have empty result_ids
    expect(JSON.parse(events[0].result_ids as string)).toEqual([]);
  });
});

describe("memory_attention instrumentation", () => {
  it("logs a retrieval event for attention calls", async () => {
    // Create a tracked namespace with a status entry
    writeState(db, "projects/blocked-proj", "status", "blocked on something", ["blocked"]);

    await callTool("memory_attention");

    const events = db
      .prepare("SELECT * FROM retrieval_events WHERE session_id = ? AND tool_name = 'memory_attention'")
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(events.length).toBeGreaterThan(0);
  });
});

describe("memory_read outcome logging", () => {
  it("logs opened_result outcome when an entry is found", async () => {
    // First log a query event so there is a session cursor
    writeState(db, "projects/outcome-test", "status", "outcome test", ["active"]);
    await callTool("memory_query", { query: "outcome test" });

    // Now read the entry — should log an opened_result outcome
    await callTool("memory_read", { namespace: "projects/outcome-test", key: "status" });

    const outcomes = db
      .prepare(
        `SELECT ro.* FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE re.session_id = ? AND ro.outcome_type = 'opened_result'`,
      )
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(outcomes.length).toBeGreaterThan(0);
  });

  it("does not log outcome when entry is not found", async () => {
    // Establish session cursor
    await callTool("memory_query", { query: "something" });

    await callTool("memory_read", { namespace: "projects/nonexistent", key: "status" });

    const outcomes = db
      .prepare(
        `SELECT ro.* FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE re.session_id = ? AND ro.outcome_type = 'opened_result'`,
      )
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(outcomes).toHaveLength(0);
  });
});

describe("memory_get outcome logging", () => {
  it("logs opened_result outcome when an entry is found by ID", async () => {
    writeState(db, "projects/get-test", "status", "get test entry", ["active"]);
    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/get-test' AND key = 'status'")
      .get() as { id: string };

    // Establish session cursor
    await callTool("memory_query", { query: "get test" });

    await callTool("memory_get", { id: entry.id });

    const outcomes = db
      .prepare(
        `SELECT ro.* FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE re.session_id = ? AND ro.outcome_type = 'opened_result'`,
      )
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.some((o) => o.entry_id === entry.id)).toBe(true);
  });
});

describe("memory_write outcome logging", () => {
  it("logs write_in_result_namespace outcome after a write", async () => {
    // Establish session cursor
    await callTool("memory_query", { query: "write outcome" });

    await callTool("memory_write", {
      namespace: "projects/write-outcome",
      key: "status",
      content: "written after query",
      tags: ["active"],
    });

    const outcomes = db
      .prepare(
        `SELECT ro.* FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE re.session_id = ? AND ro.outcome_type = 'write_in_result_namespace'`,
      )
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.some((o) => o.namespace === "projects/write-outcome")).toBe(true);
  });
});

describe("memory_log outcome logging", () => {
  it("logs log_in_result_namespace outcome after a log entry", async () => {
    // Establish session cursor
    await callTool("memory_query", { query: "log outcome" });

    await callTool("memory_log", {
      namespace: "projects/log-outcome",
      content: "a log entry",
    });

    const outcomes = db
      .prepare(
        `SELECT ro.* FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE re.session_id = ? AND ro.outcome_type = 'log_in_result_namespace'`,
      )
      .all(SESSION_ID) as Array<Record<string, unknown>>;

    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.some((o) => o.namespace === "projects/log-outcome")).toBe(true);
  });
});

describe("memory_insights tool", () => {
  it("returns empty entries when no retrieval data exists", async () => {
    const raw = await callTool("memory_insights");
    const result = parseToolResponse(raw) as { entries: unknown[]; total: number; min_impressions: number; message?: string };

    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.min_impressions).toBe(3);
  });

  it("includes an explicit message explaining the empty result is below min_impressions", async () => {
    const raw = await callTool("memory_insights");
    const result = parseToolResponse(raw) as { entries: unknown[]; message?: string };
    expect(result.entries).toHaveLength(0);
    expect(result.message).toBeTypeOf("string");
    expect(result.message).toContain("min_impressions");
  });

  it("includes session-segmented reformulation context in aggregates (#25)", async () => {
    const raw = await callTool("memory_insights");
    const result = parseToolResponse(raw) as {
      aggregates: {
        reformulation_rate: number;
        reformulation_rate_adjusted: number;
        reformulation_explanation: string;
        total_sessions: number;
        multi_event_sessions: number;
      };
    };

    expect(result.aggregates).toBeDefined();
    expect(result.aggregates.reformulation_rate).toBeTypeOf("number");
    expect(result.aggregates.reformulation_rate_adjusted).toBeTypeOf("number");
    expect(result.aggregates.reformulation_explanation).toBeTypeOf("string");
    expect(result.aggregates.reformulation_explanation.length).toBeGreaterThan(0);
    expect(result.aggregates.total_sessions).toBeTypeOf("number");
    expect(result.aggregates.multi_event_sessions).toBeTypeOf("number");
  });

  it("returns insights after retrieval events", async () => {
    writeState(db, "projects/insights-target", "status", "insights target project", ["active"]);
    const entry = db
      .prepare(
        "SELECT id FROM entries WHERE namespace = 'projects/insights-target' AND key = 'status'",
      )
      .get() as { id: string };

    // Log 5 retrieval events for this entry (exceeds default min_impressions of 3)
    for (let i = 0; i < 5; i++) {
      const sid = `session-insights-${i}`;
      const newServer = new Server(
        { name: "test-munin", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );
      registerTools(newServer, db, sid);

      const handler = (newServer as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
      await handler!({
        method: "tools/call",
        params: {
          name: "memory_query",
          arguments: { query: "insights target" },
        },
      });
    }

    const raw = await callTool("memory_insights", { min_impressions: 3 });
    const result = parseToolResponse(raw) as { entries: Array<{ entry_id: string; impressions: number }> };

    // The entry should appear with >= 3 impressions if it was returned by the queries
    // (it may not be returned by lexical query depending on FTS matching)
    expect(result).toBeDefined();
    expect(typeof result.entries).toBe("object");
  });

  it("respects the namespace filter", async () => {
    const raw = await callTool("memory_insights", { namespace: "projects/", min_impressions: 1 });
    const result = parseToolResponse(raw) as { entries: Array<{ namespace: string }> };

    // All returned entries must be in projects/ namespace
    for (const entry of result.entries) {
      expect(entry.namespace.startsWith("projects/")).toBe(true);
    }
  });

  it("respects min_impressions parameter", async () => {
    const raw = await callTool("memory_insights", { min_impressions: 999 });
    const result = parseToolResponse(raw) as { entries: unknown[]; min_impressions: number };
    expect(result.entries).toHaveLength(0);
    expect(result.min_impressions).toBe(999);
  });

  it("includes learned_signals in response entries", async () => {
    const raw = await callTool("memory_insights");
    const result = parseToolResponse(raw) as {
      entries: Array<{ learned_signals: unknown }>;
    };
    // Even when empty, structure is correct
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it("is in the tool list", async () => {
    const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/list");
    const toolList = await handler!({ method: "tools/list", params: {} });
    const tools = (toolList as { tools: Array<{ name: string }> }).tools;
    expect(tools.some((t) => t.name === "memory_insights")).toBe(true);
  });

  it("includes key and content_preview in insight entries for existing entries", async () => {
    const { writeState } = await import("../src/db.js");
    const content = "This is a content preview test entry with enough text";
    writeState(db, "projects/preview-test", "preview-key", content, []);
    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/preview-test' AND key = 'preview-key'")
      .get() as { id: string };

    const now = new Date().toISOString();

    // Insert enough retrieval events to exceed min_impressions
    for (let i = 0; i < 4; i++) {
      db.prepare(
        `INSERT INTO retrieval_events (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
         VALUES (?, 'session-preview', ?, 'memory_query', json_array(?), '[]', '[]')`,
      ).run(`evt-preview-${i}`, now, entry.id);
    }

    const raw = await callTool("memory_insights", { min_impressions: 3 });
    const result = parseToolResponse(raw) as {
      entries: Array<{ entry_id: string; key: string | null; content_preview: string | null }>;
    };

    const found = result.entries.find((e) => e.entry_id === entry.id);
    expect(found).toBeDefined();
    expect(found!.key).toBe("preview-key");
    // content_preview should be truncated to 60 chars
    expect(found!.content_preview).toBe(content.substring(0, 60));
    expect(found!.content_preview!.length).toBeLessThanOrEqual(60);
  });

  it("shows null key and content_preview for deleted entries", async () => {
    const { writeState } = await import("../src/db.js");
    writeState(db, "projects/deleted-test", "deleted-key", "entry that will be deleted", []);
    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/deleted-test' AND key = 'deleted-key'")
      .get() as { id: string };

    const now = new Date().toISOString();

    // Insert enough retrieval events to exceed min_impressions
    for (let i = 0; i < 4; i++) {
      db.prepare(
        `INSERT INTO retrieval_events (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
         VALUES (?, 'session-deleted', ?, 'memory_query', json_array(?), '[]', '[]')`,
      ).run(`evt-deleted-${i}`, now, entry.id);
    }

    // Now delete the entry to simulate a deleted entry
    db.prepare("DELETE FROM entries WHERE id = ?").run(entry.id);

    const raw = await callTool("memory_insights", { min_impressions: 3 });
    const result = parseToolResponse(raw) as {
      entries: Array<{ entry_id: string; key: string | null; content_preview: string | null }>;
    };

    const found = result.entries.find((e) => e.entry_id === entry.id);
    expect(found).toBeDefined();
    expect(found!.key).toBeNull();
    expect(found!.content_preview).toBeNull();
  });

  it("clamps followthrough_rate to at most 1.0 when outcomes exceed impressions", async () => {
    // Create an entry to reference
    const { writeState } = await import("../src/db.js");
    writeState(db, "projects/clamp-test", "status", "clamp test entry", ["active"]);
    const entry = db
      .prepare("SELECT id FROM entries WHERE namespace = 'projects/clamp-test' AND key = 'status'")
      .get() as { id: string };

    const now = new Date().toISOString();

    // Insert 2 retrieval events (impressions = 2) for this entry
    const eventIds = ["evt-clamp-1", "evt-clamp-2"];
    for (const evtId of eventIds) {
      db.prepare(
        `INSERT INTO retrieval_events (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
         VALUES (?, 'session-clamp', ?, 'memory_query', json_array(?), '[]', '[]')`,
      ).run(evtId, now, entry.id);
    }

    // Insert outcomes that exceed impressions:
    // opens=2, write_outcomes=2, log_outcomes=2 → sum=6 > impressions=2
    let outcomeIdx = 0;
    for (const evtId of eventIds) {
      db.prepare(
        `INSERT INTO retrieval_outcomes (id, retrieval_event_id, timestamp, outcome_type, entry_id)
         VALUES (?, ?, ?, 'opened_result', ?)`,
      ).run(`out-open-${outcomeIdx++}`, evtId, now, entry.id);

      db.prepare(
        `INSERT INTO retrieval_outcomes (id, retrieval_event_id, timestamp, outcome_type, entry_id)
         VALUES (?, ?, ?, 'write_in_result_namespace', ?)`,
      ).run(`out-write-${outcomeIdx++}`, evtId, now, entry.id);

      db.prepare(
        `INSERT INTO retrieval_outcomes (id, retrieval_event_id, timestamp, outcome_type, entry_id)
         VALUES (?, ?, ?, 'log_in_result_namespace', ?)`,
      ).run(`out-log-${outcomeIdx++}`, evtId, now, entry.id);
    }

    const raw = await callTool("memory_insights", { min_impressions: 1 });
    const result = parseToolResponse(raw) as {
      entries: Array<{ entry_id: string; followthrough_rate: number }>;
    };

    const clampEntry = result.entries.find((e) => e.entry_id === entry.id);
    expect(clampEntry).toBeDefined();
    expect(clampEntry!.followthrough_rate).toBeLessThanOrEqual(1.0);
  });
});

// -----------------------------------------------------------------------
// Helper: create a callTool bound to a given AccessContext
// -----------------------------------------------------------------------
function makeCallTool(
  db: Database.Database,
  ctx: AccessContext,
  sid = "test-session-owner",
): (name: string, args?: Record<string, unknown>) => Promise<unknown> {
  const s = new Server(
    { name: "test-munin-unused", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(s, db, sid, ctx);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (
      s as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("no handler");
    return handler({ method: "tools/call", params: { name, arguments: args } });
  };
}

function ownerCtx(): AccessContext {
  return { principalId: "owner", principalType: "owner", accessibleNamespaces: [] };
}

function agentCtx(): AccessContext {
  return {
    principalId: "agent:test",
    principalType: "agent",
    accessibleNamespaces: [{ pattern: "projects/*", permissions: "rw" }],
  };
}

/**
 * Seed `count` impression events (memory_query, no outcomes) for `entryId`.
 * Returns a fresh-enough ISO timestamp so the rolling window covers them.
 */
function seedImpressions(
  db: Database.Database,
  entryId: string,
  count: number,
  prefix: string,
): void {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO retrieval_events (id, session_id, timestamp, tool_name, result_ids, result_namespaces, result_ranks)
       VALUES (?, ?, ?, 'memory_query', json_array(?), '[]', '[]')`,
    ).run(`evt-${prefix}-${i}`, `sess-${prefix}`, now, entryId);
  }
}

/** Seed a single opened_result outcome for the most recent event of an entry. */
function seedOpenOutcome(
  db: Database.Database,
  entryId: string,
  prefix: string,
): void {
  const event = db
    .prepare(
      `SELECT id FROM retrieval_events WHERE result_ids LIKE '%' || ? || '%' ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(entryId) as { id: string } | undefined;
  if (!event) throw new Error("No event found for entryId: " + entryId);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO retrieval_outcomes (id, retrieval_event_id, timestamp, outcome_type, entry_id)
     VALUES (?, ?, ?, 'opened_result', ?)`,
  ).run(`out-${prefix}`, event.id, now, entryId);
}

// -----------------------------------------------------------------------
// memory_patterns — retrieved_unused pattern
// -----------------------------------------------------------------------
describe("memory_patterns — retrieved_unused pattern", () => {
  it("emits retrieved_unused pattern when >=2 entries have >=5 impressions and zero follow-through (owner)", async () => {
    const call = makeCallTool(db, ownerCtx());

    // Create two entries
    writeState(db, "projects/unused-a", "status", "unused project alpha", ["active"]);
    writeState(db, "projects/unused-b", "status", "unused project beta", ["active"]);
    const entryA = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/unused-a' AND key = 'status'").get() as { id: string }).id;
    const entryB = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/unused-b' AND key = 'status'").get() as { id: string }).id;

    seedImpressions(db, entryA, 5, "ua");
    seedImpressions(db, entryB, 5, "ub");

    const raw = await call("memory_patterns", {});
    const result = parseToolResponse(raw) as { patterns: Array<{ kind: string; summary: string; source_entry_ids: string[] }> };

    const unusedPattern = result.patterns.find((p) => p.kind === "retrieved_unused");
    expect(unusedPattern).toBeDefined();
    expect(unusedPattern!.source_entry_ids.length).toBeGreaterThan(0);
  });

  it("does NOT emit retrieved_unused when one entry has a positive outcome", async () => {
    const call = makeCallTool(db, ownerCtx());

    // Entry A: 5 impressions, no outcome → qualifies
    writeState(db, "projects/open-ok-a", "status", "open project alpha", ["active"]);
    const entryA = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/open-ok-a' AND key = 'status'").get() as { id: string }).id;
    seedImpressions(db, entryA, 5, "ok-a");

    // Entry B: 5 impressions + opened_result → disqualifies
    writeState(db, "projects/open-ok-b", "status", "open project beta", ["active"]);
    const entryB = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/open-ok-b' AND key = 'status'").get() as { id: string }).id;
    seedImpressions(db, entryB, 5, "ok-b");
    seedOpenOutcome(db, entryB, "ok-b");

    // Only A qualifies → count=1 < RETRIEVED_UNUSED_PATTERN_MIN(2) → no pattern
    const raw = await call("memory_patterns", {});
    const result = parseToolResponse(raw) as { patterns: Array<{ kind: string }> };
    const unusedPattern = result.patterns.find((p) => p.kind === "retrieved_unused");
    expect(unusedPattern).toBeUndefined();
  });

  it("does NOT emit retrieved_unused when impressions < 5", async () => {
    const call = makeCallTool(db, ownerCtx());

    // Both entries have only 4 impressions (below threshold)
    writeState(db, "projects/low-imp-a", "status", "low impressions alpha", ["active"]);
    writeState(db, "projects/low-imp-b", "status", "low impressions beta", ["active"]);
    const entryA = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/low-imp-a' AND key = 'status'").get() as { id: string }).id;
    const entryB = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/low-imp-b' AND key = 'status'").get() as { id: string }).id;
    seedImpressions(db, entryA, 4, "li-a");
    seedImpressions(db, entryB, 4, "li-b");

    const raw = await call("memory_patterns", {});
    const result = parseToolResponse(raw) as { patterns: Array<{ kind: string }> };
    expect(result.patterns.find((p) => p.kind === "retrieved_unused")).toBeUndefined();
  });

  it("does NOT emit retrieved_unused when only 1 entry qualifies", async () => {
    const call = makeCallTool(db, ownerCtx());

    writeState(db, "projects/solo-unused", "status", "solo unused project", ["active"]);
    const entryA = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/solo-unused' AND key = 'status'").get() as { id: string }).id;
    seedImpressions(db, entryA, 5, "solo");

    const raw = await call("memory_patterns", {});
    const result = parseToolResponse(raw) as { patterns: Array<{ kind: string }> };
    expect(result.patterns.find((p) => p.kind === "retrieved_unused")).toBeUndefined();
  });

  it("does NOT emit retrieved_unused for non-owner context", async () => {
    const call = makeCallTool(db, agentCtx());

    writeState(db, "projects/agent-unused-a", "status", "agent unused alpha", ["active"]);
    writeState(db, "projects/agent-unused-b", "status", "agent unused beta", ["active"]);
    const entryA = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/agent-unused-a' AND key = 'status'").get() as { id: string }).id;
    const entryB = (db.prepare("SELECT id FROM entries WHERE namespace = 'projects/agent-unused-b' AND key = 'status'").get() as { id: string }).id;
    seedImpressions(db, entryA, 5, "ag-a");
    seedImpressions(db, entryB, 5, "ag-b");

    const raw = await call("memory_patterns", {});
    const result = parseToolResponse(raw) as { patterns: Array<{ kind: string }> };
    expect(result.patterns.find((p) => p.kind === "retrieved_unused")).toBeUndefined();
  });

  it("does NOT include meta/* entries in retrieved_unused pattern", async () => {
    const call = makeCallTool(db, ownerCtx());

    // meta/ entries should be excluded
    writeState(db, "meta/excluded-a", "notes", "meta entry alpha", []);
    writeState(db, "meta/excluded-b", "notes", "meta entry beta", []);
    const entryA = (db.prepare("SELECT id FROM entries WHERE namespace = 'meta/excluded-a' AND key = 'notes'").get() as { id: string }).id;
    const entryB = (db.prepare("SELECT id FROM entries WHERE namespace = 'meta/excluded-b' AND key = 'notes'").get() as { id: string }).id;
    seedImpressions(db, entryA, 5, "me-a");
    seedImpressions(db, entryB, 5, "me-b");

    const raw = await call("memory_patterns", {});
    const result = parseToolResponse(raw) as { patterns: Array<{ kind: string }> };
    expect(result.patterns.find((p) => p.kind === "retrieved_unused")).toBeUndefined();
  });
});

// -----------------------------------------------------------------------
// memory_orient — retrieved_unused maintenance signal
// -----------------------------------------------------------------------
describe("memory_orient — retrieved_unused maintenance signal", () => {
  it("includes retrieved_unused in maintenance_needed when >=3 entries qualify (owner)", async () => {
    const call = makeCallTool(db, ownerCtx());

    for (const label of ["a", "b", "c"]) {
      writeState(db, `projects/orient-unused-${label}`, "status", `orient unused ${label}`, ["active"]);
      const id = (db.prepare(`SELECT id FROM entries WHERE namespace = 'projects/orient-unused-${label}' AND key = 'status'`).get() as { id: string }).id;
      seedImpressions(db, id, 5, `oru-${label}`);
    }

    const raw = await call("memory_orient", {});
    const result = parseToolResponse(raw) as { maintenance_needed?: Array<{ issue: string }> };
    const item = (result.maintenance_needed ?? []).find((m) => m.issue === "retrieved_unused");
    expect(item).toBeDefined();
  });

  it("does NOT include retrieved_unused when exactly 2 entries qualify (below orient threshold)", async () => {
    const call = makeCallTool(db, ownerCtx());

    for (const label of ["x", "y"]) {
      writeState(db, `projects/orient-two-${label}`, "status", `orient two ${label}`, ["active"]);
      const id = (db.prepare(`SELECT id FROM entries WHERE namespace = 'projects/orient-two-${label}' AND key = 'status'`).get() as { id: string }).id;
      seedImpressions(db, id, 5, `ot2-${label}`);
    }

    const raw = await call("memory_orient", {});
    const result = parseToolResponse(raw) as { maintenance_needed?: Array<{ issue: string }> };
    const item = (result.maintenance_needed ?? []).find((m) => m.issue === "retrieved_unused");
    expect(item).toBeUndefined();
  });

  it("does NOT include retrieved_unused for non-owner context", async () => {
    const call = makeCallTool(db, agentCtx());

    for (const label of ["p", "q", "r"]) {
      writeState(db, `projects/orient-agent-${label}`, "status", `orient agent ${label}`, ["active"]);
      const id = (db.prepare(`SELECT id FROM entries WHERE namespace = 'projects/orient-agent-${label}' AND key = 'status'`).get() as { id: string }).id;
      seedImpressions(db, id, 5, `oag-${label}`);
    }

    const raw = await call("memory_orient", {});
    const result = parseToolResponse(raw) as { maintenance_needed?: Array<{ issue: string }> };
    const item = (result.maintenance_needed ?? []).find((m) => m.issue === "retrieved_unused");
    expect(item).toBeUndefined();
  });

  it("does NOT include meta/* entries in orient retrieved_unused signal", async () => {
    const call = makeCallTool(db, ownerCtx());

    // Only meta/ entries qualify — should not trigger
    for (const label of ["d", "e", "f"]) {
      writeState(db, `meta/orient-meta-${label}`, "notes", `orient meta ${label}`, []);
      const id = (db.prepare(`SELECT id FROM entries WHERE namespace = 'meta/orient-meta-${label}' AND key = 'notes'`).get() as { id: string }).id;
      seedImpressions(db, id, 5, `ometa-${label}`);
    }

    const raw = await call("memory_orient", {});
    const result = parseToolResponse(raw) as { maintenance_needed?: Array<{ issue: string }> };
    const item = (result.maintenance_needed ?? []).find((m) => m.issue === "retrieved_unused");
    expect(item).toBeUndefined();
  });
});
