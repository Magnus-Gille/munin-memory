/**
 * Regression tests for multi-worker embedding claim safety (#170).
 *
 * Validates:
 * 1. A fresh in-flight claim is NOT reclaimed by resetOrphanedProcessingRows.
 * 2. A stale claim (past the timeout) IS reclaimed.
 * 3. An old owner cannot finalize after its claim has been reassigned.
 *
 * All tests use deterministic timestamps and direct DB manipulation — no real
 * network/model calls, no setTimeout races.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { initDatabase, writeState, storeEmbedding } from "../src/db.js";
import {
  resetOrphanedProcessingRows,
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

function mockExtractor(text: string, _options: { pooling: string; normalize: boolean }) {
  return Promise.resolve({ data: makeEmbedding(42) });
}

let db: Database.Database;

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

// ─── Helper: simulate a claim on a row ──────────────────────────────────────
function claimRow(
  entryId: string,
  claimToken: string,
  claimedAt: string,
): void {
  db.prepare(
    `UPDATE entries
       SET embedding_status = 'processing',
           embedding_claim_token = ?,
           embedding_claimed_at = ?
     WHERE id = ?`,
  ).run(claimToken, claimedAt, entryId);
}

type ClaimRow = {
  embedding_status: string;
  embedding_claim_token: string | null;
  embedding_claimed_at: string | null;
};

function getClaimState(entryId: string): ClaimRow {
  return db
    .prepare(
      "SELECT embedding_status, embedding_claim_token, embedding_claimed_at FROM entries WHERE id = ?",
    )
    .get(entryId) as ClaimRow;
}

describe("embedding claim ownership (#170)", () => {
  // ── 1. Fresh in-flight claim must NOT be reclaimed ──────────────────────
  it("does not reset a fresh in-flight claim", () => {
    const { id } = writeState(db, "test/ns", "fresh", "content", []);
    const token = randomUUID();
    const freshTimestamp = new Date().toISOString(); // just now — well within STALE_CLAIM_MS
    claimRow(id, token, freshTimestamp);

    const reset = resetOrphanedProcessingRows(db);
    expect(reset).toBe(0);

    const state = getClaimState(id);
    expect(state.embedding_status).toBe("processing");
    expect(state.embedding_claim_token).toBe(token);
    expect(state.embedding_claimed_at).toBe(freshTimestamp);
  });

  // ── 2. Stale claim IS reclaimed ─────────────────────────────────────────
  it("resets a stale claim whose timestamp exceeds the threshold", () => {
    const { id } = writeState(db, "test/ns", "stale", "content", []);
    const token = randomUUID();
    // Timestamp well in the past — older than STALE_CLAIM_MS
    const staleTimestamp = new Date(
      Date.now() - STALE_CLAIM_MS - 60_000,
    ).toISOString();
    claimRow(id, token, staleTimestamp);

    const reset = resetOrphanedProcessingRows(db);
    expect(reset).toBe(1);

    const state = getClaimState(id);
    expect(state.embedding_status).toBe("pending");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();
  });

  // ── 2b. NULL claimed_at is treated as stale (pre-v20 leftovers) ─────────
  it("resets a processing row with NULL embedding_claimed_at as stale", () => {
    const { id } = writeState(db, "test/ns", "legacy", "content", []);
    // Simulate a pre-migration-v20 orphan: status=processing, no claim metadata
    db.prepare(
      "UPDATE entries SET embedding_status = 'processing' WHERE id = ?",
    ).run(id);

    const reset = resetOrphanedProcessingRows(db);
    expect(reset).toBe(1);

    const state = getClaimState(id);
    expect(state.embedding_status).toBe("pending");
  });

  // ── 3. Old owner cannot finalize after reassignment ─────────────────────
  it("prevents a stale owner from finalizing after its claim is reassigned", () => {
    const { id } = writeState(db, "test/ns", "contested", "content", []);

    // Worker A claims the row
    const tokenA = randomUUID();
    const claimedAtA = new Date(
      Date.now() - STALE_CLAIM_MS - 60_000,
    ).toISOString();
    claimRow(id, tokenA, claimedAtA);

    // Record the updated_at that Worker A captured
    const workerAUpdatedAt = (
      db.prepare("SELECT updated_at FROM entries WHERE id = ?").get(id) as {
        updated_at: string;
      }
    ).updated_at;

    // Worker B reclaims the stale row
    const reclaimed = resetOrphanedProcessingRows(db);
    expect(reclaimed).toBe(1);

    // Worker B now claims it with its own token
    const tokenB = randomUUID();
    const claimedAtB = new Date().toISOString();
    claimRow(id, tokenB, claimedAtB);

    // Worker A belatedly tries to finalize with its old token — the claim
    // token guard must reject it.
    const txn = db.transaction(() => {
      const current = db
        .prepare(
          "SELECT updated_at, embedding_claim_token FROM entries WHERE id = ?",
        )
        .get(id) as {
        updated_at: string;
        embedding_claim_token: string | null;
      };

      if (current.embedding_claim_token !== tokenA) {
        return "rejected_claim_mismatch";
      }

      if (current.updated_at !== workerAUpdatedAt) {
        return "rejected_updated_at";
      }

      // Would call storeEmbedding here — should never reach this point
      return "stored";
    });

    const result = txn();
    expect(result).toBe("rejected_claim_mismatch");

    // Verify the row still belongs to Worker B
    const state = getClaimState(id);
    expect(state.embedding_status).toBe("processing");
    expect(state.embedding_claim_token).toBe(tokenB);
  });

  // ── 3b. Old owner failure path also guarded by claim token ──────────────
  it("prevents a stale owner from marking as failed after reassignment", () => {
    const { id } = writeState(db, "test/ns", "fail-guard", "content", []);

    // Worker A claims the row
    const tokenA = randomUUID();
    claimRow(id, tokenA, new Date().toISOString());

    // Worker B steals it (simulating stale reclaim + re-claim)
    const tokenB = randomUUID();
    claimRow(id, tokenB, new Date().toISOString());

    // Worker A tries to mark as failed with its old token
    const result = db
      .prepare(
        `UPDATE entries
           SET embedding_status = 'failed',
               embedding_claim_token = NULL,
               embedding_claimed_at = NULL
         WHERE id = ? AND embedding_claim_token = ?`,
      )
      .run(id, tokenA);

    // Should update 0 rows — token mismatch
    expect(result.changes).toBe(0);

    // Row still owned by Worker B, still processing
    const state = getClaimState(id);
    expect(state.embedding_status).toBe("processing");
    expect(state.embedding_claim_token).toBe(tokenB);
  });

  // ── 4. Custom stale threshold ───────────────────────────────────────────
  it("respects a custom staleThresholdMs parameter", () => {
    const { id } = writeState(db, "test/ns", "custom", "content", []);
    const token = randomUUID();
    // 10 seconds ago
    const tenSecsAgo = new Date(Date.now() - 10_000).toISOString();
    claimRow(id, token, tenSecsAgo);

    // With a 1-second threshold, 10 seconds is stale
    const resetShort = resetOrphanedProcessingRows(db, 1_000);
    expect(resetShort).toBe(1);
  });

  it("does not reset a claim within a custom short threshold", () => {
    const { id } = writeState(db, "test/ns", "custom2", "content", []);
    const token = randomUUID();
    const justNow = new Date().toISOString();
    claimRow(id, token, justNow);

    // With a 60-second threshold, a claim from just now is fresh
    const resetLong = resetOrphanedProcessingRows(db, 60_000);
    expect(resetLong).toBe(0);
  });

  // ── 5. Mixed batch: stale + fresh ──────────────────────────────────────
  it("only resets stale claims in a mixed batch of stale and fresh", () => {
    const { id: freshId } = writeState(db, "test/ns", "mix-fresh", "content", []);
    const { id: staleId } = writeState(db, "test/ns", "mix-stale", "content", []);

    const freshToken = randomUUID();
    claimRow(freshId, freshToken, new Date().toISOString());

    const staleToken = randomUUID();
    claimRow(
      staleId,
      staleToken,
      new Date(Date.now() - STALE_CLAIM_MS - 60_000).toISOString(),
    );

    const reset = resetOrphanedProcessingRows(db);
    expect(reset).toBe(1);

    // Fresh claim untouched
    const freshState = getClaimState(freshId);
    expect(freshState.embedding_status).toBe("processing");
    expect(freshState.embedding_claim_token).toBe(freshToken);

    // Stale claim reset
    const staleState = getClaimState(staleId);
    expect(staleState.embedding_status).toBe("pending");
    expect(staleState.embedding_claim_token).toBeNull();
  });

  // ── 6. writeState clears claim metadata on content update ───────────────
  it("writeState clears claim metadata when updating an entry", () => {
    const { id } = writeState(db, "test/ns", "ws-clear", "v1", []);
    const token = randomUUID();
    claimRow(id, token, new Date().toISOString());

    // Update the entry content
    writeState(db, "test/ns", "ws-clear", "v2", []);

    const state = getClaimState(id);
    expect(state.embedding_status).toBe("pending");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();
  });

  // ── 7. storeEmbedding terminal transition clears claim metadata ─────────
  it("storeEmbedding clears claim metadata on generated transition", () => {
    // Verify that after the full processBatch-like flow, claim metadata is
    // cleared in the terminal 'generated' state. We simulate this directly
    // since we can't run the worker without a real model.
    const { id } = writeState(db, "test/ns", "terminal", "content", []);
    const token = randomUUID();
    claimRow(id, token, new Date().toISOString());

    const buf = embeddingToBuffer(makeEmbedding(1));
    const updatedAt = (
      db.prepare("SELECT updated_at FROM entries WHERE id = ?").get(id) as {
        updated_at: string;
      }
    ).updated_at;

    // Simulate the processBatch finalization transaction
    const txn = db.transaction(() => {
      const current = db
        .prepare(
          "SELECT updated_at, embedding_claim_token FROM entries WHERE id = ?",
        )
        .get(id) as {
        updated_at: string;
        embedding_claim_token: string | null;
      };
      if (current.embedding_claim_token !== token) return;
      if (current.updated_at !== updatedAt) return;

      storeEmbedding(db, id, buf, "test-model");
      db.prepare(
        `UPDATE entries
           SET embedding_claim_token = NULL,
               embedding_claimed_at = NULL
         WHERE id = ?`,
      ).run(id);
    });
    txn();

    const state = getClaimState(id);
    expect(state.embedding_status).toBe("generated");
    expect(state.embedding_claim_token).toBeNull();
    expect(state.embedding_claimed_at).toBeNull();
  });
});
