import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ownerContext, type AccessContext } from "../src/access.js";
import {
  appendCodeHealthRecord,
  exportCodeHealthRecords,
} from "../src/code-health.js";
import { appendLog, executeDelete, getById, initDatabase, pruneCodeHealthRecords, rebuildFTS } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { createTestStorage } from "./helpers/test-storage.js";

let storage = createTestStorage("code-health");
const namespace = "projects/code-health";
const producer: AccessContext = {
  principalId: "agent:producer",
  principalType: "agent",
  accessibleNamespaces: [{ pattern: namespace, permissions: "rw" }],
  maxClassification: "internal",
  transportType: "local",
};

let db: Database.Database;
let sequence = 0;

function parse(response: unknown): Record<string, unknown> {
  const result = response as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function callAs(ctx: AccessContext, toolName = "memory_code_health") {
  const server = new Server({ name: "test-code-health", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, db, undefined, ctx);
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call");
  if (!handler) throw new Error("Cannot access MCP tool handler");
  return (args: Record<string, unknown>) => handler({ method: "tools/call", params: { name: toolName, arguments: args } });
}

function sampleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    ...structuredClone(sampleTemplate),
    task_id: `task-${sequence}`,
    attempt_id: "attempt-main",
    parent_attempt_id: null,
    record_id: `ref:record-${sequence}`,
    occurrence_id: `ref:occurrence-${sequence}`,
    observed_at: new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...overrides,
  };
}

const sampleTemplate = (() => {
  const value = JSON.parse(readFileSync(new URL("./fixtures/code-health/agent-positive.json", import.meta.url), "utf8")) as {
    records: Array<Record<string, unknown>>;
  };
  return value.records.find((candidate) => candidate.record_id === "ref:rec-worker")!;
})();

const sourceCloseTemplate = (() => {
  const value = JSON.parse(readFileSync(new URL("./fixtures/code-health/agent-positive.json", import.meta.url), "utf8")) as {
    records: Array<Record<string, unknown>>;
  };
  return value.records.find((candidate) => candidate.record_id === "ref:rec-close")!;
})();

function append(record: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return appendCodeHealthRecord(db, producer, {
    namespace,
    idempotency_key: randomUUID(),
    record,
    ...overrides,
  });
}

beforeEach(() => {
  db?.close();
  storage.cleanup();
  storage = createTestStorage("code-health");
  db = initDatabase(storage.path);
  sequence = 0;
});
afterAll(() => {
  db?.close();
  storage.cleanup();
});

describe("memory_code_health", () => {
  it("pins the vendored frozen validator, schema, and fixtures by SHA-256", () => {
    const expected: Record<string, string> = {
      "scripts/lib/code-health-agent.mjs": "9d887baea538e9801785122448b098e37a803ead244fea3f167a338d79ccb258",
      "scripts/lib/code-health-schema.mjs": "0bf6801120221ea0a21b64b8a0d15efe96e6f51a8858f4be042878f36885eb59",
      "docs/code-health-agent-v1.schema.json": "c329c167c9537382613dbc93950ecb7c82e8b4e42b66562a5821abc9d76e3bea",
      "tests/fixtures/code-health/agent-positive.json": "67864271b8a18bdc5f6249e4017075c2d0a0152857e9c858eaf17e9463b68ffd",
      "tests/fixtures/code-health/agent-adversarial.json": "2f758198a1aa1eccaf342dc86656f02ac4dcca7860b761e6330b134e75277b17",
    };
    for (const [file, hash] of Object.entries(expected)) {
      const actual = createHash("sha256").update(readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex");
      expect(actual, file).toBe(hash);
    }
  });

  it("rejects malformed, unknown-version, oversized, stale, and future records without writes", () => {
    const good = sampleRecord();
    expect(append({ ...good, unexpected: true }).ok).toBe(false);
    expect(append({ ...good, version: "2.0", record_id: "ref:unknown-version" }).ok).toBe(false);
    expect(append({ ...good, record_id: "ref:oversized", summary: "x".repeat(281) }).ok).toBe(false);
    expect(append({ ...good, record_id: "ref:future", observed_at: "2099-01-01T00:00:00Z" }).ok).toBe(false);
    expect(append({ ...good, record_id: "ref:stale", observed_at: "2020-01-01T00:00:00Z" }).ok).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n).toBe(0);
  });

  it("replays a record ID exactly, rejects payload collisions, and keeps idempotency principal scoped", () => {
    const record = sampleRecord();
    const first = append(record);
    expect(first).toMatchObject({ ok: true, updated_at: expect.any(String) });
    const replay = append(record);
    expect(replay).toMatchObject({
      ok: true, status: "replayed", record_id: record.record_id, updated_at: first.updated_at,
    });
    expect(append({ ...record, summary: "different" })).toMatchObject({ ok: false, error: "idempotency_conflict" });
    const other = { ...producer, principalId: "agent:other" };
    const otherReplay = appendCodeHealthRecord(db, other, {
      namespace, idempotency_key: randomUUID(), record,
    });
    expect(otherReplay.ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_health_records WHERE record_id = ?").get(record.record_id)).toMatchObject({ n: 2 });
  });

  it("uses durable write receipts for same-key retries and rejects concurrent key collisions", async () => {
    const call = callAs(producer);
    const record = sampleRecord();
    const key = randomUUID();
    const args = { action: "append", namespace, idempotency_key: key, record };
    const [first, replay] = await Promise.all([call(args), call(args)]);
    expect(parse(first)).toMatchObject({ ok: true, idempotency_replayed: false, updated_at: expect.any(String) });
    expect(parse(replay)).toMatchObject({
      ok: true, idempotency_replayed: true, record_id: record.record_id,
      updated_at: parse(first).updated_at,
    });
    const collision = await call({ ...args, record: sampleRecord() });
    expect(parse(collision)).toMatchObject({ ok: false, error: "idempotency_conflict" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM code_health_records").get() as { n: number }).n).toBe(1);
  });

  it("binds every keyed replay alias to one retained record and scrubs all aliases on deletion", async () => {
    const call = callAs(producer);
    const record = sampleRecord();
    const keyA = randomUUID();
    const keyB = randomUUID();
    const base = { action: "append", namespace, record };
    const first = parse(await call({ ...base, idempotency_key: keyA }));
    const alias = parse(await call({ ...base, idempotency_key: keyB }));
    expect(first).toMatchObject({ ok: true, idempotency_replayed: false, record_id: record.record_id });
    expect(alias).toMatchObject({ ok: true, status: "replayed", record_id: record.record_id, idempotency_replayed: false });
    expect(alias.id).toBe(first.id);

    const originalExpiry = db.prepare(`SELECT expires_at FROM code_health_records
      WHERE principal_id = ? AND record_id = ?`).get(producer.principalId, record.record_id) as { expires_at: string };
    const aliasRetry = parse(await call({ ...base, idempotency_key: keyB }));
    expect(aliasRetry).toMatchObject({ ok: true, idempotency_replayed: true, record_id: record.record_id, id: first.id });
    expect(db.prepare(`SELECT expires_at FROM code_health_records
      WHERE principal_id = ? AND record_id = ?`).get(producer.principalId, record.record_id)).toEqual(originalExpiry);
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_health_records WHERE principal_id = ? AND record_id = ?")
      .get(producer.principalId, record.record_id)).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = ?").get(first.id)).toMatchObject({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM write_receipts
      WHERE principal_id = ? AND tool_name = 'memory_code_health' AND code_health_record_id = ?`)
      .get(producer.principalId, record.record_id)).toMatchObject({ n: 2 });

    const lowClassification = { ...producer, maxClassification: "public" as const };
    expect(parse(await callAs(lowClassification)({ ...base, idempotency_key: keyB })))
      .toMatchObject({ ok: false, error: "access_denied" });

    executeDelete(db, namespace, undefined, producer.principalId, false);
    const receipts = db.prepare(`SELECT namespace, entry_id, entry_updated_at, classification, code_health_record_id
      FROM write_receipts WHERE principal_id = ? AND tool_name = 'memory_code_health'
      ORDER BY idempotency_key`).all(producer.principalId) as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(2);
    expect(receipts).toEqual(receipts.map((receipt) => expect.objectContaining({
      namespace: "", entry_id: "", entry_updated_at: "", classification: "public",
      code_health_record_id: record.record_id,
    })));
    expect(parse(await call({ ...base, idempotency_key: keyB })))
      .toMatchObject({ ok: false, error: "record_deleted" });
  });

  it("removes every receipt alias when a managed record expires", async () => {
    const call = callAs(producer);
    const record = sampleRecord();
    const keyA = randomUUID();
    const keyB = randomUUID();
    const base = { action: "append", namespace, record };
    const first = parse(await call({ ...base, idempotency_key: keyA }));
    expect(parse(await call({ ...base, idempotency_key: keyB }))).toMatchObject({ ok: true, status: "replayed" });
    const expiry = "2000-01-01T00:00:00.000Z";
    db.prepare("UPDATE code_health_records SET expires_at = ? WHERE principal_id = ? AND record_id = ?")
      .run(expiry, producer.principalId, record.record_id);
    expect(parse(await call({ ...base, idempotency_key: keyA }))).toMatchObject({ ok: false, error: "record_deleted" });
    expect(parse(await call({ ...base, idempotency_key: keyB }))).toMatchObject({ ok: false, error: "record_deleted" });
    expect(pruneCodeHealthRecords(db, new Date(Date.parse(expiry) + 1000).toISOString())).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM write_receipts
      WHERE principal_id = ? AND tool_name = 'memory_code_health' AND code_health_record_id = ?`)
      .get(producer.principalId, record.record_id)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT 1 FROM code_health_records WHERE principal_id = ? AND record_id = ?")
      .get(producer.principalId, record.record_id)).toBeUndefined();
    expect(first.record_id).toBe(record.record_id);
  });

  it("does not return expired records when maintenance has not yet run", async () => {
    const record = sampleRecord();
    const key = randomUUID();
    const call = callAs(producer);
    const args = { action: "append", namespace, idempotency_key: key, record };
    expect(parse(await call(args))).toMatchObject({ ok: true });
    db.prepare("UPDATE code_health_records SET expires_at = ? WHERE principal_id = ? AND record_id = ?")
      .run("2000-01-01T00:00:00.000Z", producer.principalId, record.record_id);
    expect(exportCodeHealthRecords(db, producer, { namespace })).toMatchObject({
      ok: true, total_records: 0, complete: true, records: [],
    });
    expect(parse(await call(args))).toMatchObject({ ok: false, error: "record_deleted" });
  });

  it("exports original server retention timestamps for new and previously collected records", () => {
    const record = sampleRecord();
    const stored = append(record);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const fresh = exportCodeHealthRecords(db, producer, { namespace });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.retention).toEqual([{
      record_id: record.record_id,
      collected_at: stored.collected_at,
      expires_at: stored.expires_at,
      updated_at: stored.updated_at,
      classification: stored.classification,
    }]);

    const oldCollectedAt = "2026-08-01T00:00:00.000Z";
    const oldExpiry = "2027-02-01T00:00:00.000Z";
    db.prepare(`UPDATE code_health_records SET collected_at = ?, expires_at = ?
      WHERE principal_id = ? AND record_id = ?`)
      .run(oldCollectedAt, oldExpiry, producer.principalId, record.record_id);
    const backfilled = exportCodeHealthRecords(db, producer, { namespace });
    expect(backfilled).toMatchObject({
      ok: true,
      retention: [{ record_id: record.record_id, collected_at: oldCollectedAt, expires_at: oldExpiry }],
    });
  });

  it("keeps retention metadata stable across pages with repeated context and replay", () => {
    const sourceObservedAt = new Date(Date.now() - 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const dependentObservedAt = new Date(Date.now() - 4000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const source = sampleRecord({
      task_id: "task-retention-pages",
      record_id: "ref:retention-page-source",
      observed_at: sourceObservedAt,
    });
    const sourceStored = append(source);
    expect(sourceStored.ok).toBe(true);

    const dependentRecords = ["ref:retention-page-a", "ref:retention-page-b"].map((record_id) => ({
      ...structuredClone(sourceCloseTemplate),
      task_id: source.task_id,
      record_id,
      occurrence_id: source.occurrence_id,
      observed_at: dependentObservedAt,
      source_observation_ref: source.record_id,
    }));
    for (const record of dependentRecords) expect(append(record).ok).toBe(true);

    const first = exportCodeHealthRecords(db, producer, { namespace, limit: 1 });
    expect(first.ok && first.complete).toBe(false);
    if (!first.ok) return;
    const firstSourceMetadata = (first.retention as Array<Record<string, string>>)
      .find((item) => item.record_id === source.record_id);
    expect(firstSourceMetadata).toMatchObject({
      record_id: source.record_id,
      collected_at: sourceStored.collected_at,
      expires_at: sourceStored.expires_at,
    });

    let page = exportCodeHealthRecords(db, producer, {
      namespace, limit: 1, cursor: first.next_cursor as string,
    });
    expect(page.ok && page.complete).toBe(false);
    if (!page.ok) return;
    expect(page.context_records).toMatchObject([{ record_id: source.record_id }]);
    expect(page.retention).toContainEqual(firstSourceMetadata);
    expect(page.retention).toHaveLength(2);

    page = exportCodeHealthRecords(db, producer, {
      namespace, limit: 1, cursor: page.next_cursor as string,
    });
    expect(page.ok && page.complete).toBe(true);
    if (!page.ok) return;
    expect(page.context_records).toMatchObject([{ record_id: source.record_id }]);
    expect(page.retention).toContainEqual(firstSourceMetadata);
    expect(page.retention).toHaveLength(2);

    const replay = exportCodeHealthRecords(db, producer, { namespace, limit: 1 });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.retention).toEqual(first.retention);
  });

  it("corrects through immutable lineage and exports the current correction once with authenticated context", async () => {
    const original = sampleRecord();
    const call = callAs(producer);
    const originalResponse = parse(await call({
      action: "append", namespace, idempotency_key: randomUUID(), record: original,
    }));
    expect(originalResponse).toMatchObject({ ok: true, record_id: original.record_id });
    const originalUpdatedAt = originalResponse.updated_at as string;
    const correction = sampleRecord({
      task_id: original.task_id,
      attempt_id: original.attempt_id,
      occurrence_id: original.occurrence_id,
      record_id: "ref:corrected-record",
      supersedes_record_id: original.record_id,
      correction_ref: "ref:correction-evidence",
      observed_at: original.observed_at,
    });
    const correctionResult = parse(await call({
      action: "append", namespace, idempotency_key: randomUUID(), record: correction,
      expected_updated_at: originalUpdatedAt,
    }));
    expect(correctionResult).toMatchObject({ ok: true, status: "corrected", updated_at: expect.any(String) });
    expect(correctionResult.updated_at).not.toBe(originalUpdatedAt);
    const staleCorrection = sampleRecord({
      task_id: original.task_id,
      attempt_id: original.attempt_id,
      occurrence_id: original.occurrence_id,
      record_id: "ref:stale-correction",
      supersedes_record_id: original.record_id,
      correction_ref: "ref:stale-correction-evidence",
      observed_at: original.observed_at,
    });
    expect(parse(await call({
      action: "append", namespace, idempotency_key: randomUUID(), record: staleCorrection,
      expected_updated_at: originalUpdatedAt,
    }))).toMatchObject({ ok: false, error: "conflict" });
    const exported = parse(await callAs(ownerContext())({
      action: "export", namespace, producer_principal_id: producer.principalId, limit: 1,
    }));
    expect(exported).toMatchObject({ ok: true, total_records: 1, complete: true });
    if (exported.ok) {
      expect(exported.records).toMatchObject([{ record_id: "ref:corrected-record" }]);
      expect(exported.context_records).toMatchObject([{ record_id: original.record_id }]);
      expect(exported.retention).toEqual(expect.arrayContaining([
        expect.objectContaining({ record_id: "ref:corrected-record", updated_at: correctionResult.updated_at }),
        expect.objectContaining({ record_id: original.record_id, updated_at: originalUpdatedAt }),
      ]));
      expect(exported.retention).toHaveLength(2);
    }
  });

  it("does not expose another principal's records or high-classification records in counts or pages", () => {
    const publicRecord = sampleRecord();
    const producerResult = append(publicRecord);
    const privateRecord = { ...publicRecord };
    const ownerResult = appendCodeHealthRecord(db, ownerContext(), {
      namespace, idempotency_key: randomUUID(), record: privateRecord,
      classification: "client-restricted",
    });
    expect(ownerResult.ok).toBe(true);
    db.prepare(`UPDATE code_health_records SET collected_at = ?, expires_at = ?
      WHERE principal_id = ? AND record_id = ?`)
      .run("2026-09-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z", "owner", publicRecord.record_id);
    const scoped = exportCodeHealthRecords(db, producer, { namespace, limit: 100 });
    expect(scoped).toMatchObject({ ok: true, total_records: 1, complete: true });
    const producerLedger = db.prepare(`SELECT collected_at, expires_at FROM code_health_records
      WHERE principal_id = ? AND record_id = ?`).get(producer.principalId, publicRecord.record_id);
    expect(scoped).toMatchObject({ ok: true, retention: [{ record_id: publicRecord.record_id, ...producerLedger }] });
    if (scoped.ok) expect(scoped.retention).toHaveLength(1);
    const otherProducer = exportCodeHealthRecords(db, producer, {
      namespace, producer_principal_id: "agent:other",
    });
    expect(otherProducer).toMatchObject({ ok: false, error: "access_denied" });
    const owner = exportCodeHealthRecords(db, ownerContext(), {
      namespace, producer_principal_id: producer.principalId, rubric_version: "changeability-1.0",
    });
    expect(owner).toMatchObject({ ok: true, total_records: 1 });
  });

  it("does not let hidden task-context rows consume the append context bound", () => {
    const hidden = sampleRecord({ task_id: "task-hidden-context", record_id: "ref:hidden-context" });
    const broadProducer = { ...producer, maxClassification: "client-restricted" as const };
    const stored = appendCodeHealthRecord(db, broadProducer, {
      namespace,
      idempotency_key: randomUUID(),
      record: hidden,
      classification: "client-restricted",
    });
    expect(stored.ok).toBe(true);

    const source = db.prepare("SELECT * FROM code_health_records WHERE principal_id = ? AND record_id = ?")
      .get(producer.principalId, hidden.record_id) as Record<string, unknown>;
    const sourceEntry = db.prepare("SELECT * FROM entries WHERE id = ?").get(source.entry_id) as Record<string, unknown>;
    const entryColumns = Object.keys(sourceEntry).filter((column) => column !== "id");
    const insertEntry = db.prepare(`INSERT INTO entries (id, ${entryColumns.join(", ")})
      VALUES (?, ${entryColumns.map(() => "?").join(", ")})`);
    const insert = db.prepare(`INSERT INTO code_health_records (
      principal_id, record_id, namespace, entry_id, payload_hash, record_kind,
      repo_owner, repo_name, task_id, attempt_id, observed_at, collected_at,
      expires_at, model, rubric_version, classification, supersedes_record_id,
      correction_ref, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index <= 500; index += 1) {
      const entryId = randomUUID();
      insertEntry.run(entryId, ...entryColumns.map((column) => sourceEntry[column]));
      insert.run(
        source.principal_id, `ref:hidden-context-${index}`, source.namespace, entryId,
        source.payload_hash, source.record_kind, source.repo_owner, source.repo_name, source.task_id,
        source.attempt_id, source.observed_at, source.collected_at, source.expires_at, source.model,
        source.rubric_version, source.classification, source.supersedes_record_id,
        source.correction_ref, randomUUID(),
      );
    }

    const visible = sampleRecord({ task_id: "task-hidden-context", record_id: "ref:visible-context" });
    expect(append(visible)).toMatchObject({ ok: true });
  });

  it("fails a cursor closed when namespace authorization narrows between pages", () => {
    expect(append(sampleRecord({ observed_at: new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/, "Z") })).ok).toBe(true);
    expect(append(sampleRecord({ observed_at: new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, "Z") })).ok).toBe(true);
    const first = exportCodeHealthRecords(db, producer, { namespace, limit: 1 });
    expect(first.ok && first.complete).toBe(false);
    if (!first.ok) return;
    const narrowed = { ...producer, accessibleNamespaces: [] };
    expect(exportCodeHealthRecords(db, narrowed, { namespace, limit: 1, cursor: first.next_cursor as string }))
      .toMatchObject({ ok: false, error: "access_denied" });
  });

  it("pages the complete current set beyond 500 records and invalidates reconciliation after deletion", () => {
    for (let index = 0; index < 505; index += 1) append(sampleRecord());
    let page = exportCodeHealthRecords(db, producer, { namespace, limit: 100 });
    expect(page).toMatchObject({ ok: true, total_records: 505, complete: false });
    let total = 0;
    let cursor: string | null = null;
    let pageCount = 0;
    while (page.ok && page.complete !== true) {
      total += (page.records as unknown[]).length;
      cursor = page.next_cursor as string;
      page = exportCodeHealthRecords(db, producer, { namespace, limit: 100, cursor });
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    }
    if (page.ok) total += (page.records as unknown[]).length;
    expect(page.ok && page.complete).toBe(true);
    expect(total).toBe(505);

    const first = exportCodeHealthRecords(db, producer, { namespace, limit: 1 });
    expect(first.ok && first.complete).toBe(false);
    const nextCursor = first.ok ? first.next_cursor as string : "";
    executeDelete(db, namespace, undefined, producer.principalId, false);
    const invalidated = exportCodeHealthRecords(db, producer, { namespace, limit: 1, cursor: nextCursor });
    expect(invalidated).toMatchObject({ ok: false, error: "incomplete_export" });
  });

  it("leaves only a content-free anti-resurrection tombstone after explicit deletion and six-month expiry", async () => {
    const record = sampleRecord();
    const key = randomUUID();
    const response = parse(await callAs(producer)({ action: "append", namespace, idempotency_key: key, record }));
    const entryId = response.id as string;
    const contentBefore = getById(db, entryId)!.content;
    expect(contentBefore).toContain("ref:record-");
    executeDelete(db, namespace, undefined, producer.principalId, false);
    const ledger = db.prepare(`SELECT entry_id, namespace, payload_hash, expires_at, record_kind, repo_owner,
      repo_name, task_id, attempt_id, observed_at, collected_at, model, rubric_version, classification,
      supersedes_record_id, correction_ref, idempotency_key
      FROM code_health_records WHERE principal_id = ? AND record_id = ?`)
      .get(producer.principalId, record.record_id) as Record<string, unknown>;
    expect(ledger.entry_id).toBeNull();
    for (const field of ["namespace", "record_kind", "repo_owner", "repo_name", "task_id", "attempt_id",
      "observed_at", "collected_at", "model", "rubric_version", "classification", "supersedes_record_id", "correction_ref"]) {
      expect(ledger[field], field).toBeNull();
    }
    expect(ledger.idempotency_key).toBe(key);
    expect(db.prepare(`SELECT namespace, entry_id, entry_updated_at, classification
      FROM write_receipts WHERE principal_id = ? AND idempotency_key = ?`).get(producer.principalId, key))
      .toMatchObject({ namespace: "", entry_id: "", entry_updated_at: "", classification: "public" });
    expect(db.prepare("SELECT 1 FROM entries_fts WHERE entries_fts MATCH ?").get('"ref:record"')).toBeUndefined();
    expect(append(record)).toMatchObject({ ok: false, error: "record_deleted" });
    expect(pruneCodeHealthRecords(db, new Date(Date.parse(ledger.expires_at) + 1000).toISOString())).toBe(0);
    expect(db.prepare("SELECT 1 FROM code_health_records WHERE principal_id = ? AND record_id = ?").get(producer.principalId, record.record_id)).toBeUndefined();
  });

  it("retires dependent observations when their referenced source reaches expiry", () => {
    const source = sampleRecord({
      attempt_id: sampleTemplate.attempt_id,
      parent_attempt_id: sampleTemplate.parent_attempt_id,
    });
    expect(append(source).ok).toBe(true);
    const dependent = {
      ...structuredClone(sourceCloseTemplate),
      task_id: source.task_id,
      record_id: "ref:dependent-close",
      occurrence_id: source.occurrence_id,
      observed_at: source.observed_at,
      source_observation_ref: source.record_id,
    };
    const dependentResult = append(dependent);
    expect(dependentResult.ok).toBe(true);
    db.prepare("UPDATE code_health_records SET expires_at = ? WHERE principal_id = ? AND record_id = ?")
      .run("2000-01-01T00:00:00.000Z", producer.principalId, source.record_id);
    expect(pruneCodeHealthRecords(db, new Date().toISOString())).toBe(2);
    expect(db.prepare("SELECT entry_id FROM code_health_records WHERE principal_id = ? AND record_id = ?")
      .get(producer.principalId, dependent.record_id)).toMatchObject({ entry_id: null });
  });

  it("keeps deletion cleanup scoped to the principal for duplicate record IDs and receipt keys", async () => {
    const otherProducer = { ...producer, principalId: "agent:other" };
    const otherCall = callAs(otherProducer);
    const priorOtherRecord = sampleRecord({ record_id: "ref:prior-other-record" });
    const priorOtherKey = "00000000-0000-4000-8000-000000000101";
    const priorOther = parse(await otherCall({
      action: "append", namespace, idempotency_key: priorOtherKey, record: priorOtherRecord,
    }));
    expect(priorOther).toMatchObject({ ok: true });
    executeDelete(db, namespace, undefined, otherProducer.principalId, false);

    const sharedRecordId = "ref:shared-across-principals";
    const sharedKey = "00000000-0000-4000-8000-000000000102";
    const producerSource = sampleRecord({ record_id: sharedRecordId, task_id: "task-shared" });
    const otherSource = { ...producerSource };
    const producerResponse = parse(await callAs(producer)({
      action: "append", namespace, idempotency_key: sharedKey, record: producerSource,
    }));
    const otherResponse = parse(await otherCall({
      action: "append", namespace, idempotency_key: sharedKey, record: otherSource,
    }));
    expect(producerResponse).toMatchObject({ ok: true, record_id: sharedRecordId });
    expect(otherResponse).toMatchObject({ ok: true, record_id: sharedRecordId });
    expect(db.prepare(`SELECT code_health_record_id FROM write_receipts
      WHERE principal_id = ? AND idempotency_key = ?`).get(producer.principalId, sharedKey))
      .toEqual({ code_health_record_id: sharedRecordId });
    expect(db.prepare(`SELECT code_health_record_id FROM write_receipts
      WHERE principal_id = ? AND idempotency_key = ?`).get(otherProducer.principalId, sharedKey))
      .toEqual({ code_health_record_id: sharedRecordId });

    const dependent = {
      ...structuredClone(sourceCloseTemplate),
      task_id: otherSource.task_id,
      record_id: "ref:other-dependent",
      occurrence_id: otherSource.occurrence_id,
      observed_at: otherSource.observed_at,
      source_observation_ref: sharedRecordId,
    };
    expect(parse(await otherCall({
      action: "append", namespace, idempotency_key: "00000000-0000-4000-8000-000000000103", record: dependent,
    }))).toMatchObject({ ok: true, record_id: dependent.record_id });

    executeDelete(db, namespace, undefined, producer.principalId, false);

    expect(db.prepare(`SELECT 1 FROM code_health_record_refs
      WHERE principal_id = ? AND record_id = ? AND referenced_record_id = ?`)
      .get(otherProducer.principalId, dependent.record_id, sharedRecordId)).toBeDefined();
    const otherReceipt = db.prepare(`SELECT namespace, entry_id, entry_updated_at, classification, code_health_record_id
      FROM write_receipts WHERE principal_id = ? AND idempotency_key = ?`)
      .get(otherProducer.principalId, sharedKey);
    expect(otherReceipt).toMatchObject({ namespace, entry_id: otherResponse.id, classification: "internal" });
    expect(otherReceipt).toMatchObject({ code_health_record_id: sharedRecordId });

    db.prepare("UPDATE code_health_records SET expires_at = ? WHERE principal_id = ? AND record_id = ?")
      .run("2000-01-01T00:00:00.000Z", otherProducer.principalId, sharedRecordId);
    expect(pruneCodeHealthRecords(db, new Date().toISOString())).toBe(2);
    expect(db.prepare(`SELECT entry_id FROM code_health_records
      WHERE principal_id = ? AND record_id = ?`).get(otherProducer.principalId, dependent.record_id))
      .toMatchObject({ entry_id: null });
  });

  it("excludes managed evidence from ordinary retrieval, consolidation, health, and embedding work", () => {
    const record = sampleRecord();
    const managed = append(record);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE entry_type='log' AND NOT EXISTS (SELECT 1 FROM code_health_records chr WHERE chr.entry_id=entries.id)").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_health_records").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT 1 FROM entries_fts WHERE entries_fts MATCH ?").get('"ref:record"')).toBeUndefined();
    appendLog(db, namespace, "ordinary memory log searchable normally", [], producer.principalId);
    expect(db.prepare("SELECT 1 FROM entries_fts WHERE entries_fts MATCH ?").get('"searchable"')).toBeDefined();
    expect(managed.ok).toBe(true);
  });

  it("keeps shared managed-only namespaces out of list, orient, attention, and health aggregates", async () => {
    const sharedNamespace = "projects/code-health-aggregate-shared";
    const managedOnlyNamespace = "projects/code-health-aggregate-managed-only";
    const other: AccessContext = {
      ...producer,
      principalId: "agent:other",
      accessibleNamespaces: [
        { pattern: sharedNamespace, permissions: "rw" },
        { pattern: managedOnlyNamespace, permissions: "rw" },
      ],
    };
    const producerCall = callAs({
      ...producer,
      accessibleNamespaces: [
        { pattern: sharedNamespace, permissions: "rw" },
        { pattern: managedOnlyNamespace, permissions: "rw" },
      ],
    });
    const producerLogCall = callAs({
      ...producer,
      accessibleNamespaces: [
        { pattern: sharedNamespace, permissions: "rw" },
        { pattern: managedOnlyNamespace, permissions: "rw" },
      ],
    }, "memory_log");
    const producerListCall = callAs({
      ...producer,
      accessibleNamespaces: [
        { pattern: sharedNamespace, permissions: "rw" },
        { pattern: managedOnlyNamespace, permissions: "rw" },
      ],
    }, "memory_list");
    const producerOrientCall = callAs({
      ...producer,
      accessibleNamespaces: [
        { pattern: sharedNamespace, permissions: "rw" },
        { pattern: managedOnlyNamespace, permissions: "rw" },
      ],
    }, "memory_orient");
    const producerAttentionCall = callAs({
      ...producer,
      accessibleNamespaces: [
        { pattern: sharedNamespace, permissions: "rw" },
        { pattern: managedOnlyNamespace, permissions: "rw" },
      ],
    }, "memory_attention");
    const otherCall = callAs(other);
    const appendViaMcp = async (
      call: (args: Record<string, unknown>) => Promise<unknown>,
      targetNamespace: string,
      record: Record<string, unknown>,
    ) => parse(await call({
      action: "append",
      namespace: targetNamespace,
      idempotency_key: randomUUID(),
      record,
    }));

    expect((await appendViaMcp(producerCall, managedOnlyNamespace, sampleRecord({
      record_id: "ref:aggregate-producer-managed-only",
      task_id: "task-aggregate-producer-managed-only",
    }))).ok).toBe(true);
    expect((await appendViaMcp(otherCall, managedOnlyNamespace, sampleRecord({
      record_id: "ref:aggregate-other-managed-only",
      task_id: "task-aggregate-other-managed-only",
    }))).ok).toBe(true);
    expect((await appendViaMcp(producerCall, sharedNamespace, sampleRecord({
      record_id: "ref:aggregate-producer-shared",
      task_id: "task-aggregate-shared",
    }))).ok).toBe(true);
    expect(parse(await producerLogCall({
      namespace: sharedNamespace,
      content: "ordinary shared namespace log",
    })).ok).toBe(true);

    const list = parse(await producerListCall({}));
    expect(list.namespaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: sharedNamespace, log_count: 1 }),
    ]));
    expect((list.namespaces as Array<{ namespace: string }>).some((item) => item.namespace === managedOnlyNamespace)).toBe(false);

    const orient = parse(await producerOrientCall({ detail: "standard", include_namespaces: true, include_completed_tasks: true }));
    expect((orient.namespaces as Array<{ namespace: string }>).some((item) => item.namespace === sharedNamespace)).toBe(true);
    expect((orient.namespaces as Array<{ namespace: string }>).some((item) => item.namespace === managedOnlyNamespace)).toBe(false);

    const attention = parse(await producerAttentionCall({ namespace_prefix: sharedNamespace }));
    const attentionItems = attention.items as Array<{ namespace: string; category: string }>;
    expect(attentionItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: sharedNamespace, category: "missing_status" }),
    ]));
    expect(attentionItems.some((item) => item.namespace === managedOnlyNamespace)).toBe(false);

    const health = parse(await callAs(ownerContext(), "memory_health")({}));
    expect(health).toMatchObject({ ok: true });
    expect(health.sections).toBeDefined();
    expect((health.sections as Record<string, Record<string, unknown>>).size)
      .toMatchObject({ entries_log: 1, namespace_count: 1 });
    expect((health.sections as Record<string, Record<string, unknown>>).maintenance)
      .toMatchObject({ missing_status: 1 });
  });

  it("indexes ordinary tags that only contain the managed marker as a substring", () => {
    const marker = "code-health:evidence-v1";
    const ordinary = appendLog(
      db,
      namespace,
      "adjacenttaginitialneedle",
      [`topic:${marker}-adjacent`],
      producer.principalId,
    );
    const find = (term: string) => db.prepare(
      "SELECT 1 FROM entries_fts WHERE entries_fts MATCH ?",
    ).get(`"${term}"`);
    expect(find("adjacenttaginitialneedle")).toBeDefined();

    db.prepare("UPDATE entries SET content = ?, updated_at = ? WHERE id = ?")
      .run("adjacenttagupdatedneedle", new Date().toISOString(), ordinary.id);
    expect(find("adjacenttaginitialneedle")).toBeUndefined();
    expect(find("adjacenttagupdatedneedle")).toBeDefined();

    db.prepare("DELETE FROM entries WHERE id = ?").run(ordinary.id);
    expect(find("adjacenttagupdatedneedle")).toBeUndefined();
  });

  it("keeps appended managed payloads out of rebuilt FTS through deletion and expiry", () => {
    const find = (term: string) => db.prepare(
      "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?",
    ).all(`"${term}"`);
    appendLog(db, namespace, "OrdinaryWebFetch remains searchable", [], producer.principalId);

    const deletedRecord = sampleRecord({ summary: "manageddeletionftssentinel" });
    expect(append(deletedRecord).ok).toBe(true);
    rebuildFTS(db);
    expect(find("manageddeletionftssentinel")).toHaveLength(0);
    expect(find("web fetch")).toHaveLength(1);
    executeDelete(db, namespace, undefined, producer.principalId, false);
    expect(find("manageddeletionftssentinel")).toHaveLength(0);

    const expiryNamespace = "projects/code-health-expiry";
    const expiryCtx: AccessContext = {
      ...producer,
      accessibleNamespaces: [{ pattern: expiryNamespace, permissions: "rw" }],
    };
    const expiringRecord = sampleRecord({ summary: "managedexpiryftssentinel" });
    const appendResult = appendCodeHealthRecord(db, expiryCtx, {
      namespace: expiryNamespace,
      idempotency_key: randomUUID(),
      record: expiringRecord,
    });
    expect(appendResult.ok).toBe(true);
    const expiry = "2000-01-01T00:00:00.000Z";
    db.prepare("UPDATE code_health_records SET expires_at = ? WHERE principal_id = ? AND record_id = ?")
      .run(expiry, producer.principalId, expiringRecord.record_id);
    rebuildFTS(db);
    expect(find("managedexpiryftssentinel")).toHaveLength(0);
    expect(pruneCodeHealthRecords(db, new Date(Date.parse(expiry) + 1000).toISOString())).toBe(1);
    expect(find("managedexpiryftssentinel")).toHaveLength(0);
  });
});
