/**
 * Query reranker pipeline — heuristic scoring, canonical/attention entry
 * injection, and the production-ranker that `memory_query` applies.
 *
 * Extracted from src/tools.ts as part of issue #59 (reranker-module refactor).
 */

import type Database from "better-sqlite3";
import {
  readState,
  getTrackedStatuses,
  isEntryExpired,
} from "../db.js";
import {
  parseTags,
  canonicalizeTags,
  getLifecycleTags,
  LIFECYCLE_TAGS,
  isStale,
  getDaysUntil,
  isEntryExpiringSoon,
  findUpcomingEventDate,
  findPassedForwardDate,
  isTrackedNamespace,
  RELAXED_QUERY_STOPWORDS,
} from "./retrieval-shared.js";
import type {
  Entry,
  TrackedStatusRow,
  QueryParams,
  QueryResult,
  MaintenanceItem,
} from "../types.js";
import {
  resolveOwnerAliases,
  resolveOwnerProfileNamespaces,
} from "../owner-config.js";

// --- Constants ---

export const QUERY_RERANK_OVERFETCH_MULTIPLIER = 5;
export const DEFAULT_SEARCH_RECENCY_WEIGHT = 0.2;

export const ORIENTATION_QUERY_PHRASES = [
  "orient me",
  "orientation",
  "catch me up",
  "catch-up",
  "brief me",
  "what should i know",
  "what's owner working on",
  "what is owner working on",
  "what owner is working on",
];
export const ATTENTION_TRIAGE_QUERY_PHRASES = [
  "what needs attention",
  "need attention",
  "needs attention",
  "blocked projects",
  "blocked project",
  "what is blocked",
  "what's blocked",
  "at risk",
  "stale",
  "urgent",
  "what should i look at",
];

// --- Interface ---

/** Exported for the benchmark runner's production_ranker mode. */
export interface TrackedStatusAssessment {
  row: TrackedStatusRow;
  entry: Entry;
  lifecycle: string;
  needsAttention: boolean;
  attentionReason?: "blocked" | MaintenanceItem["issue"];
  maintenanceItems: MaintenanceItem[];
}

// --- Functions ---

export function buildRelaxedLexicalQuery(query: string): string | null {
  if (query.includes("\"")) return null;
  if (/\b(AND|OR|NOT|NEAR)\b|[:()*]/.test(query)) return null;

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !RELAXED_QUERY_STOPWORDS.has(term));

  const uniqueTerms = [...new Set(terms)];
  if (uniqueTerms.length < 2) return null;

  return uniqueTerms.map((term) => `"${term}"`).join(" OR ");
}

/**
 * Whether the default attention/suppression heuristics apply.
 *
 * Exported so the benchmark runner's production_ranker mode can
 * apply the same predicate per-query as `memory_query`. Don't cache the
 * result across queries — the gating depends on each query's params.
 */
export function shouldApplyDefaultQuerySuppression(params: QueryParams): boolean {
  return !params.namespace && !params.entry_type && (!params.tags || params.tags.length === 0);
}

/**
 * Number of best-relevance candidates that structural class and recency may
 * reorder. Retrieval hands over up to 500 candidates, but structural
 * reranking (tracked-status boost, entry type, freshness) is not
 * relevance-aware, so it only operates on the 50 best-relevance candidates, as
 * it did before #306. Everything after the window keeps retrieval order.
 */
export const QUERY_RERANK_WINDOW = 50;

/**
 * Whether the default suppression drops an entry from the results: `demo`
 * namespaces and completed-task namespaces, when default suppression applies.
 * Shared by `rerankQueryResults` and the handler's post-window tail so the
 * rule exists once.
 */
export function isSuppressedByDefaultQueryRules(
  entry: Entry,
  completedTasks: Set<string>,
): boolean {
  if (entry.namespace === "demo" || entry.namespace.startsWith("demo/")) return true;
  return completedTasks.has(entry.namespace);
}

export function isBroadOrientationQuery(query: string, params: QueryParams): boolean {
  if (!shouldApplyDefaultQuerySuppression(params)) return false;

  const normalized = query.toLowerCase();
  if (ORIENTATION_QUERY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }
  if (
    resolveOwnerAliases().some((alias) =>
      [
        `what's ${alias.toLowerCase()} working on`,
        `what is ${alias.toLowerCase()} working on`,
        `what ${alias.toLowerCase()} is working on`,
      ].some((phrase) => normalized.includes(phrase)),
    )
  ) {
    return true;
  }

  const hasOrientationVerb = queryMentionsAny(normalized, ["orient", "orientation", "brief"]);
  const hasSummaryIntent = queryMentionsAny(normalized, [
    "working on",
    "current work",
    "active work",
    "what should i know",
    "context",
    "catch up",
  ]);

  return hasOrientationVerb && hasSummaryIntent;
}

export function isAttentionTriageQuery(query: string, params: QueryParams): boolean {
  if (!shouldApplyDefaultQuerySuppression(params)) return false;

  const normalized = query.toLowerCase();
  if (ATTENTION_TRIAGE_QUERY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const hasBlockedIntent = /\bblocked\b/.test(normalized);
  const hasAttentionIntent = normalized.includes("attention");
  const hasRiskIntent = queryMentionsAny(normalized, ["at risk", "stale", "urgent"]);
  const hasWorkScope = queryMentionsAny(normalized, [
    "project",
    "projects",
    "client",
    "clients",
    "work",
    "right now",
    "current",
  ]);

  return hasBlockedIntent || (hasAttentionIntent && hasWorkScope) || hasRiskIntent;
}

export function looksLikeTombstone(content: string): boolean {
  return /\bTOMBSTONE\b/i.test(content);
}

export function queryMentionsAny(query: string, terms: string[]): boolean {
  return terms.some((term) => query.includes(term));
}

export function trackedStatusRowToEntry(row: TrackedStatusRow): Entry {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    entry_type: "state",
    content: row.content,
    tags: row.tags,
    agent_id: row.agent_id,
    owner_principal_id: row.owner_principal_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    valid_from: row.updated_at,
    valid_until: row.valid_until,
    is_current: 1,
    classification: row.classification,
    embedding_status: "pending",
    embedding_model: null,
  };
}

function resolveLifecycle(
  row: TrackedStatusRow,
  maintenanceItems: MaintenanceItem[],
): string {
  const tags = parseTags(row.tags);
  const { canonical } = canonicalizeTags(tags);
  const lifecycleTags = getLifecycleTags(canonical);

  if (lifecycleTags.length === 0) {
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "missing_lifecycle",
      suggestion: `Status has no lifecycle tag. Add one of: ${[...LIFECYCLE_TAGS].join(", ")}.`,
    });
    return "uncategorized";
  }
  if (lifecycleTags.length > 1) {
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "conflicting_lifecycle",
      suggestion: `Status has tags [${lifecycleTags.join(", ")}]. Use exactly one.`,
    });
  }
  return lifecycleTags[0];
}

function applyValidityAttention(
  row: TrackedStatusRow,
  maintenanceItems: MaintenanceItem[],
): TrackedStatusAssessment["attentionReason"] | undefined {
  if (!row.valid_until) return undefined;

  if (isEntryExpired({ entry_type: "state", valid_until: row.valid_until })) {
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "expired",
      suggestion: `Status expired at ${row.valid_until}. Refresh it or rewrite without valid_until if it should remain current.`,
    });
    return "expired";
  }

  if (isEntryExpiringSoon({ entry_type: "state", valid_until: row.valid_until })) {
    const daysUntil = Math.max(1, Math.ceil(getDaysUntil(row.valid_until)));
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "expiring_soon",
      suggestion: `Status expires in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${row.valid_until}). Refresh it if it should remain current.`,
    });
    return "expiring_soon";
  }

  return undefined;
}

function applyActiveLifecycleAttention(
  row: TrackedStatusRow,
  maintenanceItems: MaintenanceItem[],
): TrackedStatusAssessment["attentionReason"] | undefined {
  if (isStale(row.updated_at)) {
    const daysSince = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / (24 * 60 * 60 * 1000));
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "active_but_stale",
      suggestion: `Last updated ${daysSince} days ago. Update status or change lifecycle to maintenance/archived.`,
    });
    return "active_but_stale";
  }

  const upcomingDate = findUpcomingEventDate(row.content, row.updated_at);
  if (upcomingDate) {
    const daysUntil = Math.ceil((new Date(upcomingDate + "T23:59:59Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    const daysSinceUpdate = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / (24 * 60 * 60 * 1000));
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "upcoming_event_stale",
      suggestion: `Event date ${upcomingDate} is ${daysUntil} day${daysUntil === 1 ? "" : "s"} away but status was last updated ${daysSinceUpdate} days ago. Verify status is current.`,
    });
    return "upcoming_event_stale";
  }

  const passedDate = findPassedForwardDate(row.content);
  if (passedDate) {
    const daysSince = Math.floor((Date.now() - new Date(passedDate + "T23:59:59Z").getTime()) / 86400000);
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "temporal_stale",
      suggestion: `Content references ${passedDate} (${daysSince} day${daysSince === 1 ? "" : "s"} ago) with forward-looking phrasing. Restate what actually happened or remove the forward-looking reference.`,
    });
    return "temporal_stale";
  }

  return undefined;
}

export function assessTrackedStatus(row: TrackedStatusRow): TrackedStatusAssessment {
  const maintenanceItems: MaintenanceItem[] = [];
  const lifecycle = resolveLifecycle(row, maintenanceItems);

  let needsAttention = false;
  let attentionReason: TrackedStatusAssessment["attentionReason"];

  if (lifecycle === "blocked") {
    attentionReason = "blocked";
  }

  const validityReason = applyValidityAttention(row, maintenanceItems);
  if (validityReason) {
    needsAttention = true;
    attentionReason = validityReason;
  } else if (lifecycle === "active") {
    const activeReason = applyActiveLifecycleAttention(row, maintenanceItems);
    if (activeReason) {
      needsAttention = true;
      attentionReason = activeReason;
    }
  }

  return {
    row,
    entry: trackedStatusRowToEntry(row),
    lifecycle,
    needsAttention,
    attentionReason,
    maintenanceItems,
  };
}

/**
 * Build the per-entry tracked-status assessment map.
 *
 * Exported for the benchmark runner's production_ranker mode.
 */
export function getTrackedStatusAssessments(
  db: Database.Database,
  patterns?: readonly string[],
): Map<string, TrackedStatusAssessment> {
  const assessments = getTrackedStatuses(db, patterns).map(assessTrackedStatus);
  return new Map(assessments.map((assessment) => [assessment.entry.id, assessment]));
}

// --- Shared predicates used by both getQueryHeuristicScore and getQueryExplainReasons ---

export function isTrackedStatusEntry(entry: Entry, patterns?: readonly string[]): boolean {
  return isTrackedNamespace(entry.namespace, patterns) && entry.key === "status";
}

export function isPeopleProfileEntry(entry: Entry): boolean {
  return entry.namespace.startsWith("people/") && entry.key === "profile";
}

export function isMetaConventionsEntry(entry: Entry): boolean {
  return entry.namespace === "meta/conventions" && entry.key === "conventions";
}

export function isMetaReferenceIndexEntry(entry: Entry): boolean {
  return entry.namespace === "meta" && entry.key === "reference-index";
}

// --- Score segment helpers ---

function scoreTrackedStatusEntry(queryLower: string, orientationQuery: boolean, triageQuery: boolean): number {
  let s = 20;
  if (queryMentionsAny(queryLower, ["active", "work", "blocker", "blockers", "next", "steps", "project"])) s += 4;
  if (orientationQuery) s += 2;
  if (triageQuery) s += 6;
  return s;
}

function scorePeopleProfileEntry(queryLower: string): number {
  let s = 18;
  if (queryMentionsAny(queryLower, ["personal", "profile", "collaboration", "style", "preference", "preferences", "context"])) s += 10;
  if (queryMentionsAny(queryLower, ["owner", ...resolveOwnerAliases(), "working on", "what should i know"])) s += 12;
  return s;
}

function scoreStatusTagPenalties(tags: string[]): number {
  let s = 0;
  if (tags.includes("archived")) s -= 12;
  if (tags.includes("completed")) s -= 8;
  if (tags.includes("stopped")) s -= 8;
  return s;
}

function scoreMetaConventionsEntry(queryLower: string): number {
  let s = 16;
  if (queryMentionsAny(queryLower, ["convention", "handshake", "cas", "lifecycle", "write protocol"])) s += 8;
  return s;
}

function scoreMetaReferenceIndexEntry(orientationQuery: boolean): number {
  return orientationQuery ? 28 : 10;
}

function scoreLogEntry(triageQuery: boolean): number {
  return triageQuery ? -9 : -3;
}

function scoreTasksNamespace(triageQuery: boolean): number {
  return triageQuery ? -22 : -8;
}

function scoreTriageTrackedStatus(trackedStatus: TrackedStatusAssessment): number {
  if (trackedStatus.lifecycle === "blocked") return 36;
  if (trackedStatus.needsAttention) {
    let s = 28;
    if (trackedStatus.attentionReason === "upcoming_event_stale") s += 4;
    if (trackedStatus.attentionReason === "active_but_stale") s += 2;
    if (trackedStatus.attentionReason === "temporal_stale") s += 3;
    return s;
  }
  if (trackedStatus.lifecycle === "active") return -8;
  return 0;
}

export function getQueryHeuristicScore(
  entry: Entry,
  queryLower: string,
  trackedStatuses?: Map<string, TrackedStatusAssessment>,
): number {
  const tags = parseTags(entry.tags);
  let score = 0;
  const orientationQuery = isBroadOrientationQuery(queryLower, { query: queryLower });
  const triageQuery = isAttentionTriageQuery(queryLower, { query: queryLower });
  const trackedStatus = trackedStatuses?.get(entry.id);

  if (entry.entry_type === "state") score += 6;
  if (isTrackedStatusEntry(entry)) score += scoreTrackedStatusEntry(queryLower, orientationQuery, triageQuery);
  if (isPeopleProfileEntry(entry)) score += scorePeopleProfileEntry(queryLower);
  if (isMetaConventionsEntry(entry)) score += scoreMetaConventionsEntry(queryLower);
  if (isMetaReferenceIndexEntry(entry)) score += scoreMetaReferenceIndexEntry(orientationQuery);
  if (entry.entry_type === "log") score += scoreLogEntry(triageQuery);
  if (looksLikeTombstone(entry.content)) score -= 30;
  if (entry.key === "status") score += scoreStatusTagPenalties(tags);
  if (entry.namespace.startsWith("tasks/")) score += scoreTasksNamespace(triageQuery);
  if (triageQuery && entry.key === "index") score -= 10;
  if (triageQuery && trackedStatus) score += scoreTriageTrackedStatus(trackedStatus);

  return score;
}

/**
 * Inject canonical reference entries (reference-index, owner profile,
 * conventions) when the query looks like a broad orientation request.
 *
 * Exported for the benchmark runner.
 */
export function injectCanonicalQueryEntries(
  db: Database.Database,
  results: Entry[],
  params: QueryParams,
): Entry[] {
  const query = params.query;
  if (!query || !isBroadOrientationQuery(query, params)) return results;

  const ownerProfile = resolveOwnerProfileNamespaces()
    .map((namespace) => readState(db, namespace, "profile"))
    .find((entry): entry is Entry => entry !== null);
  const injected = [
    readState(db, "meta", "reference-index"),
    ownerProfile,
    readState(db, "meta/conventions", "conventions"),
  ].filter((entry): entry is Entry => entry != null);

  if (injected.length === 0) return results;

  const seen = new Set(results.map((entry) => entry.id));
  const merged = [...results];
  for (const entry of injected) {
    if (!params.include_expired && isEntryExpired(entry)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/**
 * Inject blocked/needs-attention tracked statuses when the query looks
 * like a triage request.
 *
 * Exported for the benchmark runner.
 */
export function injectAttentionQueryEntries(
  results: Entry[],
  params: QueryParams,
  trackedStatuses: Map<string, TrackedStatusAssessment>,
): Entry[] {
  const query = params.query;
  if (!query || !isAttentionTriageQuery(query, params)) return results;

  const injected = [...trackedStatuses.values()]
    .filter((assessment) => assessment.lifecycle === "blocked" || assessment.needsAttention)
    .map((assessment) => assessment.entry);

  if (injected.length === 0) return results;

  const seen = new Set(results.map((entry) => entry.id));
  const merged = [...results];
  for (const entry of injected) {
    if (!params.include_expired && isEntryExpired(entry)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/** Heuristic at or below this marks deliberately demoted content (tombstones). */
const DEMOTED_HEURISTIC_CEILING = -10;

/**
 * Relevance-anchored ordering (#335, #248). Outside orientation and triage
 * queries each candidate starts at its incoming relevance index and may move
 * only a bounded number of positions:
 *   structural lift = clamp(heuristic / RANK_STRUCTURAL_DIVISOR,
 *                           -RANK_STRUCTURAL_MAX_DEMOTION, +RANK_STRUCTURAL_MAX_LIFT)
 *   recency lift    = search_recency_weight * RANK_RECENCY_MAX_LIFT * r
 * where r in [0, 1] is the relative `updated_at` rank among the candidates.
 */
/** Heuristic points per position of structural lift. */
export const RANK_STRUCTURAL_DIVISOR = 5;
/** Most positions a structural class can move an entry up. */
export const RANK_STRUCTURAL_MAX_LIFT = 5;
/** Most positions a structural class can move an entry down. */
export const RANK_STRUCTURAL_MAX_DEMOTION = 1;
/** Positions the newest candidate gains at `search_recency_weight` 1. */
export const RANK_RECENCY_MAX_LIFT = 10;
/**
 * Sort keys are rounded to this many units per position before comparison, so
 * floating-point noise cannot reorder candidates and the comparator stays a
 * strict total order.
 */
const RANK_KEY_SCALE = 1e6;

/** Longest query, in searchable terms, still treated as an identifier lookup. */
const ANCHOR_MAX_TERMS = 3;

/** Shortest term considered distinctive enough to anchor on. */
const ANCHOR_MIN_TERM_LENGTH = 4;

/**
 * Terms worth anchoring on: distinctive enough that a caller typing them is
 * naming a specific thing rather than describing a topic.
 */
function anchorTerms(queryLower: string): string[] {
  return (queryLower.match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter(
    (term) => term.length >= ANCHOR_MIN_TERM_LENGTH || /\d/.test(term),
  );
}

function entryContainsAllTerms(entry: Entry, terms: string[]): boolean {
  const haystack = `${entry.namespace} ${entry.key ?? ""} ${entry.content}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Keep an unambiguous identifier hit at the top.
 *
 * The heuristic score is structural — it rewards tracked statuses, freshness
 * and entry type, and never looks at how well an entry matches the query — so
 * on a short, distinctive lookup it could bury the one entry the caller
 * literally named. Observed in user testing: a globally unique token ranked
 * `lexical_rank: 1` with the highest fusion score came back **seventh**, behind
 * six unrelated entries scoring 26 on "tracked status, recently updated"
 * against its -3 (#252).
 *
 * Deliberately narrow, because the structural heuristic is right for the
 * operational queries it was built for. This only fires when all of:
 *   - the caller supplied a query that is not a broad orientation/triage ask;
 *   - it is at most a few distinctive terms — an identifier lookup, not a topic;
 *   - **exactly one** candidate contains every one of those terms verbatim, so
 *     the caller has named a specific thing rather than described a subject;
 *   - that candidate is the best-relevance result and is not deliberately
 *     demoted (a tombstone).
 *
 * The uniqueness requirement is what keeps this from hijacking ordinary
 * queries: when several candidates match the terms there is no single thing
 * being named, so structural score and recency continue to decide — including
 * the recency tie-break parity guarantees from #74.
 *
 * Everything below position one keeps the existing structural order.
 */
function applyExactAnchorFloor(
  ranked: Array<{ entry: Entry; heuristic: number }>,
  bestRelevance: Entry | undefined,
  queryLower: string,
  params: QueryParams,
  anchorPool: readonly Entry[] = [],
): Array<{ entry: Entry; heuristic: number }> {
  if (!bestRelevance || ranked.length < 2) return ranked;
  if (!queryLower.trim()) return ranked;
  if (isBroadOrientationQuery(queryLower, params) || isAttentionTriageQuery(queryLower, params)) {
    return ranked;
  }

  const terms = anchorTerms(queryLower);
  if (terms.length === 0 || terms.length > ANCHOR_MAX_TERMS) return ranked;
  if (!entryContainsAllTerms(bestRelevance, terms)) return ranked;

  // Unique anchor only: if more than one candidate carries every term, the
  // caller described a subject rather than naming one entry, and the existing
  // structural/recency ordering is the right answer. The count also covers
  // `anchorPool` (eligible candidates outside the reranked window), so an
  // identifier that recurs deeper in the candidate set is not mistaken for a
  // unique one.
  let matchCount = 0;
  for (const item of ranked) {
    if (entryContainsAllTerms(item.entry, terms)) {
      matchCount += 1;
      if (matchCount > 1) return ranked;
    }
  }
  for (const entry of anchorPool) {
    if (entryContainsAllTerms(entry, terms)) {
      matchCount += 1;
      if (matchCount > 1) return ranked;
    }
  }

  const currentIndex = ranked.findIndex((item) => item.entry.id === bestRelevance.id);
  if (currentIndex <= 0) return ranked;
  if (ranked[currentIndex]!.heuristic <= DEMOTED_HEURISTIC_CEILING) return ranked;

  const promoted = ranked[currentIndex]!;
  return [promoted, ...ranked.slice(0, currentIndex), ...ranked.slice(currentIndex + 1)];
}

type RankedItem = { entry: Entry; heuristic: number };

/** Orientation/triage ordering: structural heuristic first, relevance last. */
function rankStructuralFirst(
  filtered: Entry[],
  queryLower: string,
  searchRecencyWeight: number,
  trackedStatuses?: Map<string, TrackedStatusAssessment>,
): RankedItem[] {
  return filtered
    .map((entry, index) => ({
      entry,
      index,
      heuristic: getQueryHeuristicScore(entry, queryLower, trackedStatuses),
    }))
    .sort((a, b) => {
      if (b.heuristic !== a.heuristic) return b.heuristic - a.heuristic;
      // Recency tie-break by EXACT updated_at, not the float freshness score.
      // getFreshnessScore clamps age to >= 0, so any entry whose updated_at is
      // at/after the instant the ranker reads the clock collapses to freshness
      // 1.0. Two entries written ~1ms apart therefore compare *equal* when
      // ranked immediately (both clamped) but *distinct* when ranked a few ms
      // later — so the order depended on WHEN the ranker ran. memory_query and
      // the benchmark runner run milliseconds apart, so they disagreed on
      // score-tied recent entries under load (the #74 parity flake). The
      // stored updated_at is fixed data and order-equivalent to freshness for
      // already-aged entries, so rankings over real corpora are unchanged.
      if (searchRecencyWeight > 0 && a.entry.updated_at !== b.entry.updated_at) {
        return a.entry.updated_at < b.entry.updated_at ? 1 : -1; // newer first
      }
      return a.index - b.index;
    })
    .map((item) => ({ entry: item.entry, heuristic: item.heuristic }));
}

/**
 * Relevance-anchored ordering with bounded structural and recency lifts.
 * Recency uses only the stored `updated_at` strings (never the clock), so the
 * order is the same whenever it runs (#74).
 */
function rankRelevanceAnchored(
  filtered: Entry[],
  queryLower: string,
  searchRecencyWeight: number,
  trackedStatuses?: Map<string, TrackedStatusAssessment>,
): RankedItem[] {
  const distinct = [...new Set(filtered.map((entry) => entry.updated_at))].sort();
  const recencyRank = new Map<string, number>();
  distinct.forEach((timestamp, position) => {
    recencyRank.set(timestamp, distinct.length > 1 ? position / (distinct.length - 1) : 0);
  });

  return filtered
    .map((entry, index) => {
      const heuristic = getQueryHeuristicScore(entry, queryLower, trackedStatuses);
      const demoted = heuristic <= DEMOTED_HEURISTIC_CEILING;
      const structuralLift = demoted
        ? 0
        : Math.max(
            -RANK_STRUCTURAL_MAX_DEMOTION,
            Math.min(RANK_STRUCTURAL_MAX_LIFT, heuristic / RANK_STRUCTURAL_DIVISOR),
          );
      const recencyLift = searchRecencyWeight * RANK_RECENCY_MAX_LIFT * (recencyRank.get(entry.updated_at) ?? 0);
      const key = Math.round((index - structuralLift - recencyLift) * RANK_KEY_SCALE);
      return { entry, index, heuristic, demoted, key };
    })
    .sort((a, b) => {
      if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
      if (!a.demoted && a.key !== b.key) return a.key - b.key;
      return a.index - b.index;
    })
    .map((item) => ({ entry: item.entry, heuristic: item.heuristic }));
}

/**
 * Rerank query results by heuristic score + freshness, applying the
 * default suppression filter when appropriate.
 *
 * `options.anchorPool` lists additional eligible candidates that are not
 * reranked (already access- and suppression-filtered by the caller); they only
 * count toward the exact-anchor uniqueness check.
 *
 * Exported for the benchmark runner's production_ranker mode.
 */
export function rerankQueryResults(
  results: Entry[],
  params: QueryParams,
  completedTasks: Set<string>,
  trackedStatuses?: Map<string, TrackedStatusAssessment>,
  options?: { anchorPool?: readonly Entry[] },
): Entry[] {
  const query = params.query ?? "";
  const queryLower = query.toLowerCase();
  const searchRecencyWeight = normalizeSearchRecencyWeight(params.search_recency_weight);
  const suppressDefaults = shouldApplyDefaultQuerySuppression(params);
  const filtered = results.filter((entry) => {
    return !suppressDefaults || !isSuppressedByDefaultQueryRules(entry, completedTasks);
  });

  const structuralFirst = isBroadOrientationQuery(queryLower, params) || isAttentionTriageQuery(queryLower, params);
  const scored = structuralFirst
    ? rankStructuralFirst(filtered, queryLower, searchRecencyWeight, trackedStatuses)
    : rankRelevanceAnchored(filtered, queryLower, searchRecencyWeight, trackedStatuses);

  // `filtered[0]` is the best-relevance candidate: the retrieval layer hands
  // results over in fusion/lexical rank order, and the ranking above
  // keeps that order as its anchor (structural-first queries: final tie-break).
  return applyExactAnchorFloor(scored, filtered[0], queryLower, params, options?.anchorPool).map((item) => item.entry);
}

/**
 * Reranker-boundary guard for callers that bypass the MCP handler's validation
 * (for example the benchmark runner). A missing or non-finite weight falls back
 * to the default; a finite weight is clamped to [0, 1]. Unlike
 * `resolveSearchRecencyWeight` it never reports an error, so NaN or Infinity
 * cannot reach the sort keys and break the comparator's total order.
 */
export function normalizeSearchRecencyWeight(weight: number | undefined): number {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return DEFAULT_SEARCH_RECENCY_WEIGHT;
  return Math.min(1, Math.max(0, weight));
}

export function resolveSearchRecencyWeight(params: QueryParams): { ok: true; value: number } | { ok: false; error: string } {
  if (params.search_recency_weight === undefined) {
    return { ok: true, value: DEFAULT_SEARCH_RECENCY_WEIGHT };
  }
  if (typeof params.search_recency_weight !== "number" || !Number.isFinite(params.search_recency_weight)) {
    return { ok: false, error: '"search_recency_weight" must be a number between 0 and 1.' };
  }
  if (params.search_recency_weight < 0 || params.search_recency_weight > 1) {
    return { ok: false, error: '"search_recency_weight" must be between 0 and 1.' };
  }
  return { ok: true, value: params.search_recency_weight };
}

function findMatchedQueryTerm(entry: Entry, queryLower: string): string | undefined {
  const queryTerms = queryLower
    .split(/[^a-z0-9_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !RELAXED_QUERY_STOPWORDS.has(term));
  const contentLower = entry.content.toLowerCase();
  const namespaceLower = entry.namespace.toLowerCase();
  const keyLower = entry.key?.toLowerCase() ?? "";
  return queryTerms.find(
    (term) => contentLower.includes(term) || namespaceLower.includes(term) || keyLower.includes(term),
  );
}

function explainMatchSignals(match: NonNullable<QueryResult["match"]>): string[] {
  const out: string[] = [];
  if (match.lexical_rank !== undefined) out.push("matched lexical terms");
  if (match.semantic_rank !== undefined) out.push("matched semantic similarity");
  if (match.hybrid_score !== undefined && match.lexical_rank !== undefined && match.semantic_rank !== undefined) {
    out.push("combined lexical and semantic signals");
  }
  return out;
}

function explainEntryClassification(
  entry: Entry,
  trackedStatus: TrackedStatusAssessment | undefined,
  match: NonNullable<QueryResult["match"]>,
): string[] {
  const out: string[] = [];
  if (isTrackedStatusEntry(entry)) out.push("tracked status");
  if (trackedStatus?.lifecycle === "blocked") out.push("blocked item");
  else if (trackedStatus?.needsAttention) out.push("needs attention");
  if (isPeopleProfileEntry(entry)) out.push("profile entry");
  if (isMetaConventionsEntry(entry)) out.push("conventions reference");
  if (isMetaReferenceIndexEntry(entry)) out.push("reference index");
  if (match.freshness_score !== undefined && match.freshness_score >= 0.5) out.push("recently updated");
  if (isEntryExpired(entry)) out.push("expired entry included on request");
  return out;
}

export function getQueryExplainReasons(
  entry: Entry,
  queryLower: string,
  trackedStatus: TrackedStatusAssessment | undefined,
  match: NonNullable<QueryResult["match"]>,
): string[] {
  const reasons = [
    ...explainMatchSignals(match),
    ...explainEntryClassification(entry, trackedStatus, match),
  ];

  const matchedTerm = findMatchedQueryTerm(entry, queryLower);
  if (matchedTerm) reasons.push(`matched term: ${matchedTerm}`);

  return [...new Set(reasons)];
}
