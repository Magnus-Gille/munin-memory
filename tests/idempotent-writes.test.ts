import { describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { ownerContext, type AccessContext } from "../src/access.js";
import { registerTools } from "../src/tools.js";
import { createTestStorage } from "./helpers/test-storage.js";

const KEY = "a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6";

type Call = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function makeCall(db: ReturnType<typeof initDatabase>, context: AccessContext = ownerContext()): Call {
  const server = new Server(
    { name: "idempotent-writes-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, context);
  return async (name, args = {}) => {
    const handler = (server as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers.get("tools/call");
    if (!handler) throw new Error("tools/call handler unavailable");
    const response = await handler({ method: "tools/call", params: { name, arguments: args } });
    return JSON.parse((response as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;
  };
}

function familyContext(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    principalId: "alice",
    principalType: "family",
    accessibleNamespaces: [{ pattern: "users/alice/*", permissions: "rw" }],
    maxClassification: "internal",
    transportType: "consumer",
    ...overrides,
  };
}

function entryCount(db: ReturnType<typeof initDatabase>, namespace: string, entryType?: string): number {
  if (entryType) {
    return (db.prepare("SELECT COUNT(*) AS count FROM entries WHERE namespace = ? AND entry_type = ?").get(namespace, entryType) as { count: number }).count;
  }
  return (db.prepare("SELECT COUNT(*) AS count FROM entries WHERE namespace = ?").get(namespace) as { count: number }).count;
}

describe("durable idempotency for memory writes, logs, and status updates", () => {
  it("rejects malformed UUIDs without reserving or writing anything", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    for (const key of ["", "not-a-uuid", 42, null]) {
      expect(await call("memory_log", {
        namespace: "testing/invalid-key", content: "safe text", idempotency_key: key,
      })).toMatchObject({ ok: false, error: "validation_error" });
    }
    expect(entryCount(db, "testing/invalid-key")).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM write_receipts").get()).toEqual({ count: 0 });
    db.close();
  });

  it("recovers stale status CAS and create_if_absent outcomes after later writes", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const namespace = "projects/replay-later";
    const seed = await call("memory_update_status", { namespace, phase: "Initial" });
    const args = { namespace, phase: "Committed", expected_updated_at: seed.updated_at, idempotency_key: KEY };
    const first = await call("memory_update_status", args);
    await call("memory_update_status", { namespace, phase: "Later truth" });
    const replay = await call("memory_update_status", args);
    expect(replay).toMatchObject({
      ok: true, status: first.status, id: first.id, updated_at: first.updated_at,
      entry_changed: true, idempotency_replayed: true,
    });
    expect(replay).not.toHaveProperty("content");
    expect(replay).not.toHaveProperty("structured_status");
    expect((await call("memory_read", { namespace, key: "status" })).content).toContain("Later truth");
    const createArgs = { namespace, key: "once", content: "original", create_if_absent: true,
      idempotency_key: "22222222-2222-4222-8222-222222222222" };
    const created = await call("memory_write", createArgs);
    await call("memory_write", { namespace, key: "once", content: "later" });
    expect(await call("memory_write", createArgs)).toMatchObject({
      ok: true, status: "created", id: created.id, updated_at: created.updated_at,
      entry_changed: true, idempotency_replayed: true,
    });
    db.close();
  });

  it("denies an agent replay after the live entry is reclassified above its ceiling", async () => {
    const db = initDatabase(":memory:");
    const ctx = familyContext({ principalType: "agent" });
    const call = makeCall(db, ctx);
    const args = { namespace: "users/alice/reclassified", key: "note", content: "internal", idempotency_key: KEY };
    const first = await call("memory_write", args);
    expect(first.ok).toBe(true);
    db.prepare("UPDATE entries SET classification = 'client-restricted' WHERE id = ?").run(first.id);
    const denied = await call("memory_write", args);
    expect(denied).toMatchObject({ ok: false, error: "access_denied" });
    expect(denied).not.toHaveProperty("id");
    db.close();
  });

  it.each(["memory_write", "memory_log"])("replays %s corrections without creating another revision", async (tool) => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const namespace = "testing/replay-correction";
    const seedArgs = { namespace, content: "Original evidence", ...(tool === "memory_write" ? { key: "note" } : {}) };
    const seed = await call(tool, seedArgs);
    const args = { ...seedArgs, content: "Corrected evidence", supersedes: seed.id,
      expected_updated_at: seed.updated_at ?? seed.timestamp, idempotency_key: KEY };
    const first = await call(tool, args);
    expect(first).toMatchObject({ ok: true, status: "superseded" });
    const audits = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get();
    expect(await call(tool, args)).toMatchObject({
      ok: true, status: "superseded", id: first.id, valid_from: first.valid_from,
      supersedes: seed.id, idempotency_replayed: true,
    });
    expect(entryCount(db, namespace)).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log").get()).toEqual(audits);
    db.close();
  });

  it("rechecks raised namespace floors and retains the owner's explicit below-floor override", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db, familyContext({ principalType: "agent" }));
    const args = { namespace: "users/alice/floor", key: "note", content: "internal", idempotency_key: KEY };
    expect((await call("memory_write", args)).ok).toBe(true);
    db.prepare("INSERT INTO namespace_classification (namespace_pattern, min_classification, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("users/alice/floor", "client-restricted", "2026-01-01", "2026-01-01");
    expect(await call("memory_write", args)).toMatchObject({ ok: false, error: "access_denied" });
    const owner = makeCall(db, { ...ownerContext(), maxClassification: "public", transportType: "consumer" });
    const override = { namespace: "clients/replay-override", key: "note", content: "Public release",
      classification: "public", classification_override: true, idempotency_key: KEY };
    expect((await owner("memory_write", override)).ok).toBe(true);
    expect(await owner("memory_write", override)).toMatchObject({ ok: true, idempotency_replayed: true });
    db.close();
  });

  it("replays a write by canonical args and UUID case without returning payload", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const first = await call("memory_write", {
      namespace: "projects/idempotency-write",
      key: "status",
      content: "private idempotency payload",
      tags: ["active"],
      idempotency_key: KEY,
    });
    const replay = await call("memory_write", {
      idempotency_key: KEY.toUpperCase(),
      tags: ["active"],
      content: "private idempotency payload",
      key: "status",
      namespace: "projects/idempotency-write",
    });

    expect(first).toMatchObject({ ok: true, status: "created" });
    expect(replay).toMatchObject({
      ok: true,
      idempotency_replayed: true,
      entry_available: true,
      entry_changed: false,
      id: first.id,
      status: first.status,
      updated_at: first.updated_at,
    });
    expect(JSON.stringify(replay)).not.toContain("private idempotency payload");
    db.close();
  });

  it("rejects different args, tool names, and namespaces under one receipt key", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const first = await call("memory_write", {
      namespace: "projects/idempotency-conflict",
      key: "one",
      content: "original",
      idempotency_key: KEY,
    });
    expect(first.ok).toBe(true);

    await expect(call("memory_write", {
      namespace: "projects/idempotency-conflict",
      key: "one",
      content: "changed",
      idempotency_key: KEY,
    })).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
    await expect(call("memory_log", {
      namespace: "projects/idempotency-conflict",
      content: "original",
      idempotency_key: KEY,
    })).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
    await expect(call("memory_write", {
      namespace: "projects/other",
      key: "one",
      content: "original",
      idempotency_key: KEY,
    })).resolves.toMatchObject({ ok: false, error: "idempotency_conflict" });
    expect(entryCount(db, "projects/idempotency-conflict")).toBe(1);
    expect(entryCount(db, "projects/other")).toBe(0);
    db.close();
  });

  it("replays a log without appending a duplicate", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const args = {
      namespace: "projects/idempotency-log",
      content: "A decision recorded exactly once",
      tags: ["decision"],
      idempotency_key: KEY,
    };
    const first = await call("memory_log", args);
    const replay = await call("memory_log", {
      idempotency_key: KEY.toUpperCase(),
      tags: ["decision"],
      content: "A decision recorded exactly once",
      namespace: "projects/idempotency-log",
    });

    expect(first).toMatchObject({ ok: true, status: "logged" });
    expect(replay).toMatchObject({
      ok: true,
      idempotency_replayed: true,
      entry_available: true,
      entry_changed: false,
      id: first.id,
      timestamp: first.timestamp,
    });
    expect(entryCount(db, "projects/idempotency-log", "log")).toBe(1);
    db.close();
  });

  it("replays a structured status update exactly once", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const first = await call("memory_update_status", {
      namespace: "projects/idempotency-status",
      phase: "active",
      current_work: "Implementing replay safety",
      blockers: "None.",
      next_steps: ["Run recovery tests"],
      lifecycle: "active",
      idempotency_key: KEY,
    });
    const replay = await call("memory_update_status", {
      idempotency_key: KEY.toUpperCase(),
      next_steps: ["Run recovery tests"],
      blockers: "None.",
      current_work: "Implementing replay safety",
      phase: "active",
      lifecycle: "active",
      namespace: "projects/idempotency-status",
    });

    expect(first).toMatchObject({ ok: true, status: "created" });
    expect(replay).toMatchObject({
      ok: true,
      idempotency_replayed: true,
      entry_available: true,
      entry_changed: false,
      id: first.id,
      updated_at: first.updated_at,
    });
    expect(entryCount(db, "projects/idempotency-status", "state")).toBe(1);
    db.close();
  });

  it("replays a patch despite its original CAS becoming stale and applies it once", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const seed = await call("memory_write", {
      namespace: "projects/idempotency-patch",
      key: "note",
      content: "base",
    });
    const patch = {
      namespace: "projects/idempotency-patch",
      key: "note",
      patch: { content_append: " + one" },
      expected_updated_at: seed.updated_at,
      idempotency_key: KEY,
    };
    const first = await call("memory_write", patch);
    const replay = await call("memory_write", {
      idempotency_key: KEY.toUpperCase(),
      expected_updated_at: seed.updated_at,
      patch: { content_append: " + one" },
      key: "note",
      namespace: "projects/idempotency-patch",
    });
    const read = await call("memory_read", { namespace: "projects/idempotency-patch", key: "note" });

    expect(first).toMatchObject({ ok: true, status: "patched" });
    expect(replay).toMatchObject({ ok: true, idempotency_replayed: true, entry_changed: false, id: first.id });
    expect(read).toMatchObject({ found: true, content: "base\n + one" });
    db.close();
  });

  it("does not reserve a key for validate_only status checks", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const preview = await call("memory_update_status", {
      namespace: "projects/idempotency-validate",
      phase: "active",
      current_work: "Preview",
      blockers: "None.",
      next_steps: ["Write"],
      validate_only: true,
      idempotency_key: KEY,
    });
    const write = await call("memory_update_status", {
      namespace: "projects/idempotency-validate",
      phase: "active",
      current_work: "Preview",
      blockers: "None.",
      next_steps: ["Write"],
      idempotency_key: KEY,
    });

    expect(preview).toMatchObject({ ok: true, status: "validated", wrote: false });
    expect(write).toMatchObject({ ok: true, status: "created" });
    expect(write.idempotency_replayed).toBe(false);
    db.close();
  });

  it("rechecks namespace and classification authorization before replay", async () => {
    const db = initDatabase(":memory:");
    const writer = makeCall(db, familyContext());
    const first = await writer("memory_write", {
      namespace: "users/alice/idempotency-auth",
      key: "note",
      content: "internal replay target",
      classification: "internal",
      idempotency_key: KEY,
    });
    expect(first.ok).toBe(true);

    const deniedByNamespace = await makeCall(db, familyContext({
      accessibleNamespaces: [{ pattern: "users/alice/idempotency-auth", permissions: "read" }],
    }))(
      "memory_write",
      { namespace: "users/alice/idempotency-auth", key: "note", content: "internal replay target", classification: "internal", idempotency_key: KEY },
    );
    expect(deniedByNamespace).toMatchObject({ ok: true, found: false });

    const deniedByClassification = await makeCall(db, familyContext({ maxClassification: "public" }))(
      "memory_write",
      { namespace: "users/alice/idempotency-auth", key: "note", content: "internal replay target", classification: "internal", idempotency_key: KEY },
    );
    expect(deniedByClassification).toMatchObject({ ok: true, found: false });
    db.close();
  });

  it("isolates the same key across principals", async () => {
    const db = initDatabase(":memory:");
    const alice = makeCall(db, familyContext());
    const bob = makeCall(db, familyContext({ principalId: "bob", accessibleNamespaces: [{ pattern: "users/bob/*", permissions: "rw" }] }));
    const aliceResult = await alice("memory_write", { namespace: "users/alice/idempotency-isolation", key: "note", content: "alice", idempotency_key: KEY });
    const bobResult = await bob("memory_write", { namespace: "users/bob/idempotency-isolation", key: "note", content: "bob", idempotency_key: KEY });

    expect(aliceResult).toMatchObject({ ok: true, status: "created" });
    expect(bobResult).toMatchObject({ ok: true, status: "created" });
    expect(bobResult.idempotency_replayed).toBe(false);
    db.close();
  });

  it("does not reserve a key after validation or a stale CAS failure", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const invalid = await call("memory_write", {
      namespace: "projects/idempotency-failure",
      key: "bad",
      content: "",
      idempotency_key: KEY,
    });
    const seed = await call("memory_write", { namespace: "projects/idempotency-failure", key: "cas", content: "seed" });
    const stale = await call("memory_write", {
      namespace: "projects/idempotency-failure",
      key: "cas",
      content: "updated",
      expected_updated_at: "2020-01-01T00:00:00.000Z",
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    });
    const corrected = await call("memory_write", {
      namespace: "projects/idempotency-failure",
      key: "cas",
      content: "updated",
      expected_updated_at: seed.updated_at,
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    });

    expect(invalid).toMatchObject({ ok: false, error: "validation_error" });
    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect(corrected).toMatchObject({ ok: true, status: "updated" });
    expect(corrected.idempotency_replayed).toBe(false);
    db.close();
  });

  it("keeps a deleted create_if_absent entry as a replay tombstone", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const first = await call("memory_write", {
      namespace: "projects/idempotency-tombstone",
      key: "note",
      content: "delete me",
      create_if_absent: true,
      idempotency_key: KEY,
    });
    const preview = await call("memory_delete", { namespace: "projects/idempotency-tombstone", key: "note" });
    expect(preview.phase).toBe("preview");
    const deletion = await call("memory_delete", { namespace: "projects/idempotency-tombstone", key: "note", delete_token: preview.delete_token });
    expect(deletion.phase).toBe("confirmed");

    const replay = await call("memory_write", {
      namespace: "projects/idempotency-tombstone",
      key: "note",
      content: "delete me",
      create_if_absent: true,
      idempotency_key: KEY.toUpperCase(),
    });
    const read = await call("memory_read", { namespace: "projects/idempotency-tombstone", key: "note" });

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({ ok: true, idempotency_replayed: true, entry_available: false, entry_changed: false, id: first.id });
    expect(read.found).toBe(false);
    db.close();
  });

  it("replays from a reopened database", async () => {
    const storage = createTestStorage("idempotency-reopen");
    const firstDb = initDatabase(storage.path);
    const first = await makeCall(firstDb)("memory_write", {
      namespace: "projects/idempotency-reopen",
      key: "note",
      content: "survives restart",
      idempotency_key: KEY,
    });
    firstDb.close();

    const reopened = initDatabase(storage.path);
    const replay = await makeCall(reopened)("memory_write", {
      idempotency_key: KEY.toUpperCase(),
      content: "survives restart",
      key: "note",
      namespace: "projects/idempotency-reopen",
    });
    expect(replay).toMatchObject({ ok: true, idempotency_replayed: true, id: first.id, updated_at: first.updated_at });
    reopened.close();
    storage.cleanup();
  });

  it("rolls effects and audits back when receipt insertion fails", async () => {
    const db = initDatabase(":memory:");
    const call = makeCall(db);
    const receiptTable = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (lower(name) LIKE '%idempot%' OR lower(name) LIKE '%receipt%' OR lower(name) LIKE '%replay%') ORDER BY name LIMIT 1",
    ).get() as { name?: string } | undefined)?.name;
    expect(receiptTable).toBeTruthy();
    const quotedTable = `"${receiptTable!.replaceAll('"', '""')}"`;
    db.exec(`CREATE TRIGGER idempotency_test_receipt_failure BEFORE INSERT ON ${quotedTable} BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END`);

    const entriesBefore = (db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count;
    const auditsBefore = (db.prepare("SELECT COUNT(*) AS count FROM audit_log").get() as { count: number }).count;
    const failed = await call("memory_write", {
      namespace: "projects/idempotency-atomicity",
      key: "note",
      content: "must roll back",
      idempotency_key: KEY,
    });
    const entriesAfter = (db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count;
    const auditsAfter = (db.prepare("SELECT COUNT(*) AS count FROM audit_log").get() as { count: number }).count;

    expect(failed.ok).toBe(false);
    expect(entriesAfter).toBe(entriesBefore);
    expect(auditsAfter).toBe(auditsBefore);
    expect((await call("memory_read", { namespace: "projects/idempotency-atomicity", key: "note" })).found).toBe(false);
    db.exec("DROP TRIGGER idempotency_test_receipt_failure");
    expect(await call("memory_write", {
      namespace: "projects/idempotency-atomicity", key: "note", content: "must roll back", idempotency_key: KEY,
    })).toMatchObject({ ok: true, status: "created", idempotency_replayed: false });
    db.close();
  });
});
