import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  writeState,
  readState,
  getById,
  appendLog,
  queryEntries,
  queryEntriesLexicalScored,
  queryEntriesSemantic,
  queryEntriesSemanticScored,
  queryEntriesHybrid,
  queryEntriesHybridScored,
  listNamespaces,
  listNamespaceContents,
  previewDelete,
  executeDelete,
  getOtherKeysInNamespace,
  getTrackedStatuses,
  getCompletedTaskNamespaces,
  vecLoaded,
  logRetrievalEvent,
  logRetrievalOutcome,
  getInsightsByEntry,
  getAuditHistory,
} from "./db.js";
import {
  validateWriteInput,
  validateLogInput,
  validateNamespace,
  validateKey,
} from "./security.js";
import {
  generateEmbedding,
  embeddingToBuffer,
  isSemanticEnabled,
  isHybridEnabled,
  getSearchModeUnavailableReason,
} from "./embeddings.js";
import type {
  WriteParams,
  ReadParams,
  ReadBatchParams,
  GetParams,
  QueryParams,
  OrientParams,
  LogParams,
  ListParams,
  DeleteParams,
  AttentionParams,
  InsightsParams,
  EntryInsight,
  AuditHistoryParams,
  Entry,
  SearchMode,
  OrientDetail,
  DashboardEntry,
  MaintenanceItem,
  TrackedStatusRow,
  QueryResult,
  AttentionItem,
} from "./types.js";

// In-memory delete token store (debate resolution #9)
const deleteTokens = new Map<string, { namespace: string; key?: string; expiresAt: number }>();
const DELETE_TOKEN_TTL_MS = 60_000; // 1 minute

function generateDeleteToken(namespace: string, key?: string): string {
  const token = randomBytes(16).toString("hex");
  deleteTokens.set(token, {
    namespace,
    key,
    expiresAt: Date.now() + DELETE_TOKEN_TTL_MS,
  });
  return token;
}

function consumeDeleteToken(token: string, namespace: string, key?: string): boolean {
  const entry = deleteTokens.get(token);
  if (!entry) return false;
  deleteTokens.delete(token);

  if (entry.expiresAt < Date.now()) return false;
  if (entry.namespace !== namespace) return false;
  if (entry.key !== key) return false;
  return true;
}

// Clean expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of deleteTokens) {
    if (entry.expiresAt < now) deleteTokens.delete(token);
  }
}, 30_000);

function parseEntry(entry: Entry) {
  return {
    ...entry,
    tags: parseTags(entry.tags),
  };
}

function parseTags(tags: string): string[] {
  return JSON.parse(tags) as string[];
}

function contentPreview(content: string, maxLen = 500): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}

const STALENESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const EVENT_STALENESS_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const EVENT_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const QUERY_RERANK_OVERFETCH_MULTIPLIER = 5;
const RELAXED_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "for", "how", "i", "important", "is", "it",
  "my", "myself", "of", "or", "should", "the", "to", "what",
]);
const ORIENTATION_QUERY_PHRASES = [
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
const ATTENTION_TRIAGE_QUERY_PHRASES = [
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

interface TrackedStatusAssessment {
  row: TrackedStatusRow;
  entry: Entry;
  lifecycle: string;
  needsAttention: boolean;
  attentionReason?: "blocked" | MaintenanceItem["issue"];
  maintenanceItems: MaintenanceItem[];
}

function isStale(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALENESS_THRESHOLD_MS;
}

// Date pattern: YYYY-MM-DD (standalone or in ISO timestamp)
const DATE_PATTERN = /\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g;

/**
 * Detect if content mentions a date within the next 7 days and the entry
 * hasn't been updated in 3+ days. Returns the soonest upcoming date or null.
 */
function findUpcomingEventDate(content: string, updatedAt: string): string | null {
  const now = Date.now();
  const sinceUpdate = now - new Date(updatedAt).getTime();
  if (sinceUpdate < EVENT_STALENESS_THRESHOLD_MS) return null; // recently updated, no concern

  let soonest: string | null = null;
  let soonestMs = Infinity;
  for (const match of content.matchAll(DATE_PATTERN)) {
    const dateStr = match[1];
    const dateMs = new Date(dateStr + "T23:59:59Z").getTime();
    const untilEvent = dateMs - now;
    if (untilEvent > 0 && untilEvent <= EVENT_LOOKAHEAD_MS && untilEvent < soonestMs) {
      soonestMs = untilEvent;
      soonest = dateStr;
    }
  }
  return soonest;
}

// --- Lifecycle tag management ---

const LIFECYCLE_TAGS = new Set(["active", "blocked", "completed", "stopped", "maintenance", "archived"]);

const TAG_ALIASES: Record<string, string> = {
  "done": "completed",
  "paused": "stopped",
  "inactive": "archived",
};

function isTrackedNamespace(namespace: string): boolean {
  return namespace.startsWith("projects/") || namespace.startsWith("clients/");
}

function buildRelaxedLexicalQuery(query: string): string | null {
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

function shouldApplyDefaultQuerySuppression(params: QueryParams): boolean {
  return !params.namespace && !params.entry_type && (!params.tags || params.tags.length === 0);
}

function isBroadOrientationQuery(query: string, params: QueryParams): boolean {
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

function isAttentionTriageQuery(query: string, params: QueryParams): boolean {
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

function looksLikeTombstone(content: string): boolean {
  return /\bTOMBSTONE\b/i.test(content);
}

function queryMentionsAny(query: string, terms: string[]): boolean {
  return terms.some((term) => query.includes(term));
}

function trackedStatusRowToEntry(row: TrackedStatusRow): Entry {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    entry_type: "state",
    content: row.content,
    tags: row.tags,
    agent_id: "default",
    created_at: row.created_at,
    updated_at: row.updated_at,
    embedding_status: "pending",
    embedding_model: null,
  };
}

function assessTrackedStatus(row: TrackedStatusRow): TrackedStatusAssessment {
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

  if (lifecycle === "active" && isStale(row.updated_at)) {
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

function getTrackedStatusAssessments(db: Database.Database): Map<string, TrackedStatusAssessment> {
  const assessments = getTrackedStatuses(db).map(assessTrackedStatus);
  return new Map(assessments.map((assessment) => [assessment.entry.id, assessment]));
}

function getQueryHeuristicScore(
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

function injectCanonicalQueryEntries(
  db: Database.Database,
  results: Entry[],
  params: QueryParams,
): Entry[] {
  if (!isBroadOrientationQuery(params.query, params)) return results;

  const injected = [
    readState(db, "meta", "reference-index"),
    readState(db, "people/magnus", "profile"),
    readState(db, "meta/conventions", "conventions"),
  ].filter((entry): entry is Entry => entry !== null);

  if (injected.length === 0) return results;

  const seen = new Set(results.map((entry) => entry.id));
  const merged = [...results];
  for (const entry of injected) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function injectAttentionQueryEntries(
  results: Entry[],
  params: QueryParams,
  trackedStatuses: Map<string, TrackedStatusAssessment>,
): Entry[] {
  if (!isAttentionTriageQuery(params.query, params)) return results;

  const injected = [...trackedStatuses.values()]
    .filter((assessment) => assessment.lifecycle === "blocked" || assessment.needsAttention)
    .map((assessment) => assessment.entry);

  if (injected.length === 0) return results;

  const seen = new Set(results.map((entry) => entry.id));
  const merged = [...results];
  for (const entry of injected) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function rerankQueryResults(
  results: Entry[],
  params: QueryParams,
  completedTasks: Set<string>,
  trackedStatuses?: Map<string, TrackedStatusAssessment>,
): Entry[] {
  const queryLower = params.query.toLowerCase();
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
      return a.index - b.index;
    })
    .map((item) => item.entry);
}

function clampOptionalLimit(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function resolveOrientDetail(params: OrientParams): OrientDetail {
  if (params.detail === "compact" || params.detail === "standard" || params.detail === "full") {
    return params.detail;
  }
  if (params.include_full_conventions) return "full";
  return "standard";
}

function matchesNamespacePrefix(namespace: string, prefix?: string): boolean {
  if (!prefix) return true;
  if (prefix.endsWith("/")) return namespace.startsWith(prefix);
  return namespace === prefix;
}

function getAttentionSeverity(category: AttentionItem["category"]): AttentionItem["severity"] {
  switch (category) {
    case "blocked":
    case "upcoming_event_stale":
    case "conflicting_lifecycle":
      return "high";
    case "active_but_stale":
    case "missing_status":
    case "missing_lifecycle":
      return "medium";
    default:
      return "low";
  }
}

function getQueryExplainReasons(
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

  const queryTerms = queryLower
    .split(/[^a-z0-9_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !RELAXED_QUERY_STOPWORDS.has(term));
  const contentLower = entry.content.toLowerCase();
  const matchedTerm = queryTerms.find((term) => contentLower.includes(term) || entry.namespace.toLowerCase().includes(term) || (entry.key?.toLowerCase().includes(term) ?? false));
  if (matchedTerm) reasons.push(`matched term: ${matchedTerm}`);

  return [...new Set(reasons)];
}

function buildAttentionItem(
  namespace: string,
  category: AttentionItem["category"],
  updatedAt: string,
  preview: string,
  suggestion: string,
): AttentionItem {
  let reason: string;
  switch (category) {
    case "blocked":
      reason = "Lifecycle tag is blocked.";
      break;
    case "active_but_stale":
      reason = "Active status looks stale.";
      break;
    case "upcoming_event_stale":
      reason = "Upcoming event is close and the status is stale.";
      break;
    case "missing_status":
      reason = "Tracked namespace has entries but no status key.";
      break;
    case "conflicting_lifecycle":
      reason = "Status has conflicting lifecycle tags.";
      break;
    case "missing_lifecycle":
      reason = "Status is missing a lifecycle tag.";
      break;
    default:
      reason = suggestion;
      break;
  }

  return {
    namespace,
    category,
    severity: getAttentionSeverity(category),
    updated_at: updatedAt,
    preview,
    reason,
    suggested_action: suggestion,
  };
}

function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const severityRank: Record<AttentionItem["severity"], number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  if (severityRank[b.severity] !== severityRank[a.severity]) {
    return severityRank[b.severity] - severityRank[a.severity];
  }
  if (a.updated_at !== b.updated_at) {
    return a.updated_at.localeCompare(b.updated_at);
  }
  return a.namespace.localeCompare(b.namespace);
}

function canonicalizeTags(tags: string[]): { canonical: string[]; normalized: string[] } {
  const normalized: string[] = [];
  const canonical = tags.map(t => {
    const alias = TAG_ALIASES[t];
    if (alias) {
      normalized.push(`"${t}" → "${alias}"`);
      return alias;
    }
    return t;
  });
  return { canonical, normalized };
}

function getLifecycleTags(tags: string[]): string[] {
  return tags.filter(t => LIFECYCLE_TAGS.has(t));
}

/**
 * Hand-maintained compact operational summary. NOT derived from the full
 * conventions — this is a separate, concise reference for the orient
 * handshake. Full conventions live in meta/conventions and should be
 * read via memory_read when the complete guide is needed.
 */
function compactConventions(updatedAt: string): string {
  const lines: string[] = [
    "# Quick Reference (compact)",
    `Full conventions: memory_read("meta/conventions", "conventions") — last updated ${updatedAt.slice(0, 10)}`,
    "",
    "## Key Rules",
    "- **Handshake:** memory_orient first, then memory_read for specifics, memory_query for search.",
    "- **State entries** = current truth (mutable). **Log entries** = chronological (append-only).",
    "- **Write protocol:** Log decisions first (memory_log), then update status with CAS (expected_updated_at).",
    "- **Lifecycle tags** (required on status): active, blocked, completed, stopped, maintenance, archived.",
    "- **Tracked namespaces** (dashboard): projects/*, clients/*. Must have status key + lifecycle tag.",
    "- **Prefixed tags:** client:<name>, person:<name>, topic:<topic>, type:<artifact>, source:external/internal.",
    "- **No secrets** — API keys, tokens, passwords rejected by server.",
    "- **CAS for tracked statuses** — pass expected_updated_at to prevent blind overwrites.",
    "",
    "## Namespaces",
    "projects/<name> (tracked) | clients/<name> (tracked) | people/<name> | decisions/<topic>",
    "meta/<topic> | documents/<slug> | feedback/<project> | reading/<slug>",
    "signals/<source> | digests/<period> | tasks/<id> (Hugin)",
    "",
    "## Tickets",
    "File: memory_write(\"feedback/<project>\", \"<slug>\", content, tags: [\"bug\"|\"enhancement\"|\"ux\"])",
    "View: memory_list(\"feedback\") or memory_list(\"feedback/<project>\")",
  ];
  return lines.join("\n");
}

const TOOL_DEFINITIONS = [
  {
    name: "memory_orient",
    description:
      "START HERE. Call this at the beginning of every conversation before using any other memory tool. Returns conventions, a computed project dashboard (grouped by lifecycle from status entries), optional curated notes, actionable maintenance suggestions, and optionally a namespace overview — everything needed to orient yourself in one call.\n\nThe dashboard is computed automatically from status entries in projects/* and clients/* namespaces. No manual workbench maintenance needed. Demo namespaces and completed task-run namespaces are hidden by default.\n\nUse `detail` to control response size. `standard` preserves the current default behavior, `compact` trims dashboard/namespaces for token-sensitive environments, and `full` includes the full conventions document.",
    inputSchema: {
      type: "object" as const,
      properties: {
        detail: {
          type: "string",
          enum: ["compact", "standard", "full"],
          description:
            "Optional. Controls response size. `standard` is the default, `compact` trims dashboard/namespaces, and `full` returns the full conventions document.",
        },
        include_demo: {
          type: "boolean",
          description:
            "Optional. If true, include demo/* namespaces in the namespace overview. Default: false.",
        },
        include_completed_tasks: {
          type: "boolean",
          description:
            "Optional. If true, include completed/failed task-run namespaces (tasks/*) in the namespace overview. Default: false. Active, pending, and special task namespaces (tasks/admin, tasks/_heartbeat) are always shown.",
        },
        include_full_conventions: {
          type: "boolean",
          description:
            "Deprecated alias for `detail: \"full\"`.",
        },
        dashboard_limit_per_group: {
          type: "integer",
          description:
            "Optional. Maximum entries to return per lifecycle group in the dashboard. `compact` defaults to 5; other detail levels return all entries unless this is set.",
        },
        namespace_limit: {
          type: "integer",
          description:
            "Optional. Maximum namespaces to return in the namespace overview. `compact` defaults to 20; other detail levels return all namespaces unless this is set.",
        },
        include_namespaces: {
          type: "boolean",
          description:
            "Optional. If false, omit the namespace overview entirely. By default `compact` omits it and other detail levels include it.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_write",
    description:
      "Store or update a state entry in memory. If an entry with the same namespace+key exists, it will be overwritten. Use this for mutable facts: project status, current decisions, known preferences.\n\nIf this is your first memory operation in this conversation, call memory_orient first.\n\nNamespace conventions: projects/<name> for project state, people/<name> for context about people, decisions/<topic> for cross-cutting decisions, meta/<topic> for system notes.\n\nKey conventions: 'status' = compact resumption summary (Phase / Current work / Blockers / Next — keep brief, move details to other keys like 'architecture', 'workflow', 'research'). 'index' = directory of important keys in this namespace and their purpose.\n\nTag vocabulary: Use canonical lifecycle tags on status entries: active, blocked, completed, stopped, maintenance, archived. Aliases are auto-normalized (done→completed, paused→stopped, inactive→archived). Category tags: decision, architecture, preference, milestone, convention. Type tags: bug, feature, research. Prefixed tags for cross-referencing: client:<name>, person:<name>, topic:<topic>, type:<artifact> (pdf, presentation, meeting-notes), source:external/internal.\n\nThe project dashboard is computed automatically from status entries with lifecycle tags. No manual workbench maintenance needed. Writing to 'status' in projects/* or clients/* supports compare-and-swap via expected_updated_at.\n\nTo start a new project: (1) write projects/<name>/status with a lifecycle tag (e.g. 'active'), (2) optionally write projects/<name>/index listing the keys.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Hierarchical namespace using / separator. E.g. 'projects/hugin-munin', 'people/magnus', 'decisions/tech-stack'",
        },
        key: {
          type: "string",
          description:
            "Short descriptive slug for this entry. E.g. 'status', 'architecture', 'preferences'",
        },
        content: {
          type: "string",
          description:
            "The content to store. Markdown supported. Be specific and write for your future self.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional freeform tags for cross-cutting queries. Must be a JSON array, e.g. ["decision", "active", "client:lofalk"]. Do NOT pass as a comma-separated string.',
        },
        expected_updated_at: {
          type: "string",
          description:
            "Optional. For tracked status writes (projects/*, clients/*): pass the updated_at from your last read to prevent blind overwrites. Returns conflict error if the entry was modified since.",
        },
      },
      required: ["namespace", "key", "content"],
    },
  },
  {
    name: "memory_read",
    description:
      "Retrieve a specific state entry by namespace and key. Returns the full content, tags, and timestamps. Returns a clear 'not found' message if the entry doesn't exist (not an error).\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "The namespace to read from",
        },
        key: {
          type: "string",
          description: "The key of the state entry to read",
        },
      },
      required: ["namespace", "key"],
    },
  },
  {
    name: "memory_read_batch",
    description:
      "Retrieve multiple state entries in a single call. Returns an array of results (found or not found) in the same order as the input. Use this to orient on multiple projects at once instead of making sequential memory_read calls.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              namespace: { type: "string", description: "The namespace to read from" },
              key: { type: "string", description: "The key of the state entry to read" },
            },
            required: ["namespace", "key"],
          },
          description: 'Array of {namespace, key} pairs to read. E.g. [{"namespace": "projects/foo", "key": "status"}, {"namespace": "projects/bar", "key": "status"}]',
        },
      },
      required: ["reads"],
    },
  },
  {
    name: "memory_get",
    description:
      "Retrieve a single memory entry by its ID. Returns the full content regardless of entry type (state or log). Use this when memory_query returns a relevant result and you need the complete content.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The UUID of the entry to retrieve",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_query",
    description:
      "Search across memories. Supports lexical (FTS5 keyword), semantic (vector similarity), and hybrid (RRF fusion of both) search modes. Filters by namespace prefix, entry type, and tags. Pass `explain: true` to include retrieval metadata and per-result match explanations.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search terms. For lexical mode, FTS5 syntax supported. For semantic/hybrid, natural language works best.",
        },
        namespace: {
          type: "string",
          description:
            "Optional. Filter to a namespace or namespace prefix (e.g. 'projects/' matches all project namespaces)",
        },
        entry_type: {
          type: "string",
          enum: ["state", "log"],
          description: "Optional. Filter by entry type.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional. Filter to entries that have ALL of these tags. Must be a JSON array, e.g. ["decision", "active"] or ["client:lofalk", "type:pdf"].',
        },
        limit: {
          type: "number",
          description: "Max results to return. Default 10, max 50.",
        },
        search_mode: {
          type: "string",
          enum: ["lexical", "semantic", "hybrid"],
          description:
            "Search mode. Default: hybrid (RRF fusion of keyword + vector). Lexical: FTS5 keyword search. Semantic: vector KNN similarity. Degrades to lexical if embeddings unavailable.",
        },
        explain: {
          type: "boolean",
          description: "Optional. If true, include retrieval metadata and per-result match explanations.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_attention",
    description:
      "Return deterministic triage items for tracked work. Surfaces blocked statuses, stale active work, near-term event staleness, and tracked namespaces missing status or lifecycle structure. Use this instead of broad natural-language search when you explicitly want what needs attention.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace_prefix: {
          type: "string",
          description: "Optional. Restrict attention items to a namespace prefix such as `projects/` or `clients/`.",
        },
        include_blocked: {
          type: "boolean",
          description: "Optional. Include blocked statuses. Default: true.",
        },
        include_stale: {
          type: "boolean",
          description: "Optional. Include active-but-stale statuses. Default: true.",
        },
        include_upcoming_events: {
          type: "boolean",
          description: "Optional. Include stale statuses with near-term event dates. Default: true.",
        },
        include_missing_status: {
          type: "boolean",
          description: "Optional. Include tracked namespaces that have entries but no status key. Default: true.",
        },
        include_conflicting_lifecycle: {
          type: "boolean",
          description: "Optional. Include statuses with conflicting lifecycle tags. Default: true.",
        },
        include_missing_lifecycle: {
          type: "boolean",
          description: "Optional. Include statuses missing a lifecycle tag. Default: true.",
        },
        limit: {
          type: "integer",
          description: "Optional. Maximum number of attention items to return. Default: 20, max 50.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_log",
    description:
      "Append a chronological log entry. Log entries are immutable and timestamped. Use for decisions, events, and milestones with rationale. Status changes do NOT auto-log — log explicitly when decisions are made. Pair with memory_write: state entries hold current truth, log entries hold the history of how you got there.\n\nTag vocabulary: Use canonical tags — decision, milestone, blocker, discovery, correction. Add at most one freeform tag when it clearly improves retrieval.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "The namespace to log to",
        },
        content: {
          type: "string",
          description:
            "The log entry content. Be specific — include what was decided and why.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional tags. Must be a JSON array, e.g. ["decision", "active"] or ["client:lofalk"].',
        },
      },
      required: ["namespace", "content"],
    },
  },
  {
    name: "memory_list",
    description:
      "Browse memory contents. Without a namespace: shows all namespaces with entry counts and last_activity_at (demo/* and completed task-run namespaces hidden by default). With a namespace: shows all state keys, log count, and the 5 most recent log entry previews.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional. If provided, list contents of this namespace. If omitted, list all namespaces.",
        },
        include_demo: {
          type: "boolean",
          description:
            "Optional. If true, include demo/* namespaces in the top-level listing. Default: false.",
        },
        include_completed_tasks: {
          type: "boolean",
          description:
            "Optional. If true, include completed/failed task-run namespaces in the top-level listing. Default: false.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_history",
    description:
      "View the chronological audit trail of changes to memory. Returns a timeline of writes, updates, deletes, and log appends. Use this to answer 'what changed recently?' or 'what happened in this namespace?' — unlike memory_query (which is relevance-based search), this is a pure change feed ordered by time.\n\nKnown limitations: audit rows do not contain entry_id (can't link to specific entries across renames/deletes), detail field is sparse (can't reconstruct full content changes), and agent_id is currently not differentiated across environments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional. Filter to a namespace or namespace prefix. E.g. 'projects/munin-memory' returns changes in that namespace and its children.",
        },
        since: {
          type: "string",
          description:
            "Optional. ISO 8601 timestamp. Only return changes after this time. E.g. '2026-03-20T00:00:00Z' for the last week.",
        },
        action: {
          type: "string",
          enum: ["write", "update", "delete", "namespace_delete", "log_append"],
          description: "Optional. Filter by action type.",
        },
        limit: {
          type: "integer",
          description: "Optional. Maximum entries to return. Default: 20, max: 100.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_delete",
    description:
      "Delete a specific state entry by namespace+key, or all entries in a namespace. First call without delete_token to preview what will be deleted. Then call with the returned delete_token to execute.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "The namespace to delete from",
        },
        key: {
          type: "string",
          description:
            "Optional. If provided, delete only this state entry. If omitted, delete ALL entries (state and log) in the namespace.",
        },
        delete_token: {
          type: "string",
          description:
            "The token returned from a preview call. Required to execute the delete.",
        },
      },
      required: ["namespace"],
    },
  },
  {
    name: "memory_insights",
    description:
      "Return per-entry retrieval analytics: how often each entry was retrieved (impressions), opened (opens), followed by writes or logs, and whether it was stale when opened. Useful for understanding which memories are most actionable and which are frequently stale. Requires at least min_impressions retrieval events to appear in results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional. Restrict results to a specific namespace or namespace prefix (e.g. 'projects/' for all project namespaces).",
        },
        min_impressions: {
          type: "integer",
          description:
            "Optional. Minimum number of retrieval impressions for an entry to appear in results. Default: 3.",
        },
        limit: {
          type: "integer",
          description:
            "Optional. Maximum number of entries to return. Default: 20, max: 50.",
        },
      },
      required: [],
    },
  },
];

export function getMaxContentSize(): number {
  const envVal = process.env.MUNIN_MEMORY_MAX_CONTENT_SIZE;
  return envVal ? parseInt(envVal, 10) || 100_000 : 100_000;
}

// --- Retrieval analytics signal thresholds ---
const SIGNAL_OPENS_RATE_THRESHOLD = 0.3;
const SIGNAL_WRITE_RATE_THRESHOLD = 0.15;
const SIGNAL_LOG_RATE_THRESHOLD = 0.1;
const SIGNAL_STALENESS_PRESSURE_THRESHOLD = 0.5;
const SIGNAL_NO_FOLLOWTHROUGH_THRESHOLD = 0.05;
const SIGNAL_NO_FOLLOWTHROUGH_MIN_IMPRESSIONS = 5;

function computeEntryInsight(row: {
  entry_id: string;
  namespace: string;
  impressions: number;
  opens: number;
  write_outcomes: number;
  log_outcomes: number;
  opened_when_stale_count: number;
  updated_at: string;
}): EntryInsight {
  const { entry_id, namespace, impressions, opens, write_outcomes, log_outcomes, opened_when_stale_count } = row;
  const follthrough = impressions > 0
    ? (opens + write_outcomes + log_outcomes) / impressions
    : 0;
  const stalenessPresure = opens > 0 ? opened_when_stale_count / opens : 0;

  const signals: string[] = [];
  if (impressions > 0 && opens / impressions > SIGNAL_OPENS_RATE_THRESHOLD) {
    signals.push("frequently opened after retrieval");
  }
  if (impressions > 0 && write_outcomes / impressions > SIGNAL_WRITE_RATE_THRESHOLD) {
    signals.push("often followed by writes");
  }
  if (impressions > 0 && log_outcomes / impressions > SIGNAL_LOG_RATE_THRESHOLD) {
    signals.push("often followed by logs");
  }
  if (stalenessPresure > SIGNAL_STALENESS_PRESSURE_THRESHOLD) {
    signals.push("frequently stale when opened");
  }
  if (
    follthrough < SIGNAL_NO_FOLLOWTHROUGH_THRESHOLD &&
    impressions >= SIGNAL_NO_FOLLOWTHROUGH_MIN_IMPRESSIONS
  ) {
    signals.push("no follow-through");
  }

  return {
    entry_id,
    namespace,
    impressions,
    opens,
    followthrough_rate: follthrough,
    staleness_pressure: stalenessPresure,
    learned_signals: signals,
  };
}

export function registerTools(server: Server, db: Database.Database, sessionId?: string): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;
      const maxContentSize = getMaxContentSize();

      try {
        switch (name) {
          case "memory_orient": {
            const orientArgs = (args ?? {}) as OrientParams;
            const { include_demo, include_completed_tasks } = orientArgs;
            const detail = resolveOrientDetail(orientArgs);
            const includeNamespaces = orientArgs.include_namespaces ?? detail !== "compact";
            const dashboardLimit = clampOptionalLimit(orientArgs.dashboard_limit_per_group, 50) ?? (detail === "compact" ? 5 : undefined);
            const namespaceLimit = clampOptionalLimit(orientArgs.namespace_limit, 200) ?? (detail === "compact" ? 20 : undefined);
            // Read conventions and namespace list
            const conventions = readState(db, "meta/conventions", "conventions");
            const namespaces = listNamespaces(db);

            const response: Record<string, unknown> = {};

            // Conventions — compact by default, full on request
            if (conventions) {
              const parsed = parseEntry(conventions);
              const content = detail === "full"
                ? parsed.content
                : compactConventions(parsed.updated_at);
              const conv: Record<string, unknown> = {
                content,
                updated_at: parsed.updated_at,
              };
              if (detail !== "full") {
                conv.compact = true;
                conv.full_conventions_hint = 'memory_read("meta/conventions", "conventions")';
              }
              if (isStale(parsed.updated_at)) conv.stale = true;
              response.conventions = conv;
            } else {
              response.conventions = {
                content: null,
                message: "No conventions found. Write to meta/conventions with key 'conventions' to set them up.",
              };
            }

            // Computed dashboard from tracked status entries
            const trackedStatusAssessments = [...getTrackedStatusAssessments(db).values()];
            const dashboard: Record<string, DashboardEntry[]> = {
              active: [],
              blocked: [],
              maintenance: [],
              stopped: [],
              completed: [],
              archived: [],
              uncategorized: [],
            };
            const maintenanceNeeded: MaintenanceItem[] = [];

            for (const assessment of trackedStatusAssessments) {
              const entry: DashboardEntry = {
                namespace: assessment.row.namespace,
                summary: assessment.row.content_preview.slice(0, 150),
                updated_at: assessment.row.updated_at,
                lifecycle: assessment.lifecycle,
              };

              if (assessment.needsAttention) {
                entry.needs_attention = true;
              }
              maintenanceNeeded.push(...assessment.maintenanceItems);

              const group = dashboard[assessment.lifecycle] ?? dashboard.uncategorized;
              group.push(entry);
            }

            // Check for tracked namespaces that have entries but no status key
            const trackedNsWithStatus = new Set(trackedStatusAssessments.map((assessment) => assessment.row.namespace));
            for (const ns of namespaces) {
              if (isTrackedNamespace(ns.namespace) && !trackedNsWithStatus.has(ns.namespace)) {
                maintenanceNeeded.push({
                  namespace: ns.namespace,
                  issue: "missing_status",
                  suggestion: "Has entries but no 'status' key. Write a status entry with a lifecycle tag.",
                });
              }
            }

            const dashboardCounts: Record<string, number> = {};
            const truncatedGroups: string[] = [];
            for (const [groupName, entries] of Object.entries(dashboard)) {
              dashboardCounts[groupName] = entries.length;
              if (dashboardLimit !== undefined && entries.length > dashboardLimit) {
                dashboard[groupName] = entries.slice(0, dashboardLimit);
                truncatedGroups.push(groupName);
              }
            }

            response.dashboard = dashboard;
            response.dashboard_meta = {
              counts: dashboardCounts,
              truncated_groups: truncatedGroups,
            };

            // Curated overlay (meta/workbench-notes)
            const notes = readState(db, "meta", "workbench-notes");
            if (notes) {
              response.notes = notes.content;
            }

            // Reference index — data-driven discoverability for key entries
            const refIndex = readState(db, "meta", "reference-index");
            if (refIndex) {
              try {
                const parsed = JSON.parse(refIndex.content);
                if (parsed && Array.isArray(parsed.references)) {
                  const validEntries = parsed.references.filter(
                    (r: Record<string, unknown>) =>
                      typeof r.namespace === "string" &&
                      typeof r.key === "string" &&
                      typeof r.title === "string" &&
                      typeof r.when_to_load === "string",
                  );
                  if (validEntries.length > 0) {
                    response.references = {
                      entries: validEntries,
                      updated_at: refIndex.updated_at,
                    };
                  }
                }
              } catch {
                // Malformed JSON — skip silently, don't break orient
              }
            }

            // Maintenance suggestions
            if (maintenanceNeeded.length > 0) {
              response.maintenance_needed = maintenanceNeeded;
            }

            // Legacy workbench (transition period)
            const workbench = readState(db, "meta", "workbench");
            if (workbench) {
              const parsed = parseEntry(workbench);
              response.legacy_workbench = {
                content: parsed.content,
                updated_at: parsed.updated_at,
                deprecation_note: "The workbench is deprecated. The computed dashboard above is now the source of truth for project/client state. Delete meta/workbench when ready.",
              };
            }

            // Namespace overview — filter demo and completed task-run namespaces by default
            const completedTasks = include_completed_tasks ? new Set<string>() : getCompletedTaskNamespaces(db);
            const filteredNamespaces = namespaces.filter((ns) => {
              if (!include_demo && (ns.namespace.startsWith("demo/") || ns.namespace === "demo")) return false;
              if (!include_completed_tasks && completedTasks.has(ns.namespace)) return false;
              return true;
            });
            if (includeNamespaces) {
              const limitedNamespaces = namespaceLimit !== undefined
                ? filteredNamespaces.slice(0, namespaceLimit)
                : filteredNamespaces;
              response.namespaces = limitedNamespaces;
              response.namespaces_meta = {
                total: filteredNamespaces.length,
                returned: limitedNamespaces.length,
                truncated: limitedNamespaces.length < filteredNamespaces.length,
              };
            }

            // Analytics: log orient event (no result IDs — orient has no specific entries)
            if (sessionId) {
              logRetrievalEvent(db, {
                sessionId,
                toolName: "memory_orient",
                resultIds: [],
                resultNamespaces: [],
                resultRanks: [],
              });
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify(response),
              }],
            };
          }

          case "memory_write": {
            const { namespace, key, content, tags, expected_updated_at } =
              args as unknown as WriteParams & { expected_updated_at?: string };
            const validation = validateWriteInput(namespace, key, content, tags, maxContentSize);
            if (!validation.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: validation.error }) }] };
            }

            const isTrackedStatus = key === "status" && isTrackedNamespace(namespace);
            const warnings: string[] = [];

            // Canonicalize tags for tracked status writes
            let effectiveTags = tags ?? [];
            if (isTrackedStatus && effectiveTags.length > 0) {
              const { canonical, normalized } = canonicalizeTags(effectiveTags);
              if (normalized.length > 0) {
                warnings.push(`Tags normalized: ${normalized.join(", ")}`);
              }
              effectiveTags = canonical;
            }

            // Lifecycle validation for tracked status writes
            if (isTrackedStatus) {
              const lifecycleTags = getLifecycleTags(effectiveTags);
              if (lifecycleTags.length === 0) {
                warnings.push(`No lifecycle tag found. Consider adding one of: ${[...LIFECYCLE_TAGS].join(", ")}.`);
              } else if (lifecycleTags.length > 1) {
                warnings.push(`Multiple lifecycle tags found: [${lifecycleTags.join(", ")}]. Use exactly one.`);
              }
            }

            const result = writeState(db, namespace, key, content, effectiveTags, "default", expected_updated_at);

            if (result.status === "conflict") {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    status: "conflict",
                    namespace,
                    key,
                    message: result.message,
                    current_updated_at: result.current_updated_at,
                  }),
                }],
              };
            }

            const otherKeys = getOtherKeysInNamespace(db, namespace, key);
            const isFirstEntry = otherKeys.length === 0;
            const hint = isFirstEntry
              ? "This is the first entry in this namespace."
              : `Related entries in this namespace: ${otherKeys.join(", ")}`;

            const response: Record<string, unknown> = {
              status: result.status,
              id: result.id,
              namespace,
              key,
              hint,
            };

            // CAS hint for tracked status writes without expected_updated_at
            if (isTrackedStatus && !expected_updated_at && result.status === "updated") {
              warnings.push("Consider passing expected_updated_at for tracked status writes to prevent blind overwrites.");
            }

            if (warnings.length > 0) {
              response.warnings = warnings;
            }

            // Analytics: log write outcome correlated to prior retrieval in this session
            if (sessionId) {
              logRetrievalOutcome(db, sessionId, {
                outcomeType: "write_in_result_namespace",
                namespace,
              });
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify(response),
              }],
            };
          }

          case "memory_read": {
            const { namespace, key } = args as unknown as ReadParams;
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: nsCheck.error }) }] };
            }
            const keyCheck = validateKey(key);
            if (!keyCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: keyCheck.error }) }] };
            }
            const entry = readState(db, namespace, key);
            if (entry) {
              const parsed = parseEntry(entry);
              const response: Record<string, unknown> = {
                found: true,
                id: parsed.id,
                namespace: parsed.namespace,
                key: parsed.key,
                content: parsed.content,
                tags: parsed.tags,
                created_at: parsed.created_at,
                updated_at: parsed.updated_at,
              };
              if (isStale(parsed.updated_at)) {
                response.stale = true;
              }
              // Analytics: log opened_result outcome
              if (sessionId) {
                logRetrievalOutcome(db, sessionId, {
                  outcomeType: "opened_result",
                  entryId: parsed.id,
                  namespace: parsed.namespace,
                });
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify(response),
                }],
              };
            }
            const otherKeys = getOtherKeysInNamespace(db, namespace);
            const hint = otherKeys.length > 0
              ? `Other keys in this namespace: ${otherKeys.join(", ")}`
              : `No entries found in namespace "${namespace}".`;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  found: false,
                  namespace,
                  key,
                  message: `No state entry found in namespace "${namespace}" with key "${key}".`,
                  hint,
                }),
              }],
            };
          }

          case "memory_read_batch": {
            const { reads } = args as unknown as ReadBatchParams;
            if (!Array.isArray(reads) || reads.length === 0) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "reads must be a non-empty array of {namespace, key} pairs." }) }] };
            }
            if (reads.length > 20) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "Maximum 20 reads per batch." }) }] };
            }

            const results = reads.map(({ namespace: ns, key: k }) => {
              const nsCheck = validateNamespace(ns);
              if (!nsCheck.valid) return { found: false, namespace: ns, key: k, error: nsCheck.error };
              const keyCheck = validateKey(k);
              if (!keyCheck.valid) return { found: false, namespace: ns, key: k, error: keyCheck.error };

              const entry = readState(db, ns, k);
              if (entry) {
                const parsed = parseEntry(entry);
                const result: Record<string, unknown> = {
                  found: true,
                  id: parsed.id,
                  namespace: parsed.namespace,
                  key: parsed.key,
                  content: parsed.content,
                  tags: parsed.tags,
                  created_at: parsed.created_at,
                  updated_at: parsed.updated_at,
                };
                if (isStale(parsed.updated_at)) {
                  result.stale = true;
                }
                return result;
              }
              return { found: false, namespace: ns, key: k };
            });

            return {
              content: [{
                type: "text",
                text: JSON.stringify({ results }),
              }],
            };
          }

          case "memory_get": {
            const { id } = args as unknown as GetParams;
            if (!id || typeof id !== "string") {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "ID is required." }) }] };
            }
            const entry = getById(db, id);
            if (entry) {
              const parsed = parseEntry(entry);
              const response: Record<string, unknown> = {
                found: true,
                id: parsed.id,
                namespace: parsed.namespace,
                key: parsed.key,
                entry_type: parsed.entry_type,
                content: parsed.content,
                tags: parsed.tags,
                created_at: parsed.created_at,
                updated_at: parsed.updated_at,
              };
              if (isStale(parsed.updated_at)) {
                response.stale = true;
              }
              // Analytics: log opened_result outcome
              if (sessionId) {
                logRetrievalOutcome(db, sessionId, {
                  outcomeType: "opened_result",
                  entryId: parsed.id,
                  namespace: parsed.namespace,
                });
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify(response),
                }],
              };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  found: false,
                  message: `No entry found with ID "${id}".`,
                }),
              }],
            };
          }

          case "memory_query": {
            const queryArgs = (args ?? {}) as unknown as QueryParams;
            const { query, namespace, entry_type, tags, limit, search_mode } = queryArgs;
            const explain = queryArgs.explain === true;
            if (!query || typeof query !== "string") {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: "Missing required parameter: query (string). Pass a search string in the 'query' field, e.g. {\"query\": \"your search terms\"}." }) }] };
            }

            const requestedLimit = Math.min(Math.max(limit ?? 10, 1), 50);
            const internalLimit = Math.min(requestedLimit * QUERY_RERANK_OVERFETCH_MULTIPLIER, 50);
            const queryParams: QueryParams = {
              query,
              namespace,
              entry_type,
              tags,
              limit: requestedLimit,
              search_mode,
              explain,
            };
            const requestedMode: SearchMode = search_mode ?? "hybrid";
            let actualMode: SearchMode = requestedMode;
            let warning: string | undefined;
            let fallbackReason: string | null = null;
            let relaxedLexical = false;
            let results: Entry[] = [];
            let lexicalResults: ReturnType<typeof queryEntriesLexicalScored> = [];
            let semanticResults: ReturnType<typeof queryEntriesSemanticScored> = [];
            let hybridResults: ReturnType<typeof queryEntriesHybridScored> = [];

            if (requestedMode === "semantic") {
              if (!isSemanticEnabled() || !vecLoaded()) {
                actualMode = "lexical";
                warning = `Semantic search unavailable (${getSearchModeUnavailableReason("semantic")}). Falling back to lexical search.`;
                fallbackReason = "semantic_unavailable";
              }
            } else if (requestedMode === "hybrid") {
              if (!isHybridEnabled() || !vecLoaded()) {
                actualMode = "lexical";
                warning = `Hybrid search unavailable (${getSearchModeUnavailableReason("hybrid")}). Falling back to lexical search.`;
                fallbackReason = "hybrid_unavailable";
              }
            }

            if (actualMode === "semantic") {
              const queryEmb = await generateEmbedding(query);
              if (!queryEmb) {
                actualMode = "lexical";
                warning = "Failed to generate query embedding. Falling back to lexical search.";
                fallbackReason = "embedding_generation_failed";
              } else {
                const buf = embeddingToBuffer(queryEmb);
                semanticResults = queryEntriesSemanticScored(db, {
                  queryEmbedding: buf,
                  namespace,
                  entryType: entry_type,
                  tags,
                  limit: internalLimit,
                });
                results = semanticResults.map((result) => result.entry);
              }
            }

            if (actualMode === "hybrid") {
              const queryEmb = await generateEmbedding(query);
              if (!queryEmb) {
                actualMode = "lexical";
                warning = "Failed to generate query embedding. Falling back to lexical search.";
                fallbackReason = "embedding_generation_failed";
              } else {
                const buf = embeddingToBuffer(queryEmb);
                hybridResults = queryEntriesHybridScored(db, {
                  ftsOptions: { query, namespace, entryType: entry_type, tags, limit: internalLimit },
                  semanticOptions: { queryEmbedding: buf, namespace, entryType: entry_type, tags, limit: internalLimit },
                });
                results = hybridResults.map((result) => result.entry);
              }
            }

            // Lexical fallback (or original mode)
            if (actualMode === "lexical") {
              lexicalResults = queryEntriesLexicalScored(db, {
                query,
                namespace,
                entryType: entry_type,
                tags,
                limit: internalLimit,
              });
              results = lexicalResults.map((result) => result.entry);

              if (results.length === 0) {
                const relaxedQuery = buildRelaxedLexicalQuery(query);
                if (relaxedQuery) {
                  lexicalResults = queryEntriesLexicalScored(db, {
                    query: relaxedQuery,
                    namespace,
                    entryType: entry_type,
                    tags,
                    limit: internalLimit,
                  });
                  results = lexicalResults.map((result) => result.entry);
                  if (results.length > 0 && !warning) {
                    warning = "No exact lexical matches found. Used relaxed token matching for natural-language query.";
                    relaxedLexical = true;
                  }
                }
              }
            }

            const trackedStatuses = (shouldApplyDefaultQuerySuppression(queryParams) || explain)
              ? getTrackedStatusAssessments(db)
              : undefined;

            results = injectCanonicalQueryEntries(db, results, queryParams);
            if (trackedStatuses) {
              results = injectAttentionQueryEntries(results, queryParams, trackedStatuses);
            }
            const completedTasks = shouldApplyDefaultQuerySuppression(queryParams)
              ? getCompletedTaskNamespaces(db)
              : new Set<string>();
            results = rerankQueryResults(results, queryParams, completedTasks, trackedStatuses).slice(0, requestedLimit);

            const lexicalById = new Map(lexicalResults.map((result) => [result.entry.id, result] as const));
            const semanticById = new Map(semanticResults.map((result) => [result.entry.id, result] as const));
            const hybridById = new Map(hybridResults.map((result) => [result.entry.id, result] as const));

            const formatted = results.map((entry) => {
              const result: QueryResult = {
                id: entry.id,
                namespace: entry.namespace,
                key: entry.key,
                entry_type: entry.entry_type,
                content_preview: contentPreview(entry.content),
                tags: parseTags(entry.tags),
                created_at: entry.created_at,
                updated_at: entry.updated_at,
              };

              if (explain) {
                const heuristicScore = getQueryHeuristicScore(entry, query.toLowerCase(), trackedStatuses);
                const match: NonNullable<QueryResult["match"]> = {
                  heuristic_score: heuristicScore,
                  reasons: [],
                };

                if (actualMode === "lexical") {
                  const lexical = lexicalById.get(entry.id);
                  if (lexical) {
                    match.lexical_rank = lexical.rank;
                    match.lexical_score = lexical.score;
                  }
                } else if (actualMode === "semantic") {
                  const semantic = semanticById.get(entry.id);
                  if (semantic) {
                    match.semantic_rank = semantic.rank;
                    match.semantic_distance = semantic.distance;
                  }
                } else if (actualMode === "hybrid") {
                  const hybrid = hybridById.get(entry.id);
                  if (hybrid) {
                    match.hybrid_score = hybrid.score;
                    if (hybrid.lexicalRank !== undefined) match.lexical_rank = hybrid.lexicalRank;
                    if (hybrid.lexicalScore !== undefined) match.lexical_score = hybrid.lexicalScore;
                    if (hybrid.semanticRank !== undefined) match.semantic_rank = hybrid.semanticRank;
                    if (hybrid.semanticDistance !== undefined) match.semantic_distance = hybrid.semanticDistance;
                  }
                }

                match.reasons = getQueryExplainReasons(entry, query.toLowerCase(), trackedStatuses?.get(entry.id), match);
                result.match = match;
              }

              return result;
            });

            const response: Record<string, unknown> = {
              results: formatted,
              total: formatted.length,
              query,
              search_mode: requestedMode,
            };
            if (actualMode !== requestedMode) {
              response.search_mode_actual = actualMode;
            }
            if (warning) {
              response.warning = warning;
            }
            if (explain) {
              response.retrieval = {
                reranked: true,
                relaxed_lexical: relaxedLexical,
                fallback_reason: fallbackReason,
              };
            }

            // Analytics: log retrieval event with result IDs and ranks
            if (sessionId) {
              const resultIds = formatted.map((r) => r.id);
              const resultNamespaces = formatted.map((r) => r.namespace);
              const resultRanks = formatted.map((_, i) => i + 1);
              logRetrievalEvent(db, {
                sessionId,
                toolName: "memory_query",
                queryText: query,
                requestedMode: requestedMode,
                actualMode,
                resultIds,
                resultNamespaces,
                resultRanks,
              });
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify(response),
              }],
            };
          }

          case "memory_attention": {
            const attentionArgs = (args ?? {}) as AttentionParams;
            const includeBlocked = attentionArgs.include_blocked !== false;
            const includeStale = attentionArgs.include_stale !== false;
            const includeUpcomingEvents = attentionArgs.include_upcoming_events !== false;
            const includeMissingStatus = attentionArgs.include_missing_status !== false;
            const includeConflictingLifecycle = attentionArgs.include_conflicting_lifecycle !== false;
            const includeMissingLifecycle = attentionArgs.include_missing_lifecycle !== false;
            const limit = clampOptionalLimit(attentionArgs.limit, 50) ?? 20;

            const trackedStatusAssessments = [...getTrackedStatusAssessments(db).values()];
            const namespaces = listNamespaces(db);
            const attentionItems: AttentionItem[] = [];

            for (const assessment of trackedStatusAssessments) {
              if (!matchesNamespacePrefix(assessment.row.namespace, attentionArgs.namespace_prefix)) continue;

              if (includeBlocked && assessment.lifecycle === "blocked") {
                attentionItems.push(buildAttentionItem(
                  assessment.row.namespace,
                  "blocked",
                  assessment.row.updated_at,
                  assessment.row.content_preview.slice(0, 150),
                  "Review blocker and update status.",
                ));
              }

              for (const item of assessment.maintenanceItems) {
                if (item.issue === "active_but_stale" && !includeStale) continue;
                if (item.issue === "upcoming_event_stale" && !includeUpcomingEvents) continue;
                if (item.issue === "conflicting_lifecycle" && !includeConflictingLifecycle) continue;
                if (item.issue === "missing_lifecycle" && !includeMissingLifecycle) continue;
                if (item.issue === "missing_status") continue;

                attentionItems.push(buildAttentionItem(
                  item.namespace,
                  item.issue,
                  assessment.row.updated_at,
                  assessment.row.content_preview.slice(0, 150),
                  item.suggestion,
                ));
              }
            }

            if (includeMissingStatus) {
              const trackedNsWithStatus = new Set(trackedStatusAssessments.map((assessment) => assessment.row.namespace));
              for (const ns of namespaces) {
                if (!isTrackedNamespace(ns.namespace)) continue;
                if (trackedNsWithStatus.has(ns.namespace)) continue;
                if (!matchesNamespacePrefix(ns.namespace, attentionArgs.namespace_prefix)) continue;

                attentionItems.push(buildAttentionItem(
                  ns.namespace,
                  "missing_status",
                  ns.last_activity_at,
                  "Tracked namespace has entries but no status key.",
                  "Has entries but no 'status' key. Write a status entry with a lifecycle tag.",
                ));
              }
            }

            attentionItems.sort(compareAttentionItems);
            const limitedItems = attentionItems.slice(0, limit);
            const summary = {
              high: limitedItems.filter((item) => item.severity === "high").length,
              medium: limitedItems.filter((item) => item.severity === "medium").length,
              low: limitedItems.filter((item) => item.severity === "low").length,
              total: limitedItems.length,
            };

            // Analytics: log attention event — use namespace IDs of returned items as result_ids
            if (sessionId) {
              const resultNamespaces = [...new Set(limitedItems.map((item) => item.namespace))];
              logRetrievalEvent(db, {
                sessionId,
                toolName: "memory_attention",
                resultIds: [],
                resultNamespaces,
                resultRanks: resultNamespaces.map((_, i) => i + 1),
              });
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  generated_at: new Date().toISOString(),
                  summary,
                  items: limitedItems,
                }),
              }],
            };
          }

          case "memory_log": {
            const { namespace, content, tags } = args as unknown as LogParams;
            const validation = validateLogInput(namespace, content, tags, maxContentSize);
            if (!validation.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: validation.error }) }] };
            }
            const result = appendLog(db, namespace, content, tags ?? []);
            // Analytics: log log outcome correlated to prior retrieval in this session
            if (sessionId) {
              logRetrievalOutcome(db, sessionId, {
                outcomeType: "log_in_result_namespace",
                namespace,
              });
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "logged",
                  id: result.id,
                  namespace,
                  timestamp: result.timestamp,
                }),
              }],
            };
          }

          case "memory_list": {
            const { namespace, include_demo, include_completed_tasks } = (args ?? {}) as ListParams;
            if (!namespace) {
              const allNamespaces = listNamespaces(db);
              const completedTasks = include_completed_tasks ? new Set<string>() : getCompletedTaskNamespaces(db);
              const namespaces = allNamespaces.filter((ns) => {
                if (!include_demo && (ns.namespace.startsWith("demo/") || ns.namespace === "demo")) return false;
                if (!include_completed_tasks && completedTasks.has(ns.namespace)) return false;
                return true;
              });
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({ namespaces }),
                }],
              };
            }
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: nsCheck.error }) }] };
            }
            const { stateEntries, logSummary } = listNamespaceContents(db, namespace);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  namespace,
                  state_entries: stateEntries.map((e) => ({
                    key: e.key,
                    preview: e.preview,
                    tags: JSON.parse(e.tags) as string[],
                    updated_at: e.updated_at,
                  })),
                  log_summary: {
                    log_count: logSummary.log_count,
                    earliest: logSummary.earliest,
                    latest: logSummary.latest,
                    recent: logSummary.recent.map((l) => ({
                      id: l.id,
                      content_preview: l.content_preview,
                      tags: JSON.parse(l.tags) as string[],
                      created_at: l.created_at,
                    })),
                  },
                }),
              }],
            };
          }

          case "memory_delete": {
            const { namespace, key, delete_token } =
              args as unknown as DeleteParams;
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: nsCheck.error }) }] };
            }
            if (key) {
              const keyCheck = validateKey(key);
              if (!keyCheck.valid) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "validation_error", message: keyCheck.error }) }] };
              }
            }

            // Execute with token
            if (delete_token) {
              if (!consumeDeleteToken(delete_token, namespace, key)) {
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      error: "invalid_token",
                      message: "Delete token is invalid, expired, or doesn't match the requested namespace/key. Request a new preview first.",
                    }),
                  }],
                };
              }
              const deletedCount = executeDelete(db, namespace, key);
              const target = key ? `entry "${key}" in "${namespace}"` : `all entries in "${namespace}"`;
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    action: "deleted",
                    namespace,
                    key: key ?? undefined,
                    deleted_count: deletedCount,
                    message: `Deleted ${deletedCount} entries (${target}).`,
                  }),
                }],
              };
            }

            // Preview
            const info = previewDelete(db, namespace, key);
            const token = generateDeleteToken(namespace, key);
            const target = key ? `entry "${key}" in "${namespace}"` : `all entries in "${namespace}"`;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  action: "preview",
                  namespace,
                  key: key ?? undefined,
                  will_delete: {
                    state_count: info.stateCount,
                    log_count: info.logCount,
                    keys: info.keys.length > 0 ? info.keys : undefined,
                  },
                  delete_token: token,
                  message: `Will delete ${info.stateCount} state entries and ${info.logCount} log entries (${target}). Call again with delete_token to confirm.`,
                }),
              }],
            };
          }

          case "memory_insights": {
            const insightsArgs = (args ?? {}) as InsightsParams;
            const minImpressions = typeof insightsArgs.min_impressions === "number"
              ? Math.max(1, Math.floor(insightsArgs.min_impressions))
              : 3;
            const insightsLimit = clampOptionalLimit(insightsArgs.limit, 50) ?? 20;

            const rows = getInsightsByEntry(db, insightsArgs.namespace, minImpressions, insightsLimit);
            const entries: EntryInsight[] = rows.map(computeEntryInsight);

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  entries,
                  total: entries.length,
                  min_impressions: minImpressions,
                }),
              }],
            };
          }

          case "memory_history": {
            const { namespace, since, action, limit } = (args ?? {}) as AuditHistoryParams;

            // Validate action enum if provided
            const validActions = ["write", "update", "delete", "namespace_delete", "log_append", "delete_namespace", "log"];
            if (action !== undefined && !validActions.includes(action)) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    error: "validation_error",
                    message: `Invalid action "${action}". Must be one of: write, update, delete, namespace_delete, log_append.`,
                  }),
                }],
              };
            }

            // getAuditHistory validates since and clamps limit; let errors propagate as internal_error
            const historyEntries = getAuditHistory(db, {
              namespace,
              since,
              action,
              limit,
            });

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  generated_at: new Date().toISOString(),
                  count: historyEntries.length,
                  entries: historyEntries,
                }),
              }],
            };
          }

          default:
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  error: "unknown_tool",
                  message: `Unknown tool: ${name}`,
                }),
              }],
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: "internal_error", message }),
          }],
          isError: true,
        };
      }
    },
  );
}
