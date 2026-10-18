import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { populateCorpusEmbeddings } from "../benchmark/adapters/shared.js";
import { initDatabase, storeEmbedding, writeState } from "../src/db.js";
import {
  _embeddingConfig,
  _setExtractorForTesting,
  embeddingToBuffer,
  getActiveEmbeddingIdentity,
  getActiveEmbeddingModel,
} from "../src/embeddings.js";

const originalConfig = { ..._embeddingConfig };
const tempDirs: string[] = [];

function makeVector(value: number): Float32Array {
  return new Float32Array(384).fill(value);
}

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "munin-benchmark-shared-"));
  tempDirs.push(dir);
  return join(dir, "benchmark.db");
}

function readEmbeddingRows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(
      "SELECT id, embedding_status, embedding_model, embedding_identity FROM entries ORDER BY key",
    ).all();
  } finally {
    db.close();
  }
}

afterEach(() => {
  _setExtractorForTesting(null);
  Object.assign(_embeddingConfig, originalConfig);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("populateCorpusEmbeddings", () => {
  it("re-embeds legacy, stale-identity, and missing-vector rows but skips only exact matches", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    const legacy = writeState(db, "benchmarks/test", "legacy", "legacy vector", []);
    const stale = writeState(db, "benchmarks/test", "stale", "stale identity vector", []);
    const matching = writeState(db, "benchmarks/test", "matching", "matching vector", []);
    const missing = writeState(db, "benchmarks/test", "missing", "missing vector", []);

    _setExtractorForTesting(async () => ({ data: makeVector(0.25) }));
    const identity = getActiveEmbeddingIdentity();
    expect(identity).not.toBeNull();
    const model = getActiveEmbeddingModel();
    storeEmbedding(db, legacy.id, embeddingToBuffer(makeVector(0.1)), model);
    storeEmbedding(db, stale.id, embeddingToBuffer(makeVector(0.1)), model, "old-identity");
    storeEmbedding(db, matching.id, embeddingToBuffer(makeVector(0.2)), model, identity!);
    db.prepare(
      "UPDATE entries SET embedding_status='generated', embedding_model=?, embedding_identity=? WHERE id=?",
    ).run(model, identity, missing.id);
    db.close();

    const summary = await populateCorpusEmbeddings(dbPath);

    expect(summary).toMatchObject({ total: 4, generated: 3, failed: 0, skipped: 1, vector_rows: 4 });
    expect(readEmbeddingRows(dbPath)).toEqual(expect.arrayContaining([
      { id: matching.id, embedding_status: "generated", embedding_model: model, embedding_identity: identity },
      { id: missing.id, embedding_status: "generated", embedding_model: model, embedding_identity: identity },
      { id: legacy.id, embedding_status: "generated", embedding_model: model, embedding_identity: identity },
      { id: stale.id, embedding_status: "generated", embedding_model: model, embedding_identity: identity },
    ]));
  });

  it("rejects a changed embedding binding while generation is in flight", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    const row = writeState(db, "benchmarks/test", "one", "one entry", []);
    db.close();

    _setExtractorForTesting(async () => {
      _embeddingConfig.revision = "b".repeat(40);
      return { data: makeVector(0.25) };
    });

    await expect(populateCorpusEmbeddings(dbPath)).rejects.toThrow(/binding changed/i);
    expect(readEmbeddingRows(dbPath)).toEqual([
      { id: row.id, embedding_status: "pending", embedding_model: null, embedding_identity: null },
    ]);
  });

  it("fails closed when initialization has no immutable identity", async () => {
    const dbPath = makeDbPath();
    const db = initDatabase(dbPath);
    const row = writeState(db, "benchmarks/test", "legacy", "legacy vector", []);
    storeEmbedding(db, row.id, embeddingToBuffer(makeVector(0.1)), "legacy-model");
    db.close();

    _setExtractorForTesting(async () => ({ data: makeVector(0.25) }));
    Object.assign(_embeddingConfig, { model: "custom/unpinned", revision: undefined });

    await expect(populateCorpusEmbeddings(dbPath)).rejects.toThrow(/could not be initialized/i);
    expect(readEmbeddingRows(dbPath)).toEqual([
      { id: row.id, embedding_status: "generated", embedding_model: "legacy-model", embedding_identity: null },
    ]);
  });
});
