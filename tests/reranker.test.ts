import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import type Database from "better-sqlite3";
import { initDatabase, writeState, getById } from "../src/db.js";
import { rerankQueryResults, getQueryExplainReasons } from "../src/internal/reranker.js";
import type { Entry } from "../src/types.js";
import type { QueryResult } from "../src/types.js";

const TEST_DB_PATH = "/tmp/munin-memory-reranker-test.db";

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

let db: Database.Database;

beforeEach(() => {
  cleanup();
  db = initDatabase(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  cleanup();
});

/**
 * Regression guard for #74: the recency tie-break must order heuristic-tied
 * entries by their stored `updated_at`, not by a freshness score that depends
 * on the wall-clock instant the ranker runs.
 *
 * The old implementation compared `getFreshnessScore(updated_at)`, which clamps
 * age to >= 0 — so any entry written at/after "now" collapsed to freshness 1.0.
 * Two entries written ~1ms apart then compared *equal* when ranked immediately
 * (both clamped) but *distinct* a few ms later, making the order depend on
 * timing. memory_query and the benchmark runner run milliseconds apart, so they
 * disagreed on score-tied recent entries under load.
 */
describe("rerankQueryResults recency tie-break (#74)", () => {
  function tiedEntries(olderTs: string, newerTs: string): [Entry, Entry] {
    // Two entries with identical heuristic score (both decisions/* state
    // entries tagged "decision"). `older` is placed first in input order so
    // the index tie-break alone would keep it first.
    writeState(db, "decisions/older", "v1", "decision content one", ["decision"]);
    writeState(db, "decisions/newer", "v1", "decision content two", ["decision"]);
    const olderId = (db.prepare("SELECT id FROM entries WHERE namespace='decisions/older'").get() as { id: string }).id;
    const newerId = (db.prepare("SELECT id FROM entries WHERE namespace='decisions/newer'").get() as { id: string }).id;
    db.prepare("UPDATE entries SET updated_at=? WHERE id=?").run(olderTs, olderId);
    db.prepare("UPDATE entries SET updated_at=? WHERE id=?").run(newerTs, newerId);
    return [getById(db, olderId)!, getById(db, newerId)!];
  }

  const params = { query: "decision", search_recency_weight: 0.2 } as Parameters<typeof rerankQueryResults>[1];

  it("orders the newer entry first even when both timestamps are in the future (freshness would clamp to 1.0)", () => {
    const future = Date.now() + 60_000;
    const older = new Date(future).toISOString();
    const newer = new Date(future + 1).toISOString();
    const [eOlder, eNewer] = tiedEntries(older, newer);
    // Input order is [older, newer]; recency must override it.
    const order = rerankQueryResults([eOlder, eNewer], params, new Set()).map((e) => e.namespace);
    expect(order).toEqual(["decisions/newer", "decisions/older"]);
  });

  it("produces the same order regardless of how much time has elapsed since the write", () => {
    // Timestamps just before "now" — the regime where the old clamp made
    // freshness flip between equal and distinct depending on elapsed time.
    const base = Date.now();
    const older = new Date(base - 2).toISOString();
    const newer = new Date(base - 1).toISOString();
    const [eOlder, eNewer] = tiedEntries(older, newer);

    const orderNow = rerankQueryResults([eOlder, eNewer], params, new Set()).map((e) => e.namespace);
    const busyUntil = Date.now() + 1500;
    while (Date.now() < busyUntil) {
      /* burn wall-clock so a second rank runs at a very different "now" */
    }
    const orderLater = rerankQueryResults([eOlder, eNewer], params, new Set()).map((e) => e.namespace);

    expect(orderNow).toEqual(["decisions/newer", "decisions/older"]);
    expect(orderLater).toEqual(orderNow);
  });

  it("falls back to input order when timestamps are identical", () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    const [eOlder, eNewer] = tiedEntries(ts, ts);
    // Same updated_at → recency is a true tie → stable input order preserved.
    const order = rerankQueryResults([eOlder, eNewer], params, new Set()).map((e) => e.namespace);
    expect(order).toEqual(["decisions/older", "decisions/newer"]);
  });
});

/**
 * Regression guard for #81: the per-result explain `match{}` block must reach
 * parity across lexical / semantic / hybrid modes — including human-readable
 * reasons derived from the mode-specific rank/score fields. The
 * `formatQueryResult` builder in src/tools.ts already populates the
 * mode-specific fields (semantic_rank/distance, hybrid_score, etc.); this test
 * pins the reasons logic that turns those fields into explanations so
 * semantic-only and hybrid results are never left without a debuggable reason.
 */
describe("getQueryExplainReasons mode parity (#81)", () => {
  function entry(): Entry {
    writeState(db, "projects/explain", "status", "explainable status content", ["active"]);
    const id = (db.prepare("SELECT id FROM entries WHERE namespace='projects/explain'").get() as { id: string }).id;
    return getById(db, id)!;
  }

  it("explains a semantic-only match", () => {
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.5,
      freshness_score: 0.9,
      semantic_rank: 1,
      semantic_distance: 0.12,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(entry(), "vector neighbour", undefined, match);
    expect(reasons).toContain("matched semantic similarity");
    expect(reasons.length).toBeGreaterThan(0);
  });

  it("explains a hybrid match that fused both signals", () => {
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.7,
      freshness_score: 0.9,
      hybrid_score: 0.031,
      lexical_rank: 2,
      lexical_score: -3.1,
      semantic_rank: 1,
      semantic_distance: 0.2,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(entry(), "explainable status", undefined, match);
    expect(reasons).toContain("matched lexical terms");
    expect(reasons).toContain("matched semantic similarity");
    expect(reasons).toContain("combined lexical and semantic signals");
  });
});
