/**
 * Integration tests for multi-principal access enforcement.
 *
 * Verifies that every MCP tool correctly enforces namespace access rules.
 * This is the authorization matrix in test form.
 *
 * All tests seed data as owner first, then verify access as non-owner.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import type { AccessContext } from "../src/access.js";
import { ownerContext } from "../src/access.js";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function familyContext(): AccessContext {
  return {
    principalId: "sara",
    principalType: "family",
    accessibleNamespaces: [
      { pattern: "users/sara/*", permissions: "rw" },
      { pattern: "shared/family/*", permissions: "rw" },
    ],
  };
}

function agentContext(): AccessContext {
  return {
    principalId: "agent:heimdall",
    principalType: "agent",
    accessibleNamespaces: [
      { pattern: "projects/heimdall/*", permissions: "rw" },
    ],
  };
}

function zeroAccessContext(): AccessContext {
  return {
    principalId: "anonymous",
    principalType: "external",
    accessibleNamespaces: [],
  };
}

/**
 * Creates a server+callTool pair bound to the given access context.
 * Uses an in-memory DB passed in from the test.
 */
function makeServer(
  db: Database.Database,
  ctx: AccessContext,
): (name: string, args?: Record<string, unknown>) => Promise<unknown> {
  const server = new Server(
    { name: "test-munin-access", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ctx);

  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    return handler({ method: "tools/call", params: { name, arguments: args } });
  };
}

function parse(response: unknown): unknown {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let db: Database.Database;
let ownerCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
let familyCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
let agentCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
let zeroCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
  db = initDatabase(":memory:");
  ownerCall = makeServer(db, ownerContext());
  familyCall = makeServer(db, familyContext());
  agentCall = makeServer(db, agentContext());
  zeroCall = makeServer(db, zeroAccessContext());
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// memory_write
// ---------------------------------------------------------------------------

describe("memory_write — access enforcement", () => {
  it("owner writes to projects/foo → succeeds", async () => {
    const raw = await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Active",
    });
    const result = parse(raw) as { status: string };
    expect(result.status).toBe("created");
  });

  it("family writes to users/sara/notes → succeeds", async () => {
    const raw = await familyCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Family note",
    });
    const result = parse(raw) as { status: string };
    expect(result.status).toBe("created");
  });

  it("family writes to projects/foo → denied (found: false)", async () => {
    const raw = await familyCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Should fail",
    });
    const result = parse(raw) as { found?: boolean; error?: string };
    // family gets found:false (not agent, not owner)
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("agent writes to projects/foo (outside its namespace) → denied (error: access_denied)", async () => {
    const raw = await agentCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Agent intrusion",
    });
    const result = parse(raw) as { error: string };
    expect(result.error).toBe("access_denied");
  });

  it("agent writes to its own namespace projects/heimdall/data → succeeds", async () => {
    // agentContext has pattern "projects/heimdall/*" — prefix match, requires sub-namespace
    const raw = await agentCall("memory_write", {
      namespace: "projects/heimdall/data",
      key: "status",
      content: "Heimdall active",
    });
    const result = parse(raw) as { status: string };
    expect(result.status).toBe("created");
  });

  it("zero-access writes to any namespace → denied", async () => {
    const raw = await zeroCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Zero intrusion",
    });
    const result = parse(raw) as { found?: boolean };
    // external type → same as family response (found: false)
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// memory_update_status
// ---------------------------------------------------------------------------

describe("memory_update_status — access enforcement", () => {
  it("owner updates tracked status in projects/foo → succeeds", async () => {
    const raw = await ownerCall("memory_update_status", {
      namespace: "projects/foo",
      phase: "Active",
      current_work: "Owner-managed status update",
      blockers: "None.",
      next_steps: ["Keep going"],
      lifecycle: "active",
    });
    const result = parse(raw) as { status: string; key: string };
    expect(result.status).toBe("created");
    expect(result.key).toBe("status");
  });

  it("family updates users/sara/notes → validation error because namespace is not tracked", async () => {
    const raw = await familyCall("memory_update_status", {
      namespace: "users/sara/notes",
      current_work: "Should fail before write path",
    });
    const result = parse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });

  it("family updates projects/foo → denied", async () => {
    const raw = await familyCall("memory_update_status", {
      namespace: "projects/foo",
      current_work: "Unauthorized project update",
    });
    const result = parse(raw) as { found?: boolean; error?: string };
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("agent updates unauthorized tracked namespace → access_denied", async () => {
    const raw = await agentCall("memory_update_status", {
      namespace: "projects/foo",
      current_work: "Unauthorized agent update",
    });
    const result = parse(raw) as { error: string };
    expect(result.error).toBe("access_denied");
  });
});

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

describe("memory_read — access enforcement", () => {
  beforeEach(async () => {
    // Seed as owner
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Owner-only data",
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara's note",
    });
  });

  it("owner reads from projects/foo → succeeds with content", async () => {
    const raw = await ownerCall("memory_read", {
      namespace: "projects/foo",
      key: "status",
    });
    const result = parse(raw) as { found: boolean; content: string };
    expect(result.found).toBe(true);
    expect(result.content).toBe("Owner-only data");
  });

  it("family reads from users/sara/notes → succeeds", async () => {
    const raw = await familyCall("memory_read", {
      namespace: "users/sara/notes",
      key: "today",
    });
    const result = parse(raw) as { found: boolean; content: string };
    expect(result.found).toBe(true);
    expect(result.content).toBe("Sara's note");
  });

  it("family reads from projects/foo → { found: false } with NO hint about sibling keys", async () => {
    const raw = await familyCall("memory_read", {
      namespace: "projects/foo",
      key: "status",
    });
    const result = parse(raw) as { found: boolean; hint?: string; message?: string };
    expect(result.found).toBe(false);
    // accessDeniedReadResponse must not leak sibling keys
    expect(result.hint).toBeUndefined();
  });

  it("agent reads from unauthorized namespace → { found: false }", async () => {
    const raw = await agentCall("memory_read", {
      namespace: "projects/foo",
      key: "status",
    });
    const result = parse(raw) as { found: boolean };
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// memory_read_batch
// ---------------------------------------------------------------------------

describe("memory_read_batch — access enforcement", () => {
  let entryId: string;

  beforeEach(async () => {
    const raw = await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Owner data",
    });
    entryId = (parse(raw) as { id: string }).id;

    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara data",
    });
  });

  it("mixed batch: accessible items return data, inaccessible return { found: false }", async () => {
    const raw = await familyCall("memory_read_batch", {
      reads: [
        { namespace: "users/sara/notes", key: "today" },
        { namespace: "projects/foo", key: "status" },
      ],
    });
    const result = parse(raw) as { results: Array<{ found: boolean; content?: string }> };
    expect(result.results).toHaveLength(2);

    const accessible = result.results[0];
    expect(accessible.found).toBe(true);
    expect(accessible.content).toBe("Sara data");

    const inaccessible = result.results[1];
    expect(inaccessible.found).toBe(false);
    expect(inaccessible.content).toBeUndefined();
  });

  it("owner batch: all items return data", async () => {
    const raw = await ownerCall("memory_read_batch", {
      reads: [
        { namespace: "users/sara/notes", key: "today" },
        { namespace: "projects/foo", key: "status" },
      ],
    });
    const result = parse(raw) as { results: Array<{ found: boolean }> };
    expect(result.results.every((r) => r.found)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// memory_get
// ---------------------------------------------------------------------------

describe("memory_get — access enforcement", () => {
  let ownerEntryId: string;
  let restrictedEntryId: string;

  beforeEach(async () => {
    const ownerRaw = await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Owner-only",
    });
    restrictedEntryId = (parse(ownerRaw) as { id: string }).id;

    const saraRaw = await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara's own entry",
    });
    ownerEntryId = (parse(saraRaw) as { id: string }).id;
  });

  it("owner gets by ID from any namespace → succeeds", async () => {
    const raw = await ownerCall("memory_get", { id: restrictedEntryId });
    const result = parse(raw) as { found: boolean; content: string };
    expect(result.found).toBe(true);
    expect(result.content).toBe("Owner-only");
  });

  it("family gets ID of entry in users/sara/notes → succeeds", async () => {
    const raw = await familyCall("memory_get", { id: ownerEntryId });
    const result = parse(raw) as { found: boolean; content: string };
    expect(result.found).toBe(true);
    expect(result.content).toBe("Sara's own entry");
  });

  it("family gets ID of entry in projects/foo (inaccessible) → { found: false }", async () => {
    const raw = await familyCall("memory_get", { id: restrictedEntryId });
    const result = parse(raw) as { found: boolean };
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// memory_query
// ---------------------------------------------------------------------------

describe("memory_query — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Project moonbeam active development",
      tags: ["active"],
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Project moonbeam family note",
      tags: ["note"],
    });
    await ownerCall("memory_write", {
      namespace: "shared/family/calendar",
      key: "events",
      content: "Project moonbeam family calendar",
      tags: ["calendar"],
    });
  });

  it("family queries without namespace filter → only results from accessible namespaces", async () => {
    const raw = await familyCall("memory_query", { query: "moonbeam" });
    const result = parse(raw) as { results: Array<{ namespace: string }> };
    const namespaces = result.results.map((r) => r.namespace);
    expect(namespaces).not.toContain("projects/foo");
    // Should contain sara's accessible namespaces
    for (const ns of namespaces) {
      expect(
        ns.startsWith("users/sara/") || ns.startsWith("shared/family/")
      ).toBe(true);
    }
  });

  it("family search fills limit from accessible results even when top reranked hit is inaccessible", async () => {
    const raw = await familyCall("memory_query", {
      query: "moonbeam",
      search_mode: "lexical",
      limit: 1,
    });
    const result = parse(raw) as { total: number; results: Array<{ namespace: string }> };

    expect(result.total).toBe(1);
    expect(result.results[0].namespace).not.toBe("projects/foo");
    expect(
      result.results[0].namespace.startsWith("users/sara/") ||
        result.results[0].namespace.startsWith("shared/family/"),
    ).toBe(true);
  });

  it("family filter-only browse fills limit from accessible results when newest entry is inaccessible", async () => {
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = 'projects/foo'").run("2026-03-03T00:00:00.000Z");
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = 'users/sara/notes'").run("2026-03-02T00:00:00.000Z");
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = 'shared/family/calendar'").run("2026-03-01T00:00:00.000Z");

    const raw = await familyCall("memory_query", {
      entry_type: "state",
      limit: 1,
    });
    const result = parse(raw) as { total: number; results: Array<{ namespace: string }> };

    expect(result.total).toBe(1);
    expect(result.results[0].namespace).not.toBe("projects/foo");
    expect(
      result.results[0].namespace.startsWith("users/sara/") ||
        result.results[0].namespace.startsWith("shared/family/"),
    ).toBe(true);
  });

  it("owner queries → sees all results including restricted namespaces", async () => {
    const raw = await ownerCall("memory_query", { query: "moonbeam" });
    const result = parse(raw) as { results: Array<{ namespace: string }> };
    const namespaces = result.results.map((r) => r.namespace);
    expect(namespaces).toContain("projects/foo");
  });
});

// ---------------------------------------------------------------------------
// memory_log
// ---------------------------------------------------------------------------

describe("memory_log — access enforcement", () => {
  it("owner logs to projects/foo → succeeds", async () => {
    const raw = await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Owner log entry",
    });
    const result = parse(raw) as { status: string };
    expect(result.status).toBe("logged");
  });

  it("family logs to users/sara/notes → succeeds", async () => {
    const raw = await familyCall("memory_log", {
      namespace: "users/sara/notes",
      content: "Sara log entry",
    });
    const result = parse(raw) as { status: string };
    expect(result.status).toBe("logged");
  });

  it("family logs to projects/foo → denied (found: false)", async () => {
    const raw = await familyCall("memory_log", {
      namespace: "projects/foo",
      content: "Intrusion log",
    });
    const result = parse(raw) as { found?: boolean; error?: string };
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("agent logs to its authorized namespace → succeeds", async () => {
    // agentContext has pattern "projects/heimdall/*" — prefix match, requires sub-namespace
    const raw = await agentCall("memory_log", {
      namespace: "projects/heimdall/events",
      content: "Agent log",
    });
    const result = parse(raw) as { status: string };
    expect(result.status).toBe("logged");
  });

  it("agent logs to unauthorized namespace → access_denied", async () => {
    const raw = await agentCall("memory_log", {
      namespace: "projects/foo",
      content: "Agent intrusion log",
    });
    const result = parse(raw) as { error: string };
    expect(result.error).toBe("access_denied");
  });
});

// ---------------------------------------------------------------------------
// memory_list
// ---------------------------------------------------------------------------

describe("memory_list — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Owner project",
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara notes",
    });
  });

  it("family lists without namespace → only accessible namespaces returned", async () => {
    const raw = await familyCall("memory_list");
    const result = parse(raw) as { namespaces: Array<{ namespace: string }> };
    const nsList = result.namespaces.map((n) => n.namespace);
    expect(nsList).not.toContain("projects/foo");
    expect(nsList).toContain("users/sara/notes");
  });

  it("owner lists without namespace → all namespaces returned", async () => {
    const raw = await ownerCall("memory_list");
    const result = parse(raw) as { namespaces: Array<{ namespace: string }> };
    const nsList = result.namespaces.map((n) => n.namespace);
    expect(nsList).toContain("projects/foo");
    expect(nsList).toContain("users/sara/notes");
  });

  it("family lists with namespace projects/foo → empty state/log structure (no error, no data)", async () => {
    const raw = await familyCall("memory_list", { namespace: "projects/foo" });
    const result = parse(raw) as {
      namespace: string;
      state_entries: unknown[];
      log_summary: { log_count: number };
    };
    expect(result.namespace).toBe("projects/foo");
    expect(result.state_entries).toHaveLength(0);
    expect(result.log_summary.log_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// memory_orient
// ---------------------------------------------------------------------------

describe("memory_orient — access enforcement", () => {
  beforeEach(async () => {
    // Write conventions as owner
    await ownerCall("memory_write", {
      namespace: "meta/conventions",
      key: "conventions",
      content: "Owner conventions",
    });
    // Write a tracked project status
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Foo project active",
      tags: ["active"],
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "status",
      content: "Sara namespace active",
      tags: ["active"],
    });
  });

  it("family orient → conventions is null, dashboard filtered to accessible namespaces", async () => {
    const raw = await familyCall("memory_orient");
    const result = parse(raw) as {
      conventions: null | unknown;
      dashboard: Record<string, Array<{ namespace: string }>>;
    };
    expect(result.conventions).toBeNull();

    // Dashboard should not contain projects/foo
    const allDashboardNamespaces = Object.values(result.dashboard).flat().map((e) => e.namespace);
    expect(allDashboardNamespaces).not.toContain("projects/foo");
  });

  it("owner orient → conventions present, full dashboard", async () => {
    const raw = await ownerCall("memory_orient");
    const result = parse(raw) as {
      conventions: { content: string } | null;
      dashboard: Record<string, Array<{ namespace: string }>>;
    };
    // Owner should see conventions (either full or compact)
    expect(result.conventions).not.toBeNull();

    // projects/foo appears in dashboard
    const allDashboardNamespaces = Object.values(result.dashboard).flat().map((e) => e.namespace);
    expect(allDashboardNamespaces).toContain("projects/foo");
  });
});

// ---------------------------------------------------------------------------
// memory_attention
// ---------------------------------------------------------------------------

describe("memory_attention — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Blocked on vendor",
      tags: ["blocked"],
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "status",
      content: "Sara notes blocked",
      tags: ["blocked"],
    });
  });

  it("family memory_attention → only items from accessible namespaces", async () => {
    const raw = await familyCall("memory_attention");
    const result = parse(raw) as { items: Array<{ namespace: string }> };
    const namespaces = result.items.map((i) => i.namespace);
    expect(namespaces).not.toContain("projects/foo");
  });

  it("owner memory_attention → items from all namespaces", async () => {
    const raw = await ownerCall("memory_attention");
    const result = parse(raw) as { items: Array<{ namespace: string }> };
    const namespaces = result.items.map((i) => i.namespace);
    expect(namespaces).toContain("projects/foo");
  });
});

// ---------------------------------------------------------------------------
// memory_delete
// ---------------------------------------------------------------------------

describe("memory_delete — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "To be deleted",
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara's deletable note",
    });
    await ownerCall("memory_write", {
      namespace: "shared/family/list",
      key: "items",
      content: "Family list",
    });
  });

  it("owner deletes from projects/foo → preview then delete succeeds", async () => {
    const previewRaw = await ownerCall("memory_delete", {
      namespace: "projects/foo",
      key: "status",
    });
    const preview = parse(previewRaw) as { action: string; phase: string; delete_token: string };
    expect(preview.phase).toBe("preview");

    const deleteRaw = await ownerCall("memory_delete", {
      namespace: "projects/foo",
      key: "status",
      delete_token: preview.delete_token,
    });
    const del = parse(deleteRaw) as { action: string; phase: string; deleted_count: number };
    expect(del.phase).toBe("confirmed");
    expect(del.deleted_count).toBe(1);
  });

  it("family deletes from users/sara/notes → preview then delete succeeds", async () => {
    const previewRaw = await familyCall("memory_delete", {
      namespace: "users/sara/notes",
      key: "today",
    });
    const preview = parse(previewRaw) as { action: string; phase: string; delete_token: string };
    expect(preview.phase).toBe("preview");

    const deleteRaw = await familyCall("memory_delete", {
      namespace: "users/sara/notes",
      key: "today",
      delete_token: preview.delete_token,
    });
    const del = parse(deleteRaw) as { action: string; phase: string; deleted_count: number };
    expect(del.phase).toBe("confirmed");
    expect(del.deleted_count).toBe(1);
  });

  it("family deletes from projects/foo → denied (found: false)", async () => {
    const raw = await familyCall("memory_delete", {
      namespace: "projects/foo",
      key: "status",
    });
    const result = parse(raw) as { found?: boolean; error?: string };
    expect(result.found).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("family namespace-wide delete on shared/family → owner-only, denied (found: false)", async () => {
    // Family has rw on shared/family/* but namespace-wide delete requires owner
    const raw = await familyCall("memory_delete", {
      namespace: "shared/family",
    });
    const result = parse(raw) as { found?: boolean; error?: string };
    // canWrite on shared/family may pass (exact match is not covered by "shared/family/*"),
    // but the namespace-wide delete check kicks in
    // Either way: must not return action: "preview"
    expect((result as { action?: string }).action).not.toBe("preview");
  });

  it("agent deletes from unauthorized namespace → access_denied", async () => {
    const raw = await agentCall("memory_delete", {
      namespace: "projects/foo",
      key: "status",
    });
    const result = parse(raw) as { error: string };
    expect(result.error).toBe("access_denied");
  });
});

// ---------------------------------------------------------------------------
// memory_insights
// ---------------------------------------------------------------------------

describe("memory_insights — access enforcement", () => {
  it("owner memory_insights → returns (possibly empty) entries array", async () => {
    const raw = await ownerCall("memory_insights");
    const result = parse(raw) as { entries: unknown[]; total: number };
    expect(Array.isArray(result.entries)).toBe(true);
    expect(typeof result.total).toBe("number");
  });

  it("non-owner memory_insights → empty result set regardless of data", async () => {
    // Seed some data first
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Data that should not appear in insights for non-owner",
    });

    const familyRaw = await familyCall("memory_insights");
    const familyResult = parse(familyRaw) as { entries: unknown[]; total: number };
    expect(familyResult.entries).toHaveLength(0);
    expect(familyResult.total).toBe(0);

    const agentRaw = await agentCall("memory_insights");
    const agentResult = parse(agentRaw) as { entries: unknown[]; total: number };
    expect(agentResult.entries).toHaveLength(0);
    expect(agentResult.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// memory_history
// ---------------------------------------------------------------------------

describe("memory_history — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "History test entry",
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara history entry",
    });
  });

  it("family with namespace projects/foo → empty history (namespace filtered)", async () => {
    const raw = await familyCall("memory_history", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as { count: number; entries: unknown[] };
    expect(result.count).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it("family without namespace filter → only entries from accessible namespaces", async () => {
    const raw = await familyCall("memory_history");
    const result = parse(raw) as { entries: Array<{ namespace: string }> };
    const namespaces = result.entries.map((e) => e.namespace);
    expect(namespaces).not.toContain("projects/foo");
    // All returned entries must be in sara-accessible namespaces
    for (const ns of namespaces) {
      expect(
        ns.startsWith("users/sara/") || ns.startsWith("shared/family/")
      ).toBe(true);
    }
  });

  it("owner without namespace → sees all history entries", async () => {
    const raw = await ownerCall("memory_history");
    const result = parse(raw) as { entries: Array<{ namespace: string }> };
    const namespaces = result.entries.map((e) => e.namespace);
    expect(namespaces).toContain("projects/foo");
  });
});

// ---------------------------------------------------------------------------
// Meta-test: every registered tool has at least one test in this file
// ---------------------------------------------------------------------------

describe("meta: all registered tools are covered", () => {
  it("every tool returned by ListTools has at least one access enforcement test", async () => {
    const server = new Server(
      { name: "test-munin-meta", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, db, undefined, ownerContext());

    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/list");
    expect(handler).toBeDefined();

    const listResult = await handler!({ method: "tools/list", params: {} });
    const registeredTools = (listResult as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );

    // Tools tested in this file
    const testedTools = new Set([
      "memory_write",
      "memory_update_status",
      "memory_read",
      "memory_read_batch",
      "memory_get",
      "memory_query",
      "memory_log",
      "memory_list",
      "memory_orient",
      "memory_attention",
      "memory_delete",
      "memory_insights",
      "memory_history",
      "memory_status",
    ]);

    const untestedTools = registeredTools.filter((name) => !testedTools.has(name));
    expect(
      untestedTools,
      `These tools have no access enforcement tests: ${untestedTools.join(", ")}`,
    ).toHaveLength(0);
  });
});
