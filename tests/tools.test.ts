import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";

const TEST_DB_PATH = "/tmp/munin-memory-tools-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

let db: Database.Database;
let server: Server;

// Helper to call a tool handler directly through the server's request handler
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  // Access the registered handler by simulating a tools/call request
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
  if (handler) {
    const result = await handler({ method: "tools/call", params: { name, arguments: args } });
    return result;
  }

  // Fallback: use the internal method if available
  throw new Error("Cannot access tool handler");
}

function parseToolResponse(response: unknown): unknown {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  server = new Server(
    { name: "test-munin", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db);
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

describe("memory_write", () => {
  it("creates a new state entry", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Active and running",
      tags: ["active"],
    });
    const result = parseToolResponse(raw) as { status: string; id: string; namespace: string; key: string; hint: string };
    expect(result.status).toBe("created");
    expect(result.id).toBeTruthy();
    expect(result.namespace).toBe("projects/test");
    expect(result.key).toBe("status");
    expect(result.hint).toContain("first entry");
  });

  it("updates existing entry and shows related entries in hint", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "v1",
    });
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "architecture",
      content: "monolith",
    });
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "v2",
    });
    const result = parseToolResponse(raw) as { status: string; hint: string };
    expect(result.status).toBe("updated");
    expect(result.hint).toContain("architecture");
  });

  it("rejects invalid namespace", async () => {
    const raw = await callTool("memory_write", {
      namespace: "/bad",
      key: "status",
      content: "test",
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });

  it("rejects content with secrets", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "config",
      content: "api_key: sk-abcdefghijklmnopqrstuvwxyz",
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });
});

describe("memory_read", () => {
  it("reads an existing entry", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "All good",
      tags: ["active"],
    });
    const raw = await callTool("memory_read", {
      namespace: "projects/test",
      key: "status",
    });
    const result = parseToolResponse(raw) as { found: boolean; content: string; tags: string[] };
    expect(result.found).toBe(true);
    expect(result.content).toBe("All good");
    expect(result.tags).toEqual(["active"]);
  });

  it("returns not found for missing entry", async () => {
    const raw = await callTool("memory_read", {
      namespace: "projects/test",
      key: "nope",
    });
    const result = parseToolResponse(raw) as { found: boolean; message: string };
    expect(result.found).toBe(false);
    expect(result.message).toContain("No state entry found");
  });
});

describe("memory_get", () => {
  it("retrieves entry by ID", async () => {
    const writeRaw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Active",
    });
    const writeResult = parseToolResponse(writeRaw) as { id: string };

    const raw = await callTool("memory_get", { id: writeResult.id });
    const result = parseToolResponse(raw) as { found: boolean; content: string; entry_type: string };
    expect(result.found).toBe(true);
    expect(result.content).toBe("Active");
    expect(result.entry_type).toBe("state");
  });

  it("retrieves log entry by ID", async () => {
    const logRaw = await callTool("memory_log", {
      namespace: "projects/test",
      content: "Something happened",
    });
    const logResult = parseToolResponse(logRaw) as { id: string };

    const raw = await callTool("memory_get", { id: logResult.id });
    const result = parseToolResponse(raw) as { found: boolean; entry_type: string };
    expect(result.found).toBe(true);
    expect(result.entry_type).toBe("log");
  });

  it("returns not found for unknown ID", async () => {
    const raw = await callTool("memory_get", { id: "nonexistent" });
    const result = parseToolResponse(raw) as { found: boolean };
    expect(result.found).toBe(false);
  });
});

describe("memory_query", () => {
  beforeEach(async () => {
    await callTool("memory_write", {
      namespace: "projects/alpha",
      key: "status",
      content: "Building a SQLite memory server",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/beta",
      key: "status",
      content: "Designing a web application",
      tags: ["active"],
    });
    await callTool("memory_log", {
      namespace: "projects/alpha",
      content: "Chose SQLite over PostgreSQL",
      tags: ["decision"],
    });
  });

  it("searches by keyword", async () => {
    const raw = await callTool("memory_query", { query: "SQLite" });
    const result = parseToolResponse(raw) as { results: unknown[]; total: number; search_mode: string };
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it("defaults search_mode to hybrid (degrades to lexical in test env)", async () => {
    const raw = await callTool("memory_query", { query: "SQLite" });
    const result = parseToolResponse(raw) as { search_mode: string; search_mode_actual?: string };
    expect(result.search_mode).toBe("hybrid");
    // In test env without embedding model, degrades to lexical
    expect(result.search_mode_actual).toBe("lexical");
  });

  it("degrades semantic to lexical when unavailable", async () => {
    const raw = await callTool("memory_query", { query: "SQLite", search_mode: "semantic" });
    const result = parseToolResponse(raw) as { search_mode: string; search_mode_actual?: string; warning?: string };
    // In test environment without embedding model loaded, should degrade
    expect(result.search_mode).toBe("semantic");
    if (result.search_mode_actual) {
      expect(result.search_mode_actual).toBe("lexical");
      expect(result.warning).toBeTruthy();
    }
  });

  it("filters by namespace", async () => {
    const raw = await callTool("memory_query", {
      query: "SQLite",
      namespace: "projects/alpha",
    });
    const result = parseToolResponse(raw) as { results: Array<{ namespace: string }> };
    expect(result.results.every((r) => r.namespace === "projects/alpha")).toBe(true);
  });

  it("filters by entry type", async () => {
    const raw = await callTool("memory_query", {
      query: "SQLite",
      entry_type: "log",
    });
    const result = parseToolResponse(raw) as { results: Array<{ entry_type: string }> };
    expect(result.results.every((r) => r.entry_type === "log")).toBe(true);
  });

  it("returns empty results for no match", async () => {
    const raw = await callTool("memory_query", { query: "xyznonexistent" });
    const result = parseToolResponse(raw) as { total: number };
    expect(result.total).toBe(0);
  });
});

describe("memory_log", () => {
  it("appends a log entry", async () => {
    const raw = await callTool("memory_log", {
      namespace: "projects/test",
      content: "Started implementation",
      tags: ["milestone"],
    });
    const result = parseToolResponse(raw) as { status: string; id: string; timestamp: string };
    expect(result.status).toBe("logged");
    expect(result.id).toBeTruthy();
    expect(result.timestamp).toBeTruthy();
  });

  it("rejects invalid namespace", async () => {
    const raw = await callTool("memory_log", {
      namespace: "",
      content: "test",
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });
});

describe("memory_list", () => {
  it("lists all namespaces", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "people/magnus", key: "prefs", content: "c" });

    const raw = await callTool("memory_list", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    expect(result.namespaces).toHaveLength(2);
  });

  it("includes last_activity_at per namespace", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "s", content: "c" });

    const raw = await callTool("memory_list", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string; last_activity_at: string }> };
    expect(result.namespaces[0].last_activity_at).toBeDefined();
    expect(result.namespaces[0].last_activity_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("lists namespace contents", async () => {
    await callTool("memory_write", { namespace: "projects/test", key: "status", content: "active" });
    await callTool("memory_write", { namespace: "projects/test", key: "arch", content: "mono" });
    await callTool("memory_log", { namespace: "projects/test", content: "day 1" });

    const raw = await callTool("memory_list", { namespace: "projects/test" });
    const result = parseToolResponse(raw) as {
      state_entries: Array<{ key: string }>;
      log_summary: { count: number };
    };
    expect(result.state_entries).toHaveLength(2);
    expect(result.log_summary.log_count).toBe(1);
  });
});

describe("memory_delete", () => {
  it("previews deletion and returns token", async () => {
    await callTool("memory_write", { namespace: "projects/test", key: "status", content: "c" });

    const raw = await callTool("memory_delete", {
      namespace: "projects/test",
      key: "status",
    });
    const result = parseToolResponse(raw) as {
      action: string;
      delete_token: string;
      will_delete: { state_count: number };
    };
    expect(result.action).toBe("preview");
    expect(result.delete_token).toBeTruthy();
    expect(result.will_delete.state_count).toBe(1);
  });

  it("executes deletion with valid token", async () => {
    await callTool("memory_write", { namespace: "projects/test", key: "status", content: "c" });

    const previewRaw = await callTool("memory_delete", {
      namespace: "projects/test",
      key: "status",
    });
    const preview = parseToolResponse(previewRaw) as { delete_token: string };

    const deleteRaw = await callTool("memory_delete", {
      namespace: "projects/test",
      key: "status",
      delete_token: preview.delete_token,
    });
    const deleteResult = parseToolResponse(deleteRaw) as { action: string; deleted_count: number };
    expect(deleteResult.action).toBe("deleted");
    expect(deleteResult.deleted_count).toBe(1);

    // Verify it's gone
    const readRaw = await callTool("memory_read", { namespace: "projects/test", key: "status" });
    const readResult = parseToolResponse(readRaw) as { found: boolean };
    expect(readResult.found).toBe(false);
  });

  it("rejects invalid token", async () => {
    await callTool("memory_write", { namespace: "projects/test", key: "status", content: "c" });

    const raw = await callTool("memory_delete", {
      namespace: "projects/test",
      key: "status",
      delete_token: "invalid-token",
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("invalid_token");
  });

  it("rejects token used for wrong namespace", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "projects/b", key: "s", content: "c" });

    const previewRaw = await callTool("memory_delete", {
      namespace: "projects/a",
      key: "s",
    });
    const preview = parseToolResponse(previewRaw) as { delete_token: string };

    // Try to use token for a different namespace
    const raw = await callTool("memory_delete", {
      namespace: "projects/b",
      key: "s",
      delete_token: preview.delete_token,
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("invalid_token");
  });

  it("previews full namespace deletion", async () => {
    await callTool("memory_write", { namespace: "projects/test", key: "a", content: "c" });
    await callTool("memory_write", { namespace: "projects/test", key: "b", content: "c" });
    await callTool("memory_log", { namespace: "projects/test", content: "event" });

    const raw = await callTool("memory_delete", { namespace: "projects/test" });
    const result = parseToolResponse(raw) as {
      will_delete: { state_count: number; log_count: number };
    };
    expect(result.will_delete.state_count).toBe(2);
    expect(result.will_delete.log_count).toBe(1);
  });
});

describe("memory_orient", () => {
  it("returns conventions, workbench, and namespaces when all exist", async () => {
    await callTool("memory_write", {
      namespace: "meta/conventions",
      key: "conventions",
      content: "# Conventions\nUse memory_orient first.",
      tags: ["governance"],
    });
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n## Active\n- projects/test",
      tags: ["index"],
    });
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Active",
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      conventions: { content: string; updated_at: string };
      workbench: { content: string; updated_at: string };
      namespaces: Array<{ namespace: string; state_count: number; log_count: number; last_activity_at: string }>;
    };

    expect(result.conventions.content).toContain("# Conventions");
    expect(result.conventions.updated_at).toBeTruthy();
    expect(result.workbench.content).toContain("# Workbench");
    expect(result.workbench.updated_at).toBeTruthy();
    expect(result.namespaces).toHaveLength(3);
    expect(result.namespaces.map((n) => n.namespace).sort()).toEqual(
      ["meta", "meta/conventions", "projects/test"]
    );
  });

  it("returns helpful messages when conventions and workbench are missing", async () => {
    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      conventions: { content: null; message: string };
      workbench: { content: null; message: string };
      namespaces: unknown[];
    };

    expect(result.conventions.content).toBeNull();
    expect(result.conventions.message).toContain("No conventions found");
    expect(result.workbench.content).toBeNull();
    expect(result.workbench.message).toContain("No workbench found");
    expect(result.namespaces).toHaveLength(0);
  });

  it("works with conventions but no workbench", async () => {
    await callTool("memory_write", {
      namespace: "meta/conventions",
      key: "conventions",
      content: "# Guide",
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      conventions: { content: string };
      workbench: { content: null; message: string };
    };

    expect(result.conventions.content).toBe("# Guide");
    expect(result.workbench.content).toBeNull();
  });

  it("requires no parameters", async () => {
    // Should work with no args at all
    const raw = await callTool("memory_orient");
    const result = parseToolResponse(raw) as { conventions: unknown; workbench: unknown; namespaces: unknown };
    expect(result.conventions).toBeDefined();
    expect(result.workbench).toBeDefined();
    expect(result.namespaces).toBeDefined();
  });
});

describe("staleness flag", () => {
  it("does not include stale flag for fresh entries on memory_read", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Fresh",
    });
    const raw = await callTool("memory_read", { namespace: "projects/test", key: "status" });
    const result = parseToolResponse(raw) as { found: boolean; stale?: boolean };
    expect(result.found).toBe(true);
    expect(result.stale).toBeUndefined();
  });

  it("includes stale flag for old entries on memory_read", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Old entry",
    });
    // Manually backdate the entry
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/test'").run();

    const raw = await callTool("memory_read", { namespace: "projects/test", key: "status" });
    const result = parseToolResponse(raw) as { found: boolean; stale?: boolean };
    expect(result.found).toBe(true);
    expect(result.stale).toBe(true);
  });

  it("includes stale flag on memory_get for old entries", async () => {
    const writeRaw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Old",
    });
    const { id } = parseToolResponse(writeRaw) as { id: string };
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);

    const raw = await callTool("memory_get", { id });
    const result = parseToolResponse(raw) as { found: boolean; stale?: boolean };
    expect(result.found).toBe(true);
    expect(result.stale).toBe(true);
  });

  it("includes stale flag in memory_orient for stale workbench", async () => {
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n## Active\n## Blocked\n## Recently Completed\n## Needs Review",
    });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'meta' AND key = 'workbench'").run();

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { workbench: { stale?: boolean } };
    expect(result.workbench.stale).toBe(true);
  });
});

describe("auto-add to workbench", () => {
  it("adds new projects/* namespace to workbench Needs Review", async () => {
    // Create workbench first
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n\n## Active\n\n## Blocked\n\n## Recently Completed\n\n## Needs Review",
    });

    // Create first entry in a new project namespace
    const raw = await callTool("memory_write", {
      namespace: "projects/new-thing",
      key: "status",
      content: "Just started",
    });
    const result = parseToolResponse(raw) as { status: string; workbench_updated?: boolean };
    expect(result.status).toBe("created");
    expect(result.workbench_updated).toBe(true);

    // Verify workbench was updated
    const wbRaw = await callTool("memory_read", { namespace: "meta", key: "workbench" });
    const wb = parseToolResponse(wbRaw) as { content: string };
    expect(wb.content).toContain("projects/new-thing");
    expect(wb.content).toContain("auto-added");
  });

  it("does not update workbench for second entry in existing namespace", async () => {
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n\n## Active\n\n## Blocked\n\n## Recently Completed\n\n## Needs Review",
    });

    await callTool("memory_write", {
      namespace: "projects/existing",
      key: "status",
      content: "First",
    });
    const raw = await callTool("memory_write", {
      namespace: "projects/existing",
      key: "architecture",
      content: "Second entry",
    });
    const result = parseToolResponse(raw) as { workbench_updated?: boolean };
    expect(result.workbench_updated).toBeUndefined();
  });

  it("does not update workbench for non-projects namespaces", async () => {
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n\n## Active\n\n## Blocked\n\n## Recently Completed\n\n## Needs Review",
    });

    const raw = await callTool("memory_write", {
      namespace: "people/alice",
      key: "prefs",
      content: "Likes TypeScript",
    });
    const result = parseToolResponse(raw) as { workbench_updated?: boolean };
    expect(result.workbench_updated).toBeUndefined();
  });

  it("does not crash when no workbench exists", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/orphan",
      key: "status",
      content: "No workbench",
    });
    const result = parseToolResponse(raw) as { status: string; workbench_updated?: boolean };
    expect(result.status).toBe("created");
    expect(result.workbench_updated).toBeUndefined();
  });
});

describe("memory_read_batch", () => {
  it("reads multiple entries in one call", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "status", content: "Alpha" });
    await callTool("memory_write", { namespace: "projects/b", key: "status", content: "Beta" });

    const raw = await callTool("memory_read_batch", {
      reads: [
        { namespace: "projects/a", key: "status" },
        { namespace: "projects/b", key: "status" },
      ],
    });
    const result = parseToolResponse(raw) as { results: Array<{ found: boolean; content?: string }> };
    expect(result.results).toHaveLength(2);
    expect(result.results[0].found).toBe(true);
    expect(result.results[0].content).toBe("Alpha");
    expect(result.results[1].found).toBe(true);
    expect(result.results[1].content).toBe("Beta");
  });

  it("handles mix of found and not-found", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "status", content: "Alpha" });

    const raw = await callTool("memory_read_batch", {
      reads: [
        { namespace: "projects/a", key: "status" },
        { namespace: "projects/missing", key: "status" },
      ],
    });
    const result = parseToolResponse(raw) as { results: Array<{ found: boolean }> };
    expect(result.results[0].found).toBe(true);
    expect(result.results[1].found).toBe(false);
  });

  it("includes stale flag for old entries", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "status", content: "Old" });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/a'").run();

    const raw = await callTool("memory_read_batch", {
      reads: [{ namespace: "projects/a", key: "status" }],
    });
    const result = parseToolResponse(raw) as { results: Array<{ found: boolean; stale?: boolean }> };
    expect(result.results[0].stale).toBe(true);
  });

  it("rejects empty reads array", async () => {
    const raw = await callTool("memory_read_batch", { reads: [] });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });

  it("rejects more than 20 reads", async () => {
    const reads = Array.from({ length: 21 }, (_, i) => ({ namespace: `p/${i}`, key: "s" }));
    const raw = await callTool("memory_read_batch", { reads });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });
});

describe("memory_list recent logs", () => {
  it("includes recent log previews in namespace listing", async () => {
    await callTool("memory_log", { namespace: "projects/test", content: "First event" });
    await callTool("memory_log", { namespace: "projects/test", content: "Second event" });
    await callTool("memory_log", { namespace: "projects/test", content: "Third event" });

    const raw = await callTool("memory_list", { namespace: "projects/test" });
    const result = parseToolResponse(raw) as {
      log_summary: {
        log_count: number;
        recent: Array<{ id: string; content_preview: string; tags: string[]; created_at: string }>;
      };
    };
    expect(result.log_summary.log_count).toBe(3);
    expect(result.log_summary.recent).toHaveLength(3);
    // Most recent first
    expect(result.log_summary.recent[0].content_preview).toBe("Third event");
    expect(result.log_summary.recent[1].content_preview).toBe("Second event");
    expect(result.log_summary.recent[2].content_preview).toBe("First event");
    expect(result.log_summary.recent[0].tags).toEqual([]);
    expect(result.log_summary.recent[0].id).toBeTruthy();
    expect(result.log_summary.recent[0].created_at).toBeTruthy();
  });

  it("limits recent logs to 5", async () => {
    for (let i = 0; i < 8; i++) {
      await callTool("memory_log", { namespace: "projects/test", content: `Event ${i}` });
    }

    const raw = await callTool("memory_list", { namespace: "projects/test" });
    const result = parseToolResponse(raw) as {
      log_summary: { log_count: number; recent: unknown[] };
    };
    expect(result.log_summary.log_count).toBe(8);
    expect(result.log_summary.recent).toHaveLength(5);
  });

  it("returns empty recent array when no logs", async () => {
    await callTool("memory_write", { namespace: "projects/test", key: "status", content: "active" });

    const raw = await callTool("memory_list", { namespace: "projects/test" });
    const result = parseToolResponse(raw) as {
      log_summary: { log_count: number; recent: unknown[] };
    };
    expect(result.log_summary.log_count).toBe(0);
    expect(result.log_summary.recent).toEqual([]);
  });
});

describe("memory_list demo filtering", () => {
  it("hides demo namespaces by default", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "demo/test", key: "s", content: "c" });

    const raw = await callTool("memory_list", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    expect(result.namespaces.map((n) => n.namespace)).toEqual(["projects/real"]);
  });

  it("shows demo namespaces when include_demo is true", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "demo/test", key: "s", content: "c" });

    const raw = await callTool("memory_list", { include_demo: true });
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).toContain("demo/test");
    expect(names).toContain("projects/real");
  });
});

describe("memory_orient workbench drift", () => {
  it("surfaces namespaces updated after workbench", async () => {
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n## Active\n- projects/alpha",
    });
    // Backdate workbench
    db.prepare("UPDATE entries SET updated_at = '2026-01-01T00:00:00.000Z' WHERE namespace = 'meta' AND key = 'workbench'").run();

    // Create a project that's newer than the workbench
    await callTool("memory_write", {
      namespace: "projects/alpha",
      key: "status",
      content: "Updated recently",
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      workbench: { drift?: Array<{ namespace: string; last_activity_at: string }> };
    };
    expect(result.workbench.drift).toBeDefined();
    expect(result.workbench.drift!.length).toBe(1);
    expect(result.workbench.drift![0].namespace).toBe("projects/alpha");
  });

  it("does not include drift when workbench is up to date", async () => {
    await callTool("memory_write", {
      namespace: "projects/alpha",
      key: "status",
      content: "Old",
    });
    // Backdate the project
    db.prepare("UPDATE entries SET updated_at = '2025-01-01T00:00:00.000Z' WHERE namespace = 'projects/alpha'").run();

    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench\n## Active\n- projects/alpha",
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      workbench: { drift?: unknown[] };
    };
    expect(result.workbench.drift).toBeUndefined();
  });

  it("only tracks drift for projects/* namespaces", async () => {
    await callTool("memory_write", {
      namespace: "meta",
      key: "workbench",
      content: "# Workbench",
    });
    db.prepare("UPDATE entries SET updated_at = '2026-01-01T00:00:00.000Z' WHERE namespace = 'meta' AND key = 'workbench'").run();

    await callTool("memory_write", { namespace: "people/alice", key: "prefs", content: "vim" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      workbench: { drift?: unknown[] };
    };
    expect(result.workbench.drift).toBeUndefined();
  });

  it("filters demo namespaces from orient", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "demo/test", key: "s", content: "c" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      namespaces: Array<{ namespace: string }>;
    };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).toContain("projects/real");
    expect(names).not.toContain("demo/test");
  });
});

describe("unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const raw = await callTool("memory_nonexistent", {});
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("unknown_tool");
  });
});
