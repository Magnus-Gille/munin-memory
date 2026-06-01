/**
 * Derive benchmark queries from real retrieval usage (Phase 3, issue #70).
 *
 * Mines the passive analytics tables that Feature 4 Phase 1 accumulates —
 * `retrieval_events`, `retrieval_outcomes`, `retrieval_feedback` — and turns
 * observed behaviour into ground-truth benchmark queries:
 *
 *   - A query whose result was *opened* (`opened_result`) → the opened entry
 *     is relevant → `expected_ids`. This is the strongest implicit signal.
 *   - A query after which Claude *acted in a result namespace*
 *     (`write_in_result_namespace`, `log_in_result_namespace`,
 *     `opened_namespace_context`) → that namespace is relevant →
 *     `expected_namespaces`.
 *   - Explicit `good_results` feedback confirms the shown results.
 *   - Corrective feedback (`missing_result`, `bad_results`, `wrong_order`)
 *     with an `expected_entry_id` → that entry is ground truth; the shown
 *     results that weren't it become `negatives`.
 *   - A `query_reformulated` outcome means the query as-asked was abandoned →
 *     its shown results become `negatives` for that query string. A query with
 *     *only* this negative signal and no positive ground truth is dropped (it
 *     has nothing to assert).
 *
 * Output is a JSONL file of `DerivedCandidate` lines (`source: "derived"`) that
 * `scripts/curate-benchmark-query.ts` reviews before they enter a real query
 * set. Because the queries and entry IDs come from a private memory DB, the
 * output lives under `benchmark/queries/` which is gitignored except for
 * `example.jsonl`.
 *
 * CLI:
 *   tsx scripts/derive-benchmark-queries.ts                       # default DB + out
 *   tsx scripts/derive-benchmark-queries.ts --db ./memory.db
 *   tsx scripts/derive-benchmark-queries.ts --out benchmark/queries/derived.candidates.jsonl
 *   tsx scripts/derive-benchmark-queries.ts --min-support 2 --since 2026-01-01
 */

import Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { initDatabase } from "../src/db.js";
import type { BenchmarkQuery } from "../benchmark/types.js";
import type { SearchMode } from "../src/types.js";

/** Counts of the raw signals that contributed to a candidate, for transparency. */
export interface SignalCounts {
  opened_result: number;
  namespace_action: number;
  good_feedback: number;
  corrective_feedback: number;
  reformulated: number;
}

/** A derived benchmark query plus provenance for the curation step. */
export interface DerivedCandidate extends BenchmarkQuery {
  source: "derived";
  /** Number of distinct events contributing a positive ground-truth signal. */
  support: number;
  signals: SignalCounts;
}

export interface DeriveOptions {
  /** Minimum positive-signal support a candidate needs to be emitted. Default 1. */
  minSupport?: number;
  /** Cap on negatives per candidate. Default 5. */
  maxNegatives?: number;
  /** Only mine events/feedback at or after this ISO timestamp. */
  since?: string | null;
}

export interface DeriveStats {
  events: number;
  outcomes: number;
  feedback: number;
  candidates: number;
  /** Queries seen with negative signal only (reformulation/corrective) and no usable ground truth. */
  droppedNoGroundTruth: number;
  /** Candidates filtered out by minSupport. */
  droppedLowSupport: number;
}

export interface DeriveResult {
  candidates: DerivedCandidate[];
  stats: DeriveStats;
}

const POSITIVE_NAMESPACE_OUTCOMES = new Set([
  "opened_namespace_context",
  "write_in_result_namespace",
  "log_in_result_namespace",
]);

/** Lowercase + collapse internal whitespace so equivalent queries group. */
export function normalizeQueryText(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Map a namespace to a benchmark category by its top-level prefix. */
export function inferCategory(namespace: string | undefined): BenchmarkQuery["category"] {
  if (!namespace) return "broad-orientation";
  const top = namespace.split("/")[0];
  switch (top) {
    case "projects":
    case "clients":
      return "project-status";
    case "decisions":
      return "decision-lookup";
    case "people":
      return "person-context";
    case "signals":
    case "digests":
      return "temporal";
    default:
      return "broad-orientation";
  }
}

interface EventRow {
  id: string;
  query_text: string | null;
  actual_mode: string | null;
  result_ids: string;
  result_namespaces: string;
}
interface OutcomeRow {
  retrieval_event_id: string;
  outcome_type: string;
  entry_id: string | null;
  namespace: string | null;
}
interface FeedbackRow {
  retrieval_event_id: string | null;
  feedback_type: string;
  query_text: string | null;
  expected_entry_id: string | null;
  expected_namespace: string | null;
  expected_key: string | null;
}

/** Internal accumulator keyed by normalized query text. */
interface Accumulator {
  query: string;
  expectedIds: Set<string>;
  expectedNamespaces: Set<string>;
  negatives: Set<string>;
  modes: Map<string, number>;
  /** Namespace observed for an expected entry, used for category inference. */
  categoryNamespace?: string;
  signals: SignalCounts;
  /** Distinct event ids that contributed a positive ground-truth signal. */
  positiveEvents: Set<string>;
}

function parseJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function getAcc(map: Map<string, Accumulator>, rawQuery: string): Accumulator {
  const key = normalizeQueryText(rawQuery);
  let acc = map.get(key);
  if (!acc) {
    acc = {
      query: rawQuery.trim(),
      expectedIds: new Set(),
      expectedNamespaces: new Set(),
      negatives: new Set(),
      modes: new Map(),
      signals: { opened_result: 0, namespace_action: 0, good_feedback: 0, corrective_feedback: 0, reformulated: 0 },
      positiveEvents: new Set(),
    };
    map.set(key, acc);
  }
  return acc;
}

/**
 * Pure derivation: read the analytics tables from an open DB and return
 * reviewable candidates. Exported for tests and the curation tool.
 */
export function deriveQueries(db: Database.Database, opts: DeriveOptions = {}): DeriveResult {
  const minSupport = opts.minSupport ?? 1;
  const maxNegatives = opts.maxNegatives ?? 5;
  const since = opts.since ?? null;

  const eventRows = db
    .prepare(
      `SELECT id, query_text, actual_mode, result_ids, result_namespaces
       FROM retrieval_events
       WHERE tool_name = 'memory_query' AND query_text IS NOT NULL AND TRIM(query_text) != ''
         ${since ? "AND timestamp >= ?" : ""}`,
    )
    .all(...(since ? [since] : [])) as EventRow[];

  const outcomeRows = db
    .prepare(`SELECT retrieval_event_id, outcome_type, entry_id, namespace FROM retrieval_outcomes`)
    .all() as OutcomeRow[];

  const feedbackRows = db
    .prepare(
      `SELECT retrieval_event_id, feedback_type, query_text, expected_entry_id, expected_namespace, expected_key
       FROM retrieval_feedback
       ${since ? "WHERE created_at >= ?" : ""}`,
    )
    .all(...(since ? [since] : [])) as FeedbackRow[];

  const eventById = new Map<string, EventRow>();
  for (const e of eventRows) eventById.set(e.id, e);

  const outcomesByEvent = new Map<string, OutcomeRow[]>();
  for (const o of outcomeRows) {
    if (!eventById.has(o.retrieval_event_id)) continue;
    const list = outcomesByEvent.get(o.retrieval_event_id) ?? [];
    list.push(o);
    outcomesByEvent.set(o.retrieval_event_id, list);
  }

  const acc = new Map<string, Accumulator>();

  // Pass 1: outcomes on each event.
  for (const e of eventRows) {
    if (!e.query_text) continue;
    const a = getAcc(acc, e.query_text);
    if (e.actual_mode) a.modes.set(e.actual_mode, (a.modes.get(e.actual_mode) ?? 0) + 1);
    const resultIds = parseJsonArray(e.result_ids);
    let positiveHere = false;
    for (const o of outcomesByEvent.get(e.id) ?? []) {
      if (o.outcome_type === "opened_result" && o.entry_id) {
        a.expectedIds.add(o.entry_id);
        a.signals.opened_result += 1;
        if (o.namespace && !a.categoryNamespace) a.categoryNamespace = o.namespace;
        positiveHere = true;
      } else if (POSITIVE_NAMESPACE_OUTCOMES.has(o.outcome_type) && o.namespace) {
        a.expectedNamespaces.add(o.namespace);
        a.signals.namespace_action += 1;
        if (!a.categoryNamespace) a.categoryNamespace = o.namespace;
        positiveHere = true;
      } else if (o.outcome_type === "query_reformulated") {
        a.signals.reformulated += 1;
        for (const id of resultIds) a.negatives.add(id);
      }
      // no_followup_timeout: carries no signal — ignored.
    }
    if (positiveHere) a.positiveEvents.add(e.id);
  }

  // Pass 2: feedback. Join to an event by id, else fall back to query_text.
  for (const f of feedbackRows) {
    const event = f.retrieval_event_id ? eventById.get(f.retrieval_event_id) : undefined;
    const queryText = event?.query_text ?? f.query_text;
    if (!queryText) continue;
    const a = getAcc(acc, queryText);
    const resultIds = event ? parseJsonArray(event.result_ids) : [];
    const feedbackEventKey = f.retrieval_event_id ?? `fb:${normalizeQueryText(queryText)}`;

    if (f.feedback_type === "good_results") {
      a.signals.good_feedback += 1;
      if (f.expected_entry_id) a.expectedIds.add(f.expected_entry_id);
      else if (resultIds.length > 0) a.expectedIds.add(resultIds[0]);
      if (f.expected_namespace) {
        a.expectedNamespaces.add(f.expected_namespace);
        if (!a.categoryNamespace) a.categoryNamespace = f.expected_namespace;
      }
      a.positiveEvents.add(feedbackEventKey);
    } else if (
      f.feedback_type === "missing_result" ||
      f.feedback_type === "bad_results" ||
      f.feedback_type === "wrong_order"
    ) {
      a.signals.corrective_feedback += 1;
      let positive = false;
      if (f.expected_entry_id) {
        a.expectedIds.add(f.expected_entry_id);
        positive = true;
      }
      if (f.expected_namespace) {
        a.expectedNamespaces.add(f.expected_namespace);
        if (!a.categoryNamespace) a.categoryNamespace = f.expected_namespace;
        positive = true;
      }
      // Shown results that aren't the expected entry are negative examples.
      for (const id of resultIds) {
        if (id !== f.expected_entry_id) a.negatives.add(id);
      }
      if (positive) a.positiveEvents.add(feedbackEventKey);
    }
    // stale_results: signals decay, not relevance — no ground truth to add.
  }

  // Build candidates.
  const stats: DeriveStats = {
    events: eventRows.length,
    outcomes: outcomeRows.length,
    feedback: feedbackRows.length,
    candidates: 0,
    droppedNoGroundTruth: 0,
    droppedLowSupport: 0,
  };

  const candidates: DerivedCandidate[] = [];
  for (const a of acc.values()) {
    const hasGroundTruth = a.expectedIds.size > 0 || a.expectedNamespaces.size > 0;
    if (!hasGroundTruth) {
      stats.droppedNoGroundTruth += 1;
      continue;
    }
    const support = a.positiveEvents.size;
    if (support < minSupport) {
      stats.droppedLowSupport += 1;
      continue;
    }

    // Negatives must not overlap ground-truth ids; cap for readability.
    const negatives = [...a.negatives].filter((id) => !a.expectedIds.has(id)).slice(0, maxNegatives);

    const categoryNs = a.categoryNamespace ?? [...a.expectedNamespaces][0];
    const searchMode = pickMode(a.modes);

    const candidate: DerivedCandidate = {
      id: "derived-" + sha10(normalizeQueryText(a.query)),
      query: a.query,
      source: "derived",
      category: inferCategory(categoryNs),
      search_mode: searchMode,
      support,
      signals: a.signals,
      notes: describeSignals(a.signals, support),
    };
    if (a.expectedIds.size > 0) candidate.expected_ids = [...a.expectedIds];
    if (a.expectedNamespaces.size > 0) candidate.expected_namespaces = [...a.expectedNamespaces];
    if (negatives.length > 0) candidate.negatives = negatives;

    candidates.push(candidate);
  }

  // Deterministic ordering: strongest signal first, then by id for stability.
  candidates.sort((x, y) => y.support - x.support || x.id.localeCompare(y.id));
  stats.candidates = candidates.length;

  return { candidates, stats };
}

function pickMode(modes: Map<string, number>): SearchMode | "all" {
  let best: string | null = null;
  let bestN = -1;
  for (const [m, n] of modes) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  if (best === "lexical" || best === "semantic" || best === "hybrid") return best;
  return "hybrid";
}

function describeSignals(s: SignalCounts, support: number): string {
  const parts: string[] = [];
  if (s.opened_result) parts.push(`${s.opened_result} opened_result`);
  if (s.namespace_action) parts.push(`${s.namespace_action} namespace-action`);
  if (s.good_feedback) parts.push(`${s.good_feedback} good-feedback`);
  if (s.corrective_feedback) parts.push(`${s.corrective_feedback} corrective-feedback`);
  if (s.reformulated) parts.push(`${s.reformulated} reformulation`);
  return `derived (support ${support}): ${parts.join(", ") || "no signals"}`;
}

function sha10(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultDbPath(): string {
  return process.env.MUNIN_MEMORY_DB_PATH ?? join(homedir(), ".munin-memory", "memory.db");
}

function parseArgs(argv: string[]): {
  dbPath: string;
  outPath: string;
  minSupport: number;
  maxNegatives: number;
  since: string | null;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    dbPath: get("--db") ?? defaultDbPath(),
    outPath: get("--out") ?? join("benchmark", "queries", "derived.candidates.jsonl"),
    minSupport: Number(get("--min-support") ?? 1),
    maxNegatives: Number(get("--max-negatives") ?? 5),
    since: get("--since") ?? null,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = initDatabase(args.dbPath);
  try {
    const { candidates, stats } = deriveQueries(db, {
      minSupport: args.minSupport,
      maxNegatives: args.maxNegatives,
      since: args.since,
    });

    mkdirSync(dirname(args.outPath), { recursive: true });
    const body = candidates.map((c) => JSON.stringify(c)).join("\n");
    writeFileSync(args.outPath, body + (body ? "\n" : ""));

    console.error(
      `Mined ${stats.events} events / ${stats.outcomes} outcomes / ${stats.feedback} feedback rows.`,
    );
    console.error(
      `Emitted ${stats.candidates} candidate(s); dropped ${stats.droppedNoGroundTruth} (no ground truth), ${stats.droppedLowSupport} (low support).`,
    );
    console.error(`Wrote ${args.outPath} — review with: tsx scripts/curate-benchmark-query.ts ${args.outPath}`);
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ?? "";
if (/derive-benchmark-queries\.(ts|js|mjs)$/.test(invokedPath)) {
  main();
}
