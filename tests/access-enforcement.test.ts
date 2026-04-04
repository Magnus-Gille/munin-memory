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
// memory_resume
// ---------------------------------------------------------------------------

describe("memory_resume — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nOwner-only project.\n\n## Blockers\nNone.\n\n## Next Steps\n- Keep going",
      tags: ["active"],
    });
    await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Decided on the owner-only project direction.",
      tags: ["decision"],
    });
    await ownerCall("memory_log", {
      namespace: "users/sara/notes",
      content: "Decided on Sara's own family note.",
      tags: ["decision"],
    });
  });

  it("family memory_resume → only returns items from accessible namespaces", async () => {
    const raw = await familyCall("memory_resume", { opener: "decided" });
    const result = parse(raw) as { items: Array<{ namespace: string }> };
    const namespaces = result.items.map((item) => item.namespace);

    expect(namespaces).not.toContain("projects/foo");
    for (const namespace of namespaces) {
      expect(
        namespace.startsWith("users/sara/") || namespace.startsWith("shared/family/"),
      ).toBe(true);
    }
  });

  it("owner memory_resume → can see project-scoped tracked status", async () => {
    const raw = await ownerCall("memory_resume", { project: "foo" });
    const result = parse(raw) as { items: Array<{ namespace: string; key?: string | null }> };

    expect(result.items).toContainEqual(expect.objectContaining({
      namespace: "projects/foo",
      key: "status",
    }));
  });
});

// ---------------------------------------------------------------------------
// memory_extract
// ---------------------------------------------------------------------------

describe("memory_extract — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nRestricted project.\n\n## Blockers\nNone.\n\n## Next Steps\n- Keep going",
      tags: ["active"],
    });
    await ownerCall("memory_write", {
      namespace: "users/sara/notes",
      key: "profile",
      content: "Sara family notes.",
    });
  });

  it("family memory_extract does not leak restricted related entries or target namespaces", async () => {
    const raw = await familyCall("memory_extract", {
      conversation_text: "We decided to keep working on the restricted project.",
      namespace_hint: "projects/foo",
    });
    const result = parse(raw) as {
      suggestions: Array<{ namespace: string }>;
      candidate_namespaces: string[];
      related_entries: Array<{ namespace: string }>;
    };

    expect(result.candidate_namespaces).not.toContain("projects/foo");
    expect(result.related_entries).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it("owner memory_extract can target the hinted tracked namespace", async () => {
    const raw = await ownerCall("memory_extract", {
      conversation_text: "We decided to keep working on the restricted project.",
      namespace_hint: "projects/foo",
    });
    const result = parse(raw) as {
      candidate_namespaces: string[];
      related_entries: Array<{ namespace: string }>;
    };

    expect(result.candidate_namespaces).toContain("projects/foo");
    expect(result.related_entries).toContainEqual(expect.objectContaining({
      namespace: "projects/foo",
    }));
  });
});

// ---------------------------------------------------------------------------
// memory_narrative
// ---------------------------------------------------------------------------

describe("memory_narrative — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_update_status", {
      namespace: "projects/foo",
      phase: "Active",
      current_work: "Restricted project",
      blockers: "None.",
      next_steps: ["Keep going"],
      lifecycle: "active",
    });
    await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Decided to keep this project private.",
      tags: ["decision"],
    });
  });

  it("family memory_narrative on inaccessible namespace → empty narrative view", async () => {
    const raw = await familyCall("memory_narrative", {
      namespace: "projects/foo",
      include_sources: true,
    });
    const result = parse(raw) as {
      namespace: string;
      summary: string;
      signals: unknown[];
      timeline: unknown[];
      sources: unknown[];
    };

    expect(result.namespace).toBe("projects/foo");
    expect(result.summary).toContain("No narrative context found");
    expect(result.signals).toHaveLength(0);
    expect(result.timeline).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });

  it("owner memory_narrative on accessible namespace → returns signal-bearing view", async () => {
    const raw = await ownerCall("memory_narrative", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      namespace: string;
      timeline: Array<{ category: string }>;
    };

    expect(result.namespace).toBe("projects/foo");
    expect(result.timeline.some((item) => item.category === "status" || item.category === "log")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// memory_commitments
// ---------------------------------------------------------------------------

describe("memory_commitments — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_update_status", {
      namespace: "projects/foo",
      phase: "Active",
      current_work: "Restricted follow-through",
      blockers: "None.",
      next_steps: ["Ship the private patch by 2027-04-05"],
      lifecycle: "active",
    });
  });

  it("family memory_commitments on inaccessible namespace → empty commitment buckets", async () => {
    const raw = await familyCall("memory_commitments", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      open: unknown[];
      at_risk: unknown[];
      overdue: unknown[];
      completed_recently: unknown[];
    };

    expect(result.open).toHaveLength(0);
    expect(result.at_risk).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
    expect(result.completed_recently).toHaveLength(0);
  });

  it("owner memory_commitments on accessible namespace → returns source-backed commitments", async () => {
    const raw = await ownerCall("memory_commitments", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      open: Array<{ source_entry_id: string }>;
    };

    expect(result.open.length).toBeGreaterThan(0);
    expect(result.open[0].source_entry_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// memory_patterns
// ---------------------------------------------------------------------------

describe("memory_patterns — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Decision: ARM64 support is still blocked by maintainer risk.",
      tags: ["decision"],
    });
    await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Decided to wait again because ARM64 support and maintainer risk remain unresolved.",
      tags: ["decision"],
    });
    await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Decision review: ARM64 uncertainty and maintainer risk are still the blocking concerns.",
      tags: ["decision"],
    });
  });

  it("family memory_patterns on inaccessible namespace → empty pattern view", async () => {
    const raw = await familyCall("memory_patterns", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      patterns: unknown[];
      heuristics: unknown[];
      supporting_sources: unknown[];
    };

    expect(result.patterns).toHaveLength(0);
    expect(result.heuristics).toHaveLength(0);
    expect(result.supporting_sources).toHaveLength(0);
  });

  it("owner memory_patterns on accessible namespace → returns pattern-backed summary", async () => {
    const raw = await ownerCall("memory_patterns", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      patterns: Array<{ source_entry_ids: string[] }>;
    };

    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.patterns[0].source_entry_ids.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// memory_handoff
// ---------------------------------------------------------------------------

describe("memory_handoff — access enforcement", () => {
  beforeEach(async () => {
    await ownerCall("memory_update_status", {
      namespace: "projects/foo",
      phase: "Blocked",
      current_work: "Restricted handoff",
      blockers: "Waiting on auth.",
      next_steps: ["Retry tomorrow"],
      lifecycle: "blocked",
    });
    await ownerCall("memory_log", {
      namespace: "projects/foo",
      content: "Decision: keep the restricted handoff inside the owner workspace.",
      tags: ["decision"],
    });
  });

  it("family memory_handoff on inaccessible namespace → found false with empty pack", async () => {
    const raw = await familyCall("memory_handoff", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      found: boolean;
      current_state: unknown;
      recent_decisions: unknown[];
      open_loops: unknown[];
      recent_actors: unknown[];
      recommended_next_actions: unknown[];
    };

    expect(result.found).toBe(false);
    expect(result.current_state).toBeNull();
    expect(result.recent_decisions).toHaveLength(0);
    expect(result.open_loops).toHaveLength(0);
    expect(result.recent_actors).toHaveLength(0);
    expect(result.recommended_next_actions).toHaveLength(0);
  });

  it("owner memory_handoff on accessible namespace → returns populated pack", async () => {
    const raw = await ownerCall("memory_handoff", {
      namespace: "projects/foo",
    });
    const result = parse(raw) as {
      found: boolean;
      recent_decisions: unknown[];
      recent_actors: unknown[];
    };

    expect(result.found).toBe(true);
    expect(result.recent_decisions.length).toBeGreaterThan(0);
    expect(result.recent_actors.length).toBeGreaterThan(0);
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
    await familyCall("memory_write", {
      namespace: "users/sara/notes",
      key: "today",
      content: "Sara's deletable note",
    });
    await ownerCall("memory_write", {
      namespace: "shared/family/board",
      key: "owner-note",
      content: "Owner family note",
    });
    await familyCall("memory_write", {
      namespace: "shared/family/board",
      key: "sara-note",
      content: "Sara family note",
    });
    await ownerCall("memory_log", {
      namespace: "shared/family/board",
      content: "Owner log entry",
    });
    await familyCall("memory_log", {
      namespace: "shared/family/board",
      content: "Sara log entry",
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

  it("family namespace-wide delete on shared/family/board → previews only caller-owned entries", async () => {
    const previewRaw = await familyCall("memory_delete", {
      namespace: "shared/family/board",
    });
    const preview = parse(previewRaw) as {
      phase: string;
      delete_token: string;
      will_delete: { state_count: number; log_count: number; keys?: string[] };
    };

    expect(preview.phase).toBe("preview");
    expect(preview.will_delete.state_count).toBe(1);
    expect(preview.will_delete.log_count).toBe(1);
    expect(preview.will_delete.keys).toEqual(["sara-note"]);

    const deleteRaw = await familyCall("memory_delete", {
      namespace: "shared/family/board",
      delete_token: preview.delete_token,
    });
    const del = parse(deleteRaw) as { deleted_count: number };
    expect(del.deleted_count).toBe(2);

    const ownerStillThereRaw = await ownerCall("memory_read", {
      namespace: "shared/family/board",
      key: "owner-note",
    });
    const ownerStillThere = parse(ownerStillThereRaw) as { found: boolean };
    expect(ownerStillThere.found).toBe(true);

    const saraGoneRaw = await familyCall("memory_read", {
      namespace: "shared/family/board",
      key: "sara-note",
    });
    const saraGone = parse(saraGoneRaw) as { found: boolean };
    expect(saraGone.found).toBe(false);
  });

  it("owner namespace-wide delete on shared/family/board → deletes all owners' entries", async () => {
    const previewRaw = await ownerCall("memory_delete", {
      namespace: "shared/family/board",
    });
    const preview = parse(previewRaw) as {
      phase: string;
      delete_token: string;
      will_delete: { state_count: number; log_count: number };
    };

    expect(preview.phase).toBe("preview");
    expect(preview.will_delete.state_count).toBe(2);
    expect(preview.will_delete.log_count).toBe(2);

    const deleteRaw = await ownerCall("memory_delete", {
      namespace: "shared/family/board",
      delete_token: preview.delete_token,
    });
    const del = parse(deleteRaw) as { deleted_count: number };
    expect(del.deleted_count).toBe(4);

    const ownerGoneRaw = await ownerCall("memory_read", {
      namespace: "shared/family/board",
      key: "owner-note",
    });
    const ownerGone = parse(ownerGoneRaw) as { found: boolean };
    expect(ownerGone.found).toBe(false);

    const saraGoneRaw = await familyCall("memory_read", {
      namespace: "shared/family/board",
      key: "sara-note",
    });
    const saraGone = parse(saraGoneRaw) as { found: boolean };
    expect(saraGone.found).toBe(false);
  });

  it("family specific delete on owner-owned shared entry → previews zero deletions", async () => {
    const raw = await familyCall("memory_delete", {
      namespace: "shared/family/board",
      key: "owner-note",
    });
    const result = parse(raw) as {
      phase: string;
      will_delete: { state_count: number };
    };
    expect(result.phase).toBe("preview");
    expect(result.will_delete.state_count).toBe(0);
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

// ---------------------------------------------------------------------------
// memory_consolidate
// ---------------------------------------------------------------------------

describe("memory_consolidate — access enforcement", () => {
  it("owner memory_consolidate → returns unavailable (consolidation disabled in test env)", async () => {
    const raw = await ownerCall("memory_consolidate");
    const result = parse(raw);
    // Consolidation is not enabled in test env — expect unavailable error
    expect(result.error).toBe("unavailable");
  });

  it("family memory_consolidate → denied (invisible)", async () => {
    const raw = await familyCall("memory_consolidate");
    const result = parse(raw);
    expect(result.found).toBe(false);
  });

  it("agent memory_consolidate → denied", async () => {
    const raw = await agentCall("memory_consolidate");
    const result = parse(raw);
    expect(result.error).toBe("access_denied");
  });
});

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
      "memory_resume",
      "memory_extract",
      "memory_narrative",
      "memory_commitments",
      "memory_patterns",
      "memory_handoff",
      "memory_attention",
      "memory_delete",
      "memory_insights",
      "memory_history",
      "memory_consolidate",
      "memory_status",
    ]);

    const untestedTools = registeredTools.filter((name) => !testedTools.has(name));
    expect(
      untestedTools,
      `These tools have no access enforcement tests: ${untestedTools.join(", ")}`,
    ).toHaveLength(0);
  });
});
