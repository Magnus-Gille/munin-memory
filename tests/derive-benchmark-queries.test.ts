import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../src/db.js";
import {
  deriveQueries,
  inferCategory,
  normalizeQueryText,
} from "../scripts/derive-benchmark-queries.js";

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

function insertEvent(row: {
  id: string;
  query: string | null;
  mode?: string;
  resultIds?: string[];
  resultNamespaces?: string[];
}): void {
  db.prepare(
    `INSERT INTO retrieval_events (id, session_id, timestamp, tool_name, query_text, requested_mode, actual_mode, result_ids, result_namespaces, result_ranks)
     VALUES (?, 's1', '2026-05-01T00:00:00Z', 'memory_query', ?, ?, ?, ?, ?, '[]')`,
  ).run(
    row.id,
    row.query,
    row.mode ?? "hybrid",
    row.mode ?? "hybrid",
    JSON.stringify(row.resultIds ?? []),
    JSON.stringify(row.resultNamespaces ?? []),
  );
}

function insertOutcome(row: {
  id: string;
  eventId: string;
  type: string;
  entryId?: string | null;
  namespace?: string | null;
}): void {
  db.prepare(
    `INSERT INTO retrieval_outcomes (id, retrieval_event_id, timestamp, outcome_type, entry_id, namespace)
     VALUES (?, ?, '2026-05-01T00:01:00Z', ?, ?, ?)`,
  ).run(row.id, row.eventId, row.type, row.entryId ?? null, row.namespace ?? null);
}

function insertFeedback(row: {
  id: string;
  eventId?: string | null;
  type: string;
  query?: string | null;
  expectedEntryId?: string | null;
  expectedNamespace?: string | null;
  expectedKey?: string | null;
}): void {
  db.prepare(
    `INSERT INTO retrieval_feedback (id, retrieval_event_id, session_id, feedback_type, query_text, expected_namespace, expected_key, expected_entry_id, created_at)
     VALUES (?, ?, 's1', ?, ?, ?, ?, ?, '2026-05-01T00:02:00Z')`,
  ).run(
    row.id,
    row.eventId ?? null,
    row.type,
    row.query ?? null,
    row.expectedNamespace ?? null,
    row.expectedKey ?? null,
    row.expectedEntryId ?? null,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "munin-derive-"));
  dbPath = join(tmpDir, "memory.db");
  db = initDatabase(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("normalizeQueryText", () => {
  it("lowercases and collapses whitespace so equivalent queries group", () => {
    expect(normalizeQueryText("  Atlas   Phase  Two ")).toBe("atlas phase two");
    expect(normalizeQueryText("Atlas phase two")).toBe(normalizeQueryText("atlas   PHASE two"));
  });
});

describe("inferCategory", () => {
  it("maps namespace prefixes to benchmark categories", () => {
    expect(inferCategory("projects/munin-memory")).toBe("project-status");
    expect(inferCategory("decisions/auth")).toBe("decision-lookup");
    expect(inferCategory("people/alice")).toBe("person-context");
    expect(inferCategory("meta/whatever")).toBe("broad-orientation");
  });
});

describe("deriveQueries — positive outcomes become regression guards", () => {
  it("turns an opened_result into expected_ids ground truth", () => {
    insertEvent({ id: "e1", query: "atlas phase two status", resultIds: ["entry-atlas"] });
    insertOutcome({
      id: "o1",
      eventId: "e1",
      type: "opened_result",
      entryId: "entry-atlas",
      namespace: "projects/atlas",
    });

    const { candidates } = deriveQueries(db);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.query).toBe("atlas phase two status");
    expect(c.source).toBe("derived");
    expect(c.expected_ids).toEqual(["entry-atlas"]);
    expect(c.category).toBe("project-status");
    expect(c.id).toMatch(/^derived-/);
    expect(c.support).toBeGreaterThanOrEqual(1);
  });

  it("turns a namespace action into expected_namespaces", () => {
    insertEvent({ id: "e1", query: "where do auth decisions live", resultNamespaces: ["decisions/auth"] });
    insertOutcome({
      id: "o1",
      eventId: "e1",
      type: "write_in_result_namespace",
      namespace: "decisions/auth",
    });

    const { candidates } = deriveQueries(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].expected_namespaces).toEqual(["decisions/auth"]);
    expect(candidates[0].category).toBe("decision-lookup");
  });

  it("aggregates repeated signals for the same query and raises support", () => {
    insertEvent({ id: "e1", query: "Atlas status", resultIds: ["entry-atlas"] });
    insertEvent({ id: "e2", query: "atlas   status", resultIds: ["entry-atlas"] });
    insertOutcome({ id: "o1", eventId: "e1", type: "opened_result", entryId: "entry-atlas", namespace: "projects/atlas" });
    insertOutcome({ id: "o2", eventId: "e2", type: "opened_result", entryId: "entry-atlas", namespace: "projects/atlas" });

    const { candidates } = deriveQueries(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].support).toBe(2);
    expect(candidates[0].expected_ids).toEqual(["entry-atlas"]);
  });
});

describe("deriveQueries — feedback signals", () => {
  it("uses corrective feedback expected_entry_id as ground truth", () => {
    insertEvent({ id: "e1", query: "oauth pkce decision", resultIds: ["wrong-1", "wrong-2"] });
    insertFeedback({
      id: "f1",
      eventId: "e1",
      type: "missing_result",
      expectedEntryId: "entry-oauth",
    });

    const { candidates } = deriveQueries(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].expected_ids).toContain("entry-oauth");
    // The results that were shown but not the expected one become negatives.
    expect(candidates[0].negatives).toEqual(expect.arrayContaining(["wrong-1", "wrong-2"]));
  });

  it("matches feedback by query_text when retrieval_event_id is null", () => {
    insertFeedback({
      id: "f1",
      eventId: null,
      type: "good_results",
      query: "alice onboarding email",
      expectedEntryId: "entry-alice",
    });

    const { candidates } = deriveQueries(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].expected_ids).toContain("entry-alice");
  });
});

describe("deriveQueries — reformulations and filtering", () => {
  it("drops a query that has only negative signal (reformulated, no ground truth)", () => {
    insertEvent({ id: "e1", query: "vague thing", resultIds: ["x1"] });
    insertOutcome({ id: "o1", eventId: "e1", type: "query_reformulated" });

    const { candidates, stats } = deriveQueries(db);
    expect(candidates).toHaveLength(0);
    expect(stats.droppedNoGroundTruth).toBeGreaterThanOrEqual(1);
  });

  it("attaches reformulation results as negatives when the same query later succeeds", () => {
    insertEvent({ id: "e1", query: "atlas", resultIds: ["bad-atlas"] });
    insertOutcome({ id: "o1", eventId: "e1", type: "query_reformulated" });
    insertEvent({ id: "e2", query: "atlas", resultIds: ["entry-atlas"] });
    insertOutcome({ id: "o2", eventId: "e2", type: "opened_result", entryId: "entry-atlas", namespace: "projects/atlas" });

    const { candidates } = deriveQueries(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].expected_ids).toEqual(["entry-atlas"]);
    expect(candidates[0].negatives).toContain("bad-atlas");
  });

  it("respects minSupport", () => {
    insertEvent({ id: "e1", query: "atlas status", resultIds: ["entry-atlas"] });
    insertOutcome({ id: "o1", eventId: "e1", type: "opened_result", entryId: "entry-atlas", namespace: "projects/atlas" });

    expect(deriveQueries(db, { minSupport: 2 }).candidates).toHaveLength(0);
    expect(deriveQueries(db, { minSupport: 1 }).candidates).toHaveLength(1);
  });

  it("ignores no_followup_timeout (no signal)", () => {
    insertEvent({ id: "e1", query: "nothing useful", resultIds: ["x"] });
    insertOutcome({ id: "o1", eventId: "e1", type: "no_followup_timeout" });

    expect(deriveQueries(db).candidates).toHaveLength(0);
  });
});
