import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import type Database from "better-sqlite3";
import { initDatabase, writeState, appendLog, getById } from "../src/db.js";
import {
  rerankQueryResults,
  getQueryExplainReasons,
  buildRelaxedLexicalQuery,
  shouldApplyDefaultQuerySuppression,
  isBroadOrientationQuery,
  isAttentionTriageQuery,
  looksLikeTombstone,
  queryMentionsAny,
  assessTrackedStatus,
  getQueryHeuristicScore,
  injectCanonicalQueryEntries,
  injectAttentionQueryEntries,
  resolveSearchRecencyWeight,
  getTrackedStatusAssessments,
} from "../src/internal/reranker.js";
import type { Entry, TrackedStatusRow } from "../src/types.js";
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

// --- buildRelaxedLexicalQuery ---

describe("buildRelaxedLexicalQuery", () => {
  it("returns null for query containing a double quote", () => {
    expect(buildRelaxedLexicalQuery('"quoted phrase"')).toBeNull();
  });

  it("returns null for query containing FTS5 operator keywords", () => {
    expect(buildRelaxedLexicalQuery("foo AND bar")).toBeNull();
    expect(buildRelaxedLexicalQuery("foo OR bar")).toBeNull();
    expect(buildRelaxedLexicalQuery("foo NOT bar")).toBeNull();
  });

  it("returns null for query containing special FTS5 characters", () => {
    expect(buildRelaxedLexicalQuery("foo:bar")).toBeNull();
    expect(buildRelaxedLexicalQuery("(foo)")).toBeNull();
    expect(buildRelaxedLexicalQuery("foo*")).toBeNull();
  });

  it("returns null for single-term query after stopword filtering", () => {
    // Only one non-stopword term → uniqueTerms.length < 2
    expect(buildRelaxedLexicalQuery("deployment")).toBeNull();
    // Stopwords filtered out → only one term remains
    expect(buildRelaxedLexicalQuery("the foo")).toBeNull(); // "the" is a stopword, "foo" too short? Let's use a real stopword
  });

  it("returns OR-joined query for multi-term input", () => {
    const result = buildRelaxedLexicalQuery("SQLite deployment target");
    expect(result).not.toBeNull();
    expect(result).toContain(" OR ");
    expect(result).toContain('"sqlite"');
    expect(result).toContain('"deployment"');
    expect(result).toContain('"target"');
  });

  it("deduplicates repeated terms", () => {
    const result = buildRelaxedLexicalQuery("foo bar foo bar baz");
    expect(result).not.toBeNull();
    // Should only include each term once
    const count = (result!.match(/"foo"/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("filters terms shorter than 3 characters", () => {
    // "it" is 2 chars, "the" is stopword, "active" is valid
    const result = buildRelaxedLexicalQuery("it is active deployment");
    expect(result).not.toBeNull();
    expect(result).not.toContain('"it"');
    expect(result).toContain('"active"');
  });
});

// --- shouldApplyDefaultQuerySuppression ---

describe("shouldApplyDefaultQuerySuppression", () => {
  it("returns true when no namespace, entry_type, or tags", () => {
    expect(shouldApplyDefaultQuerySuppression({ query: "anything" })).toBe(true);
  });

  it("returns false when namespace is set", () => {
    expect(shouldApplyDefaultQuerySuppression({ query: "anything", namespace: "projects/foo" })).toBe(false);
  });

  it("returns false when entry_type is set", () => {
    expect(shouldApplyDefaultQuerySuppression({ query: "anything", entry_type: "log" })).toBe(false);
  });

  it("returns false when tags are set", () => {
    expect(shouldApplyDefaultQuerySuppression({ query: "anything", tags: ["active"] })).toBe(false);
  });

  it("returns true when tags is an empty array", () => {
    expect(shouldApplyDefaultQuerySuppression({ query: "anything", tags: [] })).toBe(true);
  });
});

// --- isBroadOrientationQuery ---

describe("isBroadOrientationQuery", () => {
  it("returns false when query suppression does not apply (namespace set)", () => {
    expect(isBroadOrientationQuery("orient me", { query: "orient me", namespace: "projects/foo" })).toBe(false);
  });

  it("detects phrase matches from ORIENTATION_QUERY_PHRASES", () => {
    expect(isBroadOrientationQuery("orient me on the situation", { query: "orient me on the situation" })).toBe(true);
    expect(isBroadOrientationQuery("catch me up on everything", { query: "catch me up on everything" })).toBe(true);
  });

  it("detects orientation verb + summary intent combination", () => {
    expect(isBroadOrientationQuery("brief me on current work", { query: "brief me on current work" })).toBe(true);
  });

  it("returns false for non-orientation queries", () => {
    expect(isBroadOrientationQuery("SQLite database query", { query: "SQLite database query" })).toBe(false);
  });

  it("returns false for orientation verb without summary intent", () => {
    // "orient" without matching context words
    expect(isBroadOrientationQuery("orient toward the sun", { query: "orient toward the sun" })).toBe(false);
  });
});

// --- isAttentionTriageQuery ---

describe("isAttentionTriageQuery", () => {
  it("returns false when suppression does not apply", () => {
    expect(isAttentionTriageQuery("what needs attention", { query: "what needs attention", namespace: "projects/x" })).toBe(false);
  });

  it("detects phrase matches from ATTENTION_TRIAGE_QUERY_PHRASES", () => {
    expect(isAttentionTriageQuery("what needs attention right now", { query: "what needs attention right now" })).toBe(true);
    expect(isAttentionTriageQuery("what is blocked", { query: "what is blocked" })).toBe(true);
  });

  it("detects blocked keyword", () => {
    expect(isAttentionTriageQuery("show me blocked projects", { query: "show me blocked projects" })).toBe(true);
  });

  it("detects attention + work scope combination", () => {
    expect(isAttentionTriageQuery("anything needing attention in projects", { query: "anything needing attention in projects" })).toBe(true);
  });

  it("detects risk keywords", () => {
    expect(isAttentionTriageQuery("what is at risk", { query: "what is at risk" })).toBe(true);
    expect(isAttentionTriageQuery("show me stale items", { query: "show me stale items" })).toBe(true);
  });

  it("returns false for non-triage queries", () => {
    expect(isAttentionTriageQuery("SQLite query performance", { query: "SQLite query performance" })).toBe(false);
  });
});

// --- looksLikeTombstone ---

describe("looksLikeTombstone", () => {
  it("detects TOMBSTONE in content (case-insensitive)", () => {
    expect(looksLikeTombstone("This entry is a TOMBSTONE for the project")).toBe(true);
    expect(looksLikeTombstone("tombstone marker")).toBe(true);
    expect(looksLikeTombstone("Tombstone status entry")).toBe(true);
  });

  it("returns false for normal content", () => {
    expect(looksLikeTombstone("Active project status")).toBe(false);
    expect(looksLikeTombstone("Some notes about tombstoning (not literal)")).toBe(false);
  });
});

// --- queryMentionsAny ---

describe("queryMentionsAny", () => {
  it("returns true when at least one term is in query", () => {
    expect(queryMentionsAny("working on the project", ["working on", "blocker"])).toBe(true);
  });

  it("returns false when no terms match", () => {
    expect(queryMentionsAny("SQLite database", ["blocked", "stale"])).toBe(false);
  });
});

// --- assessTrackedStatus ---

describe("assessTrackedStatus", () => {
  function makeRow(overrides: Partial<TrackedStatusRow> = {}): TrackedStatusRow {
    return {
      id: "test-id",
      namespace: "projects/test",
      key: "status",
      content: "Test status content",
      tags: JSON.stringify(["active"]),
      agent_id: "default",
      owner_principal_id: null,
      created_at: new Date(Date.now() - 86400 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 86400 * 1000).toISOString(),
      valid_until: null,
      classification: "internal",
      ...overrides,
    };
  }

  it("identifies an active entry with no issues", () => {
    const row = makeRow({ tags: JSON.stringify(["active"]) });
    const result = assessTrackedStatus(row);
    expect(result.lifecycle).toBe("active");
    expect(result.needsAttention).toBe(false);
    expect(result.maintenanceItems).toHaveLength(0);
  });

  it("flags missing lifecycle tag", () => {
    const row = makeRow({ tags: JSON.stringify(["decision"]) });
    const result = assessTrackedStatus(row);
    expect(result.lifecycle).toBe("uncategorized");
    expect(result.maintenanceItems.some((m) => m.issue === "missing_lifecycle")).toBe(true);
  });

  it("flags conflicting lifecycle tags", () => {
    const row = makeRow({ tags: JSON.stringify(["active", "blocked"]) });
    const result = assessTrackedStatus(row);
    expect(result.maintenanceItems.some((m) => m.issue === "conflicting_lifecycle")).toBe(true);
  });

  it("flags blocked status as needing attention", () => {
    const row = makeRow({ tags: JSON.stringify(["blocked"]) });
    const result = assessTrackedStatus(row);
    expect(result.lifecycle).toBe("blocked");
    expect(result.attentionReason).toBe("blocked");
  });

  it("flags expired valid_until", () => {
    const pastDate = new Date(Date.now() - 86400 * 1000).toISOString();
    const row = makeRow({ valid_until: pastDate, tags: JSON.stringify(["active"]) });
    const result = assessTrackedStatus(row);
    expect(result.needsAttention).toBe(true);
    expect(result.attentionReason).toBe("expired");
    expect(result.maintenanceItems.some((m) => m.issue === "expired")).toBe(true);
  });

  it("flags expiring soon (within 7 days)", () => {
    const soonDate = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    const row = makeRow({ valid_until: soonDate, tags: JSON.stringify(["active"]) });
    const result = assessTrackedStatus(row);
    expect(result.needsAttention).toBe(true);
    expect(result.attentionReason).toBe("expiring_soon");
    expect(result.maintenanceItems.some((m) => m.issue === "expiring_soon")).toBe(true);
  });

  it("flags stale active entry (not updated recently)", () => {
    const staleDate = new Date(Date.now() - 20 * 86400 * 1000).toISOString();
    const row = makeRow({ updated_at: staleDate, tags: JSON.stringify(["active"]) });
    const result = assessTrackedStatus(row);
    expect(result.needsAttention).toBe(true);
    expect(result.attentionReason).toBe("active_but_stale");
  });

  it("flags temporal_stale when a past date appears near forward-looking phrasing", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Planning to attend the conference on ${pastDate}. Very excited!`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.attentionReason).toBe("temporal_stale");
    const item = result.maintenanceItems.find(m => m.issue === "temporal_stale");
    expect(item).toBeDefined();
    expect(item!.suggestion).toContain(pastDate);
    expect(item!.suggestion).toMatch(/\d+ day/);
  });

  it("does NOT flag temporal_stale for retrospective phrasing near a past date", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Completed the conference on ${pastDate}. It went great.`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.attentionReason).not.toBe("temporal_stale");
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });

  it("does NOT flag temporal_stale when entry is already caught by active_but_stale (>14d)", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const staleDate = new Date(Date.now() - 20 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Planning to attend the conference on ${pastDate}.`,
      updated_at: staleDate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.attentionReason).toBe("active_but_stale");
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });

  it("does NOT flag temporal_stale for a future date with forward-looking phrasing (caught by upcoming_event_stale)", () => {
    const futureDate = new Date(Date.now() + 3 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdateButStaleEnough = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Planning to attend the workshop on ${futureDate}.`,
      updated_at: recentUpdateButStaleEnough,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.attentionReason).toBe("upcoming_event_stale");
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });

  // --- Codex-review regression tests (#140 fixes) ---

  it("does NOT flag temporal_stale for 'will continue' after a past date (bare 'will' removed from pattern)", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Shipped ${pastDate}; will continue with follow-up work.`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });

  it("does NOT flag temporal_stale for a proper name 'Will' near a past date", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `${pastDate} follow-up with Will.`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });

  it("still flags temporal_stale for strong forward-looking cue (positive control after fix)", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Planning to attend the conference on ${pastDate}.`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.attentionReason).toBe("temporal_stale");
  });

  it("does NOT flag temporal_stale for an invalid date (2026-02-31 rolls over — rejected by round-trip check)", () => {
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Planning around 2026-02-31.`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });

  it("does NOT flag temporal_stale when forward-looking cue is in a different sentence (cross-sentence)", () => {
    const pastDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString().slice(0, 10);
    const recentUpdate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const row = makeRow({
      content: `Conference was ${pastDate}. Next quarter we are planning to expand.`,
      updated_at: recentUpdate,
      tags: JSON.stringify(["active"]),
    });
    const result = assessTrackedStatus(row);
    expect(result.maintenanceItems.find(m => m.issue === "temporal_stale")).toBeUndefined();
  });
});

// --- getQueryHeuristicScore ---

describe("getQueryHeuristicScore", () => {
  function makeEntry(overrides: Partial<Entry> = {}): Entry {
    return {
      id: "entry-id",
      namespace: "projects/test",
      key: "status",
      entry_type: "state",
      content: "Test content",
      tags: JSON.stringify(["active"]),
      agent_id: "default",
      owner_principal_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      valid_until: null,
      classification: "internal",
      embedding_status: "pending",
      embedding_model: null,
      ...overrides,
    };
  }

  it("boosts tracked status entries", () => {
    const statusEntry = makeEntry({ namespace: "projects/foo", key: "status" });
    const otherEntry = makeEntry({ namespace: "projects/foo", key: "notes" });
    const statusScore = getQueryHeuristicScore(statusEntry, "project status");
    const otherScore = getQueryHeuristicScore(otherEntry, "project status");
    expect(statusScore).toBeGreaterThan(otherScore);
  });

  it("boosts people profile entries", () => {
    const profileEntry = makeEntry({ namespace: "people/magnus", key: "profile" });
    const notesEntry = makeEntry({ namespace: "people/magnus", key: "notes" });
    const profileScore = getQueryHeuristicScore(profileEntry, "personal profile");
    const notesScore = getQueryHeuristicScore(notesEntry, "personal profile");
    expect(profileScore).toBeGreaterThan(notesScore);
  });

  it("penalizes tombstone entries heavily", () => {
    const tombstone = makeEntry({ content: "TOMBSTONE: replaced by new namespace" });
    const normal = makeEntry({ content: "Active project status" });
    const tombScore = getQueryHeuristicScore(tombstone, "project");
    const normalScore = getQueryHeuristicScore(normal, "project");
    expect(tombScore).toBeLessThan(normalScore);
  });

  it("penalizes log entries", () => {
    const logEntry = makeEntry({ entry_type: "log", key: null });
    const stateEntry = makeEntry({ entry_type: "state" });
    const logScore = getQueryHeuristicScore(logEntry, "test");
    const stateScore = getQueryHeuristicScore(stateEntry, "test");
    expect(logScore).toBeLessThan(stateScore);
  });

  it("penalizes tasks/ namespaces", () => {
    const taskEntry = makeEntry({ namespace: "tasks/20260327-test", key: "status" });
    const projectEntry = makeEntry({ namespace: "projects/test", key: "status" });
    const taskScore = getQueryHeuristicScore(taskEntry, "test");
    const projectScore = getQueryHeuristicScore(projectEntry, "test");
    expect(taskScore).toBeLessThan(projectScore);
  });

  it("reduces score for archived/completed/stopped status entries", () => {
    const archivedEntry = makeEntry({ key: "status", tags: JSON.stringify(["archived"]) });
    const activeEntry = makeEntry({ key: "status", tags: JSON.stringify(["active"]) });
    const archivedScore = getQueryHeuristicScore(archivedEntry, "status");
    const activeScore = getQueryHeuristicScore(activeEntry, "status");
    expect(archivedScore).toBeLessThan(activeScore);
  });

  it("boosts conventions entry for convention queries", () => {
    const convEntry = makeEntry({ namespace: "meta/conventions", key: "conventions" });
    const normalEntry = makeEntry({ namespace: "meta/other", key: "notes" });
    const convScore = getQueryHeuristicScore(convEntry, "convention handshake lifecycle");
    const normalScore = getQueryHeuristicScore(normalEntry, "convention handshake lifecycle");
    expect(convScore).toBeGreaterThan(normalScore);
  });

  it("boosts meta reference-index for orientation queries", () => {
    const refEntry = makeEntry({ namespace: "meta", key: "reference-index" });
    const normalEntry = makeEntry({ namespace: "meta", key: "other-key" });
    const refScore = getQueryHeuristicScore(refEntry, "orient me on everything");
    const normalScore = getQueryHeuristicScore(normalEntry, "orient me on everything");
    expect(refScore).toBeGreaterThan(normalScore);
  });

  it("penalizes log entries extra for triage queries", () => {
    const logEntry = makeEntry({ entry_type: "log", key: null });
    const logNormal = getQueryHeuristicScore(logEntry, "decision architecture");
    const logTriage = getQueryHeuristicScore(logEntry, "what is blocked");
    // triage query penalizes logs more
    expect(logTriage).toBeLessThan(logNormal);
  });

  it("boosts blocked tracked status in triage queries via trackedStatuses map", () => {
    const statusEntry = makeEntry({ id: "tracked-id", namespace: "projects/blocked-proj", key: "status" });
    const blockedAssessment = {
      row: {} as TrackedStatusRow,
      entry: statusEntry,
      lifecycle: "blocked",
      needsAttention: true,
      attentionReason: "blocked" as const,
      maintenanceItems: [],
    };
    const withTracked = new Map([["tracked-id", blockedAssessment]]);
    const scoreWithTracked = getQueryHeuristicScore(statusEntry, "what is blocked", withTracked);
    const scoreWithout = getQueryHeuristicScore(statusEntry, "what is blocked");
    expect(scoreWithTracked).toBeGreaterThan(scoreWithout);
  });
});

// --- injectCanonicalQueryEntries ---

describe("injectCanonicalQueryEntries", () => {
  it("does not inject entries for narrow query (namespace filter)", () => {
    const entry = makeSimpleEntry("projects/test", "status", "active");
    const results = injectCanonicalQueryEntries(db, [entry], { query: "orient me", namespace: "projects/test" });
    // Suppression doesn't apply with namespace set, so no injection
    expect(results.length).toBe(1);
  });

  it("does not inject for non-orientation query", () => {
    const entry = makeSimpleEntry("projects/test", "status", "active");
    const results = injectCanonicalQueryEntries(db, [entry], { query: "SQLite performance" });
    expect(results.length).toBe(1);
  });

  it("injects canonical entries for broad orientation query when they exist", () => {
    // Write some canonical entries
    writeState(db, "meta", "reference-index", "All references here", ["active"]);
    writeState(db, "people/magnus", "profile", "Magnus profile", ["profile"]);

    const results = injectCanonicalQueryEntries(db, [], { query: "orient me on everything" });
    const namespaces = results.map((r) => r.namespace);
    expect(namespaces).toContain("meta");
    expect(namespaces).toContain("people/magnus");
  });

  it("does not duplicate entries already in results", () => {
    writeState(db, "meta", "reference-index", "All references here", ["active"]);
    const existing = db.prepare("SELECT * FROM entries WHERE namespace='meta' AND key='reference-index'").get() as Entry;

    const results = injectCanonicalQueryEntries(db, [existing], { query: "orient me" });
    const count = results.filter((r) => r.namespace === "meta" && r.key === "reference-index").length;
    expect(count).toBe(1);
  });

  it("returns unchanged results when no canonical entries exist", () => {
    const entry = makeSimpleEntry("projects/test", "status", "active");
    const results = injectCanonicalQueryEntries(db, [entry], { query: "orient me on everything" });
    // No canonical entries exist, so no injection beyond the input
    expect(results.length).toBe(1);
  });
});

// --- injectAttentionQueryEntries ---

describe("injectAttentionQueryEntries", () => {
  it("does not inject for non-triage query", () => {
    const entry = makeSimpleEntry("projects/test", "status", "active");
    const assessments = new Map();
    const results = injectAttentionQueryEntries([entry], { query: "show me the SQLite architecture" }, assessments);
    expect(results.length).toBe(1);
  });

  it("does not inject for triage query with namespace filter", () => {
    const entry = makeSimpleEntry("projects/test", "status", "active");
    const assessments = new Map();
    const results = injectAttentionQueryEntries(
      [entry],
      { query: "what is blocked", namespace: "projects/test" },
      assessments,
    );
    expect(results.length).toBe(1);
  });

  it("injects blocked entries for triage query", () => {
    const blockedEntry = makeSimpleEntry("projects/blocked", "status", "blocked");
    const assessment = {
      row: {} as TrackedStatusRow,
      entry: blockedEntry,
      lifecycle: "blocked",
      needsAttention: true,
      attentionReason: "blocked" as const,
      maintenanceItems: [],
    };
    const assessments = new Map([["blocked-id", assessment]]);
    const results = injectAttentionQueryEntries([], { query: "what is blocked" }, assessments);
    expect(results).toContain(blockedEntry);
  });

  it("does not duplicate already-present entries", () => {
    const blockedEntry = makeSimpleEntry("projects/blocked", "status", "blocked");
    const assessment = {
      row: {} as TrackedStatusRow,
      entry: blockedEntry,
      lifecycle: "blocked",
      needsAttention: true,
      attentionReason: "blocked" as const,
      maintenanceItems: [],
    };
    const assessments = new Map([["blocked-id", assessment]]);
    const results = injectAttentionQueryEntries([blockedEntry], { query: "what is blocked" }, assessments);
    expect(results.filter((r) => r === blockedEntry).length).toBe(1);
  });
});

// --- resolveSearchRecencyWeight ---

describe("resolveSearchRecencyWeight", () => {
  it("returns default value when undefined", () => {
    const result = resolveSearchRecencyWeight({ query: "test" });
    expect(result).toEqual({ ok: true, value: 0.2 });
  });

  it("returns the explicit value when valid", () => {
    const result = resolveSearchRecencyWeight({ query: "test", search_recency_weight: 0.5 });
    expect(result).toEqual({ ok: true, value: 0.5 });
  });

  it("accepts 0 as a valid weight", () => {
    const result = resolveSearchRecencyWeight({ query: "test", search_recency_weight: 0 });
    expect(result).toEqual({ ok: true, value: 0 });
  });

  it("accepts 1 as a valid weight", () => {
    const result = resolveSearchRecencyWeight({ query: "test", search_recency_weight: 1 });
    expect(result).toEqual({ ok: true, value: 1 });
  });

  it("rejects non-finite values", () => {
    const result = resolveSearchRecencyWeight({ query: "test", search_recency_weight: Infinity });
    expect(result.ok).toBe(false);
  });

  it("rejects values outside [0, 1]", () => {
    const tooLow = resolveSearchRecencyWeight({ query: "test", search_recency_weight: -0.1 });
    const tooHigh = resolveSearchRecencyWeight({ query: "test", search_recency_weight: 1.1 });
    expect(tooLow.ok).toBe(false);
    expect(tooHigh.ok).toBe(false);
  });

  it("rejects non-number values", () => {
    const result = resolveSearchRecencyWeight({ query: "test", search_recency_weight: "0.5" as unknown as number });
    expect(result.ok).toBe(false);
  });
});

// --- rerankQueryResults — suppression and demo filtering ---

describe("rerankQueryResults — suppression heuristics", () => {
  it("suppresses demo namespace entries for broad queries", () => {
    const demoEntry = makeSimpleEntry("demo", "status", "demo content");
    const realEntry = makeSimpleEntry("projects/real", "status", "real project");
    const results = rerankQueryResults(
      [demoEntry, realEntry],
      { query: "project status" },
      new Set(),
    );
    expect(results.some((e) => e.namespace === "demo")).toBe(false);
    expect(results.some((e) => e.namespace === "projects/real")).toBe(true);
  });

  it("suppresses completed task namespace entries for broad queries", () => {
    const taskEntry = makeSimpleEntry("tasks/20260327-done", "status", "completed task");
    const realEntry = makeSimpleEntry("projects/real", "status", "real project");
    const completedTasks = new Set(["tasks/20260327-done"]);
    const results = rerankQueryResults(
      [taskEntry, realEntry],
      { query: "what am I working on" },
      completedTasks,
    );
    expect(results.some((e) => e.namespace === "tasks/20260327-done")).toBe(false);
  });

  it("does not suppress demo entries for namespace-scoped queries", () => {
    const demoEntry = makeSimpleEntry("demo", "status", "demo content");
    const results = rerankQueryResults(
      [demoEntry],
      { query: "status", namespace: "demo" },
      new Set(),
    );
    expect(results.some((e) => e.namespace === "demo")).toBe(true);
  });

  it("sorts by heuristic score descending", () => {
    const statusEntry = makeSimpleEntry("projects/test", "status", "tracked status");
    const logEntry = makeSimpleEntry("projects/test", null, "a log entry");
    logEntry.entry_type = "log";
    const results = rerankQueryResults([logEntry, statusEntry], { query: "project status" }, new Set());
    // Status entries get higher heuristic scores than logs
    expect(results[0].key).toBe("status");
  });

  it("zeroed recency weight falls back to input order for ties", () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    const entryA = makeSimpleEntry("decisions/a", "v1", "content A");
    const entryB = makeSimpleEntry("decisions/b", "v1", "content B");
    entryA.updated_at = ts;
    entryB.updated_at = ts;
    const results = rerankQueryResults(
      [entryA, entryB],
      { query: "decision", search_recency_weight: 0 },
      new Set(),
    );
    // Input order preserved when recency weight is 0
    expect(results[0]).toBe(entryA);
  });
});

// --- getQueryExplainReasons — additional branches ---

describe("getQueryExplainReasons — additional branches", () => {
  function entry(): Entry {
    writeState(db, "projects/explain2", "status", "explainable content with keyword active", ["active"]);
    const id = (db.prepare("SELECT id FROM entries WHERE namespace='projects/explain2'").get() as { id: string }).id;
    return getById(db, id)!;
  }

  it("includes 'recently updated' when freshness_score >= 0.5", () => {
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.5,
      freshness_score: 0.8,
      lexical_rank: 1,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(entry(), "status content", undefined, match);
    expect(reasons).toContain("recently updated");
  });

  it("includes 'tracked status' for tracked namespace status entries", () => {
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.5,
      freshness_score: 0.9,
      lexical_rank: 1,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(entry(), "active project", undefined, match);
    expect(reasons).toContain("tracked status");
  });

  it("includes 'blocked item' when trackedStatus.lifecycle is blocked", () => {
    const e = entry();
    const blockedStatus = {
      row: {} as TrackedStatusRow,
      entry: e,
      lifecycle: "blocked",
      needsAttention: true,
      attentionReason: "blocked" as const,
      maintenanceItems: [],
    };
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.5,
      freshness_score: 0.9,
      lexical_rank: 1,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(e, "blocked project", blockedStatus, match);
    expect(reasons).toContain("blocked item");
  });

  it("includes 'needs attention' when trackedStatus needsAttention and not blocked", () => {
    const e = entry();
    const staleStatus = {
      row: {} as TrackedStatusRow,
      entry: e,
      lifecycle: "active",
      needsAttention: true,
      attentionReason: "active_but_stale" as const,
      maintenanceItems: [],
    };
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.5,
      freshness_score: 0.9,
      lexical_rank: 1,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(e, "stale project", staleStatus, match);
    expect(reasons).toContain("needs attention");
  });

  it("includes profile/conventions/reference-index specific reasons", () => {
    writeState(db, "people/magnus", "profile", "Magnus profile content", ["profile"]);
    const profileId = (db.prepare("SELECT id FROM entries WHERE namespace='people/magnus' AND key='profile'").get() as { id: string }).id;
    const profileEntry = getById(db, profileId)!;
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: 0.5,
      freshness_score: 0.9,
      lexical_rank: 1,
      reasons: [],
    };
    const reasons = getQueryExplainReasons(profileEntry, "profile preference", undefined, match);
    expect(reasons).toContain("profile entry");
  });
});

// --- getTrackedStatusAssessments ---

describe("getTrackedStatusAssessments", () => {
  it("returns empty map when no tracked namespaces exist", () => {
    const assessments = getTrackedStatusAssessments(db);
    expect(assessments.size).toBe(0);
  });

  it("returns assessments keyed by entry id", () => {
    writeState(db, "projects/assess-test", "status", "active project", ["active"]);
    const assessments = getTrackedStatusAssessments(db);
    expect(assessments.size).toBe(1);
    const [id, assessment] = [...assessments.entries()][0];
    expect(typeof id).toBe("string");
    expect(assessment.lifecycle).toBe("active");
  });
});

// --- helper ---

function makeSimpleEntry(namespace: string, key: string | null, content: string): Entry {
  writeState(db, namespace, key ?? "status", content, []);
  const row = db
    .prepare("SELECT * FROM entries WHERE namespace=? AND key=?")
    .get(namespace, key ?? "status") as Entry;
  if (key === null) {
    // For log-like testing, use appendLog result
  }
  return row;
}
