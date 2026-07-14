/**
 * Multi-worker embedding claim safety tests (#170).
 *
 * Uses TWO independent better-sqlite3 connections to the SAME temp database
 * file with WAL mode. Tests invoke production claim/reset/finalize helpers —
 * no hand-written claim SQL.
 *
 * Covers:
 *  1. Fresh A claim not reclaimed by B
 *  2. Stale A reset then B claims
 *  3. A cannot finalize success after B owns
 *  4. A cannot finalize failure after B owns
 *  5. A cannot finalize after content update/requeue
 *  6. Correct success persists entries_vec and clears claim
 *  7. Correct failure reaches 'failed' and clears claim
 *  8. Stale threshold validation (boundary tests)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { initDatabase, writeState } from "../src/db.js";
import {
  resetOrphanedProcessingRows,
  claimBatch,
  finalizeSuccess,
  finalizeFailure,
  STALE_CLAIM_MS,
  _setExtractorForTesting,
  resetCircuitBreaker,
  stopEmbeddingWorker,
  embeddingToBuffer,
} from "../src/embeddings.js";

const TEST_DB_PATH = "/tmp/munin-memory-claim-test.db";
const EMBEDDING_DIM = 384;

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

function makeEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.1) * 0.1;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] /= norm;
  }
  return arr;
}

function mockExtractor(
  _text: string,
  _options: { pooling: string; normalize: boolean },
) {
  return Promise.resolve({ data: makeEmbedding(42) });
}

type ClaimRow = {
  embedding_status: string;
  embedding_claim_token: string | null;
  embedding_claimed_at: string | null;
};

function getClaimState(db: Database.Database, entryId: string): ClaimRow {
  return db
    .prepare(
      "SELECT embedding_status, embedding_claim_token, embedding_claimed_at FROM entries WHERE id = ?",
    )
    .get(entryId) as ClaimRow;
}

/** Connection A — used for initial writes and as "worker A". */
let dbA: Database.Database;
/** Connection B — independent WAL connection acting as "worker B". */
let dbB: Database.Database;

beforeEach(() => {
  cleanupTestDb();
  // Connection A: initDatabase creates schema, enables WAL
  dbA = initDatabase(TEST_DB_PATH);
  // Connection B: raw better-sqlite3 open on the same file, WAL mode inherited
  dbB = new Database(TEST_DB_PATH);
  dbB.pragma("journal_mode = WAL");
  dbB.pragma("busy_timeout = 5000");
  resetCircuitBreaker();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setExtractorForTesting(mockExtractor as any);
});

afterEach(async () => {
  await stopEmbeddingWorker();
  _setExtractorForTesting(null);
  dbB.close();
  dbA.close();
  cleanupTestDb();
});

describe("embedding claim ownership (#170)", () => {
  // ── 1. Fresh A claim NOT reclaimed by B ─────────────────────────────────
  it("does not reset a fresh in-flight claim", () => {
    writeState(dbA, "test/ns", "fresh", "content", []);

    // Worker A claims via production helper
    const { claimToken, rows } = claimBatch(dbA, "test-model", 10);
    expect(rows).toHaveLength(1);

    // Worker B runs reset — should NOT reclaim a fresh claim
    const reset = resetOrphanedProcessingRows(dbB);
    expect(reset).toBe(0);

    // Verify A's claim is intact (read from B's connection to prove WAL visibility)
    const state = getClaimState(dbB, rows[0].id);
    expect(state.embedding_status).toBe("processing");
    expect(state.embedding_claim_token).toBe(claimToken);
  });

  // ── 2. Stale A reset then B claims ──────────────────────────────────────
  it("resets a stale A claim, then B claims the row", () => {
    const { id } = writeState(dbA, "test/ns", "stale", "content", []);

    // Worker A claims
    const claimA = claimBatch(dbA, "test-model", 10);
    expect(claimA.rows).toHaveLength(1);

    // Manually backdate A's claim to make it stale
    dbA
      .prepare("UPDATE entries SET embedding_claimed_at = ? WHERE id = ?")
      .run(
        new Date(Date.now() - STALE_CLAIM_MS - 60_000).toISOString(),
        id,
      );

    // Worker B resets stale claims
    const reset = resetOrphanedProcessingRows(dbB);
    expect(reset).toBe(1);

    // Worker B now claims the row
    const claimB = claimBatch(dbB, "test-model", 10);
    expect(claimB.rows).toHaveLength(1);
    expect(claimB.rows[0].id).toBe(id);

    // Verify B owns it
    const state = getClaimState(dbA, id);
    expect(state.embedding_status).toBe("processing");
    expect(state.embedding_claim_token).toBe(claimB.claimToken);
  });

  // ── 3. A cannot finalize success after B owns ───────────────────────────
  it("prevents A from finalizing success after B owns the row", () => {
    const { id } = writeState(dbA, "test/ns", "contested", "content", []);

    // Worker A claims
    const claimA = claimBatch(dbA, "test-model", 10);
    const rowA = claimA.rows[0];

    // Backdate A's claim, reset, B claims
    dbA
      .prepare("UPDATE entries SET embedding_claimed_at = ? WHERE id = ?")
      .run(
        new Date(Date.now() - STALE_CLAIM_MS - 60_000).toISOString(),
        id,
      );
    resetOrphanedProcessingRows(dbB);
    const claimB = claimBatch(dbB, "test-model", 10);
    expect(claimB.rows).toHaveLength(1);

    // Worker A belatedly tries to finalize success — must fail
    const buf = embeddingToBuffer(makeEmbedding(1));
    const stored = finalizeSuccess(
      dbA,
      rowA.id,
      claimA.claimToken,
      rowA.updated_at,
      buf,
      "test-model",
    );
    expect(stored).toBe(false);

    // Row still owned by B
    const state = getClaimState(dbB, id);
    expect(state.embedding_status).toBe("processing");
    expect(state.embedding_claim_token).toBe(claimB.claimToken);
  });

  // ── 4. A cannot finalize failure after B owns ───────────────────────────
  it("prevents A from finalizing failure after B owns the row", () => {
    const { id } = writeState(dbA, "test/ns", "fail-guard", "content", []);

    // Worker A claims
    const claimA = claimBatch(dbA, "test-model", 10);
    const rowA = claimA.rows[0];

    // Backdate A's claim, reset, B claims
    dbA
      .prepare("UPDATE entries SET embedding_claimed_at = ? WHERE id = ?")
      .run(
        new Date(Date.now() - STALE_CLAIM_MS - 60_000).toISOString(),
        id,
      );
    resetOrphanedProcessingRows(dbB);
    claimBatch(dbB, "test-model", 10);

    // Worker A belatedly tries to finalize failure — must fail
    const failed = finalizeFailure(
      dbA,
      rowA.id,
      claimA.claimToken,
      rowA.updated_at,
    );
    expect(failed).toBe(false);

    // Row still processing (owned by B)
    const state = getClaimState(dbB, id);
    expect(state.embedding_status).toBe("processing");
  });

  // ── 5. A cannot finalize after content update/requeue ───────────────────
  it("prevents A from finalizing success after content update/requeue", () => {
    writeState(dbA, "test/ns", "requeue", "v1", []);

    // Worker A claims
    const claimA = claimBatch(dbA, "test-model", 10);
    const rowA = claimA.rows[0];

    // Content update via writeState requeues as pending + clears claim
    writeState(dbA, "test/ns", "requeue", "v2", []);

    // A's claim token should be gone and status should be pending
    const state = getClaimState(dbA, rowA.id);
    expect(state.embedding_status).toBe("pending");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();

    // Worker A tries to finalize success with stale updated_at — must fail
    const buf = embeddingToBuffer(makeEmbedding(1));
    const stored = finalizeSuccess(
      dbA,
      rowA.id,
      claimA.claimToken,
      rowA.updated_at,
      buf,
      "test-model",
    );
    expect(stored).toBe(false);

    // Also verify failure finalization is blocked
    const failed = finalizeFailure(
      dbA,
      rowA.id,
      claimA.claimToken,
      rowA.updated_at,
    );
    expect(failed).toBe(false);

    // Entry still pending for re-embedding
    expect(getClaimState(dbA, rowA.id).embedding_status).toBe("pending");
  });

  // ── 6. Correct success persists entries_vec and clears claim ────────────
  it("correct success finalization persists vector and clears claim", () => {
    const { id } = writeState(dbA, "test/ns", "success", "content", []);

    // Worker A claims
    const claimA = claimBatch(dbA, "test-model", 10);
    const rowA = claimA.rows[0];

    // Generate and finalize
    const embedding = makeEmbedding(7);
    const buf = embeddingToBuffer(embedding);
    const stored = finalizeSuccess(
      dbA,
      rowA.id,
      claimA.claimToken,
      rowA.updated_at,
      buf,
      "test-model",
    );
    expect(stored).toBe(true);

    // Verify entries row
    const state = getClaimState(dbA, id);
    expect(state.embedding_status).toBe("generated");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();

    // Verify embedding_model was set
    const model = (
      dbA
        .prepare("SELECT embedding_model FROM entries WHERE id = ?")
        .get(id) as { embedding_model: string }
    ).embedding_model;
    expect(model).toBe("test-model");

    // Verify vector persisted in entries_vec (readable from connection B)
    const vecRow = dbB
      .prepare("SELECT entry_id FROM entries_vec WHERE entry_id = ?")
      .get(id) as { entry_id: string } | undefined;
    expect(vecRow).toBeDefined();
    expect(vecRow!.entry_id).toBe(id);
  });

  // ── 7. Correct failure reaches 'failed' and clears claim ───────────────
  it("correct failure finalization sets failed and clears claim", () => {
    const { id } = writeState(dbA, "test/ns", "failure", "content", []);

    // Worker A claims
    const claimA = claimBatch(dbA, "test-model", 10);
    const rowA = claimA.rows[0];

    // Finalize failure
    const failed = finalizeFailure(
      dbA,
      rowA.id,
      claimA.claimToken,
      rowA.updated_at,
    );
    expect(failed).toBe(true);

    // Verify state
    const state = getClaimState(dbA, id);
    expect(state.embedding_status).toBe("failed");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();
  });

  // ── 8. Mixed batch: only stale claims are reset ─────────────────────────
  it("only resets stale claims in a mixed batch of stale and fresh", () => {
    const { id: freshId } = writeState(
      dbA,
      "test/ns",
      "mix-fresh",
      "content",
      [],
    );
    const { id: staleId } = writeState(
      dbA,
      "test/ns",
      "mix-stale",
      "content",
      [],
    );

    // Claim both via production helper
    const claim = claimBatch(dbA, "test-model", 10);
    expect(claim.rows).toHaveLength(2);

    // Backdate only the stale entry
    dbA
      .prepare("UPDATE entries SET embedding_claimed_at = ? WHERE id = ?")
      .run(
        new Date(Date.now() - STALE_CLAIM_MS - 60_000).toISOString(),
        staleId,
      );

    const reset = resetOrphanedProcessingRows(dbB);
    expect(reset).toBe(1);

    // Fresh claim untouched
    const freshState = getClaimState(dbA, freshId);
    expect(freshState.embedding_status).toBe("processing");
    expect(freshState.embedding_claim_token).toBe(claim.claimToken);

    // Stale claim reset
    const staleState = getClaimState(dbA, staleId);
    expect(staleState.embedding_status).toBe("pending");
    expect(staleState.embedding_claim_token).toBeNull();
  });

  // ── 9. NULL claimed_at treated as stale (pre-v20 leftovers) ─────────────
  it("resets a processing row with NULL embedding_claimed_at as stale", () => {
    const { id } = writeState(dbA, "test/ns", "legacy", "content", []);
    // Simulate a pre-migration-v20 orphan: status=processing, no claim metadata
    dbA
      .prepare(
        "UPDATE entries SET embedding_status = 'processing' WHERE id = ?",
      )
      .run(id);

    const reset = resetOrphanedProcessingRows(dbB);
    expect(reset).toBe(1);

    const state = getClaimState(dbA, id);
    expect(state.embedding_status).toBe("pending");
  });

  // ── 10. writeState clears claim metadata on content update ──────────────
  it("writeState clears claim metadata when updating an entry", () => {
    const { id } = writeState(dbA, "test/ns", "ws-clear", "v1", []);

    // Claim via production helper
    claimBatch(dbA, "test-model", 10);

    // Verify claimed
    expect(getClaimState(dbA, id).embedding_status).toBe("processing");

    // Update entry content
    writeState(dbA, "test/ns", "ws-clear", "v2", []);

    // Claim should be cleared and status reset to pending
    const state = getClaimState(dbA, id);
    expect(state.embedding_status).toBe("pending");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();
  });
});

describe("stale threshold validation (#170)", () => {
  it("STALE_CLAIM_MS is the fixed 300000 production constant", () => {
    expect(STALE_CLAIM_MS).toBe(300_000);
  });

  it("rejects zero threshold", () => {
    expect(() => resetOrphanedProcessingRows(dbA, 0)).toThrow(RangeError);
  });

  it("rejects negative threshold", () => {
    expect(() => resetOrphanedProcessingRows(dbA, -1)).toThrow(RangeError);
  });

  it("rejects NaN threshold", () => {
    expect(() => resetOrphanedProcessingRows(dbA, NaN)).toThrow(RangeError);
  });

  it("rejects Infinity threshold", () => {
    expect(() => resetOrphanedProcessingRows(dbA, Infinity)).toThrow(
      RangeError,
    );
  });

  it("rejects non-integer threshold", () => {
    expect(() => resetOrphanedProcessingRows(dbA, 1.5)).toThrow(RangeError);
  });

  it("rejects unsafe integer threshold", () => {
    expect(() =>
      resetOrphanedProcessingRows(dbA, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow(RangeError);
  });

  it("accepts 1ms boundary threshold", () => {
    // Should not throw — 1 is a finite positive safe integer
    expect(() => resetOrphanedProcessingRows(dbA, 1)).not.toThrow();
  });

  it("accepts MAX_SAFE_INTEGER threshold", () => {
    expect(() =>
      resetOrphanedProcessingRows(dbA, Number.MAX_SAFE_INTEGER),
    ).not.toThrow();
  });
});
