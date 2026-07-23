import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ownerContext, type AccessContext } from "../src/access.js";
import {
  getNamespaceEntriesForIntake,
  getNamespaceStateEntries,
  initDatabase,
  readState,
  writeState,
} from "../src/db.js";
import {
  evaluateIntake,
  getPersistedIntake,
} from "../src/intake.js";
import { registerTools } from "../src/tools.js";

function parse(response: unknown): Record<string, unknown> {
  const result = response as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeServer(
  db: Database.Database,
  ctx: AccessContext,
): (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const server = new Server(
    { name: "test-munin-intake", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ctx);
  return async (name, args = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    return parse(await handler({ method: "tools/call", params: { name, arguments: args } }));
  };
}

describe("advisory intake evaluator", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("accepts a meaningful first entry", () => {
    const result = evaluateIntake({
      namespace: "projects/new",
      key: "architecture",
      content:
        "Munin uses SQLite with FTS5 for local persistence and lexical retrieval.",
      tags: ["architecture"],
      candidates: [],
      now: "2026-07-23T07:00:00.000Z",
    });

    expect(result.status).toBe("accepted");
    expect(result.flags).toEqual([]);
    expect(result.metadata.intake_mode).toBe("advisory");
    expect(result.metadata.intake_timestamp).toBe("2026-07-23T07:00:00.000Z");
  });

  it("flags duplicate keys and deterministic near-duplicate content", () => {
    writeState(
      db,
      "projects/example",
      "architecture",
      "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      ["architecture"],
      "owner",
    );
    const candidates = getNamespaceStateEntries(db, "projects/example");

    const duplicate = evaluateIntake({
      namespace: "projects/example",
      key: "architecture",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
      candidates,
    });
    expect(duplicate.flags.map((flag) => flag.check)).toContain("duplicate_key");

    const overlap = evaluateIntake({
      namespace: "projects/example",
      key: "database",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
      candidates,
    });
    expect(overlap.flags.map((flag) => flag.check)).toEqual(
      expect.arrayContaining(["content_overlap", "consolidation_candidate"]),
    );
    expect(overlap.metadata.redundancy_flag?.existing_key).toBe("architecture");
  });

  it("flags sparse content, deep namespaces, and novel tag vocabularies", () => {
    writeState(
      db,
      "projects/example",
      "architecture",
      "Architecture decision record with enough meaningful implementation context.",
      ["architecture", "decision"],
      "owner",
    );
    writeState(
      db,
      "projects/example",
      "storage",
      "Storage design notes with durable persistence and recovery boundaries.",
      ["architecture", "storage"],
      "owner",
    );

    const result = evaluateIntake({
      namespace: "projects/example/too/deep",
      key: "x",
      content: "hi",
      tags: ["zebra", "quantum"],
      candidates: getNamespaceStateEntries(db, "projects/example"),
    });

    expect(result.flags.map((flag) => flag.check)).toEqual(
      expect.arrayContaining(["low_relevance", "namespace_depth", "tag_inconsistency"]),
    );
    expect(result.status).toBe("flagged");
  });

  it("bounds candidate content before loading it from SQLite", () => {
    writeState(
      db,
      "projects/example",
      "large",
      "x".repeat(20_000),
      [],
      "owner",
    );

    const [candidate] = getNamespaceEntriesForIntake(
      db,
      "projects/example",
      "client-restricted",
    );

    expect(candidate.content).toHaveLength(8_000);
  });
});

describe("write-path intake integration", () => {
  let db: Database.Database;
  let ownerCall: ReturnType<typeof makeServer>;

  beforeEach(() => {
    db = initDatabase(":memory:");
    ownerCall = makeServer(db, ownerContext());
  });

  afterEach(() => {
    db.close();
  });

  it("returns and persists advisory findings without rejecting the write", async () => {
    const first = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "architecture",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const second = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "database",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect((second.intake as { status: string }).status).toBe("flagged");
    expect(second.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[intake:content_overlap]"),
      ]),
    );
    expect(readState(db, "projects/intake", "database")?.content).toContain(
      "durable persistence",
    );

    const persisted = getPersistedIntake(db, second.id as string);
    expect(persisted?.status).toBe("flagged");
    expect(persisted?.flags.map((flag) => flag.check)).toContain("content_overlap");
    expect(persisted?.evaluator_version).toBe(1);
  });

  it("upserts one intake record for mutable state and cascades on deletion", async () => {
    const first = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "mutable",
      content:
        "A meaningful initial state entry with enough durable implementation context.",
    });
    const second = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "mutable",
      content: "hi",
    });

    expect(second.id).toBe(first.id);
    expect(
      (getPersistedIntake(db, first.id as string)?.flags ?? [])
        .map((flag) => flag.check),
    ).toContain("low_relevance");
    const count = db.prepare(
      "SELECT COUNT(*) AS count FROM entry_intake WHERE entry_id = ?",
    ).get(first.id) as { count: number };
    expect(count.count).toBe(1);

    db.prepare("DELETE FROM entries WHERE id = ?").run(first.id);
    expect(getPersistedIntake(db, first.id as string)).toBeNull();
  });

  it("evaluates log writes and stores one bounded record per entry", async () => {
    await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis can never block durable memory writes.",
      tags: ["decision"],
    });
    const result = await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis can never block durable memory writes.",
      tags: ["decision"],
    });

    expect(result.status).toBe("logged");
    expect((result.intake as { status: string }).status).toBe("flagged");
    expect(getPersistedIntake(db, result.id as string)?.flags.map(
      (flag) => flag.check,
    )).toContain("content_overlap");
  });

  it("does not flag a corrected log against the predecessor it supersedes", async () => {
    const first = await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis cannot block durable memory writes.",
      tags: ["decision"],
    });
    const correction = await ownerCall("memory_log", {
      namespace: "projects/intake",
      content:
        "Decided to keep the write-time quality gate advisory so optional analysis can never block durable memory writes.",
      tags: ["decision"],
      supersedes: first.id,
      expected_updated_at: first.timestamp,
    });
    const checks = (
      correction.intake as { flags: Array<{ check: string }> }
    ).flags.map((flag) => flag.check);

    expect(correction.status).toBe("superseded");
    expect(checks).not.toContain("content_overlap");
    expect(checks).not.toContain("consolidation_candidate");
  });

  it("does not leak higher-classification related entries through intake", async () => {
    const restricted = await ownerCall("memory_write", {
      namespace: "projects/isolated",
      key: "restricted-design",
      content:
        "Confidential architecture uses SQLite FTS5 for local full text search and durable persistence.",
      tags: ["architecture"],
      classification: "client-restricted",
    });
    const limitedCall = makeServer(db, {
      principalId: "agent:limited",
      principalType: "agent",
      accessibleNamespaces: [
        { pattern: "projects/isolated", permissions: "rw" },
      ],
      maxClassification: "internal",
      transportType: "consumer",
    });

    const result = await limitedCall("memory_write", {
      namespace: "projects/isolated",
      key: "public-design",
      content:
        "Confidential architecture uses SQLite FTS5 for local full text search and durable persistence.",
      tags: ["architecture"],
      classification: "internal",
    });
    const serializedIntake = JSON.stringify(result.intake);

    expect(result.status).toBe("created");
    expect(serializedIntake).not.toContain("restricted-design");
    expect(serializedIntake).not.toContain(restricted.id as string);
    expect(
      ((result.intake as { flags: Array<{ related_entry_id?: string }> }).flags)
        .some((flag) => flag.related_entry_id === restricted.id),
    ).toBe(false);
  });

  it("does not derive related-entry findings for a write-only principal", async () => {
    const hidden = await ownerCall("memory_write", {
      namespace: "projects/write-only-intake",
      key: "hidden",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const writerCall = makeServer(db, {
      principalId: "writer:intake",
      principalType: "external",
      accessibleNamespaces: [
        { pattern: "projects/write-only-intake", permissions: "write" },
      ],
      maxClassification: "internal",
      transportType: "consumer",
    });

    const result = await writerCall("memory_write", {
      namespace: "projects/write-only-intake",
      key: "new",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const serializedIntake = JSON.stringify(result.intake);

    expect(result.status).toBe("created");
    expect(serializedIntake).not.toContain(hidden.id as string);
    expect(serializedIntake).not.toContain("\"hidden\"");
  });

  it("does not let expired state influence related-entry analysis", async () => {
    const expired = await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "old",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
      valid_until: "2025-01-01T00:00:00.000Z",
    });
    const result = await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "current",
      content:
        "SQLite FTS5 provides local full text search and durable persistence for memory entries.",
      tags: ["architecture"],
    });
    const intake = result.intake as {
      flags: Array<{ related_entry_id?: string }>;
      metadata: { related_keys: unknown[] };
    };

    expect(intake.flags.some((flag) => flag.related_entry_id === expired.id)).toBe(false);
    expect(intake.metadata.related_keys).toEqual([]);
  });

  it("does not treat reviving an expired state key as a duplicate overwrite", async () => {
    await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "revived",
      content: "Old temporary state that has already expired.",
      valid_until: "2025-01-01T00:00:00.000Z",
    });
    const result = await ownerCall("memory_write", {
      namespace: "projects/expired-intake",
      key: "revived",
      content: "Fresh current state replacing the expired temporary value.",
    });
    const checks = (
      result.intake as { flags: Array<{ check: string }> }
    ).flags.map((flag) => flag.check);

    expect(result.status).toBe("updated");
    expect(checks).not.toContain("duplicate_key");
  });

  it("keeps writes successful when optional intake persistence is unavailable", async () => {
    db.exec("DROP TABLE entry_intake");

    const result = await ownerCall("memory_write", {
      namespace: "projects/intake",
      key: "survives",
      content:
        "This write must survive even if optional intake metadata cannot be persisted.",
    });

    expect(result.status).toBe("created");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[intake:persistence_unavailable]"),
      ]),
    );
    expect(readState(db, "projects/intake", "survives")).not.toBeNull();
  });
});
