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
  it("returns conventions, dashboard, and namespaces", async () => {
    await callTool("memory_write", {
      namespace: "meta/conventions",
      key: "conventions",
      content: "# Conventions\nUse memory_orient first.",
      tags: ["governance"],
    });
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Active project",
      tags: ["active"],
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      conventions: { content: string; updated_at: string };
      dashboard: Record<string, unknown[]>;
      namespaces: Array<{ namespace: string }>;
    };

    // Default is compact conventions
    expect(result.conventions.content).toContain("# Quick Reference");
    expect(result.conventions.content).toContain("memory_read");
    expect(result.conventions.updated_at).toBeTruthy();
    expect((result.conventions as any).compact).toBe(true);
    expect(result.dashboard).toBeDefined();
    expect(result.dashboard.active).toHaveLength(1);
  });

  it("returns full conventions when include_full_conventions is true", async () => {
    await callTool("memory_write", {
      namespace: "meta/conventions",
      key: "conventions",
      content: "# Full Conventions Document\n\nThis is the full version with all details.",
      tags: ["governance"],
    });

    const raw = await callTool("memory_orient", { include_full_conventions: true });
    const result = parseToolResponse(raw) as {
      conventions: { content: string; compact?: boolean; full_conventions_hint?: string };
    };

    expect(result.conventions.content).toContain("# Full Conventions Document");
    expect(result.conventions.compact).toBeUndefined();
    expect(result.conventions.full_conventions_hint).toBeUndefined();
  });

  it("returns empty dashboard when no projects exist", async () => {
    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: Record<string, unknown[]>;
    };
    expect(result.dashboard.active).toHaveLength(0);
    expect(result.dashboard.blocked).toHaveLength(0);
    expect(result.dashboard.completed).toHaveLength(0);
    expect(result.dashboard.uncategorized).toHaveLength(0);
  });

  it("groups entries by lifecycle tag correctly", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "status", content: "Active", tags: ["active"] });
    await callTool("memory_write", { namespace: "projects/b", key: "status", content: "Blocked", tags: ["blocked"] });
    await callTool("memory_write", { namespace: "projects/c", key: "status", content: "Done", tags: ["completed"] });
    await callTool("memory_write", { namespace: "projects/d", key: "status", content: "On hold", tags: ["stopped"] });
    await callTool("memory_write", { namespace: "projects/e", key: "status", content: "In maint", tags: ["maintenance"] });
    await callTool("memory_write", { namespace: "clients/f", key: "status", content: "Client active", tags: ["active"] });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: Record<string, Array<{ namespace: string }>>;
    };
    expect(result.dashboard.active).toHaveLength(2);
    expect(result.dashboard.blocked).toHaveLength(1);
    expect(result.dashboard.completed).toHaveLength(1);
    expect(result.dashboard.stopped).toHaveLength(1);
    expect(result.dashboard.maintenance).toHaveLength(1);
  });

  it("entries with no lifecycle tag go to uncategorized", async () => {
    await callTool("memory_write", { namespace: "projects/x", key: "status", content: "No lifecycle", tags: ["feature"] });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: Record<string, Array<{ namespace: string }>>;
    };
    expect(result.dashboard.uncategorized).toHaveLength(1);
    expect(result.dashboard.uncategorized[0].namespace).toBe("projects/x");
  });

  it("active entries >14 days old get needs_attention", async () => {
    await callTool("memory_write", { namespace: "projects/stale", key: "status", content: "Old", tags: ["active"] });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/stale'").run();

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: { active: Array<{ namespace: string; needs_attention?: boolean }> };
    };
    expect(result.dashboard.active[0].needs_attention).toBe(true);
  });

  it("includes legacy_workbench when meta:workbench exists", async () => {
    await callTool("memory_write", { namespace: "meta", key: "workbench", content: "# Old Workbench" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      legacy_workbench: { content: string; deprecation_note: string };
    };
    expect(result.legacy_workbench.content).toContain("# Old Workbench");
    expect(result.legacy_workbench.deprecation_note).toContain("deprecated");
  });

  it("includes notes when meta/workbench-notes exists", async () => {
    await callTool("memory_write", { namespace: "meta", key: "workbench-notes", content: "Remember to check X" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { notes: string };
    expect(result.notes).toBe("Remember to check X");
  });

  it("excludes demo namespaces by default", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "demo/test", key: "s", content: "c" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).toContain("projects/real");
    expect(names).not.toContain("demo/test");
  });

  it("shows demo namespaces when include_demo is true", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "demo/test", key: "s", content: "c" });

    const raw = await callTool("memory_orient", { include_demo: true });
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).toContain("demo/test");
  });

  it("returns helpful message when conventions are missing", async () => {
    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      conventions: { content: null; message: string };
    };
    expect(result.conventions.content).toBeNull();
    expect(result.conventions.message).toContain("No conventions found");
  });

  it("requires no parameters", async () => {
    const raw = await callTool("memory_orient");
    const result = parseToolResponse(raw) as { conventions: unknown; dashboard: unknown; namespaces: unknown };
    expect(result.conventions).toBeDefined();
    expect(result.dashboard).toBeDefined();
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

});

describe("compare-and-swap (memory_write)", () => {
  it("write succeeds with correct expected_updated_at", async () => {
    await callTool("memory_write", { namespace: "projects/cas", key: "status", content: "v1", tags: ["active"] });
    const readRaw = await callTool("memory_read", { namespace: "projects/cas", key: "status" });
    const readResult = parseToolResponse(readRaw) as { updated_at: string };

    const raw = await callTool("memory_write", {
      namespace: "projects/cas",
      key: "status",
      content: "v2",
      tags: ["active"],
      expected_updated_at: readResult.updated_at,
    });
    const result = parseToolResponse(raw) as { status: string };
    expect(result.status).toBe("updated");
  });

  it("write returns conflict with wrong expected_updated_at", async () => {
    await callTool("memory_write", { namespace: "projects/cas", key: "status", content: "v1", tags: ["active"] });

    const raw = await callTool("memory_write", {
      namespace: "projects/cas",
      key: "status",
      content: "v2",
      tags: ["active"],
      expected_updated_at: "2020-01-01T00:00:00.000Z",
    });
    const result = parseToolResponse(raw) as { status: string; current_updated_at: string; message: string };
    expect(result.status).toBe("conflict");
    expect(result.current_updated_at).toBeTruthy();
    expect(result.message).toContain("was updated at");
  });

  it("write succeeds without expected_updated_at (optional)", async () => {
    await callTool("memory_write", { namespace: "projects/cas", key: "status", content: "v1", tags: ["active"] });

    const raw = await callTool("memory_write", {
      namespace: "projects/cas",
      key: "status",
      content: "v2",
      tags: ["active"],
    });
    const result = parseToolResponse(raw) as { status: string };
    expect(result.status).toBe("updated");
  });

  it("hints CAS for tracked status writes without expected_updated_at", async () => {
    await callTool("memory_write", { namespace: "projects/cas", key: "status", content: "v1", tags: ["active"] });

    const raw = await callTool("memory_write", {
      namespace: "projects/cas",
      key: "status",
      content: "v2",
      tags: ["active"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes("expected_updated_at"))).toBe(true);
  });
});

describe("tag canonicalization (memory_write)", () => {
  it("normalizes 'done' to 'completed' with warning", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/canon",
      key: "status",
      content: "Finished",
      tags: ["done"],
    });
    const result = parseToolResponse(raw) as { status: string; warnings?: string[] };
    expect(result.status).toBe("created");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes('"done" → "completed"'))).toBe(true);

    // Verify stored tags are canonical
    const readRaw = await callTool("memory_read", { namespace: "projects/canon", key: "status" });
    const readResult = parseToolResponse(readRaw) as { tags: string[] };
    expect(readResult.tags).toContain("completed");
    expect(readResult.tags).not.toContain("done");
  });

  it("normalizes 'paused' to 'stopped' with warning", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/canon2",
      key: "status",
      content: "On hold",
      tags: ["paused"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    expect(result.warnings!.some(w => w.includes('"paused" → "stopped"'))).toBe(true);

    const readRaw = await callTool("memory_read", { namespace: "projects/canon2", key: "status" });
    const readResult = parseToolResponse(readRaw) as { tags: string[] };
    expect(readResult.tags).toContain("stopped");
  });

  it("canonical tags pass through unchanged", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/canon3",
      key: "status",
      content: "Active",
      tags: ["active"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    // No normalization warnings (CAS hint may still be absent since this is "created")
    const normWarnings = (result.warnings ?? []).filter(w => w.includes("normalized"));
    expect(normWarnings).toHaveLength(0);
  });

  it("no canonicalization for non-status / non-tracked writes", async () => {
    const raw = await callTool("memory_write", {
      namespace: "people/alice",
      key: "prefs",
      content: "Likes vim",
      tags: ["done"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    // Tags should NOT be canonicalized for non-tracked writes
    const readRaw = await callTool("memory_read", { namespace: "people/alice", key: "prefs" });
    const readResult = parseToolResponse(readRaw) as { tags: string[] };
    expect(readResult.tags).toContain("done");
  });
});

describe("lifecycle validation (memory_write)", () => {
  it("warns when no lifecycle tag", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/lc",
      key: "status",
      content: "No lifecycle",
      tags: ["feature"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    expect(result.warnings!.some(w => w.includes("No lifecycle tag"))).toBe(true);
  });

  it("warns when tags omitted entirely", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/lc2",
      key: "status",
      content: "No tags at all",
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    expect(result.warnings!.some(w => w.includes("No lifecycle tag"))).toBe(true);
  });

  it("warns when multiple lifecycle tags", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/lc3",
      key: "status",
      content: "Confused",
      tags: ["active", "blocked"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    expect(result.warnings!.some(w => w.includes("Multiple lifecycle tags"))).toBe(true);
  });

  it("no lifecycle warning for exactly one lifecycle tag", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/lc4",
      key: "status",
      content: "Good",
      tags: ["active", "feature"],
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    const lifecycleWarnings = (result.warnings ?? []).filter(w =>
      w.includes("lifecycle tag") || w.includes("Multiple lifecycle")
    );
    expect(lifecycleWarnings).toHaveLength(0);
  });

  it("no validation for non-status / non-tracked writes", async () => {
    const raw = await callTool("memory_write", {
      namespace: "people/bob",
      key: "notes",
      content: "Random",
    });
    const result = parseToolResponse(raw) as { warnings?: string[] };
    expect(result.warnings).toBeUndefined();
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

describe("completed task filtering", () => {
  it("memory_list hides completed task namespaces by default", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "status", content: "active", tags: ["active"] });
    await callTool("memory_write", { namespace: "tasks/20260327-done", key: "status", content: "done", tags: ["completed"] });
    await callTool("memory_write", { namespace: "tasks/20260327-active", key: "status", content: "running", tags: ["pending"] });
    await callTool("memory_write", { namespace: "tasks/admin", key: "index", content: "task index", tags: ["completed"] });

    const raw = await callTool("memory_list", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);

    expect(names).toContain("projects/real");
    expect(names).toContain("tasks/20260327-active");
    expect(names).toContain("tasks/admin");
    expect(names).not.toContain("tasks/20260327-done");
  });

  it("memory_list shows completed tasks when include_completed_tasks is true", async () => {
    await callTool("memory_write", { namespace: "tasks/20260327-done", key: "status", content: "done", tags: ["completed"] });

    const raw = await callTool("memory_list", { include_completed_tasks: true });
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).toContain("tasks/20260327-done");
  });

  it("memory_orient hides completed task namespaces by default", async () => {
    await callTool("memory_write", { namespace: "tasks/20260327-done", key: "status", content: "done", tags: ["completed"] });
    await callTool("memory_write", { namespace: "tasks/20260327-running", key: "status", content: "running", tags: ["pending"] });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);

    expect(names).not.toContain("tasks/20260327-done");
    expect(names).toContain("tasks/20260327-running");
  });

  it("memory_list hides failed task namespaces by default", async () => {
    await callTool("memory_write", { namespace: "tasks/20260327-fail", key: "status", content: "error", tags: ["failed"] });

    const raw = await callTool("memory_list", {});
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).not.toContain("tasks/20260327-fail");
  });
});

describe("maintenance suggestions (memory_orient)", () => {
  it("flags active-but-stale entries", async () => {
    await callTool("memory_write", { namespace: "projects/old", key: "status", content: "Stale", tags: ["active"] });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/old'").run();

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed: Array<{ namespace: string; issue: string; suggestion: string }>;
    };
    expect(result.maintenance_needed).toBeDefined();
    const staleItem = result.maintenance_needed.find(m => m.issue === "active_but_stale");
    expect(staleItem).toBeDefined();
    expect(staleItem!.namespace).toBe("projects/old");
    expect(staleItem!.suggestion).toContain("days ago");
  });

  it("flags missing status key in tracked namespaces", async () => {
    // Create a project namespace with a non-status key
    await callTool("memory_write", { namespace: "projects/nostatus", key: "architecture", content: "monolith" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed: Array<{ namespace: string; issue: string }>;
    };
    const missingStatus = result.maintenance_needed.find(m => m.issue === "missing_status" && m.namespace === "projects/nostatus");
    expect(missingStatus).toBeDefined();
  });

  it("flags conflicting lifecycle tags", async () => {
    await callTool("memory_write", { namespace: "projects/conflict", key: "status", content: "Both", tags: ["active", "blocked"] });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed: Array<{ namespace: string; issue: string }>;
    };
    const conflicting = result.maintenance_needed.find(m => m.issue === "conflicting_lifecycle");
    expect(conflicting).toBeDefined();
    expect(conflicting!.namespace).toBe("projects/conflict");
  });

  it("flags missing lifecycle tags", async () => {
    await callTool("memory_write", { namespace: "projects/nolc", key: "status", content: "No lifecycle", tags: ["feature"] });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed: Array<{ namespace: string; issue: string }>;
    };
    const missing = result.maintenance_needed.find(m => m.issue === "missing_lifecycle");
    expect(missing).toBeDefined();
    expect(missing!.namespace).toBe("projects/nolc");
  });

  it("empty maintenance_needed when clean", async () => {
    await callTool("memory_write", { namespace: "projects/clean", key: "status", content: "Good", tags: ["active"] });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed?: unknown[];
    };
    expect(result.maintenance_needed).toBeUndefined();
  });

  it("flags upcoming event with stale status", async () => {
    // Create a project with a date 3 days from now but updated 5 days ago
    const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const content = `**Phase:** Active — event ${futureDate}\n\n**Current work:** Preparing for the event.`;
    await callTool("memory_write", { namespace: "projects/event-test", key: "status", content, tags: ["active"] });
    // Backdate the updated_at to 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = 'projects/event-test' AND key = 'status'").run(fiveDaysAgo);

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed: Array<{ namespace: string; issue: string; suggestion: string }>;
    };
    const eventStale = result.maintenance_needed?.find(m => m.issue === "upcoming_event_stale");
    expect(eventStale).toBeDefined();
    expect(eventStale!.namespace).toBe("projects/event-test");
    expect(eventStale!.suggestion).toContain(futureDate);
  });

  it("does not flag upcoming event if recently updated", async () => {
    const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const content = `**Phase:** Active — event ${futureDate}`;
    await callTool("memory_write", { namespace: "projects/event-fresh", key: "status", content, tags: ["active"] });
    // Entry was just written, so updated_at is now — should NOT be flagged

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed?: Array<{ namespace: string; issue: string }>;
    };
    const eventStale = (result.maintenance_needed ?? []).find(m => m.issue === "upcoming_event_stale" && m.namespace === "projects/event-fresh");
    expect(eventStale).toBeUndefined();
  });

  it("does not flag dates in the past", async () => {
    const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const content = `**Phase:** Active — event ${pastDate}`;
    await callTool("memory_write", { namespace: "projects/past-event", key: "status", content, tags: ["active"] });
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = 'projects/past-event' AND key = 'status'").run(fourDaysAgo);

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed?: Array<{ namespace: string; issue: string }>;
    };
    const eventStale = (result.maintenance_needed ?? []).find(m => m.issue === "upcoming_event_stale" && m.namespace === "projects/past-event");
    expect(eventStale).toBeUndefined();
  });

  it("does not flag non-tracked namespaces", async () => {
    await callTool("memory_write", { namespace: "people/alice", key: "prefs", content: "vim" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed?: Array<{ namespace: string }>;
    };
    const aliceIssue = (result.maintenance_needed ?? []).find(m => m.namespace === "people/alice");
    expect(aliceIssue).toBeUndefined();
  });
});

describe("reference index (memory_orient)", () => {
  it("returns references when meta/reference-index exists", async () => {
    const refIndex = JSON.stringify({
      version: 1,
      references: [
        { namespace: "people/magnus", key: "profile", title: "Magnus profile", when_to_load: "collaboration style" },
        { namespace: "meta", key: "mgc-soul", title: "MGC soul", when_to_load: "proposals and positioning" },
      ],
    });
    await callTool("memory_write", { namespace: "meta", key: "reference-index", content: refIndex });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      references: { entries: Array<{ namespace: string; key: string; title: string; when_to_load: string }>; updated_at: string };
    };

    expect(result.references).toBeDefined();
    expect(result.references.entries).toHaveLength(2);
    expect(result.references.entries[0].title).toBe("Magnus profile");
    expect(result.references.updated_at).toBeTruthy();
  });

  it("omits references when meta/reference-index is missing", async () => {
    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { references?: unknown };
    expect(result.references).toBeUndefined();
  });

  it("omits references when meta/reference-index has invalid JSON", async () => {
    await callTool("memory_write", { namespace: "meta", key: "reference-index", content: "not json {{{" });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { references?: unknown };
    expect(result.references).toBeUndefined();
  });

  it("filters out malformed entries but keeps valid ones", async () => {
    const refIndex = JSON.stringify({
      version: 1,
      references: [
        { namespace: "people/magnus", key: "profile", title: "Magnus profile", when_to_load: "always" },
        { namespace: "bad", title: "Missing key field" },
        { key: "bad", title: "Missing namespace" },
      ],
    });
    await callTool("memory_write", { namespace: "meta", key: "reference-index", content: refIndex });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      references: { entries: Array<{ namespace: string }> };
    };

    expect(result.references.entries).toHaveLength(1);
    expect(result.references.entries[0].namespace).toBe("people/magnus");
  });

  it("omits references when references array is empty after filtering", async () => {
    const refIndex = JSON.stringify({
      version: 1,
      references: [
        { bad: "entry" },
      ],
    });
    await callTool("memory_write", { namespace: "meta", key: "reference-index", content: refIndex });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as { references?: unknown };
    expect(result.references).toBeUndefined();
  });
});

describe("unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const raw = await callTool("memory_nonexistent", {});
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("unknown_tool");
  });
});
