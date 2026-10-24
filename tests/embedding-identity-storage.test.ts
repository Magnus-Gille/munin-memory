import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  getEmbeddingQueueCounts, initDatabase, patchState, previewEmbeddingCompatibility,
  queryEntriesHybridScored, queryEntriesSemanticScored, readState, storeEmbedding,
  vecLoaded, writeState,
} from "../src/db.js";
import { getSchemaVersion, migrations, registerMuninUDFs, runMigrations } from "../src/migrations.js";

const MODEL = "synthetic-model";
const IDENTITY = '{"revision":"one","dimensions":384}';
const OTHER = '{"revision":"two","dimensions":384}';
const vector = (first: number): Buffer => {
  const values = new Float32Array(384);
  values[0] = first;
  return Buffer.from(values.buffer);
};
let db: Database.Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });
const entry = (key: string) => writeState(db, "projects/identity", key, `human content ${key}`, []);
const humanRows = (database: Database.Database) => database.prepare(
  "SELECT id, content, tags, created_at, updated_at, valid_from, valid_until, is_current FROM entries ORDER BY id",
).all();

it("adds nullable identity once without relabeling or mutating legacy memory", () => {
  const legacy = new Database(":memory:");
  try {
    registerMuninUDFs(legacy);
    legacy.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of migrations.filter(({ version }) => version <= 30)) {
      migration.up(legacy);
      legacy.prepare("INSERT INTO schema_version VALUES (?, '2026-10-17')").run(migration.version);
    }
    writeState(legacy, "projects/legacy", "status", "legacy human content", []);
    legacy.exec("UPDATE entries SET embedding_status='generated', embedding_model='synthetic-model'");
    const before = humanRows(legacy);
    runMigrations(legacy);
    runMigrations(legacy);
    expect(getSchemaVersion(legacy)).toBe(32);
    expect(legacy.prepare("PRAGMA table_info(entries)").all()).toContainEqual(expect.objectContaining({ name: "embedding_identity", notnull: 0 }));
    expect(legacy.prepare("SELECT embedding_identity FROM entries").get()).toEqual({ embedding_identity: null });
    expect(humanRows(legacy)).toEqual(before);
  } finally { legacy.close(); }
});

it("counts compatible, stale, unknown and all unfinished work without overlap", () => {
  const values = [
    ["generated", MODEL, IDENTITY], ["generated", MODEL, OTHER],
    ["generated", "other-model", IDENTITY], ["generated", MODEL, null],
    ["generated", null, IDENTITY], ["generated", null, null],
    ["pending", null, null], ["processing", null, null], ["failed", null, null],
  ];
  for (const [index, value] of values.entries()) {
    const { id } = entry(`count-${index}`);
    db.prepare("UPDATE entries SET embedding_status=?, embedding_model=?, embedding_identity=? WHERE id=?").run(...value, id);
  }
  expect(getEmbeddingQueueCounts(db, MODEL, true, IDENTITY)).toEqual({
    pending: 1, processing: 1, failed: 1, generated: 6, generated_current: 1,
    generated_stale: 2, generated_null: 3, reembedding_backlog: 8, total: 9, coverage_pct: 11.1,
  });
  expect(getEmbeddingQueueCounts(db, MODEL, true)).toMatchObject({ generated_current: 3, generated_stale: 1, generated_null: 2, reembedding_backlog: 4, coverage_pct: 66.7 });
  expect(() => getEmbeddingQueueCounts(db, MODEL, false, IDENTITY)).toThrow("owner-only");
});

it("preview is owner-only, counts-only and performs no writes on new and pre31 schemas", () => {
  entry("preview");
  const old = new Database(":memory:");
  try {
    old.exec("CREATE TABLE entries (embedding_status TEXT, embedding_model TEXT, is_current INTEGER); INSERT INTO entries VALUES ('generated', 'synthetic-model', 1), ('processing', NULL, 1)");
    for (const candidate of [db, old]) {
      candidate.pragma("query_only = ON");
      const before = candidate.prepare("SELECT total_changes() AS changes").get();
      expect(() => previewEmbeddingCompatibility(candidate, MODEL, IDENTITY, false)).toThrow("owner-only");
      const result = previewEmbeddingCompatibility(candidate, MODEL, IDENTITY, true);
      expect(Object.values(result).every((value) => typeof value === "number" || value === null)).toBe(true);
      expect(candidate.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    }
    expect(previewEmbeddingCompatibility(old, MODEL, IDENTITY, true)).toMatchObject({ generated_current: 0, generated_null: 1, reembedding_backlog: 2 });
    expect(old.prepare("PRAGMA table_info(entries)").all()).not.toContainEqual(expect.objectContaining({ name: "embedding_identity" }));
  } finally { old.close(); }
});

describe("vector identity", () => {
  it("stores metadata atomically without changing human memory, and clears identity on overwrite and patch", () => {
    expect(vecLoaded()).toBe(true);
    const { id } = entry("store");
    const before = humanRows(db);
    storeEmbedding(db, id, vector(1), MODEL, IDENTITY);
    expect(readState(db, "projects/identity", "store")).toMatchObject({ embedding_status: "generated", embedding_model: MODEL, embedding_identity: IDENTITY });
    expect(humanRows(db)).toEqual(before);
    // A failed vec insert must preserve both the old vector and its metadata.
    expect(() => storeEmbedding(db, id, Buffer.alloc(3), MODEL, OTHER)).toThrow();
    expect(readState(db, "projects/identity", "store")).toMatchObject({ embedding_identity: IDENTITY });
    expect(db.prepare("SELECT count(*) AS n FROM entries_vec WHERE entry_id=?").get(id)).toEqual({ n: 1 });
    writeState(db, "projects/identity", "store", "overwritten human content", []);
    expect(readState(db, "projects/identity", "store")).toMatchObject({ embedding_model: null, embedding_identity: null, embedding_status: "pending" });
    storeEmbedding(db, id, vector(1), MODEL, IDENTITY);
    patchState(db, "projects/identity", "store", { append: "patch" });
    expect(readState(db, "projects/identity", "store")).toMatchObject({ embedding_model: null, embedding_identity: null, embedding_status: "pending" });
    storeEmbedding(db, id, vector(1), MODEL);
    expect(readState(db, "projects/identity", "store")).toMatchObject({ embedding_identity: null });
  });

  it("does not recreate vectors for corrected or deleted entries", () => {
    for (const removed of ["corrected", "deleted"]) {
      const { id } = entry(removed);
      storeEmbedding(db, id, vector(1), MODEL, IDENTITY);
      if (removed === "corrected") db.prepare("UPDATE entries SET is_current=0 WHERE id=?").run(id);
      else db.prepare("DELETE FROM entries WHERE id=?").run(id);
      const before = humanRows(db);
      storeEmbedding(db, id, vector(2), MODEL, OTHER);
      expect(db.prepare("SELECT count(*) AS n FROM entries_vec WHERE entry_id=?").get(id)).toEqual({ n: 0 });
      expect(humanRows(db)).toEqual(before);
    }
  });

  it.each([false, true])("prefilters same-model identities before ranking and limit (exactNamespaceScan=%s)", (exactNamespaceScan) => {
    const incompatible = entry("incompatible");
    const compatible = entry("compatible");
    const unknown = entry("unknown");
    storeEmbedding(db, incompatible.id, vector(0), MODEL, OTHER);
    storeEmbedding(db, compatible.id, vector(2), MODEL, IDENTITY);
    storeEmbedding(db, unknown.id, vector(0), MODEL);
    for (const queryEmbeddingModel of [MODEL, undefined]) {
      const options = { queryEmbedding: vector(0), queryEmbeddingModel, queryEmbeddingIdentity: IDENTITY, namespace: "projects/identity", exactNamespaceScan, limit: 1 };
      expect(queryEntriesSemanticScored(db, options).map(({ entry }) => entry.id)).toEqual([compatible.id]);
      const hybrid = queryEntriesHybridScored(db, { ftsOptions: { query: "absentlexicaltoken", limit: 1 }, semanticOptions: options });
      expect(hybrid.results.map(({ entry }) => entry.id)).toEqual([compatible.id]);
    }
    expect(queryEntriesSemanticScored(db, { queryEmbedding: vector(0), namespace: "projects/identity", limit: 3 })).toHaveLength(3);
  });
});
