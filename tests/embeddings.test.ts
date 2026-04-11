import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  initDatabase,
  resolveDbPath,
  getDataDir,
  writeState,
  appendLog,
  queryEntriesSemantic,
  queryEntriesHybrid,
  queryEntriesHybridScored,
  vecLoaded,
  storeEmbedding,
  removeEmbedding,
  executeDelete,
} from "../src/db.js";
import {
  embeddingToBuffer,
  _setExtractorForTesting,
  generateEmbedding,
  isEmbeddingAvailable,
  isSemanticEnabled,
  isHybridEnabled,
  resetCircuitBreaker,
  initEmbeddings,
  startEmbeddingWorker,
  stopEmbeddingWorker,
  _embeddingConfig,
  getEmbeddingCacheDir,
} from "../src/embeddings.js";

const TEST_DB_PATH = "/tmp/munin-memory-embeddings-test.db";
const EMBEDDING_DIM = 384;

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

/**
 * Create a deterministic, handcrafted embedding vector.
 * Each "seed" produces a different unit vector with known relationships.
 */
function makeEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  // Place energy in specific dimensions based on seed for controlled cosine distances
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.1) * 0.1;
  }
  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] /= norm;
  }
  return arr;
}

/**
 * Mock extractor that returns embeddings based on content keywords.
 * "cat" -> seed 1, "dog" -> seed 2, "fish" -> seed 3, etc.
 */
function mockExtractor(text: string, _options: { pooling: string; normalize: boolean }) {
  const keywordSeeds: Record<string, number> = {
    cat: 1,
    dog: 2,
    fish: 3,
    bird: 4,
    architecture: 5,
    database: 6,
    memory: 7,
  };

  // Find matching keyword and use its seed
  const lowerText = text.toLowerCase();
  for (const [keyword, seed] of Object.entries(keywordSeeds)) {
    if (lowerText.includes(keyword)) {
      return Promise.resolve({ data: makeEmbedding(seed) });
    }
  }
  // Default seed for unknown text
  return Promise.resolve({ data: makeEmbedding(42) });
}

let db: Database.Database;

// Probe vec availability at module load time (before any tests run)
// skipIf evaluates at suite collection time, before beforeEach
const probeDb = initDatabase("/tmp/munin-memory-embeddings-probe.db");
const vecAvailable = vecLoaded();
probeDb.close();
cleanupTestDb();
for (const suffix of ["", "-wal", "-shm"]) {
  const p = "/tmp/munin-memory-embeddings-probe.db" + suffix;
  if (existsSync(p)) unlinkSync(p);
}

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  resetCircuitBreaker();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setExtractorForTesting(mockExtractor as any);
});

afterEach(async () => {
  await stopEmbeddingWorker();
  _setExtractorForTesting(null);
  db.close();
  cleanupTestDb();
});

describe("embeddingToBuffer", () => {
  it("converts Float32Array to Buffer with correct byte length", () => {
    const f32 = makeEmbedding(1);
    const buf = embeddingToBuffer(f32);
    expect(buf.length).toBe(EMBEDDING_DIM * 4);
    expect(buf).toBeInstanceOf(Buffer);
  });

  it("rejects wrong-sized Float32Array", () => {
    const wrongSize = new Float32Array(100);
    expect(() => embeddingToBuffer(wrongSize)).toThrow("size mismatch");
  });
});

describe("generateEmbedding", () => {
  it("generates a 384-dim Float32Array", async () => {
    const result = await generateEmbedding("test text about cats");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result!.length).toBe(EMBEDDING_DIM);
  });

  it("returns null when extractor is not available", async () => {
    _setExtractorForTesting(null);
    const result = await generateEmbedding("test text");
    expect(result).toBeNull();
  });
});

describe("circuit breaker", () => {
  it("disables after maxFailures consecutive failures", async () => {
    const failingExtractor = () => Promise.reject(new Error("model crashed"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setExtractorForTesting(failingExtractor as any);

    // Exhaust the circuit breaker
    for (let i = 0; i < _embeddingConfig.maxFailures; i++) {
      await generateEmbedding("test");
    }

    expect(isEmbeddingAvailable()).toBe(false);

    // generateEmbedding returns null when circuit breaker is tripped
    const result = await generateEmbedding("test");
    expect(result).toBeNull();
  });

  it("resets via resetCircuitBreaker", async () => {
    const failingExtractor = () => Promise.reject(new Error("model crashed"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setExtractorForTesting(failingExtractor as any);

    for (let i = 0; i < _embeddingConfig.maxFailures; i++) {
      await generateEmbedding("test");
    }
    expect(isEmbeddingAvailable()).toBe(false);

    resetCircuitBreaker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setExtractorForTesting(mockExtractor as any);
    expect(isEmbeddingAvailable()).toBe(true);
  });
});

describe("feature gates", () => {
  it.skipIf(!vecAvailable)("isSemanticEnabled reflects config", () => {
    expect(isSemanticEnabled()).toBe(true);
  });

  it.skipIf(!vecAvailable)("isHybridEnabled reflects config", () => {
    // Default config has hybrid enabled
    expect(isHybridEnabled()).toBe(true);
  });
});

describe("path resolution", () => {
  it("expands tilde in DB path", () => {
    expect(resolveDbPath("~/.munin-memory/memory.db")).toBe(
      `${homedir()}/.munin-memory/memory.db`,
    );
  });

  it("derives data dir from resolved DB path", () => {
    expect(getDataDir("~/.munin-memory/memory.db")).toBe(
      `${homedir()}/.munin-memory`,
    );
  });

  it("derives embedding cache dir from tilde DB path", () => {
    expect(getEmbeddingCacheDir("~/.munin-memory/memory.db")).toBe(
      `${homedir()}/.munin-memory/hf-cache`,
    );
  });

  it("derives embedding cache dir from default DB path when unset", () => {
    expect(getEmbeddingCacheDir(undefined)).toBe(
      `${homedir()}/.munin-memory/hf-cache`,
    );
  });

  it("derives embedding cache dir from absolute DB path", () => {
    expect(getEmbeddingCacheDir("/var/lib/munin-memory/memory.db")).toBe(
      "/var/lib/munin-memory/hf-cache",
    );
  });
});

describe("vec store/remove operations", () => {
  it.skipIf(!vecAvailable)("stores and removes embeddings", () => {
    const { id } = writeState(db, "test/ns", "key1", "some content about cats", []);
    const embedding = makeEmbedding(1);
    const buf = embeddingToBuffer(embedding);

    storeEmbedding(db, id, buf, "test-model");

    // Verify it's stored
    const row = db
      .prepare("SELECT entry_id FROM entries_vec WHERE entry_id = ?")
      .get(id) as { entry_id: string } | undefined;
    expect(row?.entry_id).toBe(id);

    // Verify embedding_status updated
    const entry = db
      .prepare("SELECT embedding_status, embedding_model FROM entries WHERE id = ?")
      .get(id) as { embedding_status: string; embedding_model: string };
    expect(entry.embedding_status).toBe("generated");
    expect(entry.embedding_model).toBe("test-model");

    // Remove
    removeEmbedding(db, id);
    const afterRemove = db
      .prepare("SELECT entry_id FROM entries_vec WHERE entry_id = ?")
      .get(id);
    expect(afterRemove).toBeUndefined();
  });
});

describe("semantic search (vec integration)", () => {
  it.skipIf(!vecAvailable)("finds entries by vector similarity", () => {
    // Create entries with different embeddings
    const { id: catId } = writeState(db, "animals/cats", "info", "All about cats", ["animal"]);
    const { id: dogId } = writeState(db, "animals/dogs", "info", "All about dogs", ["animal"]);
    const { id: fishId } = writeState(db, "animals/fish", "info", "All about fish", ["animal"]);

    // Store embeddings
    storeEmbedding(db, catId, embeddingToBuffer(makeEmbedding(1)), "test");
    storeEmbedding(db, dogId, embeddingToBuffer(makeEmbedding(2)), "test");
    storeEmbedding(db, fishId, embeddingToBuffer(makeEmbedding(3)), "test");

    // Update status so we can verify
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?, ?)").run(catId, dogId, fishId);

    // Query with cat embedding — should rank cat entry first
    const queryEmb = embeddingToBuffer(makeEmbedding(1));
    const results = queryEntriesSemantic(db, { queryEmbedding: queryEmb });
    expect(results.length).toBe(3);
    expect(results[0].id).toBe(catId);
  });

  it.skipIf(!vecAvailable)("filters by namespace", () => {
    const { id: id1 } = writeState(db, "ns-a", "key1", "cat content", []);
    const { id: id2 } = writeState(db, "ns-b", "key2", "dog content", []);

    storeEmbedding(db, id1, embeddingToBuffer(makeEmbedding(1)), "test");
    storeEmbedding(db, id2, embeddingToBuffer(makeEmbedding(2)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?)").run(id1, id2);

    const queryEmb = embeddingToBuffer(makeEmbedding(42));
    const results = queryEntriesSemantic(db, { queryEmbedding: queryEmb, namespace: "ns-a" });
    expect(results.every((r) => r.namespace === "ns-a")).toBe(true);
  });

  it.skipIf(!vecAvailable)("filters by entry type", () => {
    const { id: stateId } = writeState(db, "test/ns", "key1", "cat state", []);
    const { id: logId } = appendLog(db, "test/ns", "cat log", []);

    storeEmbedding(db, stateId, embeddingToBuffer(makeEmbedding(1)), "test");
    storeEmbedding(db, logId, embeddingToBuffer(makeEmbedding(1)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?)").run(stateId, logId);

    const queryEmb = embeddingToBuffer(makeEmbedding(1));
    const results = queryEntriesSemantic(db, { queryEmbedding: queryEmb, entryType: "state" });
    expect(results.every((r) => r.entry_type === "state")).toBe(true);
  });

  it.skipIf(!vecAvailable)("filters by tags", () => {
    const { id: id1 } = writeState(db, "test/ns", "key1", "cat content", ["important"]);
    const { id: id2 } = writeState(db, "test/ns", "key2", "dog content", ["trivial"]);

    storeEmbedding(db, id1, embeddingToBuffer(makeEmbedding(1)), "test");
    storeEmbedding(db, id2, embeddingToBuffer(makeEmbedding(2)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?)").run(id1, id2);

    const queryEmb = embeddingToBuffer(makeEmbedding(42));
    const results = queryEntriesSemantic(db, { queryEmbedding: queryEmb, tags: ["important"] });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(id1);
  });
});

describe("hybrid RRF search", () => {
  it.skipIf(!vecAvailable)("ranks entries present in both FTS and vec higher", () => {
    // Entry that matches both FTS ("cat") and vec (seed 1)
    const { id: bothId } = writeState(db, "test/ns", "both", "The cat is a wonderful animal", ["test"]);
    // Entry that only matches FTS ("cat" keyword) but has distant vec
    const { id: ftsOnlyId } = writeState(db, "test/ns", "fts-only", "The cat sat on the mat", ["test"]);
    // Entry that only matches vec (similar embedding) but no keyword match
    const { id: vecOnlyId } = writeState(db, "test/ns", "vec-only", "No keyword match here", ["test"]);

    // Store embeddings: "both" gets seed 1 (close to query), "fts-only" gets seed 99 (far), "vec-only" gets seed 1 (close)
    storeEmbedding(db, bothId, embeddingToBuffer(makeEmbedding(1)), "test");
    storeEmbedding(db, ftsOnlyId, embeddingToBuffer(makeEmbedding(99)), "test");
    storeEmbedding(db, vecOnlyId, embeddingToBuffer(makeEmbedding(1)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?, ?)").run(bothId, ftsOnlyId, vecOnlyId);

    const queryEmb = embeddingToBuffer(makeEmbedding(1));

    const results = queryEntriesHybrid(db, {
      ftsOptions: { query: "cat" },
      semanticOptions: { queryEmbedding: queryEmb },
    });

    // "both" should be ranked first (appears in both result sets)
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe(bothId);
  });

  it.skipIf(!vecAvailable)("handles entries in only one result set", () => {
    // Entry only matchable by FTS
    const { id: ftsId } = writeState(db, "test/ns", "fts", "unique searchterm alpha", []);
    // Entry only matchable by vec (no FTS match for "searchterm")
    const { id: vecId } = writeState(db, "test/ns", "vec", "completely different content", []);

    storeEmbedding(db, ftsId, embeddingToBuffer(makeEmbedding(99)), "test");
    storeEmbedding(db, vecId, embeddingToBuffer(makeEmbedding(1)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?)").run(ftsId, vecId);

    const queryEmb = embeddingToBuffer(makeEmbedding(1));

    const results = queryEntriesHybrid(db, {
      ftsOptions: { query: "searchterm" },
      semanticOptions: { queryEmbedding: queryEmb },
    });

    // Both should appear (from different sources)
    const ids = results.map((r) => r.id);
    expect(ids).toContain(ftsId);
    expect(ids).toContain(vecId);
  });

  it.skipIf(!vecAvailable)("retries FTS with relaxed OR query when strict AND returns zero matches", () => {
    // Entry contains "OAuth" and "access" but NOT "expiry" or "control".
    // The strict AND-of-all-terms FTS query for "OAuth token expiry access control"
    // would return zero matches; the relaxed OR fallback should still surface it.
    const { id: oauthId } = writeState(
      db,
      "projects/munin-memory",
      "oauth-status",
      "OAuth 2.1 provider shipped with access token rotation",
      [],
    );
    // Unrelated entry with far embedding so it doesn't crowd the result.
    const { id: unrelatedId } = writeState(db, "test/ns", "unrelated", "completely different", []);

    storeEmbedding(db, oauthId, embeddingToBuffer(makeEmbedding(99)), "test");
    storeEmbedding(db, unrelatedId, embeddingToBuffer(makeEmbedding(50)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id IN (?, ?)").run(oauthId, unrelatedId);

    const queryEmb = embeddingToBuffer(makeEmbedding(1));
    const compound = "OAuth token expiry access control";

    // Without ftsFallbackOptions: strict AND returns zero FTS matches.
    const strict = queryEntriesHybridScored(db, {
      ftsOptions: { query: compound },
      semanticOptions: { queryEmbedding: queryEmb },
    });
    const strictOauth = strict.results.find((r) => r.entry.id === oauthId);
    expect(strict.ftsRelaxed).toBe(false);
    expect(strictOauth?.lexicalRank).toBeUndefined();

    // With a relaxed OR fallback: FTS now contributes a lexical rank for the OAuth entry.
    const relaxed = queryEntriesHybridScored(db, {
      ftsOptions: { query: compound },
      semanticOptions: { queryEmbedding: queryEmb },
      ftsFallbackOptions: {
        query: `"oauth" OR "token" OR "expiry" OR "access" OR "control"`,
        rawFts5: true,
      },
    });
    expect(relaxed.ftsRelaxed).toBe(true);
    const relaxedOauth = relaxed.results.find((r) => r.entry.id === oauthId);
    expect(relaxedOauth).toBeTruthy();
    expect(relaxedOauth?.lexicalRank).toBeTypeOf("number");
  });
});

describe("background worker", () => {
  it.skipIf(!vecAvailable)("processes pending entries", async () => {
    // Write entries — they start as 'pending'
    writeState(db, "test/ns", "key1", "content about cats", []);
    writeState(db, "test/ns", "key2", "content about dogs", []);

    const pending = db
      .prepare("SELECT COUNT(*) as cnt FROM entries WHERE embedding_status = 'pending'")
      .get() as { cnt: number };
    expect(pending.cnt).toBe(2);

    // Start worker and wait for it to process
    startEmbeddingWorker(db);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await stopEmbeddingWorker();

    // Check that entries are now generated
    const generated = db
      .prepare("SELECT COUNT(*) as cnt FROM entries WHERE embedding_status = 'generated'")
      .get() as { cnt: number };
    expect(generated.cnt).toBe(2);

    // Check that vec rows exist
    const vecRows = db
      .prepare("SELECT COUNT(*) as cnt FROM entries_vec")
      .get() as { cnt: number };
    expect(vecRows.cnt).toBe(2);
  });

  it.skipIf(!vecAvailable)("guards against stale writes", async () => {
    const { id } = writeState(db, "test/ns", "key1", "original cat content", []);

    // Claim as processing and record the updated_at
    db.prepare("UPDATE entries SET embedding_status = 'processing' WHERE id = ?").run(id);
    const claimedUpdatedAt = (db.prepare("SELECT updated_at FROM entries WHERE id = ?").get(id) as { updated_at: string }).updated_at;

    // Simulate content being updated while processing (force different timestamp)
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeState(db, "test/ns", "key1", "updated content about dogs", []);

    // The update should have changed updated_at and reset embedding_status
    const afterUpdate = db
      .prepare("SELECT updated_at, embedding_status FROM entries WHERE id = ?")
      .get(id) as { updated_at: string; embedding_status: string };
    expect(afterUpdate.embedding_status).toBe("pending");
    expect(afterUpdate.updated_at).not.toBe(claimedUpdatedAt);

    // Now try storeEmbedding with the OLD updated_at — the guard should reject
    const embedding = makeEmbedding(1);
    const buf = embeddingToBuffer(embedding);

    // Manually simulate the worker's guarded store (same pattern as processBatch)
    const txn = db.transaction(() => {
      const current = db
        .prepare("SELECT updated_at FROM entries WHERE id = ?")
        .get(id) as { updated_at: string };
      // This would be the stale check — updated_at changed
      if (current.updated_at !== claimedUpdatedAt) {
        return false; // Stale — skip
      }
      storeEmbedding(db, id, buf, "test");
      return true;
    });
    const stored = txn();
    expect(stored).toBe(false);

    // Vec should NOT have an entry (stale write was rejected)
    const vecRow = db.prepare("SELECT entry_id FROM entries_vec WHERE entry_id = ?").get(id);
    expect(vecRow).toBeUndefined();
  });
});

describe("writeState resets embedding status", () => {
  it("new entries get embedding_status = 'pending'", () => {
    const { id } = writeState(db, "test/ns", "key1", "content", []);
    const entry = db
      .prepare("SELECT embedding_status, embedding_model FROM entries WHERE id = ?")
      .get(id) as { embedding_status: string; embedding_model: string | null };
    expect(entry.embedding_status).toBe("pending");
    expect(entry.embedding_model).toBeNull();
  });

  it("updating an entry resets embedding_status to pending", () => {
    const { id } = writeState(db, "test/ns", "key1", "v1", []);

    // Simulate that embedding was generated
    db.prepare("UPDATE entries SET embedding_status = 'generated', embedding_model = 'test' WHERE id = ?").run(id);

    // Update the entry
    writeState(db, "test/ns", "key1", "v2", []);

    const entry = db
      .prepare("SELECT embedding_status, embedding_model FROM entries WHERE id = ?")
      .get(id) as { embedding_status: string; embedding_model: string | null };
    expect(entry.embedding_status).toBe("pending");
    expect(entry.embedding_model).toBeNull();
  });
});

describe("delete cleans up vec entries", () => {
  it.skipIf(!vecAvailable)("single key delete removes vec entry", () => {
    const { id } = writeState(db, "test/ns", "key1", "cat content", []);
    storeEmbedding(db, id, embeddingToBuffer(makeEmbedding(1)), "test");
    db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id = ?").run(id);

    executeDelete(db, "test/ns", "key1");

    const vecRow = db.prepare("SELECT entry_id FROM entries_vec WHERE entry_id = ?").get(id);
    expect(vecRow).toBeUndefined();
  });

  it.skipIf(!vecAvailable)("namespace delete removes all vec entries", () => {
    const { id: id1 } = writeState(db, "test/ns", "key1", "cat content", []);
    const { id: id2 } = writeState(db, "test/ns", "key2", "dog content", []);

    storeEmbedding(db, id1, embeddingToBuffer(makeEmbedding(1)), "test");
    storeEmbedding(db, id2, embeddingToBuffer(makeEmbedding(2)), "test");

    executeDelete(db, "test/ns");

    const vecCount = db.prepare("SELECT COUNT(*) as cnt FROM entries_vec").get() as { cnt: number };
    expect(vecCount.cnt).toBe(0);
  });
});
