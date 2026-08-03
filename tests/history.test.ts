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
    expect(row.detail).toBe("active");
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
    appendLog(db, "people/owner", "a log entry", []);
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

  it("matches namespace filters case-sensitively", () => {
    writeState(db, "Projects/Alpha", "status", "upper status", []);
    writeState(db, "Projects/Alpha/Sub", "status", "upper child", []);
    writeState(db, "projects/alpha/sub-lower", "status", "lower child", []);

    const result = getAuditHistory(db, { namespace: "Projects/Alpha" });

    expect(result.map((e) => e.namespace).sort()).toEqual(["Projects/Alpha", "Projects/Alpha/Sub"]);
  });

  it("namespace filter excludes other namespaces", () => {
    const result = getAuditHistory(db, { namespace: "people/owner" });
    expect(result.length).toBe(1);
    expect(result[0].namespace).toBe("people/owner");
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
      entries: Array<{ id: number; provenance: { principal_id: string } }>;
      next_cursor: number | null;
      sync_cursor: number | null;
      has_more: boolean;
      older_cursor: number | null;
      has_older: boolean;
      has_newer: boolean;
    };

    expect(result.generated_at).toBeTypeOf("string");
    expect(result.count).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provenance.principal_id).toBe("default");
    expect(result.next_cursor).toBeNull();
    expect(result.older_cursor).toBeNull();
    expect(result.sync_cursor).toBe(result.entries[0].id);
    expect(result.has_more).toBe(false);
    expect(result.has_older).toBe(false);
    expect(result.has_newer).toBe(false);
  });

  it("returns empty result when no writes have been made", async () => {
    const raw = await callTool(server, "memory_history", {});
    const result = parseToolResponse(raw) as { count: number; entries: unknown[]; sync_cursor: number | null };
    expect(result.count).toBe(0);
    expect(result.entries).toHaveLength(0);
    expect(result.sync_cursor).toBe(0);
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

  it("trailing-slash namespace filters stay descendant-only through the tool handler", async () => {
    writeState(db, "projects/root", "status", "parent", []);
    writeState(db, "projects/root/sub", "status", "child", []);

    const raw = await callTool(server, "memory_history", {
      namespace: "projects/root/",
    });
    const result = parseToolResponse(raw) as {
      count: number;
      entries: Array<{ namespace: string }>;
    };

    expect(result.count).toBe(1);
    expect(result.entries.map((entry) => entry.namespace)).toEqual(["projects/root/sub"]);
  });

  it("namespace filters stay case-sensitive through the tool handler", async () => {
    writeState(db, "Projects/Alpha", "status", "upper parent", []);
    writeState(db, "Projects/Alpha/Sub", "status", "upper child", []);
    writeState(db, "projects/alpha/sub-lower", "status", "lower child", []);

    const raw = await callTool(server, "memory_history", {
      namespace: "Projects/Alpha",
    });
    const result = parseToolResponse(raw) as {
      count: number;
      entries: Array<{ namespace: string }>;
    };

    expect(result.count).toBe(2);
    expect(result.entries.map((entry) => entry.namespace).sort()).toEqual([
      "Projects/Alpha",
      "Projects/Alpha/Sub",
    ]);
  });

  it("bare namespace filters keep emoji descendants through the tool handler", async () => {
    writeState(db, "projects/emoji", "status", "parent", []);
    writeState(db, "projects/emoji-child-temp", "status", "child", []);
    writeState(db, "projects/emoji-grandchild-temp", "status", "grandchild", []);
    writeState(db, "projects/emoji-outside-temp", "status", "outside", []);
    db.prepare("UPDATE entries SET namespace = ? WHERE namespace = ? AND key = ?").run(
      "projects/emoji/😀",
      "projects/emoji-child-temp",
      "status",
    );
    db.prepare("UPDATE entries SET namespace = ? WHERE namespace = ? AND key = ?").run(
      "projects/emoji/😀/deep",
      "projects/emoji-grandchild-temp",
      "status",
    );
    db.prepare("UPDATE entries SET namespace = ? WHERE namespace = ? AND key = ?").run(
      "projects/emojiish/😀",
      "projects/emoji-outside-temp",
      "status",
    );
    db.prepare("UPDATE audit_log SET namespace = ? WHERE namespace = ? AND key = ?").run(
      "projects/emoji/😀",
      "projects/emoji-child-temp",
      "status",
    );
    db.prepare("UPDATE audit_log SET namespace = ? WHERE namespace = ? AND key = ?").run(
      "projects/emoji/😀/deep",
      "projects/emoji-grandchild-temp",
      "status",
    );
    db.prepare("UPDATE audit_log SET namespace = ? WHERE namespace = ? AND key = ?").run(
      "projects/emojiish/😀",
      "projects/emoji-outside-temp",
      "status",
    );

    const raw = await callTool(server, "memory_history", {
      namespace: "projects/emoji",
    });
    const result = parseToolResponse(raw) as {
      count: number;
      entries: Array<{ namespace: string }>;
    };

    expect(result.count).toBe(3);
    expect(result.entries.map((entry) => entry.namespace).sort()).toEqual([
      "projects/emoji",
      "projects/emoji/😀",
      "projects/emoji/😀/deep",
    ]);
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

  it("supports explicit older paging for cursorless newest-first pages", async () => {
    for (let i = 0; i < 5; i++) {
      writeState(db, `projects/older-${i}`, "status", `v${i}`, []);
    }

    const firstRaw = await callTool(server, "memory_history", { limit: 2 });
    const first = parseToolResponse(firstRaw) as {
      entries: Array<{ id: number }>;
      next_cursor: number | null;
      older_cursor: number | null;
      sync_cursor: number | null;
      has_more: boolean;
      has_older: boolean;
      has_newer: boolean;
    };

    expect(first.entries).toHaveLength(2);
    expect(first.entries[0].id).toBeGreaterThan(first.entries[1].id);
    expect(first.next_cursor).toBeNull();
    expect(first.has_more).toBe(true);
    expect(first.has_older).toBe(true);
    expect(first.has_newer).toBe(false);
    expect(first.sync_cursor).toBe(first.entries[0].id);
    expect(first.older_cursor).toBe(first.entries[1].id);

    const secondRaw = await callTool(server, "memory_history", {
      limit: 2,
      older_cursor: first.older_cursor,
    });
    const second = parseToolResponse(secondRaw) as {
      entries: Array<{ id: number }>;
      older_cursor: number | null;
      sync_cursor: number | null;
      has_more: boolean;
      has_older: boolean;
      has_newer: boolean;
      next_cursor: number | null;
    };

    expect(second.entries).toHaveLength(2);
    expect(second.entries[0].id).toBeLessThan(first.entries[1].id);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(4);
    expect(second.next_cursor).toBeNull();
    expect(second.has_more).toBe(true);
    expect(second.has_older).toBe(true);
    expect(second.has_newer).toBe(true);
    expect(second.sync_cursor).toBeNull();
    expect(second.older_cursor).toBe(second.entries[1].id);
  });

  it("returns writes after the initial watermark when paging older history", async () => {
    for (let i = 0; i < 5; i++) {
      writeState(db, `projects/watermark-${i}`, "status", `v${i}`, []);
    }

    const first = parseToolResponse(await callTool(server, "memory_history", { limit: 2 })) as {
      entries: Array<{ id: number }>;
      older_cursor: number | null;
      sync_cursor: number | null;
    };
    expect(first.sync_cursor).toBe(first.entries[0].id);

    writeState(db, "projects/watermark-between", "status", "new after first page", []);

    const older = parseToolResponse(await callTool(server, "memory_history", {
      limit: 2,
      older_cursor: first.older_cursor,
    })) as {
      sync_cursor: number | null;
      entries: Array<{ id: number }>;
    };
    expect(older.sync_cursor).toBeNull();

    const sync = parseToolResponse(await callTool(server, "memory_history", {
      cursor: first.sync_cursor,
      limit: 10,
    })) as {
      entries: Array<{ id: number; namespace: string }>;
      next_cursor: number | null;
      sync_cursor: number | null;
    };

    expect(sync.entries.map((entry) => entry.namespace)).toContain("projects/watermark-between");
    expect(sync.next_cursor).toBe(sync.sync_cursor);
  });

  it("returns an older visible row even when newer hidden history exists", async () => {
    const exactParentServer = new Server(
      { name: "test-munin-history-exact-parent", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(exactParentServer, db, undefined, {
      principalId: "auditor",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "projects/reports", permissions: "read" }],
    });

    writeState(db, "projects/reports", "status", "visible parent", []);
    writeState(db, "projects/reports/private", "status", "hidden newer child", []);

    const result = parseToolResponse(await callTool(exactParentServer, "memory_history", {
      namespace: "projects/reports",
      limit: 1,
    })) as {
      count: number;
      entries: Array<{ id: number; namespace: string }>;
      sync_cursor: number | null;
      older_cursor: number | null;
      has_more: boolean;
      has_older: boolean;
    };

    expect(result.count).toBe(1);
    expect(result.entries.map((entry) => entry.namespace)).toEqual(["projects/reports"]);
    expect(result.sync_cursor).toBe(result.entries[0].id);
    expect(result.older_cursor).toBeNull();
    expect(result.has_more).toBe(false);
    expect(result.has_older).toBe(false);
  });

  it("does not advance forward sync cursors for hidden activity", async () => {
    const exactParentServer = new Server(
      { name: "test-munin-history-exact-parent-sync", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(exactParentServer, db, undefined, {
      principalId: "auditor",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "projects/reports", permissions: "read" }],
    });

    writeState(db, "projects/reports", "status", "visible parent", []);
    const initial = parseToolResponse(await callTool(exactParentServer, "memory_history", {
      namespace: "projects/reports",
      limit: 10,
    })) as {
      sync_cursor: number;
      entries: Array<{ namespace: string }>;
    };
    expect(initial.entries.map((entry) => entry.namespace)).toEqual(["projects/reports"]);

    writeState(db, "projects/reports/private", "status", "hidden child update", []);

    const sync = parseToolResponse(await callTool(exactParentServer, "memory_history", {
      namespace: "projects/reports",
      cursor: initial.sync_cursor,
      limit: 10,
    })) as {
      count: number;
      entries: Array<{ namespace: string }>;
      next_cursor: number | null;
      sync_cursor: number | null;
      has_more: boolean;
      has_newer: boolean;
    };

    expect(sync.count).toBe(0);
    expect(sync.entries).toEqual([]);
    expect(sync.next_cursor).toBe(initial.sync_cursor);
    expect(sync.sync_cursor).toBe(initial.sync_cursor);
    expect(sync.has_more).toBe(false);
    expect(sync.has_newer).toBe(false);
  });

  it("does not advertise another older page when only hidden older rows remain", async () => {
    const restrictedServer = new Server(
      { name: "test-munin-history-restricted", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(restrictedServer, db, undefined, {
      principalId: "family",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "shared/family/*", permissions: "rw" }],
    });

    writeState(db, "projects/private-older", "status", "hidden", []);
    writeState(db, "shared/family/visible-middle", "status", "middle", []);
    writeState(db, "shared/family/visible-newest", "status", "newest", []);

    const first = parseToolResponse(await callTool(restrictedServer, "memory_history", { limit: 2 })) as {
      count: number;
      entries: Array<{ id: number; namespace: string }>;
      older_cursor: number | null;
      has_more: boolean;
      has_older: boolean;
    };

    expect(first.count).toBe(2);
    expect(first.entries.map((entry) => entry.namespace)).toEqual([
      "shared/family/visible-newest",
      "shared/family/visible-middle",
    ]);
    expect(first.older_cursor).toBeNull();
    expect(first.has_more).toBe(false);
    expect(first.has_older).toBe(false);
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
      sync_cursor: number | null;
      has_more: boolean;
      older_cursor: number | null;
      has_newer: boolean;
    };

    expect(first.entries).toHaveLength(2);
    expect(first.entries[0].action).toBe("write");
    expect(first.entries[1].action).toBe("log");
    expect(first.next_cursor).toBe(first.entries[1].id);
    expect(first.sync_cursor).toBe(first.entries[1].id);
    expect(first.has_more).toBe(false);
    expect(first.older_cursor).toBeNull();
    expect(first.has_newer).toBe(false);

    writeState(db, "projects/sync", "status", "v2", []);

    const secondRaw = await callTool(server, "memory_history", {
      namespace: "projects/sync",
      cursor: first.next_cursor,
      limit: 10,
    });
    const second = parseToolResponse(secondRaw) as {
      entries: Array<{ action: string }>;
      next_cursor: number | null;
      sync_cursor: number | null;
      has_newer: boolean;
      older_cursor: number | null;
    };

    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].action).toBe("update");
    expect(second.next_cursor).not.toBe(first.next_cursor);
    expect(second.sync_cursor).toBe(second.next_cursor);
    expect(second.has_newer).toBe(false);
    expect(second.older_cursor).toBeNull();
  });

  it("preserves the input sync cursor on an empty sync page", async () => {
    const raw = await callTool(server, "memory_history", {
      namespace: "projects/empty-sync",
      cursor: 1234,
      limit: 10,
    });
    const result = parseToolResponse(raw) as {
      entries: unknown[];
      next_cursor: number | null;
      sync_cursor: number | null;
      has_newer: boolean;
    };

    expect(result.entries).toEqual([]);
    expect(result.next_cursor).toBe(1234);
    expect(result.sync_cursor).toBe(1234);
    expect(result.has_newer).toBe(false);
  });

  it("rejects mutually exclusive cursor directions", async () => {
    const raw = await callTool(server, "memory_history", {
      cursor: 1,
      older_cursor: 2,
    });
    const result = parseToolResponse(raw) as { ok: boolean; error?: string; message?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("validation_error");
    expect(result.message).toContain("mutually exclusive");
  });
});
