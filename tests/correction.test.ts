import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import type { AccessContext } from "../src/access.js";

let db: Database.Database;
let server: Server;

function parse(response: unknown): Record<string, unknown> {
  const result = response as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })
    ._requestHandlers.get("tools/call");
  if (!handler) throw new Error("Cannot access tool handler");
  return parse(await handler({ method: "tools/call", params: { name, arguments: args } }));
}

function callAs(ctx: AccessContext) {
  const contextServer = new Server(
    { name: "test-munin-correction-access", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(contextServer, db, undefined, ctx);
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const handler = (contextServer as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    return parse(await handler({ method: "tools/call", params: { name, arguments: args } }));
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
  server = new Server(
    { name: "test-munin-corrections", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db);
});

afterEach(() => db.close());

describe("state correction", () => {
  it("creates a new revision, hides the predecessor, and supports direct and as-of reads", async () => {
    const created = await call("memory_write", {
      namespace: "projects/corrections",
      key: "status",
      content: "The launch is Friday",
      tags: ["active"],
    });
    const predecessorId = created.id as string;
    const predecessorUpdatedAt = "2026-07-20T10:00:00.000Z";
    db.prepare(
      "UPDATE entries SET created_at = ?, updated_at = ?, valid_from = ? WHERE id = ?",
    ).run(predecessorUpdatedAt, predecessorUpdatedAt, predecessorUpdatedAt, predecessorId);
    const validFrom = new Date().toISOString();

    const corrected = await call("memory_write", {
      namespace: "projects/corrections",
      key: "status",
      content: "The launch is Monday",
      supersedes: predecessorId,
      expected_updated_at: predecessorUpdatedAt,
      valid_from: validFrom,
    });

    expect(corrected.status).toBe("superseded");
    expect(corrected.id).not.toBe(predecessorId);
    expect(corrected.supersedes).toBe(predecessorId);

    const current = await call("memory_read", {
      namespace: "projects/corrections",
      key: "status",
    });
    expect(current.content).toBe("The launch is Monday");
    expect(current.valid_from).toBe(validFrom);

    const historical = await call("memory_get", { id: predecessorId });
    expect(historical.content).toBe("The launch is Friday");
    expect(historical.superseded).toBe(true);
    expect(historical.superseded_by).toBe(corrected.id);

    const beforeCorrection = await call("memory_read", {
      namespace: "projects/corrections",
      key: "status",
      as_of: predecessorUpdatedAt,
    });
    expect(beforeCorrection.content).toBe("The launch is Friday");

    const atCorrection = await call("memory_read", {
      namespace: "projects/corrections",
      key: "status",
      as_of: validFrom,
    });
    expect(atCorrection.content).toBe("The launch is Monday");

    const query = await call("memory_query", {
      namespace: "projects/corrections",
      query: "launch",
      limit: 10,
      include_expired: true,
    });
    const results = query.results as Array<{ id: string; content: string }>;
    expect(results.map((entry) => entry.id)).toEqual([corrected.id]);
  });

  it("requires exact CAS and rejects attempts to branch from an old revision", async () => {
    const created = await call("memory_write", {
      namespace: "projects/corrections",
      key: "fact",
      content: "v1",
    });

    const missingCas = await call("memory_write", {
      namespace: "projects/corrections",
      key: "fact",
      content: "v2",
      supersedes: created.id,
    });
    expect(missingCas.error).toBe("validation_error");

    const corrected = await call("memory_write", {
      namespace: "projects/corrections",
      key: "fact",
      content: "v2",
      supersedes: created.id,
      expected_updated_at: created.updated_at,
    });
    expect(corrected.status).toBe("superseded");

    const branch = await call("memory_write", {
      namespace: "projects/corrections",
      key: "fact",
      content: "alternative v2",
      supersedes: created.id,
      expected_updated_at: created.updated_at,
    });
    expect(branch.error).toBe("conflict");
  });

  it("rejects future validity and classification downgrades", async () => {
    const created = await call("memory_write", {
      namespace: "projects/corrections",
      key: "classified",
      content: "restricted v1",
      classification: "client-confidential",
    });

    const future = await call("memory_write", {
      namespace: "projects/corrections",
      key: "classified",
      content: "restricted v2",
      supersedes: created.id,
      expected_updated_at: created.updated_at,
      valid_from: "2999-01-01T00:00:00.000Z",
      classification: "client-confidential",
    });
    expect(future.error).toBe("validation_error");

    const downgrade = await call("memory_write", {
      namespace: "projects/corrections",
      key: "classified",
      content: "public v2",
      supersedes: created.id,
      expected_updated_at: created.updated_at,
      classification: "internal",
    });
    expect(downgrade.error).toBe("classification_error");
  });

  it("resolves multi-step correction chains at half-open as-of boundaries", async () => {
    const first = await call("memory_write", {
      namespace: "projects/corrections",
      key: "chain",
      content: "A",
    });
    const t1 = "2026-07-20T10:00:00.000Z";
    const t2 = "2026-07-20T11:00:00.000Z";
    const t3 = "2026-07-20T12:00:00.000Z";
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ?, valid_from = ? WHERE id = ?")
      .run(t1, t1, t1, first.id);

    const second = await call("memory_write", {
      namespace: "projects/corrections",
      key: "chain",
      content: "B",
      supersedes: first.id,
      expected_updated_at: t1,
      valid_from: t2,
    });
    const third = await call("memory_write", {
      namespace: "projects/corrections",
      key: "chain",
      content: "C",
      supersedes: second.id,
      expected_updated_at: second.updated_at,
      valid_from: t3,
    });

    expect((await call("memory_read", {
      namespace: "projects/corrections", key: "chain", as_of: t1,
    })).content).toBe("A");
    expect((await call("memory_read", {
      namespace: "projects/corrections", key: "chain", as_of: t2,
    })).content).toBe("B");
    expect((await call("memory_read", {
      namespace: "projects/corrections", key: "chain", as_of: t3,
    })).content).toBe("C");
    expect(third.status).toBe("superseded");
  });

  it("lists only the current revision and deletes a corrected state chain atomically", async () => {
    const first = await call("memory_write", {
      namespace: "projects/corrections",
      key: "deletable",
      content: "old",
    });
    const second = await call("memory_write", {
      namespace: "projects/corrections",
      key: "deletable",
      content: "new",
      supersedes: first.id,
      expected_updated_at: first.updated_at,
    });

    const listed = await call("memory_list", { namespace: "projects/corrections" });
    const stateEntries = listed.state_entries as Array<{ id: string; key: string }>;
    expect(stateEntries.filter((entry) => entry.key === "deletable")).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);

    const preview = await call("memory_delete", {
      namespace: "projects/corrections",
      key: "deletable",
    });
    expect((preview.will_delete as { state_count: number }).state_count).toBe(1);
    const deleted = await call("memory_delete", {
      namespace: "projects/corrections",
      key: "deletable",
      delete_token: preview.delete_token,
    });
    expect(deleted.deleted_count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM entries WHERE id IN (?, ?)")
      .get(first.id, second.id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM entry_supersessions").get())
      .toEqual({ count: 0 });
  });

  it("records corrections as a filterable audit action", async () => {
    const first = await call("memory_write", {
      namespace: "projects/corrections", key: "audited", content: "old",
    });
    await call("memory_write", {
      namespace: "projects/corrections",
      key: "audited",
      content: "new",
      supersedes: first.id,
      expected_updated_at: first.updated_at,
    });

    const history = await call("memory_history", {
      namespace: "projects/corrections",
      action: "supersede",
    });
    const entries = history.entries as Array<{ action: string; key: string }>;
    expect(entries).toEqual([expect.objectContaining({ action: "supersede", key: "audited" })]);
  });

  it("requires both read and write access and source ownership", async () => {
    const rw = callAs({
      principalId: "alice",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "users/alice/*", permissions: "rw" }],
    });
    const writeOnly = callAs({
      principalId: "alice",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "users/alice/*", permissions: "write" }],
    });
    const readOnly = callAs({
      principalId: "alice",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "users/alice/*", permissions: "read" }],
    });
    const bob = callAs({
      principalId: "bob",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "users/alice/*", permissions: "rw" }],
    });

    const first = await rw("memory_write", {
      namespace: "users/alice/notes", key: "fact", content: "old",
    });
    const correction = {
      namespace: "users/alice/notes",
      key: "fact",
      content: "new",
      supersedes: first.id,
      expected_updated_at: first.updated_at,
    };
    expect((await writeOnly("memory_write", correction)).found).toBe(false);
    expect((await readOnly("memory_write", correction)).found).toBe(false);
    expect((await bob("memory_write", correction)).found).toBe(false);
    expect((await rw("memory_write", {
      ...correction,
      valid_from: new Date().toISOString(),
    })).error).toBe("access_denied");
    expect((await rw("memory_write", correction)).status).toBe("superseded");
  });
});

describe("log correction", () => {
  it("appends an immutable successor while default query hides the corrected log", async () => {
    const original = await call("memory_log", {
      namespace: "projects/corrections",
      content: "Decision: use Redis",
      tags: ["decision"],
    });

    const corrected = await call("memory_log", {
      namespace: "projects/corrections",
      content: "Decision: use SQLite",
      tags: ["decision"],
      supersedes: original.id,
      expected_updated_at: original.timestamp,
    });
    expect(corrected.status).toBe("superseded");
    expect(corrected.supersedes).toBe(original.id);

    const storedOriginal = db.prepare(
      "SELECT content, created_at, updated_at FROM entries WHERE id = ?",
    ).get(original.id) as { content: string; created_at: string; updated_at: string };
    expect(storedOriginal).toEqual({
      content: "Decision: use Redis",
      created_at: original.timestamp,
      updated_at: original.timestamp,
    });

    const direct = await call("memory_get", { id: original.id });
    expect(direct.content).toBe("Decision: use Redis");
    expect(direct.superseded_by).toBe(corrected.id);

    const query = await call("memory_query", {
      namespace: "projects/corrections",
      query: "Decision use",
      entry_type: "log",
    });
    const results = query.results as Array<{ id: string }>;
    expect(results.map((entry) => entry.id)).toEqual([corrected.id]);
  });
});
