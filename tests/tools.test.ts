import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase, upsertConsolidationMetadata } from "../src/db.js";
import { registerTools, computeCommitmentConfidence } from "../src/tools.js";
import { ownerContext } from "../src/access.js";
import type { AccessContext } from "../src/access.js";
import type { LibrarianRuntimeConfig } from "../src/librarian.js";

const TEST_DB_PATH = "/tmp/munin-memory-tools-test.db";
const RETROSPECTIVE_CI_FIX_LOG =
  "Follow-up CI fix committed and pushed on 2026-03-12 as b74ed58 after GitHub Actions failed on prettier --check. Root cause: six TypeScript files from the security hardening commit were not Prettier-formatted. Local verification after formatting: npm run build, npm test (131/131), and npm run format:check all passed before pushing.";

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

function makeContextCallTool(
  ctx: AccessContext,
  sessionId?: string,
  runtimeConfig?: LibrarianRuntimeConfig,
) {
  const contextServer = new Server(
    { name: "test-munin-context", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(contextServer, db, sessionId, ctx, runtimeConfig);

  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (contextServer as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
    if (handler) {
      return handler({ method: "tools/call", params: { name, arguments: args } });
    }
    throw new Error("Cannot access tool handler");
  };
}

function parseToolResponse(response: unknown): unknown {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

async function seedRetrospectiveCommitmentRow(namespace: string, content: string, suffix: string) {
  const logRaw = await callTool("memory_log", {
    namespace,
    content,
    tags: ["milestone"],
  });
  const logResult = parseToolResponse(logRaw) as { id: string };
  const sourceTimestamp = "2026-03-05T12:00:00.000Z";
  const dueDate = content.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!dueDate) {
    throw new Error(`Missing due date in test content: ${content}`);
  }

  db.prepare("UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?").run(
    sourceTimestamp,
    sourceTimestamp,
    logResult.id,
  );
  db.prepare(
    `INSERT INTO commitments
       (id, namespace, source_entry_id, source_type, source_fingerprint, text, due_at, status, confidence, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, 'explicit_dated_commitment', ?, ?, ?, 'open', ?, ?, ?, NULL)`,
  ).run(
    `stale-${suffix}`,
    namespace,
    logResult.id,
    `explicit_dated_commitment:${suffix}`,
    content,
    `${dueDate}T23:59:59.000Z`,
    0.78,
    "2026-04-01T10:00:00.000Z",
    "2026-04-01T10:00:00.000Z",
  );

  return { entryId: logResult.id, commitmentId: `stale-${suffix}` };
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

  it("accepts and normalizes valid_until", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "temporary",
      content: "Temporary note",
      valid_until: "2027-06-15T12:00:00+02:00",
    });
    const result = parseToolResponse(raw) as { status: string };
    expect(result.status).toBe("created");

    const readRaw = await callTool("memory_read", {
      namespace: "projects/test",
      key: "temporary",
    });
    const readResult = parseToolResponse(readRaw) as { valid_until?: string };
    expect(readResult.valid_until).toBe("2027-06-15T10:00:00.000Z");
  });

  it("rejects invalid valid_until", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "temporary",
      content: "Temporary note",
      valid_until: "next tuesday",
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });

  it("supports explicit classification above the namespace floor", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "status",
      content: "Client-sensitive status",
      tags: ["active"],
      classification: "client-confidential",
    });

    const readRaw = await callTool("memory_read", {
      namespace: "projects/test",
      key: "status",
    });
    const entry = parseToolResponse(readRaw) as { classification: string; tags: string[] };
    expect(entry.classification).toBe("client-confidential");
    expect(entry.tags).toContain("classification:client-confidential");
  });

  it("rejects writes below the namespace floor without override", async () => {
    const raw = await callTool("memory_write", {
      namespace: "clients/acme",
      key: "notes",
      content: "too open",
      classification: "public",
    });
    const result = parseToolResponse(raw) as { error: string; message: string };
    expect(result.error).toBe("validation_error");
    expect(result.message).toMatch(/below namespace floor/);
  });

  it("allows owner override for below-floor writes", async () => {
    const raw = await callTool("memory_write", {
      namespace: "clients/acme",
      key: "notes",
      content: "owner override",
      classification: "public",
      classification_override: true,
    });
    const result = parseToolResponse(raw) as { status: string; classification: string };
    expect(result.status).toBe("created");
    expect(result.classification).toBe("public");
  });
});

describe("memory_write patch", () => {
  it("appends content to existing entry", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "line one",
      tags: ["active"],
    });

    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      patch: { content_append: "line two" },
    });
    const result = parseToolResponse(raw) as { status: string; id: string };
    expect(result.status).toBe("patched");

    const readRaw = await callTool("memory_read", { namespace: "projects/test", key: "notes" });
    const entry = parseToolResponse(readRaw) as { content: string; tags: string[] };
    expect(entry.content).toBe("line one\nline two");
    expect(entry.tags).toEqual(["active", "classification:internal"]); // tags unchanged aside from synced classification
  });

  it("prepends content to existing entry", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "line two",
    });

    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      patch: { content_prepend: "line one" },
    });

    const readRaw = await callTool("memory_read", { namespace: "projects/test", key: "notes" });
    const entry = parseToolResponse(readRaw) as { content: string };
    expect(entry.content).toBe("line one\nline two");
  });

  it("adds tags without duplicates", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "hello",
      tags: ["active", "decision"],
    });

    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      patch: { tags_add: ["active", "architecture"] }, // "active" is a duplicate
    });

    const readRaw = await callTool("memory_read", { namespace: "projects/test", key: "notes" });
    const entry = parseToolResponse(readRaw) as { tags: string[] };
    expect(entry.tags).toEqual(["active", "decision", "architecture", "classification:internal"]);
  });

  it("removes specified tags", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "hello",
      tags: ["active", "decision", "architecture"],
    });

    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      patch: { tags_remove: ["decision"] },
    });

    const readRaw = await callTool("memory_read", { namespace: "projects/test", key: "notes" });
    const entry = parseToolResponse(readRaw) as { tags: string[] };
    expect(entry.tags).toEqual(["active", "architecture", "classification:internal"]);
  });

  it("returns not_found for non-existent entry", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "no-such-key",
      patch: { content_append: "hello" },
    });
    const result = parseToolResponse(raw) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found");
  });

  it("rejects patch and content together", async () => {
    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "full write",
      patch: { content_append: "extra" },
    });
    const result = parseToolResponse(raw) as { error: string; message: string };
    expect(result.error).toBe("validation_error");
    expect(result.message).toMatch(/mutually exclusive/);
  });

  it("rejects patch containing a secret in appended content", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "safe content",
    });

    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      patch: { content_append: "token: sk-abcdefghijklmnopqrstuvwxyz" },
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });

  it("rejects patch with invalid tags_add", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      content: "hello",
      tags: ["active"],
    });

    const raw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "notes",
      patch: { tags_add: ["bad tag!"] },
    });
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("validation_error");
  });
});

describe("memory_update_status", () => {
  it("creates a canonical tracked status from structured fields", async () => {
    const raw = await callTool("memory_update_status", {
      namespace: "projects/status-tool",
      phase: "Active",
      current_work: "Implementing structured status updates",
      blockers: "None.",
      next_steps: ["Add tests", "Update docs"],
      lifecycle: "active",
    });
    const result = parseToolResponse(raw) as {
      status: string;
      key: string;
      content: string;
      structured_status: { next_steps: string[] };
    };

    expect(result.status).toBe("created");
    expect(result.key).toBe("status");
    expect(result.content).toContain("## Phase");
    expect(result.content).toContain("## Current Work");
    expect(result.content).toContain("## Blockers");
    expect(result.content).toContain("## Next Steps");
    expect(result.structured_status.next_steps).toEqual(["Add tests", "Update docs"]);
  });

  it("patches only the requested sections and preserves existing values", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/status-tool",
      phase: "Active",
      current_work: "Initial work",
      blockers: "Blocked on review.",
      next_steps: ["Do the first thing"],
      notes: "Carry forward",
      lifecycle: "blocked",
    });

    const raw = await callTool("memory_update_status", {
      namespace: "projects/status-tool",
      blockers: "None.",
      next_steps: ["Ship it"],
      lifecycle: "active",
    });
    const result = parseToolResponse(raw) as {
      status: string;
      structured_status: {
        phase: string;
        current_work: string;
        blockers: string;
        next_steps: string[];
        notes?: string;
      };
      content: string;
    };

    expect(result.status).toBe("updated");
    expect(result.structured_status.phase).toBe("Active");
    expect(result.structured_status.current_work).toBe("Initial work");
    expect(result.structured_status.blockers).toBe("None.");
    expect(result.structured_status.next_steps).toEqual(["Ship it"]);
    expect(result.structured_status.notes).toBe("Carry forward");
    expect(result.content).toContain("- Ship it");
  });

  it("preserves an existing higher classification when not re-specified", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/status-tool",
      phase: "Active",
      current_work: "Sensitive work",
      lifecycle: "active",
      classification: "client-confidential",
    });

    await callTool("memory_update_status", {
      namespace: "projects/status-tool",
      blockers: "None.",
    });

    const readRaw = await callTool("memory_read", {
      namespace: "projects/status-tool",
      key: "status",
    });
    const entry = parseToolResponse(readRaw) as { classification: string; tags: string[] };
    expect(entry.classification).toBe("client-confidential");
    expect(entry.tags).toContain("classification:client-confidential");
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
    const result = parseToolResponse(raw) as {
      found: boolean;
      content: string;
      tags: string[];
      provenance: { principal_id: string };
    };
    expect(result.found).toBe(true);
    expect(result.content).toBe("All good");
    expect(result.tags).toEqual(["active", "classification:internal"]);
    expect(result.provenance.principal_id).toBe("owner");
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

  it("returns expired entries with valid_until and expired flag", async () => {
    await callTool("memory_write", {
      namespace: "projects/test",
      key: "temporary",
      content: "Expired state",
      valid_until: "2020-01-01T00:00:00Z",
    });

    const raw = await callTool("memory_read", {
      namespace: "projects/test",
      key: "temporary",
    });
    const result = parseToolResponse(raw) as { found: boolean; valid_until?: string; expired?: boolean };
    expect(result.found).toBe(true);
    expect(result.valid_until).toBe("2020-01-01T00:00:00.000Z");
    expect(result.expired).toBe(true);
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

  it("returns expired flag on memory_get for expired state entries", async () => {
    const writeRaw = await callTool("memory_write", {
      namespace: "projects/test",
      key: "temporary",
      content: "Expired state",
      valid_until: "2020-01-01T00:00:00Z",
    });
    const writeResult = parseToolResponse(writeRaw) as { id: string };

    const raw = await callTool("memory_get", { id: writeResult.id });
    const result = parseToolResponse(raw) as { found: boolean; valid_until?: string; expired?: boolean };
    expect(result.found).toBe(true);
    expect(result.valid_until).toBe("2020-01-01T00:00:00.000Z");
    expect(result.expired).toBe(true);
  });
});

describe("Librarian direct-entry enforcement", () => {
  beforeEach(() => {
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    delete process.env.MUNIN_REDACTION_LOG_ENABLED;
  });

  afterEach(() => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    delete process.env.MUNIN_REDACTION_LOG_ENABLED;
  });

  it("redacts owner reads on downgraded consumer transport and logs the redaction", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "Active retainer and billing note",
      tags: ["active"],
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool(
      {
        ...ownerContext(),
        transportType: "consumer",
        maxClassification: "internal",
      },
      "owner-consumer-session",
    );

    const raw = await consumerOwnerCall("memory_read", {
      namespace: "clients/lofalk",
      key: "status",
    });
    const result = parseToolResponse(raw) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.redacted).toBe(true);
    expect(result.namespace).toBe("clients/lofalk");
    expect(result.key).toBe("status");
    expect(result.classification).toBe("client-confidential");
    expect(result.content).toBeUndefined();
    expect(result.redaction_reason).toContain("allows up to internal");

    const logRow = db.prepare(
      `SELECT principal_id, transport_type, entry_namespace, entry_classification, connection_max_classification, tool_name
       FROM redaction_log
       WHERE entry_namespace = ?`,
    ).get("clients/lofalk") as {
      principal_id: string;
      transport_type: string;
      entry_namespace: string;
      entry_classification: string;
      connection_max_classification: string;
      tool_name: string;
    };

    expect(logRow).toMatchObject({
      principal_id: "owner",
      transport_type: "consumer",
      entry_namespace: "clients/lofalk",
      entry_classification: "client-confidential",
      connection_max_classification: "internal",
      tool_name: "memory_read",
    });
  });

  it("returns minimal metadata for non-owner redaction on memory_get", async () => {
    const writeRaw = await callTool("memory_write", {
      namespace: "shared/family/calendar",
      key: "events",
      content: "Private client dinner schedule",
      classification: "client-confidential",
    });
    const writeResult = parseToolResponse(writeRaw) as { id: string };

    const familyCall = makeContextCallTool(
      {
        principalId: "sara",
        principalType: "family",
        accessibleNamespaces: [{ pattern: "shared/family/*", permissions: "rw" }],
        transportType: "consumer",
        maxClassification: "internal",
      },
      "family-redaction-session",
    );

    const raw = await familyCall("memory_get", { id: writeResult.id });
    const result = parseToolResponse(raw) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.redacted).toBe(true);
    expect(result.namespace).toBe("shared/family/calendar");
    expect(result.redaction_reason).toBe("Some entries in this namespace exceed your classification level.");
    expect(result.key).toBeUndefined();
    expect(result.classification).toBeUndefined();
    expect(result.tags).toBeUndefined();
    expect(result.content).toBeUndefined();
    expect(result.created_at).toBeUndefined();
    expect(result.updated_at).toBeUndefined();
  });

  it("redacts only over-classified items in memory_read_batch", async () => {
    await callTool("memory_write", {
      namespace: "shared/family/notes",
      key: "visible",
      content: "Internal family note",
    });
    await callTool("memory_write", {
      namespace: "shared/family/notes",
      key: "restricted",
      content: "Client-confidential note",
      classification: "client-confidential",
    });

    const familyCall = makeContextCallTool({
      principalId: "sara",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "shared/family/*", permissions: "rw" }],
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await familyCall("memory_read_batch", {
      reads: [
        { namespace: "shared/family/notes", key: "visible" },
        { namespace: "shared/family/notes", key: "restricted" },
      ],
    });
    const result = parseToolResponse(raw) as { results: Array<Record<string, unknown>> };

    expect(result.results).toHaveLength(2);
    expect(result.results[0].found).toBe(true);
    expect(result.results[0].content).toBe("Internal family note");
    expect(result.results[0].redacted).toBeUndefined();

    expect(result.results[1].found).toBe(true);
    expect(result.results[1].redacted).toBe(true);
    expect(result.results[1].namespace).toBe("shared/family/notes");
    expect(result.results[1].content).toBeUndefined();
  });
});

describe("Librarian Pattern A enforcement for query/list/history", () => {
  beforeEach(() => {
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    delete process.env.MUNIN_REDACTION_LOG_ENABLED;
  });

  afterEach(() => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    delete process.env.MUNIN_REDACTION_LOG_ENABLED;
  });

  it("redacts classified query results for owner consumer transport and suppresses explain metadata", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "Unique billing review marker for classified query result",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_query", {
      query: "Unique billing review marker",
      search_mode: "lexical",
      explain: true,
    });
    const result = parseToolResponse(raw) as {
      total: number;
      redacted_count: number;
      results: Array<Record<string, unknown>>;
    };

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.redacted_count).toBeGreaterThanOrEqual(1);
    expect(result.results[0].redacted).toBe(true);
    expect(result.results[0].namespace).toBe("clients/lofalk");
    expect(result.results[0].classification).toBe("client-confidential");
    expect(result.results[0].content_preview).toBeUndefined();
    expect(result.results[0].match).toBeUndefined();
  });

  it("filters classified key names out of memory_write hints on downgraded transports", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "secret-key",
      content: "Hidden confidential note",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_write", {
      namespace: "clients/lofalk",
      key: "public-note",
      content: "Visible internal note",
      classification: "client-confidential",
    });
    const result = parseToolResponse(raw) as { hint: string };

    expect(result.hint).not.toContain("secret-key");
    expect(result.hint).toBe("No other visible entries in this namespace.");
  });

  it("filters classified key names out of memory_read miss hints on downgraded transports", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "secret-key",
      content: "Hidden confidential note",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_read", {
      namespace: "clients/lofalk",
      key: "missing-key",
    });
    const result = parseToolResponse(raw) as { found: boolean; hint: string };

    expect(result.found).toBe(false);
    expect(result.hint).not.toContain("secret-key");
    expect(result.hint).toBe('No visible entries found in namespace "clients/lofalk".');
  });

  it("uses minimal metadata for non-owner redacted query results", async () => {
    await callTool("memory_write", {
      namespace: "shared/family/notes",
      key: "private-client",
      content: "Family-visible namespace but classified note marker",
      classification: "client-confidential",
    });

    const familyCall = makeContextCallTool({
      principalId: "sara",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "shared/family/*", permissions: "rw" }],
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await familyCall("memory_query", {
      query: "classified note marker",
      search_mode: "lexical",
      explain: true,
    });
    const result = parseToolResponse(raw) as { results: Array<Record<string, unknown>> };

    expect(result.results[0].redacted).toBe(true);
    expect(result.results[0].namespace).toBe("shared/family/notes");
    expect(result.results[0].redaction_reason).toBe("Some entries in this namespace exceed your classification level.");
    expect(result.results[0].id).toBeUndefined();
    expect(result.results[0].key).toBeUndefined();
    expect(result.results[0].classification).toBeUndefined();
    expect(result.results[0].content_preview).toBeUndefined();
    expect(result.results[0].match).toBeUndefined();
  });

  it("redacts previews in memory_list for classified state and log entries", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "List preview should not leak",
      classification: "client-confidential",
    });
    await callTool("memory_log", {
      namespace: "clients/lofalk",
      content: "List log preview should not leak",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_list", { namespace: "clients/lofalk" });
    const result = parseToolResponse(raw) as {
      state_entries: Array<Record<string, unknown>>;
      log_summary: { recent: Array<Record<string, unknown>> };
    };

    expect(result.state_entries[0].redacted).toBe(true);
    expect(result.state_entries[0].classification).toBe("client-confidential");
    expect(result.state_entries[0].preview).toBeUndefined();

    expect(result.log_summary.recent[0].redacted).toBe(true);
    expect(result.log_summary.recent[0].classification).toBe("client-confidential");
    expect(result.log_summary.recent[0].content_preview).toBeUndefined();
  });

  it("hides classified-only namespaces and uses visible aggregate counts in memory_list", async () => {
    await callTool("memory_write", {
      namespace: "projects/internal",
      key: "status",
      content: "Visible internal status",
    });
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "Classified namespace should disappear from top-level list",
      classification: "client-confidential",
    });
    await callTool("memory_write", {
      namespace: "shared/family/mixed",
      key: "status",
      content: "Visible mixed namespace status",
    });
    await callTool("memory_log", {
      namespace: "shared/family/mixed",
      content: "Visible mixed namespace log",
    });
    await callTool("memory_log", {
      namespace: "shared/family/mixed",
      content: "Hidden mixed namespace log",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const topLevelRaw = await consumerOwnerCall("memory_list", {});
    const topLevelResult = parseToolResponse(topLevelRaw) as {
      total: number;
      namespaces: Array<{ namespace: string; log_count: number }>;
    };
    const listedNamespaces = topLevelResult.namespaces.map((entry) => entry.namespace);

    expect(listedNamespaces).toContain("projects/internal");
    expect(listedNamespaces).toContain("shared/family/mixed");
    expect(listedNamespaces).not.toContain("clients/lofalk");
    expect(topLevelResult.total).toBe(2);
    expect(topLevelResult.namespaces.find((entry) => entry.namespace === "shared/family/mixed")?.log_count).toBe(1);

    const detailRaw = await consumerOwnerCall("memory_list", { namespace: "shared/family/mixed" });
    const detailResult = parseToolResponse(detailRaw) as {
      log_summary: { log_count: number; recent: Array<Record<string, unknown>> };
    };

    expect(detailResult.log_summary.log_count).toBe(1);
    expect(detailResult.log_summary.recent).toHaveLength(2);
    expect(detailResult.log_summary.recent.some((entry) => entry.redacted === true)).toBe(true);
  });

  it("filters classified keys and counts out of memory_delete preview on downgraded transports", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "secret-key",
      content: "Hidden confidential note",
      classification: "client-confidential",
    });
    await callTool("memory_log", {
      namespace: "clients/lofalk",
      content: "Hidden confidential log",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_delete", { namespace: "clients/lofalk" });
    const result = parseToolResponse(raw) as {
      phase: string;
      will_delete: { state_count: number; log_count: number; keys?: string[] };
      message: string;
    };

    expect(result.phase).toBe("preview");
    expect(result.will_delete.state_count).toBe(0);
    expect(result.will_delete.log_count).toBe(0);
    expect(result.will_delete.keys).toBeUndefined();
    expect(result.message).toContain("visible entries on this connection");
  });

  it("confirmed delete only removes entries within classification ceiling", async () => {
    // projects/* floor is "internal", so we can write both internal and client-confidential
    await callTool("memory_write", {
      namespace: "projects/delete-test",
      key: "visible-note",
      content: "Visible internal note",
      classification: "internal",
    });
    await callTool("memory_write", {
      namespace: "projects/delete-test",
      key: "secret-note",
      content: "Hidden confidential note",
      classification: "client-confidential",
    });
    await callTool("memory_log", {
      namespace: "projects/delete-test",
      content: "Internal log entry",
      classification: "internal",
    });
    await callTool("memory_log", {
      namespace: "projects/delete-test",
      content: "Confidential log entry",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    // Preview — should only show the internal entry
    const previewRaw = await consumerOwnerCall("memory_delete", { namespace: "projects/delete-test" });
    const preview = parseToolResponse(previewRaw) as {
      phase: string;
      will_delete: { state_count: number; log_count: number; keys?: string[] };
      delete_token: string;
    };
    expect(preview.phase).toBe("preview");
    expect(preview.will_delete.state_count).toBe(1);
    expect(preview.will_delete.keys).toEqual(["visible-note"]);
    expect(preview.will_delete.log_count).toBe(1);

    // Confirm — should only delete the internal entries, not the confidential ones
    const deleteRaw = await consumerOwnerCall("memory_delete", {
      namespace: "projects/delete-test",
      delete_token: preview.delete_token,
    });
    const deleteResult = parseToolResponse(deleteRaw) as {
      phase: string;
      deleted_count: number;
    };
    expect(deleteResult.phase).toBe("confirmed");
    expect(deleteResult.deleted_count).toBe(2); // 1 state + 1 log (internal only)

    // Verify: confidential entries still exist
    const confidentialState = db.prepare(
      "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
    ).get("projects/delete-test", "secret-note") as { id: string } | undefined;
    expect(confidentialState).toBeDefined();

    const confidentialLog = db.prepare(
      "SELECT COUNT(*) AS cnt FROM entries WHERE namespace = ? AND entry_type = 'log' AND classification = 'client-confidential'",
    ).get("projects/delete-test") as { cnt: number };
    expect(confidentialLog.cnt).toBe(1);
  });

  it("redacts audit detail in memory_history for classified entries", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "History billing note should not leak",
      classification: "client-confidential",
    });
    await callTool("memory_log", {
      namespace: "clients/lofalk",
      content: "History log note should not leak",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_history", { namespace: "clients/lofalk" });
    const result = parseToolResponse(raw) as { entries: Array<Record<string, unknown>> };

    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of result.entries) {
      expect(entry.namespace).toBe("clients/lofalk");
      expect(entry.redacted).toBe(true);
      expect(entry.detail).toBeNull();
      expect(entry.classification).toBe("client-confidential");
    }
    expect(result.entries.some((entry) => String(entry.detail ?? "").includes("should not leak"))).toBe(false);
  });

  it("fails closed for deleted-entry audit history and logs the redaction", async () => {
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "Deleted audit detail should not leak after source removal",
      classification: "client-confidential",
    });
    db.prepare(
      "DELETE FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
    ).run("clients/lofalk", "status");

    const consumerOwnerCall = makeContextCallTool(
      {
        ...ownerContext(),
        transportType: "consumer",
        maxClassification: "internal",
      },
      "history-deleted-source-session",
    );

    const raw = await consumerOwnerCall("memory_history", { namespace: "clients/lofalk" });
    const result = parseToolResponse(raw) as { entries: Array<Record<string, unknown>> };

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every((entry) => entry.redacted === true)).toBe(true);
    expect(result.entries.every((entry) => entry.detail === null)).toBe(true);
    expect(result.entries.every((entry) => entry.classification === "client-restricted")).toBe(true);

    const redactionCount = db.prepare(
      "SELECT COUNT(*) AS count FROM redaction_log WHERE tool_name = 'memory_history' AND entry_namespace = ?",
    ).get("clients/lofalk") as { count: number };
    expect(redactionCount.count).toBeGreaterThan(0);
  });
});

describe("Librarian Pattern B enforcement for derived tools", () => {
  beforeEach(() => {
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    delete process.env.MUNIN_REDACTION_LOG_ENABLED;
  });

  afterEach(() => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    delete process.env.MUNIN_REDACTION_LOG_ENABLED;
  });

  it("omits classified tracked statuses from memory_orient and reports them in Librarian metadata", async () => {
    await callTool("memory_write", {
      namespace: "projects/internal",
      key: "status",
      content: "Internal project status",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "clients/lofalk",
      key: "status",
      content: "Client-confidential tracked status",
      tags: ["active"],
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: Record<string, Array<{ namespace: string }>>;
      librarian_summary: {
        enabled: boolean;
        transport_type: string;
        max_classification: string;
        redacted_dashboard_count?: number;
        redacted_source_count?: number;
      };
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    const dashboardNamespaces = Object.values(result.dashboard).flat().map((entry) => entry.namespace);
    expect(dashboardNamespaces).toContain("projects/internal");
    expect(dashboardNamespaces).not.toContain("clients/lofalk");
    expect(result.librarian_summary).toMatchObject({
      enabled: true,
      transport_type: "consumer",
      max_classification: "internal",
      redacted_dashboard_count: 1,
    });
    expect(result.redacted_sources).toMatchObject({
      count: 1,
    });
    expect(result.redacted_sources?.namespaces).toContain("clients/lofalk");
  });

  it("hides classified-only namespaces from orient namespace overview and missing-status synthesis", async () => {
    await callTool("memory_write", {
      namespace: "projects/visible-no-status",
      key: "notes",
      content: "Visible project notes without a status entry",
    });
    await callTool("memory_write", {
      namespace: "projects/private-no-status",
      key: "notes",
      content: "Hidden project notes without a status entry",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_orient", { include_namespaces: true });
    const result = parseToolResponse(raw) as {
      namespaces: Array<{ namespace: string }>;
      maintenance_needed: Array<{ namespace: string; issue: string }>;
    };

    expect(result.namespaces.map((entry) => entry.namespace)).toContain("projects/visible-no-status");
    expect(result.namespaces.map((entry) => entry.namespace)).not.toContain("projects/private-no-status");
    expect(result.maintenance_needed).toContainEqual(expect.objectContaining({
      namespace: "projects/visible-no-status",
      issue: "missing_status",
    }));
    expect(result.maintenance_needed).not.toContainEqual(expect.objectContaining({
      namespace: "projects/private-no-status",
      issue: "missing_status",
    }));
  });

  it("returns partial or empty resume packs when all matching sources are filtered", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/client-rollout",
      phase: "Active",
      current_work: "Confidential rollout",
      blockers: "None.",
      next_steps: ["Call the client by 2026-04-10"],
      lifecycle: "active",
      classification: "client-confidential",
    });
    await callTool("memory_log", {
      namespace: "projects/client-rollout",
      content: "Decided to keep the rollout details private.",
      tags: ["decision"],
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_resume", {
      namespace: "projects/client-rollout",
      include_history: true,
    });
    const result = parseToolResponse(raw) as {
      target_namespace?: string;
      items: Array<unknown>;
      open_loops: Array<unknown>;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.target_namespace).toBe("projects/client-rollout");
    expect(result.items).toHaveLength(0);
    expect(result.open_loops).toHaveLength(0);
    expect(result.redacted_sources).toMatchObject({ count: expect.any(Number) });
    expect(result.redacted_sources?.count).toBeGreaterThan(0);
    expect(result.redacted_sources?.namespaces).toContain("projects/client-rollout");
  });

  it("does not infer hidden namespaces in memory_resume from filtered tracked statuses", async () => {
    await callTool("memory_update_status", {
      namespace: "clients/lofalk",
      phase: "Active",
      current_work: "Hidden client rollout",
      blockers: "None.",
      next_steps: ["Keep this private"],
      lifecycle: "active",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_resume", { project: "lofalk" });
    const result = parseToolResponse(raw) as {
      target_namespace?: string;
      items: Array<{ namespace: string }>;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.target_namespace).toBe("projects/lofalk");
    expect(result.items).toHaveLength(0);
    expect(result.redacted_sources?.count).toBeGreaterThan(0);
    expect(result.redacted_sources?.namespaces).toContain("clients/lofalk");
  });

  it("filters hidden scope inference and related entries in memory_extract", async () => {
    await callTool("memory_update_status", {
      namespace: "clients/lofalk",
      phase: "Active",
      current_work: "Hidden extract target",
      blockers: "None.",
      next_steps: ["Keep private notes in this namespace"],
      lifecycle: "active",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_extract", {
      conversation_text: "We decided to keep the billing notes private for now.",
      project_hint: "lofalk",
    });
    const result = parseToolResponse(raw) as {
      suggestions: Array<{ namespace: string }>;
      candidate_namespaces: string[];
      related_entries: Array<unknown>;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.candidate_namespaces).not.toContain("clients/lofalk");
    expect(result.related_entries).toHaveLength(0);
    expect(result.suggestions.every((suggestion) => suggestion.namespace !== "clients/lofalk")).toBe(true);
    expect(result.redacted_sources?.count).toBeGreaterThan(0);
    expect(result.redacted_sources?.namespaces).toContain("clients/lofalk");
  });

  it("does not derive commitments from filtered source entries on downgraded transports", async () => {
    db.prepare(
      `INSERT INTO entries
         (id, namespace, key, entry_type, content, tags, agent_id, owner_principal_id, created_at, updated_at, valid_until, classification)
       VALUES (?, ?, ?, 'state', ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      "private-followthrough-status",
      "projects/client-followthrough",
      "status",
      [
        "## Phase",
        "Active",
        "",
        "## Current Work",
        "Private follow-through",
        "",
        "## Blockers",
        "None.",
        "",
        "## Next Steps",
        "- Send the private deck by 2026-04-10",
      ].join("\n"),
      JSON.stringify(["active", "classification:client-confidential"]),
      "owner",
      "owner",
      "2026-04-02T12:00:00.000Z",
      "2026-04-02T12:00:00.000Z",
      "client-confidential",
    );

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_commitments", {
      namespace: "projects/client-followthrough",
    });
    const result = parseToolResponse(raw) as {
      open: Array<unknown>;
      at_risk: Array<unknown>;
      overdue: Array<unknown>;
      completed_recently: Array<unknown>;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.open).toHaveLength(0);
    expect(result.at_risk).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
    expect(result.completed_recently).toHaveLength(0);
    expect(result.redacted_sources?.count).toBeGreaterThan(0);
    expect(result.redacted_sources?.namespaces).toContain("projects/client-followthrough");

    const commitmentCount = db.prepare("SELECT COUNT(*) AS count FROM commitments").get() as { count: number };
    expect(commitmentCount.count).toBe(0);
  });

  it("does not mine classified decision logs in memory_patterns", async () => {
    for (const content of [
      "Decision: lofalk pricing review stays private until Monday.",
      "Decided again that lofalk pricing review remains private until Monday.",
      "Decision review: lofalk pricing review remains the recurring concern.",
    ]) {
      await callTool("memory_log", {
        namespace: "projects/private-patterns",
        content,
        tags: ["decision"],
        classification: "client-confidential",
      });
    }

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_patterns", {
      namespace: "projects/private-patterns",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<unknown>;
      heuristics: Array<unknown>;
      supporting_sources: Array<unknown>;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.patterns).toHaveLength(0);
    expect(result.heuristics).toHaveLength(0);
    expect(result.supporting_sources).toHaveLength(0);
    expect(result.redacted_sources?.count).toBeGreaterThanOrEqual(3);
    expect(result.redacted_sources?.namespaces).toContain("projects/private-patterns");
  });

  it("returns an empty handoff pack with redacted source metadata when all inputs are filtered", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/private-handoff",
      phase: "Blocked",
      current_work: "Confidential handoff",
      blockers: "Waiting on the client.",
      next_steps: ["Retry the call on 2026-04-09"],
      lifecycle: "blocked",
      classification: "client-confidential",
    });
    await callTool("memory_log", {
      namespace: "projects/private-handoff",
      content: "Decision: keep this handoff private.",
      tags: ["decision"],
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_handoff", {
      namespace: "projects/private-handoff",
    });
    const result = parseToolResponse(raw) as {
      found: boolean;
      current_state: unknown;
      recent_decisions: Array<unknown>;
      open_loops: Array<unknown>;
      recent_actors: Array<unknown>;
      recommended_next_actions: Array<unknown>;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.found).toBe(false);
    expect(result.current_state).toBeNull();
    expect(result.recent_decisions).toHaveLength(0);
    expect(result.open_loops).toHaveLength(0);
    expect(result.recent_actors).toHaveLength(0);
    expect(result.recommended_next_actions).toHaveLength(0);
    expect(result.redacted_sources?.count).toBeGreaterThan(0);
    expect(result.redacted_sources?.namespaces).toContain("projects/private-handoff");
  });

  it("does not surface false missing-status items when attention-worthy statuses are only redacted by classification", async () => {
    await callTool("memory_write", {
      namespace: "projects/private-attention",
      key: "status",
      content: "Blocked confidential status",
      tags: ["blocked"],
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_attention", {
      namespace_prefix: "projects/private-attention",
    });
    const result = parseToolResponse(raw) as {
      items: Array<{ category: string }>;
      message?: string;
      redacted_sources?: { count: number; namespaces?: string[] };
    };

    expect(result.items).toHaveLength(0);
    expect(result.message).toBe("No attention items are visible on this connection.");
    expect(result.redacted_sources?.count).toBeGreaterThan(0);
    expect(result.redacted_sources?.namespaces).toContain("projects/private-attention");
  });

  it("does not surface classified-only namespaces as missing-status attention items", async () => {
    await callTool("memory_write", {
      namespace: "projects/private-no-status",
      key: "notes",
      content: "Hidden namespace notes",
      classification: "client-confidential",
    });

    const consumerOwnerCall = makeContextCallTool({
      ...ownerContext(),
      transportType: "consumer",
      maxClassification: "internal",
    });

    const raw = await consumerOwnerCall("memory_attention", {
      namespace_prefix: "projects/private-no-status",
    });
    const result = parseToolResponse(raw) as {
      items: Array<{ namespace: string; category: string }>;
    };

    expect(result.items).toHaveLength(0);
    expect(result.items).not.toContainEqual(expect.objectContaining({
      namespace: "projects/private-no-status",
      category: "missing_status",
    }));
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
    const result = parseToolResponse(raw) as {
      results: Array<{ id: string; provenance: { principal_id: string } }>;
      total: number;
      search_mode: string;
    };
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.results[0].id).toBeTruthy();
    expect(result.results[0].provenance.principal_id).toBe("owner");
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

  it("excludes expired state entries from query results by default", async () => {
    await callTool("memory_write", {
      namespace: "projects/expired",
      key: "status",
      content: "SQLite phase plan",
      tags: ["active"],
      valid_until: "2020-01-01T00:00:00Z",
    });

    const raw = await callTool("memory_query", { query: "SQLite phase plan", search_mode: "lexical" });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string }>;
      retrieval: { expired_filtered_count: number };
    };

    expect(result.results).not.toContainEqual(expect.objectContaining({ namespace: "projects/expired" }));
    expect(result.retrieval.expired_filtered_count).toBeGreaterThanOrEqual(1);
  });

  it("includes expired state entries when include_expired is true", async () => {
    await callTool("memory_write", {
      namespace: "projects/expired",
      key: "status",
      content: "SQLite phase plan",
      tags: ["active"],
      valid_until: "2020-01-01T00:00:00Z",
    });

    const raw = await callTool("memory_query", {
      query: "SQLite phase plan",
      search_mode: "lexical",
      include_expired: true,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string; expired?: boolean; valid_until?: string }>;
      retrieval: { expired_filtered_count: number };
    };

    expect(result.results).toContainEqual(expect.objectContaining({
      namespace: "projects/expired",
      expired: true,
      valid_until: "2020-01-01T00:00:00.000Z",
    }));
    expect(result.retrieval.expired_filtered_count).toBe(0);
  });

  it("promotes fresher equivalent entries by default", async () => {
    await callTool("memory_write", {
      namespace: "projects/old-recency",
      key: "status",
      content: "Recency ranking candidate",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/fresh-recency",
      key: "status",
      content: "Recency ranking candidate",
      tags: ["active"],
    });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/old-recency'").run();

    const raw = await callTool("memory_query", {
      query: "Recency ranking candidate",
      search_mode: "lexical",
      limit: 2,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string }>;
      retrieval: { recency_applied: boolean; search_recency_weight: number };
    };

    expect(result.results[0].namespace).toBe("projects/fresh-recency");
    expect(result.retrieval.recency_applied).toBe(true);
    expect(result.retrieval.search_recency_weight).toBe(0.2);
  });

  it("search_recency_weight 0 preserves previous candidate ordering", async () => {
    await callTool("memory_write", {
      namespace: "projects/old-recency",
      key: "status",
      content: "Recency ranking candidate",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/fresh-recency",
      key: "status",
      content: "Recency ranking candidate",
      tags: ["active"],
    });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/old-recency'").run();

    const raw = await callTool("memory_query", {
      query: "Recency ranking candidate",
      search_mode: "lexical",
      search_recency_weight: 0,
      limit: 2,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string }>;
      retrieval: { recency_applied: boolean; search_recency_weight: number };
    };

    expect(result.results[0].namespace).toBe("projects/old-recency");
    expect(result.retrieval.recency_applied).toBe(false);
    expect(result.retrieval.search_recency_weight).toBe(0);
  });

  it("keeps strong tracked-status heuristics above fresher generic noise", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "Current work, blockers, and next steps for the main project.",
      tags: ["active"],
    });
    db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE namespace = 'projects/grimnir'").run();

    await callTool("memory_write", {
      namespace: "notes/fresh-noise",
      key: "summary",
      content: "Current work blockers next steps generic fresh note.",
    });

    const raw = await callTool("memory_query", {
      query: "current work blockers next steps",
      search_mode: "lexical",
      limit: 3,
    });
    const result = parseToolResponse(raw) as { results: Array<{ namespace: string; key: string | null }> };

    expect(result.results[0]).toEqual(expect.objectContaining({
      namespace: "projects/grimnir",
      key: "status",
    }));
  });

  it("suppresses demo namespaces for broad queries by default", async () => {
    await callTool("memory_write", {
      namespace: "demo/test-person",
      key: "status",
      content: "Orientation notes for a demo profile",
      tags: ["demo"],
    });
    await callTool("memory_write", {
      namespace: "people/magnus",
      key: "profile",
      content: "Orientation notes for the real profile",
      tags: ["profile"],
    });

    const raw = await callTool("memory_query", { query: "orientation notes profile" });
    const result = parseToolResponse(raw) as { results: Array<{ namespace: string }> };
    const namespaces = result.results.map((r) => r.namespace);

    expect(namespaces).toContain("people/magnus");
    expect(namespaces).not.toContain("demo/test-person");
  });

  it("suppresses completed task namespaces for broad queries by default", async () => {
    await callTool("memory_write", {
      namespace: "tasks/20260327-done",
      key: "status",
      content: "Parser rollout completed successfully",
      tags: ["completed"],
    });
    await callTool("memory_write", {
      namespace: "projects/hugin",
      key: "status",
      content: "Parser rollout active and evolving",
      tags: ["active"],
    });

    const raw = await callTool("memory_query", { query: "parser rollout" });
    const result = parseToolResponse(raw) as { results: Array<{ namespace: string }> };
    const namespaces = result.results.map((r) => r.namespace);

    expect(namespaces).toContain("projects/hugin");
    expect(namespaces).not.toContain("tasks/20260327-done");
  });

  it("boosts profile entries above secondary person records", async () => {
    await callTool("memory_write", {
      namespace: "people/magnus",
      key: "employment",
      content: "Magnus employment and collaboration details",
      tags: ["employment"],
    });
    await callTool("memory_write", {
      namespace: "people/magnus",
      key: "profile",
      content: "Magnus profile with collaboration style and working preferences",
      tags: ["profile"],
    });

    const raw = await callTool("memory_query", {
      query: "Magnus collaboration style",
      namespace: "people/",
    });
    const result = parseToolResponse(raw) as { results: Array<{ key: string | null }> };

    expect(result.results[0].key).toBe("profile");
  });

  it("prioritizes live project status and profile context for broad orientation queries", async () => {
    await callTool("memory_write", {
      namespace: "people/magnus",
      key: "profile",
      content: "Magnus profile with personal context, collaboration style, decision-making, and practical working preferences",
      tags: ["profile", "person:magnus"],
    });
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Vision\nSystem architecture\n\n## Current Work\nActive work and current blockers are tracked here.\n\n## Blockers\nOne blocker.\n\n## Next Steps\nTwo next steps.",
      tags: ["active"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-memory",
      content: "Usability-priority debate round 2 about compact conventions and context tax",
      tags: ["decision"],
    });
    await callTool("memory_write", {
      namespace: "demo/people/astrid-lindqvist",
      key: "status",
      content: "Demo profile with collaboration style and orientation notes",
      tags: ["demo", "person"],
    });
    await callTool("memory_write", {
      namespace: "tasks/20260327-dream-project",
      key: "status",
      content: "Important personal context and active work from a completed task",
      tags: ["completed"],
    });

    const raw = await callTool("memory_query", {
      query: "How should I orient myself to active work and important personal context?",
      search_mode: "hybrid",
      limit: 6,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string; key: string | null }>;
    };

    expect(result.results.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "projects/grimnir",
      key: "status",
    }));
    expect(result.results.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "people/magnus",
      key: "profile",
    }));
    expect(result.results).not.toContainEqual(expect.objectContaining({
      namespace: "demo/people/astrid-lindqvist",
    }));
    expect(result.results).not.toContainEqual(expect.objectContaining({
      namespace: "tasks/20260327-dream-project",
    }));
  });

  it("injects canonical orientation entries for broad catch-up queries", async () => {
    await callTool("memory_write", {
      namespace: "meta",
      key: "reference-index",
      content: "Session-start reference index for Magnus profile and conventions",
      tags: ["convention"],
    });
    await callTool("memory_write", {
      namespace: "people/magnus",
      key: "profile",
      content: "Magnus profile with collaboration context and working style",
      tags: ["profile", "person:magnus"],
    });
    await callTool("memory_write", {
      namespace: "clients/daniel-norin",
      key: "status",
      content: "Magnus is working on a proposal and hackathon follow-up for Photowall",
      tags: ["active", "client"],
    });
    await callTool("memory_write", {
      namespace: "projects/gille-ai",
      key: "status",
      content: "Current work includes website updates and new case studies",
      tags: ["active"],
    });

    const raw = await callTool("memory_query", {
      query: "orient me to what Magnus is working on and what I should know",
      search_mode: "hybrid",
      limit: 5,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string; key: string | null }>;
    };

    expect(result.results.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "meta",
      key: "reference-index",
    }));
    expect(result.results.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "people/magnus",
      key: "profile",
    }));
  });

  it("injects blocked and needs-attention statuses for triage queries", async () => {
    const upcomingDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await callTool("memory_write", {
      namespace: "projects/release-train",
      key: "status",
      content: "## Current Work\nWaiting on external approval before launch.\n\n## Blockers\nVendor sign-off is missing.\n\n## Next Steps\nFollow up and unblock rollout.",
      tags: ["blocked"],
    });
    await callTool("memory_write", {
      namespace: "projects/hackathon-web",
      key: "status",
      content: `**Phase:** Active — event ${upcomingDate}\n\n**Current work:** Final venue logistics and attendee messaging.\n\n**Blockers:** None`,
      tags: ["active", "event"],
    });
    db.prepare(
      "UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'status' AND entry_type = 'state'",
    ).run(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), "projects/hackathon-web");
    await callTool("memory_write", {
      namespace: "projects/gille-ai",
      key: "status",
      content: "## Current Work\nStable website work with no blockers.\n\n## Next Steps\nPublish another blog post.",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "tasks",
      key: "index",
      content: "Project list and operational checklist index",
      tags: ["tasks", "active"],
    });

    const raw = await callTool("memory_query", {
      query: "what projects are blocked or need attention right now",
      search_mode: "hybrid",
      limit: 5,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string; key: string | null }>;
    };

    expect(result.results.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "projects/release-train",
      key: "status",
    }));
    expect(result.results.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "projects/hackathon-web",
      key: "status",
    }));
  });

  it("prioritizes attention-worthy statuses above generic task and active-project noise", async () => {
    const upcomingDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await callTool("memory_write", {
      namespace: "projects/hackathon-web",
      key: "status",
      content: `**Phase:** Active — event ${upcomingDate}\n\n**Current work:** Final venue logistics and attendee messaging.\n\n**Blockers:** None`,
      tags: ["active", "event"],
    });
    db.prepare(
      "UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'status' AND entry_type = 'state'",
    ).run(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(), "projects/hackathon-web");
    await callTool("memory_write", {
      namespace: "projects/gille-ai",
      key: "status",
      content: "Attention is on routine content updates, but nothing is at risk.",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "tasks",
      key: "index",
      content: "Attention checklist and task categories",
      tags: ["tasks", "active"],
    });

    const raw = await callTool("memory_query", {
      query: "what needs attention",
      search_mode: "hybrid",
      limit: 5,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string; key: string | null }>;
    };

    expect(result.results[0]).toEqual(expect.objectContaining({
      namespace: "projects/hackathon-web",
      key: "status",
    }));
    expect(result.results[0]).not.toEqual(expect.objectContaining({
      namespace: "tasks",
      key: "index",
    }));
  });

  it("prioritizes project status entries over tombstones and logs in project-scoped queries", async () => {
    await callTool("memory_write", {
      namespace: "projects/hugin",
      key: "status",
      content: "## Vision\nTask dispatcher\n\n## Current Work\nEnhanced task parser shipped.\n\n## Blockers\nNone.\n\n## Next Steps\nProgress streaming.",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/hackathon-2026",
      key: "status",
      content: "**TOMBSTONE** — Active work moved elsewhere.",
      tags: ["archived"],
    });
    await callTool("memory_log", {
      namespace: "projects/hugin",
      content: "Morning session: task parser and task logging updates",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_query", {
      query: "active work current blockers next steps",
      namespace: "projects/",
      search_mode: "hybrid",
      limit: 5,
    });
    const result = parseToolResponse(raw) as {
      results: Array<{ namespace: string; key: string | null }>;
    };

    expect(result.results[0]).toEqual(expect.objectContaining({
      namespace: "projects/hugin",
      key: "status",
    }));
    expect(result.results.at(-1)).not.toEqual(expect.objectContaining({
      namespace: "projects/hackathon-2026",
      key: "status",
    }));
  });

  it("returns explainability metadata when explain is true", async () => {
    const raw = await callTool("memory_query", {
      query: "SQLite memory",
      search_mode: "lexical",
      explain: true,
    });
    const result = parseToolResponse(raw) as {
      retrieval: { reranked: boolean; relaxed_lexical: boolean; fallback_reason: string | null };
      results: Array<{ match?: { heuristic_score: number; lexical_rank?: number; reasons: string[] } }>;
    };

    expect(result.retrieval.reranked).toBe(true);
    expect(result.retrieval.relaxed_lexical).toBe(false);
    expect(result.retrieval.fallback_reason).toBeNull();
    expect(result.results[0].match?.heuristic_score).toBeTypeOf("number");
    expect(result.results[0].match?.lexical_rank).toBe(1);
    expect(result.results[0].match?.reasons).toContain("matched lexical terms");
  });

  it("reports fallback reason in explain mode when semantic search degrades", async () => {
    const raw = await callTool("memory_query", {
      query: "SQLite",
      search_mode: "semantic",
      explain: true,
    });
    const result = parseToolResponse(raw) as {
      search_mode_actual?: string;
      retrieval?: { fallback_reason: string | null };
    };

    expect(result.search_mode_actual).toBe("lexical");
    expect(result.retrieval?.fallback_reason).toBeTruthy();
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

  it("defaults log classification from the namespace floor", async () => {
    const raw = await callTool("memory_log", {
      namespace: "clients/acme",
      content: "Client call notes",
    });
    const result = parseToolResponse(raw) as { id: string; classification: string };
    expect(result.classification).toBe("client-confidential");

    const getRaw = await callTool("memory_get", { id: result.id });
    const entry = parseToolResponse(getRaw) as { classification: string; tags: string[] };
    expect(entry.classification).toBe("client-confidential");
    expect(entry.tags).toContain("classification:client-confidential");
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
      state_entries: Array<{ id: string; key: string; provenance: { principal_id: string } }>;
      log_summary: { log_count: number; recent: Array<{ id: string; provenance: { principal_id: string } }> };
    };
    expect(result.state_entries).toHaveLength(2);
    expect(result.state_entries[0].id).toBeTruthy();
    expect(result.state_entries[0].provenance.principal_id).toBe("owner");
    expect(result.log_summary.log_count).toBe(1);
    expect(result.log_summary.recent[0].provenance.principal_id).toBe("owner");
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
      ok: boolean;
      action: string;
      phase: string;
      delete_token: string;
      will_delete: { state_count: number };
    };
    expect(result.ok).toBe(true);
    expect(result.action).toBe("delete");
    expect(result.phase).toBe("preview");
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
    const deleteResult = parseToolResponse(deleteRaw) as { ok: boolean; action: string; phase: string; deleted_count: number };
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.action).toBe("delete");
    expect(deleteResult.phase).toBe("confirmed");
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

    const raw = await callTool("memory_orient", { include_namespaces: true });
    const result = parseToolResponse(raw) as { namespaces: Array<{ namespace: string }> };
    const names = result.namespaces.map((n) => n.namespace);
    expect(names).toContain("projects/real");
    expect(names).not.toContain("demo/test");
  });

  it("shows demo namespaces when include_demo is true", async () => {
    await callTool("memory_write", { namespace: "projects/real", key: "s", content: "c" });
    await callTool("memory_write", { namespace: "demo/test", key: "s", content: "c" });

    const raw = await callTool("memory_orient", { include_demo: true, include_namespaces: true });
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
    // compact default does not include namespaces unless include_namespaces is set
    expect(result.namespaces).toBeUndefined();
  });

  it("supports compact detail with dashboard truncation and no namespaces by default", async () => {
    await callTool("memory_write", {
      namespace: "meta/conventions",
      key: "conventions",
      content: "# Conventions\nUse memory_orient first.",
    });
    for (let i = 0; i < 6; i++) {
      await callTool("memory_write", {
        namespace: `projects/compact-${i}`,
        key: "status",
        content: `Active project ${i}`,
        tags: ["active"],
      });
    }

    const raw = await callTool("memory_orient", { detail: "compact" });
    const result = parseToolResponse(raw) as {
      namespaces?: Array<unknown>;
      dashboard: { active: Array<unknown> };
      dashboard_meta: { counts: Record<string, number>; truncated_groups: string[] };
      conventions: { compact?: boolean };
    };

    expect(result.conventions.compact).toBe(true);
    expect(result.namespaces).toBeUndefined();
    expect(result.dashboard.active).toHaveLength(5);
    expect(result.dashboard_meta.counts.active).toBe(6);
    expect(result.dashboard_meta.truncated_groups).toContain("active");
  });

  it("honors namespace_limit when namespaces are included", async () => {
    await callTool("memory_write", { namespace: "projects/a", key: "status", content: "A", tags: ["active"] });
    await callTool("memory_write", { namespace: "projects/b", key: "status", content: "B", tags: ["active"] });

    const raw = await callTool("memory_orient", {
      detail: "compact",
      include_namespaces: true,
      namespace_limit: 1,
    });
    const result = parseToolResponse(raw) as {
      namespaces: Array<{ namespace: string }>;
      namespaces_meta: { total: number; returned: number; truncated: boolean };
    };

    expect(result.namespaces).toHaveLength(1);
    expect(result.namespaces_meta.total).toBeGreaterThan(1);
    expect(result.namespaces_meta.returned).toBe(1);
    expect(result.namespaces_meta.truncated).toBe(true);
  });
});

describe("synthesis freshness metadata", () => {
  it("memory_orient includes synthesis_age_days, logs_incorporated, and origin when synthesis exists", async () => {
    // Write status and synthesis entries
    await callTool("memory_write", {
      namespace: "projects/synth-test",
      key: "status",
      content: "Active project with synthesis",
      tags: ["active"],
    });
    // Write a synthesis entry with a known timestamp
    const synthesisTime = "2026-03-31T12:00:00.000Z";
    await callTool("memory_write", {
      namespace: "projects/synth-test",
      key: "synthesis",
      content: "## Phase: Active\n\nConsolidated synthesis content.",
      tags: ["active"],
    });
    // Backdate synthesis to synthesisTime so age_days is predictable
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'synthesis'").run(
      synthesisTime,
      "projects/synth-test",
    );
    // Write 3 log entries then add consolidation metadata
    await callTool("memory_log", { namespace: "projects/synth-test", content: "Log 1", tags: ["decision"] });
    await callTool("memory_log", { namespace: "projects/synth-test", content: "Log 2", tags: ["milestone"] });
    await callTool("memory_log", { namespace: "projects/synth-test", content: "Log 3", tags: ["decision"] });
    // Backdate all logs so they are before last_log_created_at
    const logTime = "2026-03-30T10:00:00.000Z";
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ? WHERE namespace = ? AND entry_type = 'log'").run(
      logTime,
      logTime,
      "projects/synth-test",
    );
    // Insert consolidation metadata referencing all 3 logs
    upsertConsolidationMetadata(db, {
      namespace: "projects/synth-test",
      last_consolidated_at: synthesisTime,
      last_log_id: null,
      last_log_created_at: logTime,
      synthesis_model: "test-model",
      synthesis_token_count: 800,
      run_duration_ms: 500,
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: {
        active: Array<{
          namespace: string;
          synthesis?: {
            synthesis_age_days: number;
            logs_incorporated: number | null;
            origin: string;
          };
        }>;
      };
    };

    const entry = result.dashboard.active.find((e) => e.namespace === "projects/synth-test");
    expect(entry).toBeDefined();
    expect(entry!.synthesis).toBeDefined();
    expect(typeof entry!.synthesis!.synthesis_age_days).toBe("number");
    expect(entry!.synthesis!.synthesis_age_days).toBeGreaterThanOrEqual(0);
    expect(entry!.synthesis!.logs_incorporated).toBe(3);
    expect(entry!.synthesis!.origin).toBe("auto");
  });

  it("synthesis.logs_incorporated is null when no consolidation metadata exists", async () => {
    await callTool("memory_write", {
      namespace: "projects/no-meta",
      key: "status",
      content: "Active project without consolidation",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/no-meta",
      key: "synthesis",
      content: "Manually written synthesis.",
      tags: ["active"],
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: {
        active: Array<{
          namespace: string;
          synthesis?: { logs_incorporated: number | null; origin: string; synthesis_age_days: number };
        }>;
      };
    };

    const entry = result.dashboard.active.find((e) => e.namespace === "projects/no-meta");
    expect(entry!.synthesis).toBeDefined();
    expect(entry!.synthesis!.logs_incorporated).toBeNull();
    expect(entry!.synthesis!.origin).toBe("manual");
    expect(typeof entry!.synthesis!.synthesis_age_days).toBe("number");
  });

  it("memory_read for key=synthesis includes freshness metadata", async () => {
    await callTool("memory_write", {
      namespace: "projects/read-synth",
      key: "synthesis",
      content: "## Synthesis content",
      tags: ["active"],
    });
    const synthesisTime = "2026-03-28T08:00:00.000Z";
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'synthesis'").run(
      synthesisTime,
      "projects/read-synth",
    );
    await callTool("memory_log", { namespace: "projects/read-synth", content: "Log A", tags: ["decision"] });
    await callTool("memory_log", { namespace: "projects/read-synth", content: "Log B", tags: ["decision"] });
    const logTime = "2026-03-27T10:00:00.000Z";
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ? WHERE namespace = ? AND entry_type = 'log'").run(
      logTime,
      logTime,
      "projects/read-synth",
    );
    upsertConsolidationMetadata(db, {
      namespace: "projects/read-synth",
      last_consolidated_at: synthesisTime,
      last_log_id: null,
      last_log_created_at: logTime,
      synthesis_model: "test-model",
      synthesis_token_count: 400,
      run_duration_ms: 300,
    });

    const raw = await callTool("memory_read", { namespace: "projects/read-synth", key: "synthesis" });
    const result = parseToolResponse(raw) as {
      found: boolean;
      synthesis_age_days: number;
      logs_incorporated: number | null;
      origin: string;
    };

    expect(result.found).toBe(true);
    expect(typeof result.synthesis_age_days).toBe("number");
    expect(result.synthesis_age_days).toBeGreaterThanOrEqual(0);
    expect(result.logs_incorporated).toBe(2);
    expect(result.origin).toBe("auto");
  });

  it("memory_read for non-synthesis keys does NOT include freshness metadata", async () => {
    await callTool("memory_write", {
      namespace: "projects/no-synth-key",
      key: "status",
      content: "Regular status entry",
      tags: ["active"],
    });

    const raw = await callTool("memory_read", { namespace: "projects/no-synth-key", key: "status" });
    const result = parseToolResponse(raw) as {
      found: boolean;
      synthesis_age_days?: number;
      logs_incorporated?: number;
      origin?: string;
    };

    expect(result.found).toBe(true);
    expect(result.synthesis_age_days).toBeUndefined();
    expect(result.logs_incorporated).toBeUndefined();
    expect(result.origin).toBeUndefined();
  });

  it("stale synthesis: synthesis older than status has stale:true and no summary", async () => {
    const namespace = "projects/stale-synth-test";
    // Write status entry first (will have a later timestamp)
    await callTool("memory_write", {
      namespace,
      key: "status",
      content: "## Phase: Active\n\nWorking on integration.",
      tags: ["active"],
    });
    // Write synthesis entry
    await callTool("memory_write", {
      namespace,
      key: "synthesis",
      content: "## Phase: Active\n\nOld synthesis summary.",
      tags: ["active"],
    });
    // Backdate synthesis to be older than the status entry
    const oldSynthesisTime = "2025-01-01T00:00:00.000Z";
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'synthesis'").run(
      oldSynthesisTime,
      namespace,
    );

    const raw = await callTool("memory_orient", { detail: "standard" });
    const result = parseToolResponse(raw) as {
      dashboard: {
        active: Array<{
          namespace: string;
          synthesis?: {
            stale?: true;
            summary?: string;
            updated_at: string;
            synthesis_age_days: number;
            logs_incorporated: number | null;
            origin: string;
          };
        }>;
      };
    };

    const entry = result.dashboard.active.find((e) => e.namespace === namespace);
    expect(entry).toBeDefined();
    expect(entry!.synthesis).toBeDefined();
    expect(entry!.synthesis!.stale).toBe(true);
    expect(entry!.synthesis!.summary).toBeUndefined();
    // Diagnostic fields should still be present
    expect(entry!.synthesis!.updated_at).toBe(oldSynthesisTime);
    expect(typeof entry!.synthesis!.synthesis_age_days).toBe("number");
    expect(entry!.synthesis!.origin).toBeDefined();
  });

  it("fresh synthesis: synthesis newer than status has summary and no stale flag", async () => {
    const namespace = "projects/fresh-synth-test";
    // Write status entry with old timestamp
    await callTool("memory_write", {
      namespace,
      key: "status",
      content: "## Phase: Active\n\nWorking on integration.",
      tags: ["active"],
    });
    // Backdate status to be older than synthesis
    const oldStatusTime = "2025-01-01T00:00:00.000Z";
    db.prepare("UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'status'").run(
      oldStatusTime,
      namespace,
    );
    // Write synthesis entry (will have a current/newer timestamp)
    await callTool("memory_write", {
      namespace,
      key: "synthesis",
      content: "## Phase: Active\n\nFresh synthesis summary.",
      tags: ["active"],
    });

    const raw = await callTool("memory_orient", { detail: "standard" });
    const result = parseToolResponse(raw) as {
      dashboard: {
        active: Array<{
          namespace: string;
          synthesis?: {
            stale?: true;
            summary?: string;
            updated_at: string;
            synthesis_age_days: number;
            logs_incorporated: number | null;
            origin: string;
          };
        }>;
      };
    };

    const entry = result.dashboard.active.find((e) => e.namespace === namespace);
    expect(entry).toBeDefined();
    expect(entry!.synthesis).toBeDefined();
    expect(entry!.synthesis!.stale).toBeUndefined();
    expect(typeof entry!.synthesis!.summary).toBe("string");
    expect(entry!.synthesis!.summary!.length).toBeGreaterThan(0);
  });
});

describe("memory_resume", () => {
  it("prioritizes the current tracked status for a project-scoped resume", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nParser rollout and retrieval cleanup.\n\n## Blockers\nNone.\n\n## Next Steps\n- Finish the migration\n- Update the tests",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "architecture",
      content: "Current architecture notes for Grimnir.",
    });
    await callTool("memory_log", {
      namespace: "projects/grimnir",
      content: "Decided to keep the first resume pack deterministic and tool-layer only.",
      tags: ["decision"],
    });
    await callTool("memory_write", {
      namespace: "projects/other",
      key: "status",
      content: "Another active project.",
      tags: ["active"],
    });

    const raw = await callTool("memory_resume", { project: "grimnir", limit: 4 });
    const result = parseToolResponse(raw) as {
      target_namespace?: string;
      items: Array<{ namespace: string; key?: string | null; category: string }>;
      open_loops: Array<{ type: string; summary: string }>;
      suggested_reads: Array<{ tool: string; namespace?: string; key?: string }>;
    };

    expect(result.target_namespace).toBe("projects/grimnir");
    expect(result.items[0]).toEqual(expect.objectContaining({
      namespace: "projects/grimnir",
      key: "status",
      category: "status",
    }));
    expect(result.open_loops).toContainEqual(expect.objectContaining({
      type: "next_step",
      summary: "Finish the migration",
    }));
    expect(result.suggested_reads).toContainEqual(expect.objectContaining({
      tool: "memory_read",
      namespace: "projects/grimnir",
      key: "status",
    }));
  });

  it("uses opener terms to pull likely-relevant status and decision context", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nParser rollout and resume-tool wiring.\n\n## Blockers\nNone.\n\n## Next Steps\n- Land the parser patch",
      tags: ["active"],
    });
    await callTool("memory_log", {
      namespace: "projects/grimnir",
      content: "Decided to keep parser rollout inside the Grimnir project namespace.",
      tags: ["decision"],
    });
    await callTool("memory_write", {
      namespace: "projects/hugin",
      key: "status",
      content: "Task runner maintenance.",
      tags: ["active"],
    });

    const raw = await callTool("memory_resume", {
      opener: "continue grimnir parser rollout",
      limit: 4,
    });
    const result = parseToolResponse(raw) as {
      items: Array<{ namespace: string; category: string }>;
      why_this_set: string[];
    };

    expect(result.items).toContainEqual(expect.objectContaining({
      namespace: "projects/grimnir",
      category: "status",
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      namespace: "projects/grimnir",
      category: "decision_log",
    }));
    expect(result.why_this_set).toContain("Biased toward terms from the opener.");
  });

  it("ranks blocked work ahead of generic recent noise", async () => {
    await callTool("memory_write", {
      namespace: "projects/release-train",
      key: "status",
      content: "## Phase\nBlocked\n\n## Current Work\nWaiting on vendor approval.\n\n## Blockers\nVendor sign-off is missing.\n\n## Next Steps\n- Escalate with vendor",
      tags: ["blocked"],
    });
    await callTool("memory_write", {
      namespace: "projects/generic",
      key: "status",
      content: "Routine active project with no blockers.",
      tags: ["active"],
    });
    await callTool("memory_log", {
      namespace: "projects/generic",
      content: "General project note with little decision value.",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_resume", {
      opener: "what should I continue next",
      limit: 3,
    });
    const result = parseToolResponse(raw) as {
      items: Array<{ namespace: string; key?: string | null; category: string }>;
      open_loops: Array<{ namespace: string; type: string }>;
    };

    expect(result.items[0]).toEqual(expect.objectContaining({
      namespace: "projects/release-train",
      key: "status",
      category: "status",
    }));
    expect(result.open_loops).toContainEqual(expect.objectContaining({
      namespace: "projects/release-train",
      type: "blocker",
    }));
  });

  it("can include recent namespace history in the resume pack", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nResume pack implementation.\n\n## Blockers\nNone.\n\n## Next Steps\n- Add history coverage",
      tags: ["active"],
    });
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "architecture",
      content: "Architecture note for the current iteration.",
    });
    await callTool("memory_log", {
      namespace: "projects/grimnir",
      content: "Milestone: first resume pack assembled.",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_resume", {
      namespace: "projects/grimnir",
      include_history: true,
      limit: 6,
    });
    const result = parseToolResponse(raw) as {
      items: Array<{ category: string }>;
      suggested_reads: Array<{ tool: string; namespace?: string }>;
    };

    expect(result.items).toContainEqual(expect.objectContaining({ category: "history" }));
    expect(result.suggested_reads).toContainEqual(expect.objectContaining({
      tool: "memory_history",
      namespace: "projects/grimnir",
    }));
  });

  it("resolves a full namespace path with slash as-is (not prepending projects/)", async () => {
    await callTool("memory_write", {
      namespace: "testing/opus-review",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nOpus review run.\n\n## Blockers\nNone.\n\n## Next Steps\n- Finish review",
      tags: ["active"],
    });

    const raw = await callTool("memory_resume", { project: "testing/opus-review" });
    const result = parseToolResponse(raw) as { target_namespace?: string };

    expect(result.target_namespace).toBe("testing/opus-review");
  });

  it("still prepends projects/ for a simple name without a slash", async () => {
    await callTool("memory_write", {
      namespace: "projects/munin-memory",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nBug fixes.\n\n## Blockers\nNone.\n\n## Next Steps\n- Ship fix",
      tags: ["active"],
    });

    const raw = await callTool("memory_resume", { project: "munin-memory" });
    const result = parseToolResponse(raw) as { target_namespace?: string };

    expect(result.target_namespace).toBe("projects/munin-memory");
  });

  it("uses an already-prefixed projects/ path as-is", async () => {
    await callTool("memory_write", {
      namespace: "projects/munin-memory",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nPrefix test.\n\n## Blockers\nNone.\n\n## Next Steps\n- Confirm prefix",
      tags: ["active"],
    });

    const raw = await callTool("memory_resume", { project: "projects/munin-memory" });
    const result = parseToolResponse(raw) as { target_namespace?: string };

    expect(result.target_namespace).toBe("projects/munin-memory");
  });
});

describe("memory_extract", () => {
  it("turns explicit decisions into proposed log entries", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nParser rollout.\n\n## Blockers\nNone.\n\n## Next Steps\n- Ship it",
      tags: ["active"],
    });

    const raw = await callTool("memory_extract", {
      conversation_text: "We decided to keep parser rollout inside the Grimnir project namespace.",
      project_hint: "grimnir",
    });
    const result = parseToolResponse(raw) as {
      suggestions: Array<{ action: string; namespace: string; content?: string; tags?: string[]; confidence: number }>;
      candidate_namespaces: string[];
      capture_warnings: string[];
    };

    expect(result.candidate_namespaces[0]).toBe("projects/grimnir");
    expect(result.suggestions).toContainEqual(expect.objectContaining({
      action: "memory_log",
      namespace: "projects/grimnir",
      content: "We decided to keep parser rollout inside the Grimnir project namespace.",
      tags: ["decision"],
    }));
    expect(result.capture_warnings).toContain("Suggestions only — nothing has been written.");
    expect(result.suggestions[0].confidence).toBeGreaterThan(0.9);
  });

  it("turns explicit next steps into a proposed status update for tracked namespaces", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nResume tool.\n\n## Blockers\nNone.\n\n## Next Steps\n- Ship the first pass",
      tags: ["active"],
    });

    const raw = await callTool("memory_extract", {
      conversation_text: [
        "Current work: finish memory_extract.",
        "Next steps:",
        "- Add tests",
        "- Update docs",
      ].join("\n"),
      namespace_hint: "projects/grimnir",
    });
    const result = parseToolResponse(raw) as {
      suggestions: Array<{ action: string; namespace: string; status_patch?: { current_work?: string; next_steps?: string[] } }>;
      related_entries: Array<{ namespace: string; key?: string | null }>;
    };

    expect(result.related_entries).toContainEqual(expect.objectContaining({
      namespace: "projects/grimnir",
      key: "status",
    }));
    expect(result.suggestions).toContainEqual(expect.objectContaining({
      action: "memory_update_status",
      namespace: "projects/grimnir",
      status_patch: expect.objectContaining({
        current_work: "finish memory_extract.",
        next_steps: ["Add tests", "Update docs"],
      }),
    }));
  });

  it("uses namespace hints to constrain suggestions and related entries", async () => {
    await callTool("memory_write", {
      namespace: "users/sara/notes",
      key: "profile",
      content: "Sara family notes profile.",
    });
    await callTool("memory_write", {
      namespace: "projects/foo",
      key: "status",
      content: "Owner-only project context.",
      tags: ["active"],
    });

    const raw = await callTool("memory_extract", {
      conversation_text: "Decided to keep this in Sara's family notes.",
      namespace_hint: "users/sara/notes",
    });
    const result = parseToolResponse(raw) as {
      suggestions: Array<{ namespace: string }>;
      candidate_namespaces: string[];
      related_entries: Array<{ namespace: string }>;
    };

    expect(result.candidate_namespaces).toEqual(["users/sara/notes"]);
    expect(result.suggestions.every((suggestion) => suggestion.namespace === "users/sara/notes")).toBe(true);
    expect(result.related_entries.every((entry) => entry.namespace === "users/sara/notes")).toBe(true);
  });

  it("does not write anything while generating suggestions", async () => {
    const raw = await callTool("memory_extract", {
      conversation_text: "We decided to document this later.\nNext steps:\n- Add notes",
      project_hint: "grimnir",
    });
    const result = parseToolResponse(raw) as { suggestions: Array<unknown> };
    expect(result.suggestions.length).toBeGreaterThan(0);

    const listRaw = await callTool("memory_list", {});
    const listResult = parseToolResponse(listRaw) as { namespaces?: Array<unknown> };
    expect(listResult.namespaces ?? []).toHaveLength(0);
  });

  it("keeps dense sprint recap prose out of next steps", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nSprint follow-through.\n\n## Blockers\nNone.\n\n## Next Steps\n- Keep shipping",
      tags: ["active"],
    });

    const raw = await callTool("memory_extract", {
      conversation_text: [
        "Phase 1 is now complete in the worktree. The batch adds conservative recency-aware reranking, valid_until soft expiry, expired-entry suppression, and expiring_soon / expired signals.",
        "I then started Phase 2 with a first memory_resume implementation.",
        "Next clean move is to commit, push, and deploy this batch, then continue with memory_extract.",
      ].join("\n\n"),
      namespace_hint: "projects/grimnir",
    });
    const result = parseToolResponse(raw) as {
      suggestions: Array<{
        action: string;
        status_patch?: {
          lifecycle?: string;
          next_steps?: string[];
        };
      }>;
    };

    const statusSuggestion = result.suggestions.find((suggestion) => suggestion.action === "memory_update_status");
    expect(statusSuggestion).toBeTruthy();
    expect(statusSuggestion?.status_patch?.lifecycle).toBeUndefined();
    expect(statusSuggestion?.status_patch?.next_steps).toEqual(expect.arrayContaining([
      "Commit, push, and deploy this batch",
      "Continue with memory_extract",
    ]));
    expect(statusSuggestion?.status_patch?.next_steps?.join(" ")).not.toMatch(/recency-aware|valid_until|expiring_soon|phase 1/i);
  });

  it("normalizes inline next-step and action-item fragments without leading punctuation", async () => {
    await callTool("memory_write", {
      namespace: "projects/grimnir",
      key: "status",
      content: "## Phase\nActive\n\n## Current Work\nHeuristic cleanup.\n\n## Blockers\nNone.\n\n## Next Steps\n- Keep shipping",
      tags: ["active"],
    });

    const raw = await callTool("memory_extract", {
      conversation_text: [
        "The sprint demo looked good and the release batch is already deployed.",
        "Next step: exercise the new tools in normal usage and tune heuristics if they prove too Magnus-specific.",
        "Action item: refresh the docs after the live pass.",
      ].join(" "),
      namespace_hint: "projects/grimnir",
    });
    const result = parseToolResponse(raw) as {
      suggestions: Array<{
        action: string;
        status_patch?: {
          next_steps?: string[];
        };
      }>;
    };

    const statusSuggestion = result.suggestions.find((suggestion) => suggestion.action === "memory_update_status");
    expect(statusSuggestion?.status_patch?.next_steps).toEqual(expect.arrayContaining([
      "Exercise the new tools in normal usage and tune heuristics if they prove too Magnus-specific",
      "Refresh the docs after the live pass",
    ]));
    expect(statusSuggestion?.status_patch?.next_steps?.some((step) => /^[:;,\-]/.test(step))).toBe(false);
    expect(statusSuggestion?.status_patch?.next_steps?.join(" ")).not.toMatch(/sprint demo looked good|release batch is already deployed/i);
  });
});

describe("memory_narrative", () => {
  it("surfaces repeated reversal patterns", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/grimnir",
      phase: "Active",
      current_work: "Initial rollout",
      blockers: "None.",
      next_steps: ["Keep going"],
      lifecycle: "active",
    });
    await callTool("memory_update_status", {
      namespace: "projects/grimnir",
      current_work: "Paused while requirements changed",
      blockers: "Requirements unclear.",
      lifecycle: "blocked",
    });
    await callTool("memory_update_status", {
      namespace: "projects/grimnir",
      current_work: "Resumed after clarification",
      blockers: "None.",
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/grimnir",
      content: "Resumed work after pausing the rollout.",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_narrative", {
      namespace: "projects/grimnir",
      include_sources: true,
    });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string; source_audit_ids: number[] }>;
      sources: Array<{ kind: string }>;
    };

    expect(result.signals).toContainEqual(expect.objectContaining({
      category: "reversal_pattern",
    }));
    const reversal = result.signals.find((signal) => signal.category === "reversal_pattern")!;
    expect(reversal.source_audit_ids.length).toBeGreaterThan(0);
    expect(result.sources.some((source) => source.kind === "audit")).toBe(true);
  });

  it("surfaces old blockers", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/release-train",
      phase: "Blocked",
      current_work: "Waiting on vendor",
      blockers: "Vendor sign-off missing.",
      next_steps: ["Follow up"],
      lifecycle: "blocked",
    });
    db.prepare("UPDATE entries SET updated_at = '2026-03-20T00:00:00.000Z' WHERE namespace = 'projects/release-train' AND key = 'status'").run();

    const raw = await callTool("memory_narrative", { namespace: "projects/release-train" });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string; severity: string }>;
    };

    expect(result.signals).toContainEqual(expect.objectContaining({
      category: "blocker_age",
    }));
  });

  it("does not label stale maintenance work as a long-gap problem", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/mimir",
      phase: "Maintenance",
      current_work: "Quiet maintenance mode",
      blockers: "None.",
      next_steps: ["Monitor only"],
      lifecycle: "maintenance",
    });
    db.prepare("UPDATE entries SET updated_at = '2026-03-01T00:00:00.000Z' WHERE namespace = 'projects/mimir' AND key = 'status'").run();

    const raw = await callTool("memory_narrative", { namespace: "projects/mimir" });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
    };

    expect(result.signals.some((signal) => signal.category === "long_gap")).toBe(false);
  });

  it("includes source references when requested", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/skuld",
      phase: "Active",
      current_work: "Morning briefing refinement",
      blockers: "None.",
      next_steps: ["Tighten scoring"],
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/skuld",
      content: "Decided again to keep the first narrative layer source-backed for now.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/skuld",
      content: "Decided to avoid background materialization for now because attribution got muddier.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/skuld",
      content: "Decision: narrow the scope instead of reopening the broader rollout plan.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_narrative", {
      namespace: "projects/skuld",
      include_sources: true,
    });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string; source_entry_ids: string[] }>;
      sources: Array<{ kind: string; id: string | number }>;
    };

    expect(result.signals).toContainEqual(expect.objectContaining({
      category: "decision_churn",
    }));
    const churn = result.signals.find((signal) => signal.category === "decision_churn")!;
    expect(churn.source_entry_ids.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.some((source) => source.kind === "entry")).toBe(true);
  });

  it("does not treat a normal release burst as churn or reversal", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/munin-burst",
      phase: "Active",
      current_work: "Preparing release",
      blockers: "None.",
      next_steps: ["Deploy the batch"],
      lifecycle: "active",
    });
    await callTool("memory_update_status", {
      namespace: "projects/munin-burst",
      current_work: "Release pushed to main",
      blockers: "None.",
      next_steps: ["Deploy the batch"],
      lifecycle: "active",
    });
    await callTool("memory_update_status", {
      namespace: "projects/munin-burst",
      current_work: "Post-deploy verification",
      blockers: "None.",
      next_steps: ["Update the status"],
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/munin-burst",
      content: "Milestone: pushed the release candidate to main.",
      tags: ["milestone"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-burst",
      content: "Milestone: deployed the batch and the service restarted cleanly after deploy.",
      tags: ["milestone"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-burst",
      content: "Milestone: synced the project status after deploy.",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_narrative", {
      namespace: "projects/munin-burst",
    });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
    };

    expect(result.signals.some((signal) => signal.category === "decision_churn")).toBe(false);
    expect(result.signals.some((signal) => signal.category === "reversal_pattern")).toBe(false);
  });

  it("does not fire churn or reversal for linear sprint logs plus meta reversal discussion", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/munin-meta",
      phase: "Active",
      current_work: "Shipping the heuristic cleanup",
      blockers: "None.",
      next_steps: ["Exercise the tools on live data"],
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/munin-meta",
      content: "Decision: shipped the heuristic cleanup batch and pushed it to main.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-meta",
      content: "Decision: deployed the follow-up fix and verified the service health check.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-meta",
      content: "Decision: added the regression coverage and synced STATUS after the deploy.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-meta",
      content: "Correction: the reversal heuristic should ignore logs that mention reopen or resume signals while describing the detector itself.",
      tags: ["correction"],
    });

    const raw = await callTool("memory_narrative", {
      namespace: "projects/munin-meta",
    });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
    };

    expect(result.signals.some((signal) => signal.category === "decision_churn")).toBe(false);
    expect(result.signals.some((signal) => signal.category === "reversal_pattern")).toBe(false);
  });

  it("does not treat roadmap and planning decisions as churn on live-shaped history", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/munin-live-narrative",
      phase: "Active",
      current_work: "Roadmap follow-through",
      blockers: "None.",
      next_steps: ["Exercise the live heuristics"],
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-narrative",
      content: "Added full engineering-plan coverage for the roadmap. Decision: later phases are planned in enough detail to guide future work, but remain provisional where they depend on earlier implementation.",
      tags: ["decision", "milestone", "topic:roadmap"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-narrative",
      content: "Added docs/phase-1-engineering-plan.md to convert Roadmap Phase 1 into a concrete implementation plan. Decision: use valid_until only and defer full temporal history for now.",
      tags: ["decision", "topic:phase-1"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-narrative",
      content: "Locked in Munin's product direction after reviewing the docs. Decision: position Munin as sovereign operational memory, not a broad general-purpose AI memory platform.",
      tags: ["decision", "topic:positioning"],
    });

    const raw = await callTool("memory_narrative", {
      namespace: "projects/munin-live-narrative",
      since: "2026-03-30T00:00:00Z",
      include_sources: true,
      limit: 6,
    });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
    };

    expect(result.signals.some((signal) => signal.category === "decision_churn")).toBe(false);
  });

  it("does not emit time_in_phase for a status updated today (0 days)", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/narrative-fresh",
      phase: "Active",
      current_work: "Just started",
      blockers: "None.",
      next_steps: ["Continue"],
      lifecycle: "active",
    });

    const raw = await callTool("memory_narrative", { namespace: "projects/narrative-fresh" });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
      reason?: string;
    };

    expect(result.signals.some((signal) => signal.category === "time_in_phase")).toBe(false);
  });

  it("emits time_in_phase for a status entry older than 3 days", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/narrative-stale",
      phase: "Active",
      current_work: "Ongoing work",
      blockers: "None.",
      next_steps: ["Keep going"],
      lifecycle: "active",
    });
    db.prepare("UPDATE entries SET updated_at = '2026-03-31T00:00:00.000Z' WHERE namespace = 'projects/narrative-stale' AND key = 'status'").run();

    const raw = await callTool("memory_narrative", { namespace: "projects/narrative-stale" });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
    };

    expect(result.signals.some((signal) => signal.category === "time_in_phase")).toBe(true);
  });

  it("includes a reason field when no signals are found", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/narrative-quiet",
      phase: "Active",
      current_work: "Quiet period",
      blockers: "None.",
      next_steps: ["Monitor"],
      lifecycle: "active",
    });

    const raw = await callTool("memory_narrative", { namespace: "projects/narrative-quiet" });
    const result = parseToolResponse(raw) as {
      signals: Array<{ category: string }>;
      reason?: string;
    };

    if (result.signals.length === 0) {
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
    }
  });
});

describe("memory_commitments", () => {
  it("tracks status next steps and resolves them when they are cleared", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/bifrost",
      phase: "Active",
      current_work: "Polish onboarding",
      blockers: "None.",
      next_steps: [
        "Ship onboarding notes by 2027-04-05",
        "Add cleanup checklist",
      ],
      lifecycle: "active",
    });

    const initialRaw = await callTool("memory_commitments", {
      namespace: "projects/bifrost",
    });
    const initial = parseToolResponse(initialRaw) as {
      open: Array<{ text: string; source_type: string; source_entry_id: string; due_at: string | null }>;
      completed_recently: Array<unknown>;
    };

    expect(initial.open).toHaveLength(2);
    expect(initial.open).toContainEqual(expect.objectContaining({
      text: "Ship onboarding notes by 2027-04-05",
      source_type: "tracked_next_step",
    }));
    expect(initial.open[0].source_entry_id).toBeTruthy();
    expect(initial.completed_recently).toHaveLength(0);

    await callTool("memory_update_status", {
      namespace: "projects/bifrost",
      current_work: "Onboarding notes shipped",
      blockers: "None.",
      next_steps: [],
      lifecycle: "active",
    });

    const resolvedRaw = await callTool("memory_commitments", {
      namespace: "projects/bifrost",
    });
    const resolved = parseToolResponse(resolvedRaw) as {
      open: Array<unknown>;
      completed_recently: Array<{ text: string; status: string }>;
    };

    expect(resolved.open).toHaveLength(0);
    expect(resolved.completed_recently).toContainEqual(expect.objectContaining({
      text: "Ship onboarding notes by 2027-04-05",
      status: "done",
    }));
  });

  it("surfaces overdue explicit commitments from dated logs", async () => {
    await callTool("memory_log", {
      namespace: "projects/tyr",
      content: "We will ship the patch by 2026-03-01.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/tyr",
    });
    const result = parseToolResponse(raw) as {
      overdue: Array<{ text: string; source_type: string; due_at: string | null }>;
    };

    expect(result.overdue).toContainEqual(expect.objectContaining({
      text: "We will ship the patch by 2026-03-01.",
      source_type: "explicit_dated_commitment",
    }));
    expect(result.overdue[0].due_at).toContain("2026-03-01");
  });

  it("does not treat dated completion records as open or overdue commitments", async () => {
    await callTool("memory_log", {
      namespace: "projects/forseti",
      content: "Completed the Codex usability improvement (2026-03-05).",
      tags: ["milestone"],
    });
    await callTool("memory_log", {
      namespace: "projects/forseti",
      content: "Public repo security audit completed (2026-03-15).",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/forseti",
    });
    const result = parseToolResponse(raw) as {
      open: Array<unknown>;
      at_risk: Array<unknown>;
      overdue: Array<unknown>;
      completed_recently: Array<unknown>;
    };

    expect(result.open).toHaveLength(0);
    expect(result.at_risk).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
    expect(result.completed_recently).toHaveLength(0);
  });

  it("re-syncs stale retrospective rows even when since skips the source entry", async () => {
    await seedRetrospectiveCommitmentRow(
      "projects/forseti",
      "Completed the Codex usability improvement (2026-03-05).",
      "forseti-1",
    );
    await seedRetrospectiveCommitmentRow(
      "projects/forseti",
      "Public repo security audit completed (2026-03-15).",
      "forseti-2",
    );

    const raw = await callTool("memory_commitments", {
      namespace: "projects/forseti",
      since: "2026-04-01T00:00:00.000Z",
    });
    const result = parseToolResponse(raw) as {
      open: Array<unknown>;
      at_risk: Array<unknown>;
      overdue: Array<unknown>;
    };

    expect(result.open).toHaveLength(0);
    expect(result.at_risk).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);

    const rows = db.prepare("SELECT id, status FROM commitments WHERE namespace = 'projects/forseti' ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stale-forseti-1", status: "cancelled" }),
      expect.objectContaining({ id: "stale-forseti-2", status: "cancelled" }),
    ]));
  });

  it("does not treat retrospective CI fix logs as overdue commitments", async () => {
    await callTool("memory_log", {
      namespace: "projects/fortnox-mcp",
      content: RETROSPECTIVE_CI_FIX_LOG,
      tags: ["milestone"],
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/fortnox-mcp",
    });
    const result = parseToolResponse(raw) as {
      open: Array<unknown>;
      at_risk: Array<unknown>;
      overdue: Array<unknown>;
      completed_recently: Array<unknown>;
    };

    expect(result.open).toHaveLength(0);
    expect(result.at_risk).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
    expect(result.completed_recently).toHaveLength(0);
  });

  it("returns a reason when no tracked status entries exist for the namespace", async () => {
    const raw = await callTool("memory_commitments", {
      namespace: "projects/empty-commitments-reason-test",
    });
    const result = parseToolResponse(raw) as {
      open: Array<unknown>;
      at_risk: Array<unknown>;
      overdue: Array<unknown>;
      completed_recently: Array<unknown>;
      reason?: string;
    };

    expect(result.open).toHaveLength(0);
    expect(result.at_risk).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
    expect(result.completed_recently).toHaveLength(0);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/namespace has no status or log entries to scan/i);
  });

  it("does not include reason when commitments are found", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/commitments-reason-check",
      phase: "Active",
      current_work: "Building the feature",
      blockers: "None.",
      next_steps: ["Ship the feature by 2027-06-01"],
      lifecycle: "active",
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/commitments-reason-check",
    });
    const result = parseToolResponse(raw) as {
      open: Array<unknown>;
      reason?: string;
    };

    expect(result.open.length).toBeGreaterThan(0);
    expect(result.reason).toBeUndefined();
  });

  it("detects explicit 'Commitment:' prefix in log entries", async () => {
    await callTool("memory_log", {
      namespace: "projects/explicit-commitment-test",
      content: "Commitment: I will prepare the quarterly report",
      tags: ["decision"],
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/explicit-commitment-test",
    });
    const result = parseToolResponse(raw) as {
      open: Array<{ text: string; source_type: string }>;
      overdue: Array<{ text: string; source_type: string }>;
    };

    const allCommitments = [...result.open, ...result.overdue];
    expect(allCommitments).toContainEqual(expect.objectContaining({
      text: "Commitment: I will prepare the quarterly report",
      source_type: "explicit_commitment",
    }));
  });

  it("detects 'We agreed to' prefix in log entries", async () => {
    await callTool("memory_log", {
      namespace: "projects/we-agreed-test",
      content: "We agreed to: migrate the database by 2027-06-01",
      tags: ["decision"],
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/we-agreed-test",
    });
    const result = parseToolResponse(raw) as {
      open: Array<{ text: string; source_type: string }>;
      overdue: Array<{ text: string; source_type: string }>;
    };

    const allCommitments = [...result.open, ...result.overdue];
    expect(allCommitments).toContainEqual(expect.objectContaining({
      source_type: "explicit_commitment",
    }));
  });

  it("detects 'I commit to' prefix in log entries", async () => {
    await callTool("memory_log", {
      namespace: "projects/i-commit-test",
      content: "I commit to: reviewing the PR before EOD",
      tags: ["decision"],
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/i-commit-test",
    });
    const result = parseToolResponse(raw) as {
      open: Array<{ text: string; source_type: string }>;
      overdue: Array<{ text: string; source_type: string }>;
    };

    const allCommitments = [...result.open, ...result.overdue];
    expect(allCommitments).toContainEqual(expect.objectContaining({
      source_type: "explicit_commitment",
    }));
  });

  it("still extracts commitments from status next-steps (regression)", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/regression-next-steps",
      phase: "Active",
      current_work: "Working on feature X",
      blockers: "None.",
      next_steps: ["Ship feature X by 2027-08-01", "Write tests"],
      lifecycle: "active",
    });

    const raw = await callTool("memory_commitments", {
      namespace: "projects/regression-next-steps",
    });
    const result = parseToolResponse(raw) as {
      open: Array<{ text: string; source_type: string }>;
    };

    expect(result.open).toContainEqual(expect.objectContaining({
      text: "Ship feature X by 2027-08-01",
      source_type: "tracked_next_step",
    }));
  });

  it("includes a reason string in empty results and omits it in non-empty results", async () => {
    // Empty namespace — no entries at all
    const emptyRaw = await callTool("memory_commitments", {
      namespace: "projects/commitments-reason-field-empty",
    });
    const emptyResult = parseToolResponse(emptyRaw) as {
      open: Array<unknown>;
      at_risk: Array<unknown>;
      overdue: Array<unknown>;
      completed_recently: Array<unknown>;
      reason?: string;
    };

    expect(emptyResult.open).toHaveLength(0);
    expect(emptyResult.reason).toBeDefined();
    expect(typeof emptyResult.reason).toBe("string");
    expect(emptyResult.reason!.length).toBeGreaterThan(0);

    // Non-empty namespace — commitments found
    await callTool("memory_update_status", {
      namespace: "projects/commitments-reason-field-nonempty",
      phase: "Active",
      current_work: "Building things",
      blockers: "None.",
      next_steps: ["Deliver feature by 2027-09-01"],
      lifecycle: "active",
    });
    const nonEmptyRaw = await callTool("memory_commitments", {
      namespace: "projects/commitments-reason-field-nonempty",
    });
    const nonEmptyResult = parseToolResponse(nonEmptyRaw) as {
      open: Array<unknown>;
      reason?: string;
    };

    expect(nonEmptyResult.open.length).toBeGreaterThan(0);
    expect(nonEmptyResult.reason).toBeUndefined();
  });
});

describe("memory_patterns", () => {
  it("surfaces repeated decision themes with source references", async () => {
    await callTool("memory_log", {
      namespace: "projects/odin",
      content: "Decision: ARM64 support still looks fragile because maintainer risk remains high.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/odin",
      content: "Decided to defer rollout again due to ARM64 uncertainty and single maintainer risk.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/odin",
      content: "Decision review: maintainer risk and ARM64 support are still the blocking concerns.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/odin",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string; summary: string; source_entry_ids: string[] }>;
      supporting_sources: Array<{ entry_id: string }>;
    };

    expect(result.patterns).toContainEqual(expect.objectContaining({
      kind: "decision_theme",
    }));
    expect(result.patterns[0].summary.toLowerCase()).toMatch(/arm64|maintainer|risk/);
    expect(result.patterns[0].source_entry_ids.length).toBeGreaterThan(0);
    expect(result.supporting_sources.length).toBeGreaterThan(0);
  });

  it("does not overstate a one-off status snapshot as a heuristic", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/solo",
      phase: "Active",
      current_work: "One session only",
      blockers: "None.",
      next_steps: ["Do the thing", "Do the other thing"],
      lifecycle: "active",
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/solo",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<unknown>;
      heuristics: Array<unknown>;
    };

    expect(result.patterns).toHaveLength(0);
    expect(result.heuristics).toHaveLength(0);
  });

  it("does not derive commitment_slip only from dated completion logs", async () => {
    await callTool("memory_log", {
      namespace: "projects/bragi",
      content: "Completed the Codex usability improvement (2026-03-05).",
      tags: ["milestone"],
    });
    await callTool("memory_log", {
      namespace: "projects/bragi",
      content: "Public repo security audit completed (2026-03-15).",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/bragi",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string }>;
    };

    expect(result.patterns.some((pattern) => pattern.kind === "commitment_slip")).toBe(false);
  });

  it("does not derive commitment_slip from stale retrospective rows in since-scoped views", async () => {
    await seedRetrospectiveCommitmentRow(
      "projects/bragi",
      "Completed the Codex usability improvement (2026-03-05).",
      "bragi-1",
    );
    await seedRetrospectiveCommitmentRow(
      "projects/bragi",
      "Public repo security audit completed (2026-03-15).",
      "bragi-2",
    );

    const raw = await callTool("memory_patterns", {
      namespace: "projects/bragi",
      since: "2026-04-01T00:00:00.000Z",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string }>;
    };

    expect(result.patterns.some((pattern) => pattern.kind === "commitment_slip")).toBe(false);
  });

  it("filters generic engineering filler out of decision themes", async () => {
    await callTool("memory_log", {
      namespace: "projects/echo",
      content: "Decision: implementation work and project status need review with the current deployment.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/echo",
      content: "Decision: review the implementation update with the project status before the next deployment.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/echo",
      content: "Decision: implementation details from the current project review are still about deployment status.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/echo",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string; summary: string }>;
    };

    expect(result.patterns.some((pattern) => pattern.kind === "decision_theme")).toBe(false);
  });

  it("does not derive commitment_slip from retrospective CI fix logs", async () => {
    await callTool("memory_log", {
      namespace: "projects/fortnox-mcp",
      content: RETROSPECTIVE_CI_FIX_LOG,
      tags: ["milestone"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/fortnox-mcp",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string }>;
    };

    expect(result.patterns.some((pattern) => pattern.kind === "commitment_slip")).toBe(false);
  });

  it("omits decision_theme when only live-style glue terms repeat", async () => {
    await callTool("memory_log", {
      namespace: "projects/munin-live-patterns",
      content: "Decision: added the full regression pass into the current batch before deploy.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-patterns",
      content: "Decision: added the full status sync into the current batch after deploy.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-patterns",
      content: "Decision: added the full live feedback into the current tools batch.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/munin-live-patterns",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string }>;
    };

    expect(result.patterns.some((pattern) => pattern.kind === "decision_theme")).toBe(false);
  });

  it("omits decision_theme for live-shaped planning vocabulary", async () => {
    await callTool("memory_log", {
      namespace: "projects/munin-live-pattern-theme",
      content: "Added full engineering-plan coverage for the roadmap. Decision: keep the design explicit and the implementation plan in docs.",
      tags: ["decision", "topic:roadmap"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-pattern-theme",
      content: "Added docs/phase-1-engineering-plan.md to convert Roadmap Phase 1 into a concrete implementation plan with an explicit design boundary.",
      tags: ["decision", "topic:phase-1"],
    });
    await callTool("memory_log", {
      namespace: "projects/munin-live-pattern-theme",
      content: "Locked in the product direction after reviewing the docs. Decision: keep the plan explicit and the design narrow.",
      tags: ["decision", "topic:positioning"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/munin-live-pattern-theme",
      since: "2026-03-30T00:00:00Z",
      limit: 5,
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string; summary: string }>;
    };

    expect(result.patterns.some((pattern) => pattern.kind === "decision_theme")).toBe(false);
  });

  it("returns a reason explaining no entries when namespace is empty", async () => {
    const raw = await callTool("memory_patterns", {
      namespace: "projects/empty-namespace-reason-test",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<unknown>;
      reason?: string;
    };

    expect(result.patterns).toHaveLength(0);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/namespace has \d+ log entries — minimum \d+ required for pattern detection/i);
  });

  it("returns a reason about threshold when entries exist but produce no patterns", async () => {
    await callTool("memory_log", {
      namespace: "projects/threshold-reason-test",
      content: "Decision: we chose to use postgres for the database.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/threshold-reason-test",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<unknown>;
      reason?: string;
    };

    expect(result.patterns).toHaveLength(0);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/\d+ entries scanned, no recurring terms above frequency threshold/i);
  });

  it("does not include reason when patterns are found", async () => {
    await callTool("memory_log", {
      namespace: "projects/odin-reason-check",
      content: "Decision: ARM64 support still looks fragile because maintainer risk remains high.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/odin-reason-check",
      content: "Decided to defer rollout again due to ARM64 uncertainty and single maintainer risk.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/odin-reason-check",
      content: "Decision review: maintainer risk and ARM64 support are still the blocking concerns.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/odin-reason-check",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<unknown>;
      reason?: string;
    };

    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.reason).toBeUndefined();
  });

  it("does not surface common English stopwords as recurring pattern terms", async () => {
    await callTool("memory_log", {
      namespace: "projects/stopword-test",
      content: "Decision: still blocked because database migration is still delayed. Also, kubernetes rollout deferred.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/stopword-test",
      content: "Decided to also defer the kubernetes deployment because database capacity is still insufficient.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/stopword-test",
      content: "Decision: kubernetes cluster still degraded also because of database connection limits.",
      tags: ["decision"],
    });

    const raw = await callTool("memory_patterns", {
      namespace: "projects/stopword-test",
    });
    const result = parseToolResponse(raw) as {
      patterns: Array<{ kind: string; summary: string }>;
    };

    const summaries = result.patterns.map((p) => p.summary.toLowerCase());
    const allSummaryText = summaries.join(" ");

    expect(allSummaryText).not.toMatch(/\bstill\b/);
    expect(allSummaryText).not.toMatch(/\balso\b/);
    expect(allSummaryText).not.toMatch(/\bbecause\b/);

    if (result.patterns.some((p) => p.kind === "decision_theme")) {
      expect(allSummaryText).toMatch(/kubernetes|database/);
    }
  });

  it("includes a reason string in empty results and omits it in non-empty results", async () => {
    // Empty namespace — no entries at all
    const emptyRaw = await callTool("memory_patterns", {
      namespace: "projects/patterns-reason-field-empty",
    });
    const emptyResult = parseToolResponse(emptyRaw) as {
      patterns: Array<unknown>;
      reason?: string;
    };

    expect(emptyResult.patterns).toHaveLength(0);
    expect(emptyResult.reason).toBeDefined();
    expect(typeof emptyResult.reason).toBe("string");
    expect(emptyResult.reason!.length).toBeGreaterThan(0);

    // Non-empty namespace — patterns found
    await callTool("memory_log", {
      namespace: "projects/patterns-reason-field-nonempty",
      content: "Decision: ARM64 support still looks fragile because maintainer risk remains high.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/patterns-reason-field-nonempty",
      content: "Decided to defer rollout again due to ARM64 uncertainty and single maintainer risk.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/patterns-reason-field-nonempty",
      content: "Decision review: maintainer risk and ARM64 support are still the blocking concerns.",
      tags: ["decision"],
    });

    const nonEmptyRaw = await callTool("memory_patterns", {
      namespace: "projects/patterns-reason-field-nonempty",
    });
    const nonEmptyResult = parseToolResponse(nonEmptyRaw) as {
      patterns: Array<unknown>;
      reason?: string;
    };

    expect(nonEmptyResult.patterns.length).toBeGreaterThan(0);
    expect(nonEmptyResult.reason).toBeUndefined();
  });
});

describe("memory_handoff", () => {
  it("returns current state, recent decisions, recent actors, and open loops", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/heimdall",
      phase: "Blocked",
      current_work: "Waiting on deployment auth",
      blockers: "Deploy remains blocked on external auth.",
      next_steps: ["Retry the deploy tomorrow"],
      lifecycle: "blocked",
    });
    await callTool("memory_log", {
      namespace: "projects/heimdall",
      content: "Decision: pause the rollout until auth is working again.",
      tags: ["decision"],
    });
    await callTool("memory_log", {
      namespace: "projects/heimdall",
      content: "We will rerun the deploy by 2026-03-20.",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_handoff", {
      namespace: "projects/heimdall",
    });
    const result = parseToolResponse(raw) as {
      found: boolean;
      current_state: { summary: string } | null;
      recent_decisions: Array<{ summary: string }>;
      open_loops: string[];
      recent_actors: Array<{ principal_id: string }>;
      recommended_next_actions: string[];
    };

    expect(result.found).toBe(true);
    expect(result.current_state?.summary).toContain("Blocked");
    expect(result.recent_decisions.length).toBeGreaterThan(0);
    expect(result.recent_actors).toContainEqual(expect.objectContaining({
      principal_id: "owner",
    }));
    expect(result.open_loops.some((loop) => /blocker|overdue|retry/i.test(loop))).toBe(true);
    expect(result.recommended_next_actions.length).toBeGreaterThan(0);
  });

  it("does not surface overdue loops from dated completion logs", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/vidar",
      phase: "Active",
      current_work: "Post-release cleanup",
      blockers: "None.",
      next_steps: [],
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/vidar",
      content: "Completed the Codex usability improvement (2026-03-05).",
      tags: ["milestone"],
    });
    await callTool("memory_log", {
      namespace: "projects/vidar",
      content: "Public repo security audit completed (2026-03-15).",
      tags: ["milestone"],
    });

    const raw = await callTool("memory_handoff", {
      namespace: "projects/vidar",
    });
    const result = parseToolResponse(raw) as {
      open_loops: string[];
    };

    expect(result.open_loops.some((loop) => /overdue commitment/i.test(loop))).toBe(false);
  });

  it("does not surface overdue loops from stale retrospective rows in since-scoped views", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/vidar-since",
      phase: "Active",
      current_work: "Post-release cleanup",
      blockers: "None.",
      next_steps: [],
      lifecycle: "active",
    });
    await seedRetrospectiveCommitmentRow(
      "projects/vidar-since",
      "Completed the Codex usability improvement (2026-03-05).",
      "vidar-1",
    );
    await seedRetrospectiveCommitmentRow(
      "projects/vidar-since",
      "Public repo security audit completed (2026-03-15).",
      "vidar-2",
    );

    const raw = await callTool("memory_handoff", {
      namespace: "projects/vidar-since",
      since: "2026-04-01T00:00:00.000Z",
    });
    const result = parseToolResponse(raw) as {
      open_loops: string[];
    };

    expect(result.open_loops.some((loop) => /overdue commitment/i.test(loop))).toBe(false);
  });

  it("does not surface overdue loops from retrospective CI fix logs", async () => {
    await callTool("memory_update_status", {
      namespace: "projects/fortnox-mcp",
      phase: "Active",
      current_work: "Post-CI cleanup",
      blockers: "None.",
      next_steps: [],
      lifecycle: "active",
    });
    await callTool("memory_log", {
      namespace: "projects/fortnox-mcp",
      content: RETROSPECTIVE_CI_FIX_LOG,
      tags: ["milestone"],
    });

    const raw = await callTool("memory_handoff", {
      namespace: "projects/fortnox-mcp",
    });
    const result = parseToolResponse(raw) as {
      open_loops: string[];
    };

    expect(result.open_loops.some((loop) => /overdue commitment/i.test(loop))).toBe(false);
  });
});

describe("memory_attention", () => {
  it("surfaces blocked, stale, and missing-status work in priority order", async () => {
    const upcomingDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await callTool("memory_write", {
      namespace: "projects/release-train",
      key: "status",
      content: "Waiting on vendor approval.",
      tags: ["blocked"],
    });
    await callTool("memory_write", {
      namespace: "projects/hackathon-web",
      key: "status",
      content: `Event ${upcomingDate} and venue logistics need review.`,
      tags: ["active"],
    });
    db.prepare(
      "UPDATE entries SET updated_at = ? WHERE namespace = ? AND key = 'status' AND entry_type = 'state'",
    ).run(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), "projects/hackathon-web");
    await callTool("memory_write", {
      namespace: "projects/no-status",
      key: "notes",
      content: "This namespace has work but no status entry.",
    });

    const raw = await callTool("memory_attention", {});
    const result = parseToolResponse(raw) as {
      summary: { high: number; medium: number; total: number };
      items: Array<{ namespace: string; category: string; severity: string }>;
    };

    expect(result.summary.total).toBeGreaterThanOrEqual(3);
    expect(result.summary.high).toBeGreaterThanOrEqual(2);
    expect(result.items[0]).toEqual(expect.objectContaining({
      namespace: "projects/hackathon-web",
      category: "upcoming_event_stale",
      severity: "high",
    }));
    expect(result.items.slice(0, 2)).toContainEqual(expect.objectContaining({
      namespace: "projects/release-train",
      category: "blocked",
      severity: "high",
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      namespace: "projects/no-status",
      category: "missing_status",
      severity: "medium",
    }));
  });

  it("supports namespace prefix filtering", async () => {
    await callTool("memory_write", {
      namespace: "projects/release-train",
      key: "status",
      content: "Blocked on infra.",
      tags: ["blocked"],
    });
    await callTool("memory_write", {
      namespace: "clients/acme",
      key: "status",
      content: "Blocked on approval.",
      tags: ["blocked"],
    });

    const raw = await callTool("memory_attention", { namespace_prefix: "clients/" });
    const result = parseToolResponse(raw) as {
      items: Array<{ namespace: string }>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0].namespace).toBe("clients/acme");
  });

  it("surfaces expired and expiring tracked statuses", async () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

    await callTool("memory_write", {
      namespace: "projects/expired-status",
      key: "status",
      content: "Expired tracked status",
      tags: ["active"],
      valid_until: "2020-01-01T00:00:00Z",
    });
    await callTool("memory_write", {
      namespace: "projects/expiring-status",
      key: "status",
      content: "Expiring tracked status",
      tags: ["active"],
      valid_until: soon,
    });

    const raw = await callTool("memory_attention", {});
    const result = parseToolResponse(raw) as {
      items: Array<{ namespace: string; category: string; severity: string }>;
    };

    expect(result.items).toContainEqual(expect.objectContaining({
      namespace: "projects/expired-status",
      category: "expired",
      severity: "high",
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      namespace: "projects/expiring-status",
      category: "expiring_soon",
      severity: "medium",
    }));
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
    const result = parseToolResponse(raw) as { ok: boolean; error: string; current_updated_at: string; message: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");
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

  it("includes expired flag for expired entries", async () => {
    await callTool("memory_write", {
      namespace: "projects/a",
      key: "status",
      content: "Expired",
      valid_until: "2020-01-01T00:00:00Z",
    });

    const raw = await callTool("memory_read_batch", {
      reads: [{ namespace: "projects/a", key: "status" }],
    });
    const result = parseToolResponse(raw) as { results: Array<{ found: boolean; expired?: boolean; valid_until?: string }> };
    expect(result.results[0].found).toBe(true);
    expect(result.results[0].expired).toBe(true);
    expect(result.results[0].valid_until).toBe("2020-01-01T00:00:00.000Z");
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
    expect(result.log_summary.recent[0].tags).toEqual(["classification:internal"]);
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

    const raw = await callTool("memory_orient", { include_namespaces: true });
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

describe("memory_list pagination", () => {
  it("returns total, returned, and has_more fields", async () => {
    for (let i = 0; i < 5; i++) {
      await callTool("memory_write", { namespace: `ns/item${i}`, key: "k", content: "c" });
    }

    const raw = await callTool("memory_list", { limit: 2, offset: 0 });
    const result = parseToolResponse(raw) as {
      namespaces: Array<{ namespace: string }>;
      total: number;
      returned: number;
      has_more: boolean;
    };
    expect(result.total).toBe(5);
    expect(result.returned).toBe(2);
    expect(result.namespaces).toHaveLength(2);
    expect(result.has_more).toBe(true);
  });

  it("last page sets has_more false", async () => {
    for (let i = 0; i < 3; i++) {
      await callTool("memory_write", { namespace: `pg/item${i}`, key: "k", content: "c" });
    }

    const raw = await callTool("memory_list", { limit: 10, offset: 0 });
    const result = parseToolResponse(raw) as {
      total: number;
      returned: number;
      has_more: boolean;
    };
    expect(result.total).toBe(3);
    expect(result.returned).toBe(3);
    expect(result.has_more).toBe(false);
  });

  it("offset advances the window", async () => {
    for (let i = 0; i < 4; i++) {
      await callTool("memory_write", { namespace: `page/item${i}`, key: "k", content: "c" });
    }

    const page1 = parseToolResponse(await callTool("memory_list", { limit: 2, offset: 0 })) as {
      namespaces: Array<{ namespace: string }>;
    };
    const page2 = parseToolResponse(await callTool("memory_list", { limit: 2, offset: 2 })) as {
      namespaces: Array<{ namespace: string }>;
    };

    const all = [...page1.namespaces, ...page2.namespaces];
    const names = all.map((n) => n.namespace);
    // All four distinct, no duplicates
    expect(new Set(names).size).toBe(4);
  });

  it("defaults to limit 20", async () => {
    for (let i = 0; i < 25; i++) {
      await callTool("memory_write", { namespace: `many/item${String(i).padStart(2, "0")}`, key: "k", content: "c" });
    }

    const raw = await callTool("memory_list", {});
    const result = parseToolResponse(raw) as {
      namespaces: Array<{ namespace: string }>;
      total: number;
      has_more: boolean;
    };
    expect(result.namespaces).toHaveLength(20);
    expect(result.total).toBe(25);
    expect(result.has_more).toBe(true);
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

  it("flags expired tracked statuses without hiding them from the dashboard", async () => {
    await callTool("memory_write", {
      namespace: "projects/expired-status",
      key: "status",
      content: "Expired tracked status",
      tags: ["active"],
      valid_until: "2020-01-01T00:00:00Z",
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      dashboard: { active: Array<{ namespace: string; needs_attention?: boolean }> };
      maintenance_needed: Array<{ namespace: string; issue: string }>;
    };

    expect(result.dashboard.active).toContainEqual(expect.objectContaining({
      namespace: "projects/expired-status",
      needs_attention: true,
    }));
    expect(result.maintenance_needed).toContainEqual(expect.objectContaining({
      namespace: "projects/expired-status",
      issue: "expired",
    }));
  });

  it("flags expiring-soon tracked statuses", async () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    await callTool("memory_write", {
      namespace: "projects/expiring-status",
      key: "status",
      content: "Expiring tracked status",
      tags: ["active"],
      valid_until: soon,
    });

    const raw = await callTool("memory_orient", {});
    const result = parseToolResponse(raw) as {
      maintenance_needed: Array<{ namespace: string; issue: string }>;
    };
    expect(result.maintenance_needed).toContainEqual(expect.objectContaining({
      namespace: "projects/expiring-status",
      issue: "expiring_soon",
    }));
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

describe("memory_status", () => {
  it("returns all expected top-level fields", async () => {
    const raw = await callTool("memory_status", {});
    const result = parseToolResponse(raw) as {
      server: { name: string; version: string };
      schema_version: number;
      features: { embeddings: boolean; semantic_search: boolean; hybrid_search: boolean };
      tools: { count: number; names: string[] };
      principal: { id: string; type: string };
      librarian: {
        enabled: boolean;
        redaction_logging: boolean;
        transport_type: string;
        max_classification: string;
      };
    };

    expect(result.server).toBeDefined();
    expect(result.server.name).toBe("munin-memory");
    expect(result.server.version).toBe("0.1.0");

    expect(typeof result.schema_version).toBe("number");
    expect(result.schema_version).toBeGreaterThan(0);

    expect(result.features).toBeDefined();
    expect(typeof result.features.embeddings).toBe("boolean");
    expect(typeof result.features.semantic_search).toBe("boolean");
    expect(typeof result.features.hybrid_search).toBe("boolean");

    expect(result.tools).toBeDefined();
    expect(typeof result.tools.count).toBe("number");
    expect(Array.isArray(result.tools.names)).toBe(true);

    expect(result.librarian).toBeDefined();
    expect(typeof result.librarian.enabled).toBe("boolean");
    expect(typeof result.librarian.redaction_logging).toBe("boolean");
    expect(typeof result.librarian.transport_type).toBe("string");
    expect(typeof result.librarian.max_classification).toBe("string");
  });

  it("tools.count matches tools.names.length", async () => {
    const raw = await callTool("memory_status", {});
    const result = parseToolResponse(raw) as { tools: { count: number; names: string[] } };
    expect(result.tools.count).toBe(result.tools.names.length);
  });

  it("tools.names includes memory_status itself", async () => {
    const raw = await callTool("memory_status", {});
    const result = parseToolResponse(raw) as { tools: { names: string[] } };
    expect(result.tools.names).toContain("memory_status");
  });

  it("principal reflects the calling context for owner", async () => {
    const raw = await callTool("memory_status", {});
    const result = parseToolResponse(raw) as {
      principal: { id: string; type: string };
      librarian: { transport_type: string; max_classification: string };
    };
    expect(result.principal.type).toBe("owner");
    expect(result.librarian.transport_type).toBe("local");
    expect(result.librarian.max_classification).toBe("client-restricted");
  });

  it("surfaces owner-only Librarian config warnings from the runtime config", async () => {
    const ownerCall = makeContextCallTool(
      ownerContext(),
      undefined,
      {
        transportMode: "http",
        librarianEnabled: false,
        hasLegacyBearerCredential: false,
        hasDpaBearerCredential: false,
        legacyBearerTransportType: "dpa_covered",
      },
    );

    const raw = await ownerCall("memory_status", {});
    const result = parseToolResponse(raw) as {
      librarian: { config_warnings?: string[] };
    };

    expect(result.librarian.config_warnings).toEqual([
      "MUNIN_LIBRARIAN_ENABLED is false; classification enforcement is disabled.",
      "No HTTP bearer credential currently resolves to dpa_covered; configure MUNIN_API_KEY_DPA or set MUNIN_API_KEY with MUNIN_BEARER_TRANSPORT_TYPE=dpa_covered.",
    ]);
  });

  it("does not expose Librarian config warnings to non-owner callers", async () => {
    const agentCall = makeContextCallTool(
      {
        principalId: "agent:test",
        principalType: "agent",
        namespaceRules: [],
      },
      undefined,
      {
        transportMode: "http",
        librarianEnabled: false,
        hasLegacyBearerCredential: false,
        hasDpaBearerCredential: false,
        legacyBearerTransportType: "dpa_covered",
      },
    );

    const raw = await agentCall("memory_status", {});
    const result = parseToolResponse(raw) as {
      librarian: { config_warnings?: string[] };
    };

    expect(result.librarian.config_warnings).toBeUndefined();
  });

  it("does not warn when legacy bearer already provides dpa-covered access", async () => {
    const ownerCall = makeContextCallTool(
      ownerContext(),
      undefined,
      {
        transportMode: "http",
        librarianEnabled: true,
        hasLegacyBearerCredential: true,
        hasDpaBearerCredential: false,
        legacyBearerTransportType: "dpa_covered",
      },
    );

    const raw = await ownerCall("memory_status", {});
    const result = parseToolResponse(raw) as {
      librarian: { config_warnings?: string[] };
    };

    expect(result.librarian.config_warnings).toBeUndefined();
  });

  it("principal reflects a non-owner context", async () => {
    const agentCtx: AccessContext = {
      principalId: "agent:test",
      principalType: "agent",
      namespaceRules: [],
    };
    const agentServer = new Server(
      { name: "test-munin-agent", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(agentServer, db, undefined, agentCtx);

    const agentCallTool = async (name: string, args: Record<string, unknown> = {}) => {
      const handler = (agentServer as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
      if (!handler) throw new Error("Cannot access tool handler");
      return handler({ method: "tools/call", params: { name, arguments: args } });
    };

    const raw = await agentCallTool("memory_status", {});
    const result = parseToolResponse(raw) as { principal: { id: string; type: string } };
    expect(result.principal.id).toBe("agent:test");
    expect(result.principal.type).toBe("agent");
  });
});

describe("unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const raw = await callTool("memory_nonexistent", {});
    const result = parseToolResponse(raw) as { error: string };
    expect(result.error).toBe("unknown_tool");
  });
});

describe("computeCommitmentConfidence", () => {
  const now = new Date().toISOString();
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  it("fresh tracked_next_step has confidence close to 0.90", () => {
    const confidence = computeCommitmentConfidence("tracked_next_step", now, false);
    expect(confidence).toBeCloseTo(0.90, 1);
  });

  // Source type ordering: status next-steps > explicit phrases > implicit mentions
  it("status next-steps (tracked_next_step) have higher confidence than log-extracted items", () => {
    const statusNextStep = computeCommitmentConfidence("tracked_next_step", now, false);
    const explicitPhrase = computeCommitmentConfidence("explicit_commitment", now, false);
    const implicit = computeCommitmentConfidence("explicit_dated_commitment", now, false);
    expect(statusNextStep).toBeGreaterThan(explicitPhrase);
    expect(explicitPhrase).toBeGreaterThan(implicit);
  });

  // Staleness: discrete multipliers — 30+ days = ×0.7, 60+ days = ×0.5
  it("old commitments have lower confidence than fresh ones", () => {
    const fresh = computeCommitmentConfidence("tracked_next_step", fiveDaysAgo, false);
    const stale30 = computeCommitmentConfidence("tracked_next_step", thirtyDaysAgo, false);
    const stale60 = computeCommitmentConfidence("tracked_next_step", sixtyDaysAgo, false);
    expect(stale30).toBeLessThan(fresh);
    expect(stale60).toBeLessThan(stale30);
  });

  it("30-day staleness applies ×0.7 multiplier to base score", () => {
    const stale = computeCommitmentConfidence("tracked_next_step", thirtyDaysAgo, false);
    expect(stale).toBeCloseTo(0.90 * 0.7, 5);
  });

  it("60-day staleness applies ×0.5 multiplier to base score", () => {
    const stale = computeCommitmentConfidence("tracked_next_step", sixtyDaysAgo, false);
    expect(stale).toBeCloseTo(0.90 * 0.5, 5);
  });

  // Specificity: dates score higher than vague ones
  it("commitments with dates score higher than vague ones", () => {
    const withDue = computeCommitmentConfidence("tracked_next_step", now, true);
    const withoutDue = computeCommitmentConfidence("tracked_next_step", now, false);
    expect(withDue).toBeGreaterThan(withoutDue);
  });

  it("commitments with specific names score higher than generic ones", () => {
    const withName = computeCommitmentConfidence("tracked_next_step", now, false, "Review PR from Alice before Friday");
    const withoutName = computeCommitmentConfidence("tracked_next_step", now, false, "review the pr");
    expect(withName).toBeGreaterThan(withoutName);
  });

  it("vague terms reduce confidence", () => {
    const vague = computeCommitmentConfidence("explicit_commitment", now, false, "will eventually fix the issue someday");
    const nonVague = computeCommitmentConfidence("explicit_commitment", now, false, "will fix the issue");
    expect(vague).toBeLessThan(nonVague);
  });

  // Clamping to [0.0, 1.0]
  it("confidence never exceeds 1.0", () => {
    expect(computeCommitmentConfidence("tracked_next_step", now, true, "Fix by 2026-01-01 with Alice")).toBeLessThanOrEqual(1.0);
    expect(computeCommitmentConfidence("explicit_commitment", now, true)).toBeLessThanOrEqual(1.0);
  });

  it("confidence never drops below 0.0", () => {
    const veryStale = computeCommitmentConfidence("unknown_type", sixtyDaysAgo, false, "maybe someday eventually");
    expect(veryStale).toBeGreaterThanOrEqual(0.0);
  });
});
