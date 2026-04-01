import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase, writeState, appendLog, executeDelete, getAuditHistory } from "../src/db.js";
import { registerTools } from "../src/tools.js";

const TEST_DB_PATH = "/tmp/munin-memory-history-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

let db: Database.Database;

// Helper to call a tool handler through the server
async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
  if (handler) {
    return handler({ method: "tools/call", params: { name, arguments: args } });
  }
  throw new Error("Cannot access tool handler");
}

function parseToolResponse(response: unknown): unknown {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

// --- Unit tests for getAuditHistory ---

describe("getAuditHistory — empty log", () => {
  it("returns empty array when audit log is empty", () => {
    const result = getAuditHistory(db, {});
    expect(result).toEqual([]);
  });
});

describe("getAuditHistory — basic retrieval", () => {
  it("returns audit rows after writes and log appends", () => {
    writeState(db, "projects/alpha", "status", "active", ["active"]);
    appendLog(db, "projects/alpha", "started the project", []);

    const result = getAuditHistory(db, {});
    expect(result.length).toBe(2);

    // Most recent first
    const actions = result.map((e) => e.action);
    expect(actions).toContain("write");
    expect(actions).toContain("log_append");
  });

  it("audit rows have expected fields", () => {
    writeState(db, "projects/alpha", "status", "active", []);
    const result = getAuditHistory(db, {});
    expect(result.length).toBe(1);
    const row = result[0];
    expect(row.id).toBeTypeOf("number");
    expect(row.timestamp).toBeTypeOf("string");
    expect(row.agent_id).toBe("default");
    expect(row.action).toBe("write");
    expect(row.namespace).toBe("projects/alpha");
    expect(row.key).toBe("status");
    expect(row.detail).toBeNull();
  });

  it("records update action on overwrite", () => {
    writeState(db, "projects/alpha", "status", "v1", []);
    writeState(db, "projects/alpha", "status", "v2", []);

    const result = getAuditHistory(db, {});
    expect(result.length).toBe(2);
    const actions = result.map((e) => e.action);
    expect(actions).toContain("write");
    expect(actions).toContain("update");
  });

  it("records delete action", () => {
    writeState(db, "projects/alpha", "status", "v1", []);
    executeDelete(db, "projects/alpha", "status");

    const result = getAuditHistory(db, {});
    const actions = result.map((e) => e.action);
    expect(actions).toContain("delete");
  });

  it("records delete_namespace action for namespace delete", () => {
    writeState(db, "projects/alpha", "status", "v1", []);
    executeDelete(db, "projects/alpha");

    const result = getAuditHistory(db, {});
    const actions = result.map((e) => e.action);
    expect(actions).toContain("namespace_delete");
  });
});

describe("getAuditHistory — namespace filter", () => {
  beforeEach(() => {
    writeState(db, "projects/alpha", "status", "alpha status", []);
    writeState(db, "projects/beta", "status", "beta status", []);
    appendLog(db, "people/magnus", "a log entry", []);
  });

  it("exact namespace match returns only that namespace", () => {
    const result = getAuditHistory(db, { namespace: "projects/alpha" });
    expect(result.length).toBe(1);
    expect(result[0].namespace).toBe("projects/alpha");
  });

  it("prefix match with trailing slash returns all children", () => {
    const result = getAuditHistory(db, { namespace: "projects/" });
    expect(result.length).toBe(2);
    const namespaces = result.map((e) => e.namespace);
    expect(namespaces).toContain("projects/alpha");
    expect(namespaces).toContain("projects/beta");
  });

  it("exact namespace with children also matches children", () => {
    writeState(db, "projects/alpha/subns", "status", "sub status", []);
    const result = getAuditHistory(db, { namespace: "projects/alpha" });
    // Should match projects/alpha (exact) AND projects/alpha/subns (prefix)
    expect(result.length).toBe(2);
    const namespaces = result.map((e) => e.namespace);
    expect(namespaces).toContain("projects/alpha");
    expect(namespaces).toContain("projects/alpha/subns");
  });

  it("namespace filter excludes other namespaces", () => {
    const result = getAuditHistory(db, { namespace: "people/magnus" });
    expect(result.length).toBe(1);
    expect(result[0].namespace).toBe("people/magnus");
  });
});

describe("getAuditHistory — since filter", () => {
  it("only returns entries at or after the given timestamp", async () => {
    writeState(db, "projects/alpha", "status", "first", []);
    const midpoint = new Date().toISOString();
    // Small pause to ensure timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    writeState(db, "projects/alpha", "notes", "second", []);

    const result = getAuditHistory(db, { since: midpoint });
    // Should include 'second' write but not 'first' (which occurred before midpoint)
    // Note: timestamp comparison is >= so we may get both if they share a millisecond;
    // assert at least one and all are at or after midpoint
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const row of result) {
      expect(row.timestamp >= midpoint).toBe(true);
    }
  });

  it("throws on invalid since value", () => {
    expect(() =>
      getAuditHistory(db, { since: "not-a-date" }),
    ).toThrow(/Invalid "since" value/);
  });
});

describe("getAuditHistory — action filter", () => {
  beforeEach(() => {
    writeState(db, "projects/alpha", "status", "v1", []);
    writeState(db, "projects/alpha", "status", "v2", []); // update
    appendLog(db, "projects/alpha", "a log entry", []);
  });

  it("filters to only 'write' actions", () => {
    const result = getAuditHistory(db, { action: "write" });
    expect(result.length).toBe(1);
    expect(result[0].action).toBe("write");
  });

  it("filters to only 'update' actions", () => {
    const result = getAuditHistory(db, { action: "update" });
    expect(result.length).toBe(1);
    expect(result[0].action).toBe("update");
  });

  it("filters to only 'log_append' actions", () => {
    const result = getAuditHistory(db, { action: "log_append" });
    expect(result.length).toBe(1);
    expect(result[0].action).toBe("log_append");
  });

  it("accepts legacy log alias and normalizes to canonical action", () => {
    const result = getAuditHistory(db, { action: "log" });
    expect(result.length).toBe(1);
    expect(result[0].action).toBe("log_append");
  });
});

describe("getAuditHistory — combined filters", () => {
  it("namespace + action combined filter works", () => {
    writeState(db, "projects/alpha", "status", "alpha", []);
    writeState(db, "projects/beta", "status", "beta", []);
    appendLog(db, "projects/alpha", "a log", []);

    const result = getAuditHistory(db, { namespace: "projects/alpha", action: "write" });
    expect(result.length).toBe(1);
    expect(result[0].namespace).toBe("projects/alpha");
    expect(result[0].action).toBe("write");
  });

  it("namespace + since combined filter works", async () => {
    writeState(db, "projects/alpha", "status", "v1", []);
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    writeState(db, "projects/alpha", "notes", "v1", []);
    writeState(db, "projects/beta", "status", "v1", []);

    const result = getAuditHistory(db, { namespace: "projects/alpha", since: midpoint });
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const row of result) {
      expect(row.namespace).toBe("projects/alpha");
      expect(row.timestamp >= midpoint).toBe(true);
    }
  });
});

describe("getAuditHistory — limit", () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) {
      writeState(db, `projects/ns${i}`, "status", `content ${i}`, []);
    }
  });

  it("respects limit and returns most recent first", () => {
    const result = getAuditHistory(db, { limit: 3 });
    expect(result.length).toBe(3);
    // Most recent first: timestamps should be descending
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].timestamp >= result[i + 1].timestamp).toBe(true);
    }
  });

  it("default limit is 20", () => {
    // Insert 25 entries total
    for (let i = 10; i < 25; i++) {
      writeState(db, `projects/extra${i}`, "status", `content ${i}`, []);
    }
    const result = getAuditHistory(db, {});
    expect(result.length).toBe(20);
  });
});

describe("getAuditHistory — limit clamping", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      writeState(db, `projects/clamp${i}`, "status", "x", []);
    }
  });

  it("values > 100 are clamped to 100", () => {
    // Can't exceed available rows in this test but limit should not throw
    const result = getAuditHistory(db, { limit: 999 });
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("values < 1 are clamped to 1", () => {
    const result = getAuditHistory(db, { limit: 0 });
    expect(result.length).toBe(1);
  });

  it("negative values are clamped to 1", () => {
    const result = getAuditHistory(db, { limit: -5 });
    expect(result.length).toBe(1);
  });
});

// --- Tool handler integration tests ---

describe("memory_history tool handler", () => {
  let server: Server;

  beforeEach(() => {
    server = new Server(
      { name: "test-munin-history", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, db);
  });

  it("returns correct response shape", async () => {
    writeState(db, "projects/test", "status", "active", ["active"]);

    const raw = await callTool(server, "memory_history", {});
    const result = parseToolResponse(raw) as {
      generated_at: string;
      count: number;
      entries: Array<{ provenance: { principal_id: string } }>;
      next_cursor: number | null;
      has_more: boolean;
    };

    expect(result.generated_at).toBeTypeOf("string");
    expect(result.count).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provenance.principal_id).toBe("default");
    expect(typeof result.next_cursor).toBe("number");
    expect(result.has_more).toBe(false);
  });

  it("returns empty result when no writes have been made", async () => {
    const raw = await callTool(server, "memory_history", {});
    const result = parseToolResponse(raw) as { count: number; entries: unknown[] };
    expect(result.count).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it("write then history: write appears in audit trail", async () => {
    // Use the tool handler for the write
    const writeServer = new Server(
      { name: "test-munin-write", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(writeServer, db);

    await callTool(writeServer, "memory_write", {
      namespace: "projects/myproject",
      key: "status",
      content: "project is running",
    });

    const raw = await callTool(server, "memory_history", {
      namespace: "projects/myproject",
    });
    const result = parseToolResponse(raw) as {
      count: number;
      entries: Array<{ namespace: string; action: string; key: string }>;
    };

    expect(result.count).toBe(1);
    expect(result.entries[0].namespace).toBe("projects/myproject");
    expect(result.entries[0].action).toBe("write");
    expect(result.entries[0].key).toBe("status");
  });

  it("namespace filter works through tool handler", async () => {
    writeState(db, "projects/alpha", "status", "a", []);
    writeState(db, "projects/beta", "status", "b", []);

    const raw = await callTool(server, "memory_history", {
      namespace: "projects/alpha",
    });
    const result = parseToolResponse(raw) as {
      count: number;
      entries: Array<{ namespace: string }>;
    };

    expect(result.count).toBe(1);
    expect(result.entries[0].namespace).toBe("projects/alpha");
  });

  it("action filter works through tool handler", async () => {
    writeState(db, "projects/alpha", "status", "v1", []);
    writeState(db, "projects/alpha", "status", "v2", []);

    const raw = await callTool(server, "memory_history", { action: "update" });
    const result = parseToolResponse(raw) as {
      count: number;
      entries: Array<{ action: string }>;
    };

    expect(result.count).toBe(1);
    expect(result.entries[0].action).toBe("update");
  });

  it("invalid since returns error", async () => {
    const raw = await callTool(server, "memory_history", { since: "not-a-date" });
    const result = parseToolResponse(raw) as { error: string; message: string };
    expect(result.error).toBe("internal_error");
    expect(result.message).toContain("Invalid");
  });

  it("limit parameter is respected through tool handler", async () => {
    for (let i = 0; i < 10; i++) {
      writeState(db, `projects/lim${i}`, "status", "x", []);
    }

    const raw = await callTool(server, "memory_history", { limit: 3 });
    const result = parseToolResponse(raw) as { count: number; entries: unknown[] };
    expect(result.count).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it("supports cursor-based forward sync with canonical actions", async () => {
    writeState(db, "projects/sync", "status", "v1", []);
    appendLog(db, "projects/sync", "progress", []);

    const firstRaw = await callTool(server, "memory_history", {
      namespace: "projects/sync",
      cursor: 0,
      limit: 10,
    });
    const first = parseToolResponse(firstRaw) as {
      entries: Array<{ id: number; action: string }>;
      next_cursor: number | null;
      has_more: boolean;
    };

    expect(first.entries).toHaveLength(2);
    expect(first.entries[0].action).toBe("write");
    expect(first.entries[1].action).toBe("log_append");
    expect(first.next_cursor).toBe(first.entries[1].id);
    expect(first.has_more).toBe(false);

    writeState(db, "projects/sync", "status", "v2", []);

    const secondRaw = await callTool(server, "memory_history", {
      namespace: "projects/sync",
      cursor: first.next_cursor,
      limit: 10,
    });
    const second = parseToolResponse(secondRaw) as {
      entries: Array<{ action: string }>;
      next_cursor: number | null;
    };

    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].action).toBe("update");
    expect(second.next_cursor).not.toBe(first.next_cursor);
  });
});
