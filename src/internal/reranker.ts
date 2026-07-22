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

/**
 * Rerank query results by heuristic score + freshness, applying the
 * default suppression filter when appropriate.
 *
 * Exported for the benchmark runner's production_ranker mode.
 */
export function rerankQueryResults(
  results: Entry[],
  params: QueryParams,
  completedTasks: Set<string>,
  trackedStatuses?: Map<string, TrackedStatusAssessment>,
): Entry[] {
  const query = params.query ?? "";
  const queryLower = query.toLowerCase();
  const searchRecencyWeight = params.search_recency_weight ?? DEFAULT_SEARCH_RECENCY_WEIGHT;
  const suppressDefaults = shouldApplyDefaultQuerySuppression(params);
  const filtered = results.filter((entry) => {
    if (!suppressDefaults) return true;
    if (entry.namespace === "demo" || entry.namespace.startsWith("demo/")) return false;
    if (completedTasks.has(entry.namespace)) return false;
    return true;
  });

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
    .map((item) => item.entry);
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
