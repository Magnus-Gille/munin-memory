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
  getFreshnessScore,
  getDaysUntil,
  isEntryExpiringSoon,
  findUpcomingEventDate,
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
  "what's magnus working on",
  "what is magnus working on",
  "what magnus is working on",
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
    valid_until: row.valid_until,
    classification: row.classification,
    embedding_status: "pending",
    embedding_model: null,
  };
}

export function assessTrackedStatus(row: TrackedStatusRow): TrackedStatusAssessment {
  const maintenanceItems: MaintenanceItem[] = [];
  const tags = parseTags(row.tags);
  const { canonical } = canonicalizeTags(tags);
  const lifecycleTags = getLifecycleTags(canonical);

  let lifecycle: string;
  if (lifecycleTags.length === 0) {
    lifecycle = "uncategorized";
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "missing_lifecycle",
      suggestion: `Status has no lifecycle tag. Add one of: ${[...LIFECYCLE_TAGS].join(", ")}.`,
    });
  } else if (lifecycleTags.length > 1) {
    lifecycle = lifecycleTags[0];
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "conflicting_lifecycle",
      suggestion: `Status has tags [${lifecycleTags.join(", ")}]. Use exactly one.`,
    });
  } else {
    lifecycle = lifecycleTags[0];
  }

  let needsAttention = false;
  let attentionReason: TrackedStatusAssessment["attentionReason"];

  if (lifecycle === "blocked") {
    attentionReason = "blocked";
  }

  if (row.valid_until && isEntryExpired({ entry_type: "state", valid_until: row.valid_until })) {
    needsAttention = true;
    attentionReason = "expired";
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "expired",
      suggestion: `Status expired at ${row.valid_until}. Refresh it or rewrite without valid_until if it should remain current.`,
    });
  } else if (row.valid_until && isEntryExpiringSoon({ entry_type: "state", valid_until: row.valid_until })) {
    needsAttention = true;
    attentionReason = "expiring_soon";
    const daysUntil = Math.max(1, Math.ceil(getDaysUntil(row.valid_until)));
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "expiring_soon",
      suggestion: `Status expires in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${row.valid_until}). Refresh it if it should remain current.`,
    });
  }

  if (lifecycle === "active" && !needsAttention && isStale(row.updated_at)) {
    needsAttention = true;
    attentionReason = "active_but_stale";
    const daysSince = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / (24 * 60 * 60 * 1000));
    maintenanceItems.push({
      namespace: row.namespace,
      issue: "active_but_stale",
      suggestion: `Last updated ${daysSince} days ago. Update status or change lifecycle to maintenance/archived.`,
    });
  }

  if (lifecycle === "active" && !needsAttention) {
    const upcomingDate = findUpcomingEventDate(row.content, row.updated_at);
    if (upcomingDate) {
      needsAttention = true;
      attentionReason = "upcoming_event_stale";
      const daysUntil = Math.ceil((new Date(upcomingDate + "T23:59:59Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      const daysSinceUpdate = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / (24 * 60 * 60 * 1000));
      maintenanceItems.push({
        namespace: row.namespace,
        issue: "upcoming_event_stale",
        suggestion: `Event date ${upcomingDate} is ${daysUntil} day${daysUntil === 1 ? "" : "s"} away but status was last updated ${daysSinceUpdate} days ago. Verify status is current.`,
      });
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
export function getTrackedStatusAssessments(db: Database.Database): Map<string, TrackedStatusAssessment> {
  const assessments = getTrackedStatuses(db).map(assessTrackedStatus);
  return new Map(assessments.map((assessment) => [assessment.entry.id, assessment]));
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

  if (isTrackedNamespace(entry.namespace) && entry.key === "status") {
    score += 20;
    if (queryMentionsAny(queryLower, ["active", "work", "blocker", "blockers", "next", "steps", "project"])) {
      score += 4;
    }
    if (orientationQuery) {
      score += 2;
    }
    if (triageQuery) {
      score += 6;
    }
  }

  if (entry.namespace.startsWith("people/") && entry.key === "profile") {
    score += 18;
    if (queryMentionsAny(queryLower, ["personal", "profile", "collaboration", "style", "preference", "preferences", "context"])) {
      score += 10;
    }
    if (queryMentionsAny(queryLower, ["magnus", "working on", "what should i know"])) {
      score += 12;
    }
  }

  if (entry.namespace === "meta/conventions" && entry.key === "conventions") {
    score += 16;
    if (queryMentionsAny(queryLower, ["convention", "handshake", "cas", "lifecycle", "write protocol"])) {
      score += 8;
    }
  }

  if (entry.namespace === "meta" && entry.key === "reference-index") {
    score += 10;
    if (orientationQuery) {
      score += 18;
    }
  }

  if (entry.entry_type === "log") {
    score -= 3;
    if (triageQuery) score -= 6;
  }

  if (looksLikeTombstone(entry.content)) {
    score -= 30;
  }

  if (entry.key === "status") {
    if (tags.includes("archived")) score -= 12;
    if (tags.includes("completed")) score -= 8;
    if (tags.includes("stopped")) score -= 8;
  }

  if (entry.namespace.startsWith("tasks/")) {
    score -= 8;
    if (triageQuery) score -= 14;
  }

  if (triageQuery && entry.key === "index") {
    score -= 10;
  }

  if (triageQuery && trackedStatus) {
    if (trackedStatus.lifecycle === "blocked") {
      score += 36;
    } else if (trackedStatus.needsAttention) {
      score += 28;
      if (trackedStatus.attentionReason === "upcoming_event_stale") score += 4;
      if (trackedStatus.attentionReason === "active_but_stale") score += 2;
    } else if (trackedStatus.lifecycle === "active") {
      score -= 8;
    }
  }

  return score;
}

/**
 * Inject canonical reference entries (reference-index, magnus profile,
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

  const injected = [
    readState(db, "meta", "reference-index"),
    readState(db, "people/magnus", "profile"),
    readState(db, "meta/conventions", "conventions"),
  ].filter((entry): entry is Entry => entry !== null);

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
      freshness: getFreshnessScore(entry.updated_at),
    }))
    .sort((a, b) => {
      if (b.heuristic !== a.heuristic) return b.heuristic - a.heuristic;
      if (searchRecencyWeight > 0 && b.freshness !== a.freshness) return b.freshness - a.freshness;
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

export function getQueryExplainReasons(
  entry: Entry,
  queryLower: string,
  trackedStatus: TrackedStatusAssessment | undefined,
  match: NonNullable<QueryResult["match"]>,
): string[] {
  const reasons: string[] = [];

  if (match.lexical_rank !== undefined) reasons.push("matched lexical terms");
  if (match.semantic_rank !== undefined) reasons.push("matched semantic similarity");
  if (match.hybrid_score !== undefined && match.lexical_rank !== undefined && match.semantic_rank !== undefined) {
    reasons.push("combined lexical and semantic signals");
  }
  if (isTrackedNamespace(entry.namespace) && entry.key === "status") reasons.push("tracked status");
  if (trackedStatus?.lifecycle === "blocked") reasons.push("blocked item");
  else if (trackedStatus?.needsAttention) reasons.push("needs attention");
  if (entry.namespace.startsWith("people/") && entry.key === "profile") reasons.push("profile entry");
  if (entry.namespace === "meta/conventions" && entry.key === "conventions") reasons.push("conventions reference");
  if (entry.namespace === "meta" && entry.key === "reference-index") reasons.push("reference index");
  if (match.freshness_score !== undefined && match.freshness_score >= 0.5) reasons.push("recently updated");
  if (isEntryExpired(entry)) reasons.push("expired entry included on request");

  const queryTerms = queryLower
    .split(/[^a-z0-9_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !RELAXED_QUERY_STOPWORDS.has(term));
  const contentLower = entry.content.toLowerCase();
  const matchedTerm = queryTerms.find((term) => contentLower.includes(term) || entry.namespace.toLowerCase().includes(term) || (entry.key?.toLowerCase().includes(term) ?? false));
  if (matchedTerm) reasons.push(`matched term: ${matchedTerm}`);

  return [...new Set(reasons)];
}
