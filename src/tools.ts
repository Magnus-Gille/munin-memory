import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getSchemaVersion } from "./migrations.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import {
  type AccessContext,
  ownerContext,
  canRead,
  canWrite,
  canReadSubtree,
  filterByAccess,
  getContextMaxClassification,
  getContextTransportType,
} from "./access.js";
import { randomBytes } from "node:crypto";
import {
  writeState,
  patchState,
  type PatchParams,
  type AuditHistoryEntry,
  readState,
  getById,
  appendLog,
  queryEntries,
  queryEntriesLexicalScored,
  queryEntriesSemantic,
  queryEntriesSemanticScored,
  queryEntriesHybrid,
  queryEntriesHybridScored,
  queryEntriesByFilter,
  listEntriesForDerivation,
  listNamespaces,
  listNamespacesByClassification,
  listNamespacesPaged,
  listNamespaceContents,
  summarizeNamespaceLogsByClassification,
  previewDelete,
  executeDelete,
  listCommitments,
  syncCommitmentsForEntry,
  type DerivedCommitmentInput,
  type CommitmentRow,
  getOtherKeysInNamespace,
  getTrackedStatuses,
  getCompletedTaskNamespaces,
  isEntryExpired,
  nowUTC,
  vecLoaded,
  logRetrievalEvent,
  logRetrievalOutcome,
  getInsightsByEntry,
  getAuditHistoryPage,
  insertRedactionLog,
} from "./db.js";
import {
  CLASSIFICATION_LEVELS,
  buildLibrarianRuntimeSummary,
  enforceClassification,
  filterSourcesByClassification,
  isClassificationLevel,
  isLibrarianEnabled,
  isRedactionLogEnabled,
  stripClassificationTags,
  summarizeRedactedSources,
  type RedactableEntryMetadata,
} from "./librarian.js";
import {
  validateWriteInput,
  validateLogInput,
  validateNamespace,
  validateKey,
  validateTags,
} from "./security.js";
import {
  generateEmbedding,
  embeddingToBuffer,
  isEmbeddingAvailable,
  isSemanticEnabled,
  isHybridEnabled,
  getSearchModeUnavailableReason,
} from "./embeddings.js";
import type {
  WriteParams,
  StatusUpdateParams,
  ReadParams,
  ReadBatchParams,
  GetParams,
  QueryParams,
  OrientParams,
  ResumeParams,
  ExtractParams,
  NarrativeParams,
  CommitmentsParams,
  PatternsParams,
  HandoffParams,
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
  ResumeItem,
  ResumeOpenLoop,
  ResumeSuggestedRead,
  ExtractSuggestion,
  ExtractRelatedEntry,
  NarrativeSignal,
  NarrativeTimelineItem,
  NarrativeSource,
  CommitmentItem,
  PatternItem,
  HeuristicItem,
  PatternSource,
  HandoffResponse,
  AuditAction,
  AuditEntry,
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

function buildProvenance(principalId: string, ownerPrincipalId?: string | null) {
  return {
    principal_id: principalId,
    owner_principal_id: ownerPrincipalId ?? undefined,
  };
}

function serializeParsedEntry(entry: ReturnType<typeof parseEntry>) {
  return {
    id: entry.id,
    namespace: entry.namespace,
    key: entry.key,
    entry_type: entry.entry_type,
    content: entry.content,
    tags: entry.tags,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    valid_until: entry.valid_until ?? undefined,
    classification: entry.classification,
    provenance: buildProvenance(entry.agent_id, entry.owner_principal_id),
  };
}

function buildRedactableEntryMetadata(entry: ReturnType<typeof parseEntry>) {
  return {
    id: entry.id,
    namespace: entry.namespace,
    key: entry.key,
    entry_type: entry.entry_type,
    classification: entry.classification,
    tags: entry.tags,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

function maybeRedactEntryMetadata(
  db: Database.Database,
  ctx: AccessContext,
  entry: RedactableEntryMetadata,
  toolName: string,
  sessionId?: string,
): Record<string, unknown> | null {
  const enforcement = enforceClassification(ctx, entry);
  if (enforcement.allowed) {
    return null;
  }

  if (isRedactionLogEnabled()) {
    insertRedactionLog(db, {
      sessionId,
      principalId: ctx.principalId,
      transportType: enforcement.transportType,
      entryId: entry.id,
      entryNamespace: entry.namespace,
      entryClassification: entry.classification,
      connectionMaxClassification: enforcement.maxClassification,
      toolName,
    });
  }

  return enforcement.response;
}

function maybeRedactDirectEntry(
  db: Database.Database,
  ctx: AccessContext,
  entry: ReturnType<typeof parseEntry>,
  toolName: string,
  sessionId?: string,
): Record<string, unknown> | null {
  return maybeRedactEntryMetadata(db, ctx, buildRedactableEntryMetadata(entry), toolName, sessionId);
}

function filterDerivedSources<T>(
  db: Database.Database,
  ctx: AccessContext,
  sources: T[],
  toolName: string,
  getMetadata: (source: T) => RedactableEntryMetadata,
  sessionId?: string,
): { allowed: T[]; redacted: RedactableEntryMetadata[] } {
  const filtered = filterSourcesByClassification(ctx, sources, getMetadata);

  if (filtered.redacted.length > 0 && isRedactionLogEnabled()) {
    for (const redacted of filtered.redacted) {
      const enforcement = enforceClassification(ctx, redacted.metadata);
      if (!enforcement.allowed) {
        insertRedactionLog(db, {
          sessionId,
          principalId: ctx.principalId,
          transportType: enforcement.transportType,
          entryId: redacted.metadata.id,
          entryNamespace: redacted.metadata.namespace,
          entryClassification: redacted.metadata.classification,
          connectionMaxClassification: enforcement.maxClassification,
          toolName,
        });
      }
    }
  }

  return {
    allowed: filtered.allowed,
    redacted: filtered.redacted.map((entry) => entry.metadata),
  };
}

function combineRedactedSources(...groups: RedactableEntryMetadata[][]): RedactableEntryMetadata[] {
  const combined: RedactableEntryMetadata[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const entry of group) {
      const key = `${entry.id}:${entry.namespace}:${entry.classification}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(entry);
    }
  }

  return combined;
}

function buildAuditHistoryMetadata(
  db: Database.Database,
  entry: AuditHistoryEntry | AuditEntry,
): RedactableEntryMetadata {
  const sourceEntry = entry.entry_id ? getById(db, entry.entry_id) : null;
  if (sourceEntry) {
    return buildRedactableEntryMetadata(parseEntry(sourceEntry));
  }

  return {
    id: entry.entry_id ?? `audit:${entry.id}`,
    namespace: entry.namespace,
    key: entry.key,
    classification: "client-restricted",
  };
}

function listVisibleNamespaces(
  db: Database.Database,
  ctx: AccessContext,
): ReturnType<typeof listNamespaces> {
  if (!isLibrarianEnabled()) {
    return listNamespaces(db);
  }
  return listNamespacesByClassification(db, getContextMaxClassification(ctx));
}

function formatQueryResult(
  db: Database.Database,
  ctx: AccessContext,
  entry: Entry,
  toolName: string,
  sessionId: string | undefined,
  explain: boolean,
  queryLower: string | null,
  trackedStatuses: ReturnType<typeof getTrackedStatusAssessments> | undefined,
  actualMode: SearchMode,
  lexicalById: Map<string, ReturnType<typeof queryEntriesLexicalScored>[number]>,
  semanticById: Map<string, ReturnType<typeof queryEntriesSemanticScored>[number]>,
  hybridById: Map<string, ReturnType<typeof queryEntriesHybridScored>[number]>,
): QueryResult {
  const parsed = parseEntry(entry);
  const redacted = maybeRedactEntryMetadata(db, ctx, buildRedactableEntryMetadata(parsed), toolName, sessionId);
  if (redacted) {
    return redacted as unknown as QueryResult;
  }

  const result: QueryResult = {
    id: entry.id,
    namespace: entry.namespace,
    key: entry.key,
    entry_type: entry.entry_type,
    content_preview: contentPreview(entry.content),
    tags: parsed.tags,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    valid_until: entry.valid_until ?? undefined,
    classification: entry.classification,
    provenance: buildProvenance(entry.agent_id, entry.owner_principal_id),
  };
  if (isEntryExpired(entry)) {
    result.expired = true;
  }

  if (explain && queryLower !== null) {
    const heuristicScore = getQueryHeuristicScore(entry, queryLower, trackedStatuses);
    const match: NonNullable<QueryResult["match"]> = {
      heuristic_score: heuristicScore,
      freshness_score: getFreshnessScore(entry.updated_at),
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

    match.reasons = getQueryExplainReasons(entry, queryLower, trackedStatuses?.get(entry.id), match);
    result.match = match;
  }

  return result;
}

function serializeHistoryAction(
  action: AuditEntry["action"],
): AuditEntry["action"] {
  return action === "log_append"
    ? "log"
    : action === "namespace_delete"
      ? "delete_namespace"
      : action;
}

function formatHistoryEntry(
  db: Database.Database,
  ctx: AccessContext,
  entry: AuditEntry,
  sessionId?: string,
): AuditEntry {
  const action = serializeHistoryAction(entry.action);
  const provenance = buildProvenance(entry.agent_id);
  const metadata = buildAuditHistoryMetadata(db, entry);
  const redactionResponse = maybeRedactEntryMetadata(db, ctx, metadata, "memory_history", sessionId);

  if (redactionResponse) {
    const response: AuditEntry = {
      id: entry.id,
      timestamp: entry.timestamp,
      agent_id: entry.agent_id,
      action,
      namespace: entry.namespace,
      key: ctx.principalType === "owner" ? entry.key : null,
      entry_id: ctx.principalType === "owner" ? entry.entry_id : null,
      detail: null,
      provenance,
      redacted: true,
      redaction_reason: redactionResponse.redaction_reason as string | undefined,
    };
    if (ctx.principalType === "owner") {
      response.classification = metadata.classification;
    }
    return response;
  }

  return {
    ...entry,
    action,
    provenance,
  };
}

function parseTags(tags: string): string[] {
  return JSON.parse(tags) as string[];
}

function validateClassificationInput(
  classification: unknown,
  classificationOverride: unknown,
): string | null {
  if (classification !== undefined && !isClassificationLevel(classification)) {
    return `classification must be one of: ${CLASSIFICATION_LEVELS.join(", ")}.`;
  }
  if (classificationOverride !== undefined && typeof classificationOverride !== "boolean") {
    return "classification_override must be a boolean.";
  }
  return null;
}

interface StructuredStatus {
  phase?: string;
  current_work?: string;
  blockers?: string;
  next_steps?: string[];
  notes?: string;
}

const STATUS_SECTION_ORDER = [
  "phase",
  "current_work",
  "blockers",
  "next_steps",
  "notes",
] as const;

const STATUS_SECTION_TITLES: Record<(typeof STATUS_SECTION_ORDER)[number], string> = {
  phase: "Phase",
  current_work: "Current Work",
  blockers: "Blockers",
  next_steps: "Next Steps",
  notes: "Notes",
};

function normalizeStatusLabel(raw: string): keyof StructuredStatus | null {
  const normalized = raw
    .toLowerCase()
    .replace(/[*:_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "phase") return "phase";
  if (normalized === "current work" || normalized === "current") return "current_work";
  if (normalized === "blockers" || normalized === "blocker") return "blockers";
  if (normalized === "next steps" || normalized === "next step" || normalized === "next") return "next_steps";
  if (normalized === "notes" || normalized === "note") return "notes";
  return null;
}

function extractStatusSectionValue(key: keyof StructuredStatus, raw: string): string | string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (key === "next_steps") {
    const bulletItems = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
    if (bulletItems.length > 0) return bulletItems;
    return [trimmed];
  }
  return trimmed;
}

function assignStructuredStatusValue(
  target: StructuredStatus,
  key: keyof StructuredStatus,
  value: string | string[],
): void {
  if (key === "next_steps") {
    if (Array.isArray(value)) {
      target.next_steps = value;
    } else {
      target.next_steps = [value];
    }
    return;
  }

  if (typeof value === "string") {
    switch (key) {
      case "phase":
        target.phase = value;
        break;
      case "current_work":
        target.current_work = value;
        break;
      case "blockers":
        target.blockers = value;
        break;
      case "notes":
        target.notes = value;
        break;
      default:
        break;
    }
  }
}

function parseStructuredStatus(content: string): StructuredStatus {
  const structured: StructuredStatus = {};
  const lines = content.split("\n");

  const headingMatches = [...content.matchAll(/^##\s+(.+)$/gm)];
  if (headingMatches.length > 0) {
    for (let i = 0; i < headingMatches.length; i++) {
      const match = headingMatches[i];
      const label = normalizeStatusLabel(match[1]);
      if (!label) continue;
      const sectionStart = match.index! + match[0].length;
      const sectionEnd = i + 1 < headingMatches.length ? headingMatches[i + 1].index! : content.length;
      const raw = content.slice(sectionStart, sectionEnd).trim();
      const extracted = extractStatusSectionValue(label, raw);
      if (extracted !== undefined) assignStructuredStatusValue(structured, label, extracted);
    }
  }

  for (const line of lines) {
    const inline = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
    if (!inline) continue;
    const label = normalizeStatusLabel(inline[1]);
    if (!label) continue;
    const extracted = extractStatusSectionValue(label, inline[2]);
    if (extracted !== undefined) assignStructuredStatusValue(structured, label, extracted);
  }

  return structured;
}

function normalizeStatusText(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStatusList(value?: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.map((item) => item.trim()).filter(Boolean);
  return items;
}

function buildStructuredStatus(update: StructuredStatus, existing?: StructuredStatus): Required<StructuredStatus> {
  const merged: Required<StructuredStatus> = {
    phase: normalizeStatusText(update.phase) ?? normalizeStatusText(existing?.phase) ?? "Unspecified.",
    current_work: normalizeStatusText(update.current_work) ?? normalizeStatusText(existing?.current_work) ?? "Unspecified.",
    blockers: normalizeStatusText(update.blockers) ?? normalizeStatusText(existing?.blockers) ?? "None.",
    next_steps: normalizeStatusList(update.next_steps) ?? normalizeStatusList(existing?.next_steps) ?? ["None."],
    notes: normalizeStatusText(update.notes) ?? normalizeStatusText(existing?.notes) ?? "",
  };
  return merged;
}

function formatStructuredStatus(status: Required<StructuredStatus>): string {
  const sections: string[] = [];
  for (const key of STATUS_SECTION_ORDER) {
    const title = STATUS_SECTION_TITLES[key];
    const value = status[key];
    if (key === "notes" && !value) continue;
    sections.push(`## ${title}`);
    if (key === "next_steps") {
      sections.push((value as string[]).map((item) => `- ${item}`).join("\n"));
    } else {
      sections.push(value as string);
    }
    sections.push("");
  }
  return sections.join("\n").trim();
}

function serializeAuditEntry(entry: AuditEntry) {
  const action = entry.action === "log_append"
    ? "log"
    : entry.action === "namespace_delete"
      ? "delete_namespace"
      : entry.action;
  return {
    ...entry,
    action,
    provenance: buildProvenance(entry.agent_id),
  };
}

const VALID_AUDIT_ACTIONS: Array<AuditAction | "delete_namespace" | "log"> = [
  "write",
  "update",
  "delete",
  "namespace_delete",
  "log_append",
  "delete_namespace",
  "log",
];

function contentPreview(content: string, maxLen = 500): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}

const STALENESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const EVENT_STALENESS_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const EVENT_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const QUERY_RERANK_OVERFETCH_MULTIPLIER = 5;
const DEFAULT_ORIENT_DETAIL: OrientDetail = "compact";
const DEFAULT_SEARCH_RECENCY_WEIGHT = 0.2;
const SEARCH_RECENCY_HALF_LIFE_DAYS = 30;
const EXPIRES_SOON_DAYS = 7;
const ISO_8601_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const TRANSCRIPT_SPEAKER_PREFIX_RE = /^(user|assistant|human|claude|codex|magnus|sara)\s*:\s*/i;
const RELAXED_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "for", "how", "i", "important", "is", "it",
  "my", "myself", "of", "or", "should", "the", "to", "what",
]);
const PATTERN_GENERIC_TERMS = new Set([
  "added",
  "after",
  "around",
  "batch",
  "before",
  "boundaries",
  "build",
  "clean",
  "current",
  "design",
  "decision",
  "decisions",
  "deploy",
  "deployed",
  "deployment",
  "docs",
  "exact",
  "explicit",
  "full",
  "from",
  "into",
  "implementation",
  "implemented",
  "live",
  "memory",
  "normal",
  "phase",
  "plan",
  "planned",
  "planning",
  "position",
  "positioning",
  "project",
  "projects",
  "real",
  "release",
  "released",
  "review",
  "roadmap",
  "source",
  "sources",
  "status",
  "suite",
  "sync",
  "synced",
  "tests",
  "through",
  "tool",
  "tools",
  "update",
  "updated",
  "using",
  "with",
  "work",
  "working",
]);
const EXTRACT_ACTION_STEP_CUE =
  /\b(next step(?:s)?|action item(?:s)?|todo|follow up|follow-up|we need to|need to|needs to|we should|should|must|plan to|planned to|we will|will|next clean move|next move|continue with|retry|before|by)\b/i;
const EXTRACT_IMPERATIVE_STEP_PREFIX =
  /^(?:next(?:\s+clean)?\s+move(?::|\s+is:?)?(?:\s+to)?|next step(?:s)?(?::|\s+is:?)?(?:\s+to)?|action item(?:s)?(?::|\s+is:?)?(?:\s+to)?|todo:?|follow up:?|follow-up:?|then\s+)?(?:add|clear|commit|continue|deploy|document|draft|exercise|fix|implement|investigate|prepare|publish|push|refresh|rerun|retry|review|ship|split|sync|update|write|check)\b/i;
const EXTRACT_STEP_PREFIX =
  /^(?:next(?:\s+clean)?\s+move(?::|\s+is:?)?(?:\s+to)?|next step(?:s)?(?::|\s+is:?)?(?:\s+to)?|action item(?:s)?(?::|\s+is:?)?(?:\s+to)?|todo:?|follow up:?|follow-up:?|we need to|need to|needs to|we should|should|we will|will|plan to|planned to)\s*/i;
const EXTRACT_INLINE_EXPLICIT_STEP =
  /\b(next(?:\s+clean)?\s+move(?::|\s+is:?)?(?:\s+to)?|next step(?:s)?(?::|\s+is:?)?(?:\s+to)?|action item(?:s)?(?::|\s+is:?)?(?:\s+to)?|todo:?|follow up:?|follow-up:?)/i;
const EXTRACT_RECAP_LANGUAGE =
  /\b(completed|deployed|implemented|landed|passed|pushed|released|shipped|started|synced|updated|verified)\b/i;
const EXTRACT_FUTURE_LANGUAGE =
  /\b(will|need to|needs to|should|must|plan to|planned to|next step|next clean move|todo|action item|follow up|follow-up|continue with|retry|before|by)\b/i;
const EXTRACT_COMPLETED_LIFECYCLE =
  /\b(project|repository|repo|engagement|client work)\b.*\b(completed|archived|wrapped up|finished)\b|\b(completed|archived|wrapped up|finished)\b.*\b(project|repository|repo|engagement|client work)\b/i;
const NARRATIVE_META_DISCUSSION_TERMS =
  /\b(heuristic|heuristics|signal|signals|pattern|patterns|detection|detector|matcher|regex|keyword|keywords|memory_narrative|memory_patterns|decision churn|reversal pattern)\b/i;
const NARRATIVE_OPERATIONAL_RELEASE_TERMS =
  /\b(batch|build|ci|commit(?:ted)?|deploy(?:ed)?|fix(?:ed)?|format(?:ting)?|health|push(?:ed|ing)?|release(?:d)?|ship(?:ped|ping)?|status(?: update)?|sync(?:ed)?|test(?:s)?|verification|verified)\b/i;
const NARRATIVE_DECISION_RATIONALE_TERMS =
  /\b(again|avoid|because|choose|chose|concern|concerns|defer|due to|keep|narrow|prefer|reason|revisit|risk|scope|settled|still|tradeoff|uncertainty)\b/i;
const NARRATIVE_CHURN_MARKERS =
  /\b(again|avoid|changed|defer|deferred|instead|reconsider|revisit|rework|rollback|tradeoff|uncertainty|for now)\b/i;
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

function normalizeIsoTimestamp(value: unknown, fieldName: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !ISO_8601_TIMESTAMP_RE.test(value)) {
    return {
      ok: false,
      error: `Invalid "${fieldName}" value. Must be an ISO 8601 timestamp (e.g. 2026-12-31T23:59:59Z).`,
    };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      ok: false,
      error: `Invalid "${fieldName}" value. Must be a valid ISO 8601 timestamp.`,
    };
  }

  return { ok: true, value: date.toISOString() };
}

function resolveSearchRecencyWeight(params: QueryParams): { ok: true; value: number } | { ok: false; error: string } {
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

function getFreshnessScore(updatedAt: string): number {
  const ageMs = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.exp((-Math.log(2) * ageDays) / SEARCH_RECENCY_HALF_LIFE_DAYS);
}

function getDaysUntil(validUntil: string): number {
  return (new Date(validUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

function isEntryExpiringSoon(entry: { entry_type: "state" | "log"; valid_until?: string | null }): boolean {
  if (entry.entry_type !== "state" || !entry.valid_until) return false;
  const daysUntil = getDaysUntil(entry.valid_until);
  return daysUntil > 0 && daysUntil <= EXPIRES_SOON_DAYS;
}

function filterExpiredEntries<T extends Entry | { entry: Entry }>(
  items: T[],
  includeExpired: boolean,
): { items: T[]; expiredFilteredCount: number } {
  if (includeExpired) {
    return { items, expiredFilteredCount: 0 };
  }

  let expiredFilteredCount = 0;
  const filtered = items.filter((item) => {
    const wrapper = item as { entry?: Entry };
    const entry = wrapper.entry ?? (item as Entry);
    if (!isEntryExpired(entry)) return true;
    expiredFilteredCount += 1;
    return false;
  });

  return { items: filtered, expiredFilteredCount };
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

function getTrackedStatusAssessments(db: Database.Database): Map<string, TrackedStatusAssessment> {
  const assessments = getTrackedStatuses(db).map(assessTrackedStatus);
  return new Map(assessments.map((assessment) => [assessment.entry.id, assessment]));
}

function getVisibleTrackedStatusAssessments(
  db: Database.Database,
  ctx: AccessContext,
  toolName: string,
  sessionId?: string,
): { allowed: TrackedStatusAssessment[]; redacted: RedactableEntryMetadata[] } {
  const accessible = [...getTrackedStatusAssessments(db).values()]
    .filter((assessment) => canRead(ctx, assessment.row.namespace));
  return filterDerivedSources(
    db,
    ctx,
    accessible,
    toolName,
    (assessment) => buildRedactableEntryMetadata(parseEntry(assessment.entry)),
    sessionId,
  );
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

function injectAttentionQueryEntries(
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

function rerankQueryResults(
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

function clampOptionalLimit(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function resolveOrientDetail(params: OrientParams): OrientDetail {
  if (params.detail === "compact" || params.detail === "standard" || params.detail === "full") {
    return params.detail;
  }
  if (params.include_full_conventions) return "full";
  return DEFAULT_ORIENT_DETAIL;
}

function matchesNamespacePrefix(namespace: string, prefix?: string): boolean {
  if (!prefix) return true;
  if (prefix.endsWith("/")) return namespace.startsWith(prefix);
  return namespace === prefix;
}

function getAttentionSeverity(category: AttentionItem["category"]): AttentionItem["severity"] {
  switch (category) {
    case "blocked":
    case "expired":
    case "upcoming_event_stale":
    case "conflicting_lifecycle":
      return "high";
    case "active_but_stale":
    case "expiring_soon":
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
    case "expiring_soon":
      reason = "Status is nearing its validity deadline.";
      break;
    case "expired":
      reason = "Status validity window has expired.";
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

interface ResumeCandidate {
  item: ResumeItem;
  score: number;
  openLoops: ResumeOpenLoop[];
  suggestedRead?: ResumeSuggestedRead;
}

function isNoneLikeStatusText(value: string): boolean {
  return /^(none|n\/a)[.!]?$/i.test(value.trim());
}

function extractResumeTerms(...values: Array<string | undefined>): string[] {
  const combined = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (!combined) return [];

  const terms = combined
    .split(/[^a-z0-9_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !RELAXED_QUERY_STOPWORDS.has(term));

  return [...new Set(terms)];
}

function countResumeTermMatches(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
}

function resolveResumeScope(
  params: ResumeParams,
  trackedStatusAssessments: TrackedStatusAssessment[],
): string | undefined {
  if (typeof params.namespace === "string" && params.namespace.trim().length > 0) {
    return params.namespace.trim();
  }

  if (typeof params.project !== "string" || params.project.trim().length === 0) {
    return undefined;
  }

  const project = params.project.trim();
  if (project.startsWith("projects/") || project.startsWith("clients/")) {
    return project;
  }

  const trackedNamespaces = trackedStatusAssessments.map((assessment) => assessment.row.namespace);
  const preferredProjects = [`projects/${project}`, `clients/${project}`];
  for (const candidate of preferredProjects) {
    if (trackedNamespaces.includes(candidate)) return candidate;
  }

  const suffixMatches = trackedNamespaces
    .filter((namespace) => namespace.endsWith(`/${project}`))
    .sort();
  if (suffixMatches.length > 0) return suffixMatches[0];

  return `projects/${project}`;
}

function extractResumeOpenLoops(assessment: TrackedStatusAssessment): ResumeOpenLoop[] {
  const structured = parseStructuredStatus(assessment.row.content);
  const loops: ResumeOpenLoop[] = [];

  if (structured.blockers && !isNoneLikeStatusText(structured.blockers)) {
    loops.push({
      namespace: assessment.row.namespace,
      type: "blocker",
      summary: contentPreview(structured.blockers, 160),
      suggested_action: "Review blocker details and update the status when it changes.",
    });
  }

  for (const step of structured.next_steps ?? []) {
    if (isNoneLikeStatusText(step)) continue;
    loops.push({
      namespace: assessment.row.namespace,
      type: "next_step",
      summary: contentPreview(step, 160),
      suggested_action: "Treat this as the next concrete action for the project.",
    });
    if (loops.filter((loop) => loop.type === "next_step").length >= 2) break;
  }

  if (assessment.needsAttention && assessment.maintenanceItems.length > 0) {
    loops.push({
      namespace: assessment.row.namespace,
      type: "attention",
      summary: contentPreview(assessment.maintenanceItems[0].suggestion, 160),
      suggested_action: assessment.maintenanceItems[0].suggestion,
    });
  }

  return loops;
}

function buildResumeStatusCandidate(
  assessment: TrackedStatusAssessment,
  scope: string | undefined,
  hintTerms: string[],
  includeAttention: boolean,
): ResumeCandidate | null {
  const inScope = scope ? matchesNamespacePrefix(assessment.row.namespace, scope) : false;
  const matchText = `${assessment.row.namespace} ${assessment.row.key} ${assessment.row.content_preview}`;
  const matchedTerms = countResumeTermMatches(matchText, hintTerms);

  if (scope && !inScope) return null;
  if (
    !scope &&
    assessment.lifecycle !== "active" &&
    assessment.lifecycle !== "blocked" &&
    !(includeAttention && assessment.needsAttention) &&
    matchedTerms === 0
  ) {
    return null;
  }

  let score = 0;
  if (inScope) score += 140;
  if (assessment.lifecycle === "blocked") score += 80;
  else if (includeAttention && assessment.needsAttention) score += 70;
  else if (assessment.lifecycle === "active") score += 60;
  else if (assessment.lifecycle === "maintenance") score += 30;
  else if (assessment.lifecycle === "completed" || assessment.lifecycle === "stopped" || assessment.lifecycle === "archived") score -= 20;
  score += matchedTerms * 8;
  score += getFreshnessScore(assessment.row.updated_at) * 10;

  const reasons: string[] = [];
  if (inScope) reasons.push("current tracked status in the requested scope");
  else if (assessment.lifecycle === "blocked") reasons.push("blocked tracked status");
  else if (includeAttention && assessment.needsAttention) reasons.push("attention-worthy tracked status");
  else reasons.push(`${assessment.lifecycle} tracked status`);
  if (matchedTerms > 0) reasons.push("matched opener/project terms");

  let suggestedAction = "Read the current status, then continue from the listed next steps.";
  if (assessment.lifecycle === "blocked") {
    suggestedAction = "Read the blocker context first, then decide whether to unblock or re-plan.";
  } else if (includeAttention && assessment.needsAttention && assessment.maintenanceItems.length > 0) {
    suggestedAction = assessment.maintenanceItems[0].suggestion;
  }

  return {
    item: {
      namespace: assessment.row.namespace,
      key: assessment.row.key,
      entry_id: assessment.row.id,
      category: "status",
      preview: contentPreview(assessment.row.content_preview, 220),
      updated_at: assessment.row.updated_at,
      reason: reasons.join("; "),
      suggested_action: suggestedAction,
    },
    score,
    openLoops: extractResumeOpenLoops(assessment),
    suggestedRead: {
      tool: "memory_read",
      namespace: assessment.row.namespace,
      key: assessment.row.key,
      reason: "Read the full tracked status before continuing work.",
    },
  };
}

function buildResumeStateCandidate(
  entry: Entry,
  scope: string,
  hintTerms: string[],
): ResumeCandidate {
  const matchText = `${entry.namespace} ${entry.key ?? ""} ${entry.content}`;
  const matchedTerms = countResumeTermMatches(matchText, hintTerms);

  return {
    item: {
      namespace: entry.namespace,
      key: entry.key,
      entry_id: entry.id,
      category: "state",
      preview: contentPreview(entry.content, 220),
      updated_at: entry.updated_at,
      reason: matchedTerms > 0
        ? "recent state entry in the requested scope that matched the opener"
        : "recent state entry in the requested scope",
      suggested_action: "Read this entry if you need implementation or reference context beyond the status.",
    },
    score: 60 + matchedTerms * 6 + getFreshnessScore(entry.updated_at) * 8 + (matchesNamespacePrefix(entry.namespace, scope) ? 20 : 0),
    openLoops: [],
    suggestedRead: entry.key
      ? {
          tool: "memory_read",
          namespace: entry.namespace,
          key: entry.key,
          reason: "Read the full state entry for additional project context.",
        }
      : undefined,
  };
}

function isDecisionLikeLog(entry: Entry): boolean {
  if (entry.entry_type !== "log") return false;
  const tags = parseTags(entry.tags);
  if (tags.some((tag) => ["decision", "milestone", "blocker", "discovery", "correction"].includes(tag))) {
    return true;
  }
  return /\b(decided|decision|milestone|blocker|resolved|discovered|corrected)\b/i.test(entry.content);
}

function isStrictDecisionLikeLog(entry: Entry): boolean {
  if (entry.entry_type !== "log") return false;
  const tags = parseTags(entry.tags);
  if (tags.includes("decision")) return true;
  return /\b(decided|decision|agreed to|settled on|chose to)\b/i.test(entry.content);
}

function buildResumeLogCandidate(
  entry: Entry,
  scope: string | undefined,
  hintTerms: string[],
): ResumeCandidate | null {
  if (!isDecisionLikeLog(entry)) return null;
  if (scope && !matchesNamespacePrefix(entry.namespace, scope)) return null;

  const matchText = `${entry.namespace} ${entry.content}`;
  const matchedTerms = countResumeTermMatches(matchText, hintTerms);
  const inScope = scope ? matchesNamespacePrefix(entry.namespace, scope) : false;

  return {
    item: {
      namespace: entry.namespace,
      key: entry.key,
      entry_id: entry.id,
      category: "decision_log",
      preview: contentPreview(entry.content, 220),
      updated_at: entry.updated_at,
      reason: inScope
        ? "recent decision-style log in the requested scope"
        : matchedTerms > 0
          ? "recent decision-style log that matched the opener"
          : "recent decision-style log in a likely-relevant namespace",
      suggested_action: "Read this log before making changes that could repeat or undo an earlier decision.",
    },
    score: (inScope ? 85 : 35) + matchedTerms * 7 + getFreshnessScore(entry.updated_at) * 8,
    openLoops: [],
    suggestedRead: {
      tool: "memory_get",
      id: entry.id,
      reason: "Open the full decision log entry for rationale and chronology.",
    },
  };
}

function buildResumeHistoryCandidate(entry: AuditHistoryEntry, scope: string): ResumeCandidate {
  const detail = entry.detail ? contentPreview(entry.detail, 180) : `${entry.action} ${entry.key ?? "namespace"}`;
  return {
    item: {
      namespace: entry.namespace,
      category: "history",
      preview: detail,
      updated_at: entry.timestamp,
      reason: "recent namespace mutation history",
      suggested_action: "Review recent writes and updates before continuing work in this namespace.",
    },
    score: 50 + (matchesNamespacePrefix(entry.namespace, scope) ? 15 : 0) + getFreshnessScore(entry.timestamp) * 6,
    openLoops: [],
    suggestedRead: {
      tool: "memory_history",
      namespace: scope,
      reason: "Inspect the recent mutation history for this namespace.",
    },
  };
}

function compareResumeCandidates(a: ResumeCandidate, b: ResumeCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.item.updated_at !== a.item.updated_at) return b.item.updated_at.localeCompare(a.item.updated_at);
  if (a.item.namespace !== b.item.namespace) return a.item.namespace.localeCompare(b.item.namespace);
  if ((a.item.key ?? "") !== (b.item.key ?? "")) return (a.item.key ?? "").localeCompare(b.item.key ?? "");
  return a.item.category.localeCompare(b.item.category);
}

interface ExtractSignals {
  decisions: string[];
  nextSteps: string[];
  preferences: string[];
  currentWork?: string;
  blockers?: string;
  phase?: string;
  lifecycle?: "active" | "blocked" | "completed" | "stopped" | "maintenance" | "archived";
  hasRelativeDates: boolean;
}

function normalizeTranscriptLine(line: string): string {
  return line
    .replace(TRANSCRIPT_SPEAKER_PREFIX_RE, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

function normalizeCompareText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function splitExtractFragments(line: string): string[] {
  return line
    .split("\n")
    .flatMap((segment) => segment.split(/(?<=[.!?])\s+/))
    .flatMap((segment) => segment.split(/\s*;\s*/))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function normalizeExtractStep(text: string): string {
  const normalized = text
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(EXTRACT_STEP_PREFIX, "")
    .replace(/^[:;,\-–—)\]]+\s*/, "")
    .replace(/^to\s+/i, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function isolateInlineExplicitStep(fragment: string): string {
  const match = fragment.match(EXTRACT_INLINE_EXPLICIT_STEP);
  if (!match || match.index === undefined) return fragment;
  return fragment.slice(match.index).trim();
}

function extractActionableNextSteps(line: string, force = false): string[] {
  return line
    .split(/\s*(?:,?\s+then\s+|;\s*)/i)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0)
    .flatMap((fragment) => {
      const candidate = isolateInlineExplicitStep(fragment);
      if (!force && looksLikeRetrospectiveCompletion(candidate)) return [];
      if (!force && EXTRACT_RECAP_LANGUAGE.test(candidate) && !EXTRACT_FUTURE_LANGUAGE.test(candidate)) {
        return [];
      }
      if (!force && !EXTRACT_ACTION_STEP_CUE.test(candidate) && !EXTRACT_IMPERATIVE_STEP_PREFIX.test(candidate)) {
        return [];
      }
      const normalized = normalizeExtractStep(candidate);
      return normalized ? [normalized] : [];
    });
}

function isNarrativeMetaDiscussion(text: string): boolean {
  return NARRATIVE_META_DISCUSSION_TERMS.test(text);
}

function isOperationalReleaseDecisionLog(entry: Entry): boolean {
  return NARRATIVE_OPERATIONAL_RELEASE_TERMS.test(entry.content) && !NARRATIVE_DECISION_RATIONALE_TERMS.test(entry.content);
}

function isChurnRelevantDecisionLog(entry: Entry): boolean {
  return isStrictDecisionLikeLog(entry) && !isNarrativeMetaDiscussion(entry.content) && !isOperationalReleaseDecisionLog(entry);
}

function hasNarrativeChurnMarker(entry: Entry): boolean {
  return NARRATIVE_CHURN_MARKERS.test(entry.content);
}

function inferExtractLifecycle(line: string): ExtractSignals["lifecycle"] | undefined {
  if (/^lifecycle:/i.test(line)) {
    const value = line.replace(/^lifecycle:\s*/i, "").trim().toLowerCase();
    if (value === "active" || value === "blocked" || value === "completed" || value === "stopped" || value === "maintenance" || value === "archived") {
      return value;
    }
  }
  if (/\b(paused|parked|on hold|stopped)\b/i.test(line)) return "stopped";
  if (/\b(active again|back in progress|resumed)\b/i.test(line)) return "active";
  if (/\b(blocked|waiting on|depends on)\b/i.test(line)) return "blocked";
  if (EXTRACT_COMPLETED_LIFECYCLE.test(line)) return "completed";
  return undefined;
}

function extractConversationSignals(conversationText: string): ExtractSignals {
  const lines = conversationText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const decisions: string[] = [];
  const nextSteps: string[] = [];
  const preferences: string[] = [];
  let currentWork: string | undefined;
  let blockers: string | undefined;
  let phase: string | undefined;
  let lifecycle: ExtractSignals["lifecycle"];
  let section: "next_steps" | "decisions" | "preferences" | null = null;
  let hasRelativeDates = false;

  for (const rawLine of lines) {
    const line = normalizeTranscriptLine(rawLine);
    if (!line) {
      section = null;
      continue;
    }

    if (/\b(today|tomorrow|yesterday|by friday|by monday|by tuesday|by wednesday|by thursday|by saturday|by sunday|next week|next month)\b/i.test(line)) {
      hasRelativeDates = true;
    }
    if (/^next steps?:/i.test(line) || /^action items?:/i.test(line) || /^todo:?/i.test(line)) {
      section = "next_steps";
      const remainder = line.replace(/^(next steps?|action items?|todo):\s*/i, "").trim();
      if (remainder) nextSteps.push(...extractActionableNextSteps(remainder, true));
      continue;
    }
    if (/^decisions?:/i.test(line)) {
      section = "decisions";
      const remainder = line.replace(/^decisions?:\s*/i, "").trim();
      if (remainder) decisions.push(remainder);
      continue;
    }
    if (/^preferences?:/i.test(line)) {
      section = "preferences";
      const remainder = line.replace(/^preferences?:\s*/i, "").trim();
      if (remainder) preferences.push(remainder);
      continue;
    }
    if (/^phase:/i.test(line)) {
      phase = line.replace(/^phase:\s*/i, "").trim();
      continue;
    }
    if (/^current work:/i.test(line)) {
      currentWork = line.replace(/^current work:\s*/i, "").trim();
      continue;
    }
    if (/^blockers?:/i.test(line)) {
      blockers = line.replace(/^blockers?:\s*/i, "").trim();
      lifecycle = lifecycle ?? "blocked";
      continue;
    }

    const isBullet = /^[-*]\s+/.test(rawLine.trim()) || /^\d+\.\s+/.test(rawLine.trim());
    if (isBullet && section === "next_steps") {
      nextSteps.push(...extractActionableNextSteps(line, true));
      continue;
    }
    if (isBullet && section === "decisions") {
      decisions.push(line);
      continue;
    }
    if (isBullet && section === "preferences") {
      preferences.push(line);
      continue;
    }

    for (const fragment of splitExtractFragments(line)) {
      if (/\b(decided|decision:|agreed to|settled on|chose to)\b/i.test(fragment)) {
        decisions.push(fragment);
      }
      nextSteps.push(...extractActionableNextSteps(fragment));
      if (/\b(i prefer|i don't like|i do not like|please remember|remember that|i always|i never)\b/i.test(fragment)) {
        preferences.push(fragment);
      }

      if (!currentWork && /\b(current work|working on|in progress)\b/i.test(fragment)) {
        currentWork = fragment;
      }
      if (!blockers && /\b(blocked|waiting on|depends on)\b/i.test(fragment.toLowerCase())) {
        blockers = fragment;
        lifecycle = "blocked";
      }
      if (!lifecycle) {
        lifecycle = inferExtractLifecycle(fragment);
      }
    }
  }

  return {
    decisions: [...new Set(decisions.map((line) => line.trim()).filter(Boolean))],
    nextSteps: [...new Set(nextSteps.map((line) => line.trim()).filter(Boolean))],
    preferences: [...new Set(preferences.map((line) => line.trim()).filter(Boolean))],
    currentWork: currentWork?.trim() || undefined,
    blockers: blockers?.trim() || undefined,
    phase: phase?.trim() || undefined,
    lifecycle,
    hasRelativeDates,
  };
}

function resolveExtractNamespace(
  params: ExtractParams,
  conversationText: string,
  trackedStatusAssessments: TrackedStatusAssessment[],
  ctx: AccessContext,
): {
  primaryNamespace?: string;
  candidateNamespaces: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const candidateNamespaces: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (namespace: string | undefined, warningWhenDenied?: string) => {
    if (!namespace) return;
    if (seen.has(namespace)) return;
    if (canWrite(ctx, namespace)) {
      seen.add(namespace);
      candidateNamespaces.push(namespace);
      return;
    }
    if (warningWhenDenied) warnings.push(warningWhenDenied);
  };

  if (typeof params.namespace_hint === "string" && params.namespace_hint.trim().length > 0) {
    addCandidate(
      params.namespace_hint.trim(),
      `Skipped namespace_hint ${params.namespace_hint.trim()} because the current principal cannot write there.`,
    );
  }

  const scopeFromProject = resolveResumeScope({
    namespace: params.namespace_hint,
    project: params.project_hint,
  }, trackedStatusAssessments);
  if (scopeFromProject && scopeFromProject !== params.namespace_hint) {
    addCandidate(
      scopeFromProject,
      `Skipped project-derived namespace ${scopeFromProject} because the current principal cannot write there.`,
    );
  }

  const hintTerms = extractResumeTerms(params.namespace_hint, params.project_hint, conversationText);
  const inferredTrackedNamespaces = trackedStatusAssessments
    .filter((assessment) => canWrite(ctx, assessment.row.namespace))
    .map((assessment) => ({
      namespace: assessment.row.namespace,
      score: countResumeTermMatches(`${assessment.row.namespace} ${assessment.row.content_preview}`, hintTerms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace))
    .slice(0, 3);

  for (const candidate of inferredTrackedNamespaces) {
    addCandidate(candidate.namespace);
  }

  return {
    primaryNamespace: candidateNamespaces[0],
    candidateNamespaces,
    warnings,
  };
}

interface ExtractRelatedSource {
  entry: Entry;
  reason: string;
}

function buildExtractRelatedEntries(
  db: Database.Database,
  namespace: string | undefined,
  ctx: AccessContext,
  sessionId?: string,
): { entries: ExtractRelatedEntry[]; redacted: RedactableEntryMetadata[] } {
  if (!namespace || !canRead(ctx, namespace)) {
    return { entries: [], redacted: [] };
  }

  const related: ExtractRelatedSource[] = [];
  const seenIds = new Set<string>();

  const pushEntry = (entry: Entry | null, reason: string) => {
    if (!entry) return;
    if (!canRead(ctx, entry.namespace)) return;
    if (seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    related.push({ entry, reason });
  };

  pushEntry(readState(db, namespace, "status"), "current status in the hinted namespace");

  for (const entry of queryEntriesByFilter(db, {
    namespace,
    entryType: "log",
    limit: 2,
  })) {
    pushEntry(entry, "recent decision or activity log in the hinted namespace");
  }

  for (const entry of queryEntriesByFilter(db, {
    namespace,
    entryType: "state",
    includeExpired: true,
    limit: 3,
  }).filter((entry) => entry.key !== "status")) {
    pushEntry(entry, "recent state entry in the hinted namespace");
  }

  const filtered = filterDerivedSources(
    db,
    ctx,
    related,
    "memory_extract",
    (source) => buildRedactableEntryMetadata(parseEntry(source.entry)),
    sessionId,
  );

  return {
    entries: filtered.allowed.slice(0, 5).map((source) => ({
      id: source.entry.id,
      namespace: source.entry.namespace,
      key: source.entry.key,
      entry_type: source.entry.entry_type,
      preview: contentPreview(source.entry.content, 220),
      updated_at: source.entry.updated_at,
      reason: source.reason,
    })),
    redacted: filtered.redacted,
  };
}

function buildExistingContextSet(relatedEntries: ExtractRelatedEntry[]): Set<string> {
  return new Set(relatedEntries.map((entry) => normalizeCompareText(entry.preview)));
}

function determineWriteKeyForNamespace(namespace: string): string {
  if (namespace.startsWith("people/")) return "profile";
  return "notes";
}

function determineWriteTags(namespace: string): string[] {
  if (namespace.startsWith("people/")) return ["preference"];
  return ["note"];
}

function buildExtractSuggestions(
  signals: ExtractSignals,
  namespace: string | undefined,
  relatedEntries: ExtractRelatedEntry[],
): {
  suggestions: ExtractSuggestion[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!namespace) {
    return {
      suggestions: [],
      warnings: ["No clear writable namespace was found. Pass namespace_hint or project_hint for better suggestions."],
    };
  }

  const existingContext = buildExistingContextSet(relatedEntries);
  const duplicateLines: string[] = [];
  const suggestions: ExtractSuggestion[] = [];

  const isTracked = isTrackedNamespace(namespace);
  const isPeopleNamespace = namespace.startsWith("people/");

  const dedupeLine = (line: string): boolean => {
    const normalized = normalizeCompareText(line);
    if (existingContext.has(normalized)) {
      duplicateLines.push(line);
      return true;
    }
    return false;
  };

  if (signals.decisions.length > 0) {
    for (const line of signals.decisions) {
      if (dedupeLine(line)) continue;
      suggestions.push({
        action: "memory_log",
        namespace,
        content: line,
        tags: ["decision"],
        rationale: "Explicit decision-style language was found in the conversation.",
        confidence: 0.96,
      });
    }
  }

  const statusPatch: NonNullable<ExtractSuggestion["status_patch"]> = {};
  if (signals.phase) statusPatch.phase = signals.phase;
  if (signals.currentWork) statusPatch.current_work = signals.currentWork;
  if (signals.blockers) statusPatch.blockers = signals.blockers;
  if (signals.nextSteps.length > 0) {
    const dedupedSteps = signals.nextSteps.filter((line) => !dedupeLine(line));
    if (dedupedSteps.length > 0) statusPatch.next_steps = dedupedSteps;
  }
  if (signals.lifecycle) statusPatch.lifecycle = signals.lifecycle;

  if (isTracked && (
    statusPatch.phase !== undefined ||
    statusPatch.current_work !== undefined ||
    statusPatch.blockers !== undefined ||
    (statusPatch.next_steps !== undefined && statusPatch.next_steps.length > 0) ||
    statusPatch.lifecycle !== undefined
  )) {
    suggestions.push({
      action: "memory_update_status",
      namespace,
      status_patch: statusPatch,
      rationale: "The conversation included explicit project-status signals such as current work, blockers, next steps, or lifecycle changes.",
      confidence: 0.91,
    });
  } else if (!isTracked && signals.nextSteps.length > 0) {
    const nonDuplicateSteps = signals.nextSteps.filter((line) => !duplicateLines.includes(line));
    if (nonDuplicateSteps.length > 0) {
      suggestions.push({
        action: "memory_write",
        namespace,
        key: determineWriteKeyForNamespace(namespace),
        content: nonDuplicateSteps.map((step) => `- ${step}`).join("\n"),
        tags: determineWriteTags(namespace),
        rationale: "The conversation included explicit next steps, but the target namespace is not tracked, so a state write is a better fit than status patching.",
        confidence: 0.79,
      });
    }
  }

  if (signals.preferences.length > 0 && isPeopleNamespace) {
    const nonDuplicatePreferences = signals.preferences.filter((line) => !dedupeLine(line));
    if (nonDuplicatePreferences.length > 0) {
      suggestions.push({
        action: "memory_write",
        namespace,
        key: "profile",
        content: nonDuplicatePreferences.map((line) => `- ${line}`).join("\n"),
        tags: ["preference"],
        rationale: "The conversation included explicit preference-style statements suited for a people profile.",
        confidence: 0.82,
      });
    }
  } else if (signals.preferences.length > 0) {
    warnings.push("Preference-style lines were found, but no people/* namespace was identified, so no profile suggestion was produced.");
  }

  if (duplicateLines.length > 0) {
    warnings.push(`Skipped ${duplicateLines.length} extracted line${duplicateLines.length === 1 ? "" : "s"} that already appeared in the related context.`);
  }
  if (signals.hasRelativeDates) {
    warnings.push("Relative date phrases were captured verbatim. Review them before writing durable memory.");
  }

  return { suggestions, warnings };
}

const NARRATIVE_LONG_GAP_DAYS = 14;
const NARRATIVE_BLOCKER_DAYS = 3;
const NARRATIVE_DECISION_CHURN_THRESHOLD = 3;
const NARRATIVE_REVERSAL_KEYWORDS = /\b(reopen|reopened|resume|resumed|paused|parked|on hold|unblocked|rolled back|active again)\b/i;
const NARRATIVE_STRONG_REVERSAL_RESUME = /\b(reopen|reopened|resume|resumed|unblocked|active again)\b/i;
const NARRATIVE_STRONG_REVERSAL_PAUSE = /\b(pause|pausing|paused|parked|parking|on hold|rolled back|rollback)\b/i;

function getLifecycleFromEntry(entry: Entry): string | undefined {
  const tags = parseTags(entry.tags);
  const { canonical } = canonicalizeTags(tags);
  return getLifecycleTags(canonical)[0];
}

function resolveNarrativeStatusEntry(db: Database.Database, namespace: string): Entry | null {
  if (!namespace.endsWith("/")) {
    return readState(db, namespace, "status");
  }

  return queryEntriesByFilter(db, {
    namespace,
    entryType: "state",
    includeExpired: true,
    limit: 20,
  }).find((entry) => entry.key === "status") ?? null;
}

function buildNarrativeSourceFromEntry(entry: Entry): NarrativeSource {
  return {
    kind: "entry",
    id: entry.id,
    namespace: entry.namespace,
    key: entry.key,
    timestamp: entry.entry_type === "log" ? entry.created_at : entry.updated_at,
    preview: contentPreview(entry.content, 220),
  };
}

function buildNarrativeSourceFromAudit(entry: AuditHistoryEntry): NarrativeSource {
  return {
    kind: "audit",
    id: entry.id,
    namespace: entry.namespace,
    key: entry.key,
    timestamp: entry.timestamp,
    preview: contentPreview(entry.detail ?? `${entry.action} ${entry.key ?? "namespace"}`, 220),
  };
}

function getDaysSince(timestamp: string): number {
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / (24 * 60 * 60 * 1000));
}

function buildNarrativeStatusSummary(entry: Entry): string {
  const structured = parseStructuredStatus(entry.content);
  const lifecycle = getLifecycleFromEntry(entry);
  const phase = structured.phase ?? lifecycle ?? "Unspecified";
  const currentWork = structured.current_work ? ` ${contentPreview(structured.current_work, 120)}` : "";
  return `Status in phase ${phase}.${currentWork}`;
}

function buildNarrativeSignals(
  namespace: string,
  statusEntry: Entry | null,
  logs: Entry[],
  history: AuditHistoryEntry[],
): NarrativeSignal[] {
  const signals: NarrativeSignal[] = [];
  const seenSummaries = new Set<string>();

  const pushSignal = (signal: NarrativeSignal) => {
    if (seenSummaries.has(signal.summary)) return;
    seenSummaries.add(signal.summary);
    signals.push(signal);
  };

  if (statusEntry) {
    const structured = parseStructuredStatus(statusEntry.content);
    const lifecycle = getLifecycleFromEntry(statusEntry);
    const phase = structured.phase ?? lifecycle ?? "Unspecified";
    const daysInPhase = getDaysSince(statusEntry.updated_at);

    pushSignal({
      category: "time_in_phase",
      severity: daysInPhase > NARRATIVE_LONG_GAP_DAYS && (lifecycle === "active" || lifecycle === "blocked") ? "medium" : "low",
      summary: `Current phase "${phase}" has held for ${daysInPhase} day${daysInPhase === 1 ? "" : "s"}.`,
      reason: "Derived from the current tracked status timestamp.",
      source_entry_ids: [statusEntry.id],
      source_audit_ids: [],
    });

    const blockerText = structured.blockers?.trim();
    if (
      ((lifecycle === "blocked") || (blockerText && !isNoneLikeStatusText(blockerText))) &&
      daysInPhase >= NARRATIVE_BLOCKER_DAYS
    ) {
      pushSignal({
        category: "blocker_age",
        severity: daysInPhase > NARRATIVE_LONG_GAP_DAYS ? "high" : "medium",
        summary: `Blocker context has been unchanged for ${daysInPhase} day${daysInPhase === 1 ? "" : "s"}.`,
        reason: "Current status is blocked or still lists blockers, and the status has not been refreshed recently.",
        source_entry_ids: [statusEntry.id],
        source_audit_ids: [],
      });
    }

    const latestActivity = [statusEntry.updated_at, ...logs.map((entry) => entry.updated_at)]
      .sort()
      .at(-1);
    if (latestActivity) {
      const daysSinceActivity = getDaysSince(latestActivity);
      if (
        daysSinceActivity >= NARRATIVE_LONG_GAP_DAYS &&
        lifecycle !== "maintenance" &&
        lifecycle !== "completed" &&
        lifecycle !== "stopped" &&
        lifecycle !== "archived"
      ) {
        pushSignal({
          category: "long_gap",
          severity: lifecycle === "blocked" ? "high" : "medium",
          summary: `No meaningful updates have landed for ${daysSinceActivity} day${daysSinceActivity === 1 ? "" : "s"}.`,
          reason: "Derived from the most recent status or log activity in this namespace.",
          source_entry_ids: [statusEntry.id, ...logs.slice(0, 2).map((entry) => entry.id)],
          source_audit_ids: [],
        });
      }
    }
  }

  const decisionLogs = logs.filter((entry) => isChurnRelevantDecisionLog(entry));
  const churnMarkerLogs = decisionLogs.filter((entry) => hasNarrativeChurnMarker(entry));
  if (decisionLogs.length >= NARRATIVE_DECISION_CHURN_THRESHOLD && churnMarkerLogs.length >= 2) {
    const newest = decisionLogs[0];
    const oldest = decisionLogs.at(-1)!;
    const spanDays = Math.max(0, getDaysSince(oldest.created_at) - getDaysSince(newest.created_at));
    pushSignal({
      category: "decision_churn",
      severity: decisionLogs.length >= 5 ? "high" : "medium",
      summary: `${decisionLogs.length} decision-like log entries landed across roughly ${spanDays} day${spanDays === 1 ? "" : "s"}.`,
      reason: "A dense cluster of decision logs plus explicit re-evaluation language suggests active churn rather than ordinary planning activity.",
      source_entry_ids: decisionLogs
        .filter((entry) => hasNarrativeChurnMarker(entry))
        .slice(0, 5)
        .map((entry) => entry.id),
      source_audit_ids: [],
    });
  }

  const reversalLogs = logs.filter((entry) =>
    NARRATIVE_REVERSAL_KEYWORDS.test(entry.content) && !isNarrativeMetaDiscussion(entry.content)
  );
  const strongReversalLogs = reversalLogs.filter((entry) =>
    /\b(reopened|rolled back)\b/i.test(entry.content) ||
    (NARRATIVE_STRONG_REVERSAL_RESUME.test(entry.content) && NARRATIVE_STRONG_REVERSAL_PAUSE.test(entry.content))
  );
  const statusHistory = history.filter((entry) => entry.key === "status" && ((entry.action as string) === "write" || (entry.action as string) === "update" || (entry.action as string) === "patch"));
  if (strongReversalLogs.length >= 1 || reversalLogs.length >= 2) {
    pushSignal({
      category: "reversal_pattern",
      severity: reversalLogs.length >= 2 ? "medium" : "low",
      summary: `Recent logs and status changes suggest reopen or reversal behavior in ${namespace}.`,
      reason: strongReversalLogs.length >= 1
        ? "Detected explicit resume/pause or reopen language in recent logs."
        : "Detected repeated reversal-style language in recent logs.",
      source_entry_ids: (strongReversalLogs.length >= 1 ? strongReversalLogs : reversalLogs).slice(0, 3).map((entry) => entry.id),
      source_audit_ids: statusHistory.slice(0, 3).map((entry) => entry.id),
    });
  }

  const severityRank: Record<NarrativeSignal["severity"], number> = { high: 3, medium: 2, low: 1 };
  return signals.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || a.category.localeCompare(b.category));
}

function buildNarrativeTimeline(
  statusEntry: Entry | null,
  logs: Entry[],
  history: AuditHistoryEntry[],
  limit: number,
): NarrativeTimelineItem[] {
  const items: NarrativeTimelineItem[] = [];

  if (statusEntry) {
    items.push({
      timestamp: statusEntry.updated_at,
      category: "status",
      summary: buildNarrativeStatusSummary(statusEntry),
      source_entry_id: statusEntry.id,
    });
  }

  for (const entry of logs) {
    items.push({
      timestamp: entry.created_at,
      category: "log",
      summary: contentPreview(entry.content, 180),
      source_entry_id: entry.id,
    });
  }

  for (const entry of history) {
    items.push({
      timestamp: entry.timestamp,
      category: "audit",
      summary: contentPreview(entry.detail ?? `${entry.action} ${entry.key ?? "namespace"}`, 180),
      source_audit_id: entry.id,
    });
  }

  return items
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.category.localeCompare(b.category))
    .slice(0, limit);
}

function buildNarrativeSources(
  includeSources: boolean,
  statusEntry: Entry | null,
  logs: Entry[],
  history: AuditHistoryEntry[],
): NarrativeSource[] | undefined {
  if (!includeSources) return undefined;

  const sources: NarrativeSource[] = [];
  const seen = new Set<string>();

  const push = (source: NarrativeSource) => {
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };

  if (statusEntry) push(buildNarrativeSourceFromEntry(statusEntry));
  for (const entry of logs) push(buildNarrativeSourceFromEntry(entry));
  for (const entry of history) push(buildNarrativeSourceFromAudit(entry));

  return sources;
}

const COMMITMENT_SOON_DAYS = 3;
const COMMITMENT_COMPLETED_RECENT_DAYS = 14;
const COMMITMENT_ACTION_VERB =
  /\b(send|ship|deliver|finish|complete|publish|deploy|update|write|call|review|rerun|check)\b/i;
const COMMITMENT_FORWARD_CUE =
  /\b(will|must|need to|needs to|plan to|planned|should|target(?:ing)?|aim to|by|due)\b/i;
const COMMITMENT_IMPERATIVE_PREFIX =
  /^(?:next(?:\s+steps?)?:\s*)?(send|ship|deliver|finish|complete|publish|deploy|update|write|call|review|rerun|check)\b/i;
const COMMITMENT_RETROSPECTIVE_CUE =
  /\b(committed|completed|finished|pushed|shipped|delivered|published|deployed|resolved|closed|landed|wrapped up|done)\b/i;
const COMMITMENT_FUTURE_COMPLETION_PHRASE =
  /\b(must|need to|needs to|should|will|plan to|planned to|target(?:ing)? to|aim to)\s+(?:be\s+)?(completed|finished|shipped|delivered|published|deployed)\b/i;

function mapTrackedStatusAssessmentsByNamespace(
  assessments: TrackedStatusAssessment[],
): Map<string, TrackedStatusAssessment> {
  const byNamespace = new Map<string, TrackedStatusAssessment>();
  for (const assessment of assessments) {
    byNamespace.set(assessment.row.namespace, assessment);
  }
  return byNamespace;
}

function normalizeCommitmentText(text: string): string {
  return normalizeCompareText(
    text
      .replace(/^[-*]\s+/, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function buildDueAtFromDateString(dateString: string): string | null {
  const parsed = new Date(`${dateString}T23:59:59Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function extractDueAtFromText(text: string): string | null {
  const match = text.match(DATE_PATTERN);
  if (!match || match.length === 0) return null;
  return buildDueAtFromDateString(match[0]);
}

function extractCandidateSegments(content: string): string[] {
  return content
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function looksLikeRetrospectiveCompletion(segment: string): boolean {
  return COMMITMENT_RETROSPECTIVE_CUE.test(segment) && !COMMITMENT_FUTURE_COMPLETION_PHRASE.test(segment);
}

function isForwardLookingDatedCommitment(segment: string): boolean {
  if (!COMMITMENT_ACTION_VERB.test(segment)) return false;
  if (looksLikeRetrospectiveCompletion(segment)) return false;
  return COMMITMENT_FORWARD_CUE.test(segment) || COMMITMENT_IMPERATIVE_PREFIX.test(segment);
}

function extractCommitmentsFromEntry(entry: Entry): DerivedCommitmentInput[] {
  const commitments: DerivedCommitmentInput[] = [];
  const seenNormalized = new Set<string>();

  const pushCommitment = (commitment: DerivedCommitmentInput, normalizedText: string) => {
    if (seenNormalized.has(normalizedText)) return;
    seenNormalized.add(normalizedText);
    commitments.push(commitment);
  };

  if (entry.entry_type === "state" && entry.key === "status" && isTrackedNamespace(entry.namespace)) {
    const structured = parseStructuredStatus(entry.content);
    for (const step of structured.next_steps ?? []) {
      if (isNoneLikeStatusText(step)) continue;
      const normalized = normalizeCommitmentText(step);
      if (!normalized) continue;
      pushCommitment({
        sourceType: "tracked_next_step",
        fingerprint: `tracked_next_step:${normalized}`,
        text: step.trim(),
        dueAt: extractDueAtFromText(step),
        confidence: 0.96,
      }, normalized);
    }
  }

  for (const segment of extractCandidateSegments(entry.content)) {
    const dueAt = extractDueAtFromText(segment);
    if (!dueAt) continue;
    if (!isForwardLookingDatedCommitment(segment)) continue;

    const normalized = normalizeCommitmentText(segment);
    if (!normalized) continue;
    pushCommitment({
      sourceType: "explicit_dated_commitment",
      fingerprint: `explicit_dated_commitment:${normalized}`,
      text: segment.trim(),
      dueAt,
      confidence: 0.78,
    }, normalized);
  }

  return commitments;
}

function syncCommitmentsForScope(
  db: Database.Database,
  ctx: AccessContext,
  toolName: string,
  namespace?: string,
  since?: string,
  sessionId?: string,
): RedactableEntryMetadata[] {
  const entries = listEntriesForDerivation(db, { namespace, since })
    .filter((entry) => canRead(ctx, entry.namespace));
  const filtered = filterDerivedSources(
    db,
    ctx,
    entries,
    toolName,
    (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
    sessionId,
  );

  for (const entry of filtered.allowed) {
    syncCommitmentsForEntry(db, entry.id, extractCommitmentsFromEntry(entry));
  }

  return filtered.redacted;
}

function listFreshCommitmentRows(
  db: Database.Database,
  ctx: AccessContext,
  toolName: string,
  options: {
    namespace?: string;
    since?: string;
    limit: number;
    includeResolved?: boolean;
  },
  sessionId?: string,
): { rows: CommitmentRow[]; redacted: RedactableEntryMetadata[] } {
  const { namespace, since, limit, includeResolved = true } = options;
  const redactedSources = syncCommitmentsForScope(db, ctx, toolName, namespace, since, sessionId);

  const refreshCandidates = listCommitments(db, {
    namespace,
    since,
    limit,
    includeResolved: true,
  }).filter((row) => canRead(ctx, row.namespace));

  const allowedRefreshCandidates = filterDerivedSources(
    db,
    ctx,
    refreshCandidates,
    toolName,
    (row) => ({
      id: row.source_entry_id,
      namespace: row.namespace,
      key: row.source_key,
      classification: row.source_classification,
    }),
    sessionId,
  );

  const seenSourceEntries = new Set<string>();
  for (const row of allowedRefreshCandidates.allowed) {
    if (seenSourceEntries.has(row.source_entry_id)) continue;
    seenSourceEntries.add(row.source_entry_id);
    const entry = getById(db, row.source_entry_id);
    if (!entry || !canRead(ctx, entry.namespace)) continue;
    const entryFilter = filterDerivedSources(
      db,
      ctx,
      [entry],
      toolName,
      (candidate) => buildRedactableEntryMetadata(parseEntry(candidate)),
      sessionId,
    );
    if (entryFilter.allowed.length === 0) {
      redactedSources.push(...entryFilter.redacted);
      continue;
    }
    syncCommitmentsForEntry(db, entry.id, extractCommitmentsFromEntry(entry));
  }

  const rows = listCommitments(db, {
    namespace,
    since,
    limit,
    includeResolved,
  }).filter((row) => canRead(ctx, row.namespace));

  const visibleRows = filterDerivedSources(
    db,
    ctx,
    rows,
    toolName,
    (row) => ({
      id: row.source_entry_id,
      namespace: row.namespace,
      key: row.source_key,
      classification: row.source_classification,
    }),
    sessionId,
  );

  return {
    rows: visibleRows.allowed,
    redacted: combineRedactedSources(
      redactedSources,
      allowedRefreshCandidates.redacted,
      visibleRows.redacted,
    ),
  };
}

function buildCommitmentItem(row: CommitmentRow, reason?: string): CommitmentItem {
  return {
    id: row.id,
    namespace: row.namespace,
    text: row.text,
    due_at: row.due_at,
    status: row.status,
    confidence: row.confidence,
    source_type: row.source_type,
    source_entry_id: row.source_entry_id,
    source_key: row.source_key,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    source_excerpt: row.source_excerpt,
    source_classification: row.source_classification,
    reason,
  };
}

function compareCommitmentItems(a: CommitmentItem, b: CommitmentItem): number {
  const aDue = a.due_at ?? "9999-12-31T23:59:59.999Z";
  const bDue = b.due_at ?? "9999-12-31T23:59:59.999Z";
  if (aDue !== bDue) return aDue.localeCompare(bDue);
  if (a.updated_at !== b.updated_at) return b.updated_at.localeCompare(a.updated_at);
  return a.namespace.localeCompare(b.namespace);
}

function classifyCommitments(
  rows: CommitmentRow[],
  trackedStatusByNamespace: Map<string, TrackedStatusAssessment>,
  limit: number,
) {
  const now = nowUTC();
  const completedCutoff = new Date(Date.now() - COMMITMENT_COMPLETED_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const open: CommitmentItem[] = [];
  const atRisk: CommitmentItem[] = [];
  const overdue: CommitmentItem[] = [];
  const completedRecently: CommitmentItem[] = [];

  for (const row of rows) {
    const assessment = trackedStatusByNamespace.get(row.namespace);

    if (row.status === "done" && row.resolved_at && row.resolved_at >= completedCutoff) {
      completedRecently.push(buildCommitmentItem(row, "Recently resolved from an explicit source entry."));
      continue;
    }

    if (row.status !== "open") continue;

    if (row.due_at && row.due_at < now) {
      overdue.push(buildCommitmentItem(row, `Due at ${row.due_at}.`));
      continue;
    }

    const dueSoon = row.due_at
      ? getDaysUntil(row.due_at) <= COMMITMENT_SOON_DAYS
      : false;
    const blockedNamespace = assessment?.lifecycle === "blocked";
    const attentionNamespace = assessment?.needsAttention ?? false;

    if (dueSoon || blockedNamespace || attentionNamespace) {
      let reason = row.due_at
        ? `Due soon at ${row.due_at}.`
        : "Source namespace needs attention.";
      if (blockedNamespace) {
        reason = "Source namespace is currently blocked.";
      } else if (attentionNamespace && assessment?.maintenanceItems[0]) {
        reason = assessment.maintenanceItems[0].suggestion;
      }
      atRisk.push(buildCommitmentItem(row, reason));
      continue;
    }

    open.push(buildCommitmentItem(row));
  }

  return {
    open: open.sort(compareCommitmentItems).slice(0, limit),
    at_risk: atRisk.sort(compareCommitmentItems).slice(0, limit),
    overdue: overdue.sort(compareCommitmentItems).slice(0, limit),
    completed_recently: completedRecently
      .sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? ""))
      .slice(0, limit),
  };
}

function extractPatternTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_-]+/i)
        .map((term) => term.trim())
        .filter((term) =>
          term.length >= 4 &&
          !RELAXED_QUERY_STOPWORDS.has(term) &&
          !PATTERN_GENERIC_TERMS.has(term) &&
          !/^\d+$/.test(term) &&
          !/^\d{4}-\d{2}-\d{2}$/.test(term),
        ),
    ),
  ];
}

function buildPatternSources(entries: Entry[], sourceIds: Set<string>): PatternSource[] {
  return entries
    .filter((entry) => sourceIds.has(entry.id))
    .map((entry) => ({
      entry_id: entry.id,
      namespace: entry.namespace,
      key: entry.key,
      preview: contentPreview(entry.content, 220),
      updated_at: entry.updated_at,
    }));
}

function buildHandoffCurrentState(namespace: string, statusEntry: Entry | null, fallbackEntries: Entry[]): HandoffResponse["current_state"] {
  if (statusEntry) {
    return {
      namespace,
      summary: buildNarrativeStatusSummary(statusEntry),
      updated_at: statusEntry.updated_at,
      source_entry_id: statusEntry.id,
    };
  }

  const fallback = fallbackEntries.find((entry) => entry.entry_type === "state");
  if (!fallback) return null;
  return {
    namespace,
    summary: contentPreview(fallback.content, 220),
    updated_at: fallback.updated_at,
    source_entry_id: fallback.id,
  };
}

function buildHandoffRecentActors(history: AuditHistoryEntry[], limit: number) {
  const actors = new Map<string, { last_seen_at: string; actions: Set<string> }>();

  for (const entry of history) {
    const existing = actors.get(entry.agent_id) ?? { last_seen_at: entry.timestamp, actions: new Set<string>() };
    if (entry.timestamp > existing.last_seen_at) {
      existing.last_seen_at = entry.timestamp;
    }
    existing.actions.add(entry.action);
    actors.set(entry.agent_id, existing);
  }

  return [...actors.entries()]
    .map(([principal_id, value]) => ({
      principal_id,
      last_seen_at: value.last_seen_at,
      actions: [...value.actions].sort(),
    }))
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, limit);
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
    "- **Read vs get:** `memory_read` uses namespace+key. `memory_get` uses an entry UUID from query results.",
    "- **State entries** = current truth (mutable). **Log entries** = chronological (append-only).",
    "- **Write vs update_status:** use `memory_update_status` for tracked `projects/*`/`clients/*` status entries; use `memory_write` for other state.",
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
      `START HERE. Call this at the beginning of every conversation before using any other memory tool. Returns conventions, a computed project dashboard (grouped by lifecycle from status entries), optional curated notes, actionable maintenance suggestions, and optionally a namespace overview — everything needed to orient yourself in one call. Use \`memory_resume\` after this when you want a targeted continuation pack for a project, namespace, or opener.\n\nThe dashboard is computed automatically from status entries in projects/* and clients/* namespaces. No manual workbench maintenance needed. Demo namespaces and completed task-run namespaces are hidden by default.\n\nUse \`detail\` to control response size. \`${DEFAULT_ORIENT_DETAIL}\` is the default for token-sensitive handshakes, \`standard\` includes the full dashboard and namespace overview, and \`full\` includes the full conventions document.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        detail: {
          type: "string",
          enum: ["compact", "standard", "full"],
          description:
            `Optional. Controls response size. \`${DEFAULT_ORIENT_DETAIL}\` is the default, \`compact\` trims dashboard/namespaces, \`standard\` includes the full dashboard and namespace overview, and \`full\` returns the full conventions document.`,
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
    name: "memory_resume",
    description:
      "Build a compact, targeted continuation pack after `memory_orient`. Use this when you have a project hint, namespace, or opener and want the most relevant current status, recent decision context, open loops, and optional recent namespace history without running broad search.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        opener: {
          type: "string",
          description:
            "Optional. User opener or task phrasing to bias the pack toward likely-relevant context.",
        },
        namespace: {
          type: "string",
          description:
            "Optional. Exact namespace or namespace prefix to focus on. Prefer exact tracked namespaces such as `projects/grimnir`.",
        },
        project: {
          type: "string",
          description:
            "Optional. Project slug or tracked namespace hint, such as `grimnir` or `projects/grimnir`.",
        },
        limit: {
          type: "integer",
          description:
            "Optional. Maximum number of items to include in the resume pack. Default 6, max 10.",
        },
        include_history: {
          type: "boolean",
          description:
            "Optional. Include a few recent audit-history items for the focused namespace. Default: false.",
        },
        include_attention: {
          type: "boolean",
          description:
            "Optional. Include blocked or attention-worthy tracked work when relevant. Default: true.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_extract",
    description:
      "Suggest reviewable memory operations from explicit conversation signals. Use this after `memory_orient` when you have messy notes or transcript text and want proposed `memory_log`, `memory_write`, or `memory_update_status` calls. This tool is suggestion-only: it never writes to memory.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversation_text: {
          type: "string",
          description:
            "Raw transcript text, notes, or a rough recap to inspect for explicit capture-worthy signals.",
        },
        namespace_hint: {
          type: "string",
          description:
            "Optional. Exact namespace to target if you already know where the memory should go.",
        },
        project_hint: {
          type: "string",
          description:
            "Optional. Project slug or tracked namespace hint, such as `grimnir` or `projects/grimnir`.",
        },
        max_suggestions: {
          type: "integer",
          description:
            "Optional. Maximum number of suggestions to return. Default 5, max 10.",
        },
      },
      required: ["conversation_text"],
    },
  },
  {
    name: "memory_narrative",
    description:
      "Derive a compact narrative view for one namespace from current status, recent logs, and audit history. Use this when you want project-arc signals such as blocker age, decision churn, reversals, or long gaps without pretending that Munin has a hidden planning model. Every signal is source-backed.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Namespace or namespace prefix to analyze. For project arcs, prefer exact tracked namespaces such as `projects/munin-memory`.",
        },
        since: {
          type: "string",
          description:
            "Optional. ISO 8601 timestamp. Restrict logs and audit history to this lower bound.",
        },
        limit: {
          type: "integer",
          description:
            "Optional. Maximum number of timeline items to return. Default 8, max 20.",
        },
        include_sources: {
          type: "boolean",
          description:
            "Optional. Include explicit source objects for the signals and timeline. Default: false.",
        },
      },
      required: ["namespace"],
    },
  },
  {
    name: "memory_commitments",
    description:
      "Surface explicit commitments derived from tracked next steps and dated, attributable source text. Use this when you want to review open, at-risk, overdue, or recently completed follow-through items rather than rely on fuzzy prose search.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional. Restrict the view to one namespace or namespace prefix.",
        },
        since: {
          type: "string",
          description:
            "Optional. ISO 8601 timestamp. Restrict commitment derivation and listing to this lower bound.",
        },
        limit: {
          type: "integer",
          description:
            "Optional. Maximum number of items to return per bucket. Default 10, max 25.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_patterns",
    description:
      "Derive conservative, reviewable patterns from repeated decision logs, tracked-status follow-through, and commitment outcomes. Use this for compressed summaries, not hidden policy: every surfaced pattern stays tied to explicit source entries.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional. Restrict derivation to one namespace or namespace prefix.",
        },
        topic: {
          type: "string",
          description:
            "Optional. Simple term filter applied to candidate source text and namespace names.",
        },
        since: {
          type: "string",
          description:
            "Optional. ISO 8601 timestamp. Restrict candidate entries to this lower bound.",
        },
        limit: {
          type: "integer",
          description:
            "Optional. Maximum number of patterns and heuristics to return. Default 5, max 10.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_handoff",
    description:
      "Assemble a source-backed handoff pack for one namespace: current state, recent decisions, open loops, recent actors, and recommended next actions. Use this when one agent or environment is handing work to another.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description:
            "Namespace or namespace prefix to hand off.",
        },
        since: {
          type: "string",
          description:
            "Optional. ISO 8601 timestamp. Restrict logs and audit history to this lower bound.",
        },
        limit: {
          type: "integer",
          description:
            "Optional. Maximum number of recent decisions, actors, and next actions to return. Default 5, max 10.",
        },
      },
      required: ["namespace"],
    },
  },
  {
    name: "memory_write",
    description:
      "Store or update a state entry in memory. If an entry with the same namespace+key exists, it will be overwritten. Use this for mutable facts and non-tracked state. For `status` entries under `projects/*` or `clients/*`, prefer `memory_update_status`. Optional `valid_until` adds soft expiry for temporary state; direct reads still work after expiry, but broad search hides expired state by default.\n\nIf this is your first memory operation in this conversation, call memory_orient first.\n\nNamespace conventions: projects/<name> for project state, people/<name> for context about people, decisions/<topic> for cross-cutting decisions, meta/<topic> for system notes.\n\nKey conventions: 'status' = compact resumption summary (Phase / Current work / Blockers / Next — keep brief, move details to other keys like 'architecture', 'workflow', 'research'). 'index' = directory of important keys in this namespace and their purpose.\n\nTag vocabulary: Use canonical lifecycle tags on status entries: active, blocked, completed, stopped, maintenance, archived. Aliases are auto-normalized (done→completed, paused→stopped, inactive→archived). Category tags: decision, architecture, preference, milestone, convention. Type tags: bug, feature, research. Prefixed tags for cross-referencing: client:<name>, person:<name>, topic:<topic>, type:<artifact> (pdf, presentation, meeting-notes), source:external/internal.\n\nThe project dashboard is computed automatically from status entries with lifecycle tags. No manual workbench maintenance needed. Writing to 'status' in projects/* or clients/* supports compare-and-swap via expected_updated_at.\n\nTo start a new project: (1) write projects/<name>/status with a lifecycle tag (e.g. 'active'), (2) optionally write projects/<name>/index listing the keys.",
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
        classification: {
          type: "string",
          enum: [...CLASSIFICATION_LEVELS],
          description:
            "Optional explicit classification. If omitted, the server uses the namespace floor or preserves an existing higher classification.",
        },
        classification_override: {
          type: "boolean",
          description:
            "Optional owner-only escape hatch for writes below the namespace floor.",
        },
        valid_until: {
          type: "string",
          description:
            "Optional. ISO 8601 timestamp after which this state entry is treated as expired in broad retrieval, while remaining available to direct read/get.",
        },
        expected_updated_at: {
          type: "string",
          description:
            "Optional. For tracked status writes (projects/*, clients/*): pass the updated_at from your last read to prevent blind overwrites. Returns conflict error if the entry was modified since.",
        },
        patch: {
          type: "object",
          description: "Partial update for an existing entry. Mutually exclusive with content. Entry must already exist.",
          properties: {
            content_append: { type: "string", description: "Text to append after existing content (separated by newline)" },
            content_prepend: { type: "string", description: "Text to prepend before existing content (separated by newline)" },
            tags_add: { type: "array", items: { type: "string" }, description: "Tags to add (deduplicated with existing)" },
            tags_remove: { type: "array", items: { type: "string" }, description: "Tags to remove from existing" },
          },
        },
      },
      required: ["namespace", "key"],
    },
  },
  {
    name: "memory_update_status",
    description:
      "Create or patch a tracked `status` entry using a server-enforced structure. Use this for `projects/*` and `clients/*` status updates instead of `memory_write` when you want reliable partial updates instead of read-modify-write on markdown blobs. The server rewrites the content into canonical sections: Phase, Current Work, Blockers, Next Steps, and optional Notes. Status changes are not auto-logged; call `memory_log` separately when recording a decision or milestone.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "Tracked namespace to update. Must be under `projects/` or `clients/`.",
        },
        phase: {
          type: "string",
          description: "Optional. Replace the Phase section.",
        },
        current_work: {
          type: "string",
          description: "Optional. Replace the Current Work section.",
        },
        blockers: {
          type: "string",
          description: "Optional. Replace the Blockers section. Use 'None.' to clear blockers explicitly.",
        },
        next_steps: {
          type: "array",
          items: { type: "string" },
          description: "Optional. Replace the Next Steps bullet list. Pass an empty array to clear it.",
        },
        notes: {
          type: "string",
          description: "Optional. Replace the Notes section.",
        },
        lifecycle: {
          type: "string",
          enum: ["active", "blocked", "completed", "stopped", "maintenance", "archived"],
          description: "Optional. Sets the tracked lifecycle tag while preserving non-lifecycle tags.",
        },
        classification: {
          type: "string",
          enum: [...CLASSIFICATION_LEVELS],
          description: "Optional. Sets or preserves the authoritative classification for this tracked status.",
        },
        classification_override: {
          type: "boolean",
          description: "Optional owner-only escape hatch for writing below the namespace floor.",
        },
        expected_updated_at: {
          type: "string",
          description: "Optional compare-and-swap guard. Pass the updated_at from a prior read to avoid blind overwrites.",
        },
      },
      required: ["namespace"],
    },
  },
  {
    name: "memory_read",
    description:
      "Retrieve a specific state entry by namespace and key. Use this when you already know both. Returns the full content, tags, and timestamps. Returns a clear 'not found' message if the entry doesn't exist (not an error).\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
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
      "Retrieve the full content of a single memory entry by its UUID. Use this after `memory_query` returns truncated previews and you have an entry ID. If you already know namespace+key, use `memory_read` instead. Works for both state and log entries.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
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
      "Search and filter memories. Supports lexical (FTS5 keyword), semantic (vector similarity), and hybrid (RRF fusion of both) search modes. Filters by namespace prefix, entry type, tags, time range (since/until), and optional expiry handling. Can be used without a query to browse by filters alone (e.g. all entries with a specific tag, or all entries updated today). Broad retrieval hides expired state entries by default; use `include_expired: true` to include them. Pass `explain: true` to include retrieval metadata and per-result match explanations.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search terms. For lexical mode, FTS5 syntax supported. For semantic/hybrid, natural language works best. Optional — omit to browse by filters alone (tags, namespace, time range).",
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
        search_recency_weight: {
          type: "number",
          description:
            `Optional. Recency influence from 0 to 1. Default ${DEFAULT_SEARCH_RECENCY_WEIGHT}. Only affects query-based search, not filter-only browsing.`,
        },
        include_expired: {
          type: "boolean",
          description:
            "Optional. If true, include expired state entries in query results and mark them as expired. Default: false.",
        },
        explain: {
          type: "boolean",
          description: "Optional. If true, include retrieval metadata and per-result match explanations.",
        },
        since: {
          type: "string",
          description: "Optional. ISO 8601 timestamp. Only return entries updated at or after this time. E.g. '2026-04-01T00:00:00Z'.",
        },
        until: {
          type: "string",
          description: "Optional. ISO 8601 timestamp. Only return entries updated at or before this time.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_attention",
    description:
      "Return deterministic triage items for tracked work. Surfaces blocked statuses, stale active work, expiring or expired tracked statuses, near-term event staleness, and tracked namespaces missing status or lifecycle structure. Use this instead of broad natural-language search when you explicitly want what needs attention.\n\nIf this is your first memory operation in this conversation, call memory_orient first.",
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
        include_expiring: {
          type: "boolean",
          description: "Optional. Include expiring-soon and expired tracked statuses. Default: true.",
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
        classification: {
          type: "string",
          enum: [...CLASSIFICATION_LEVELS],
          description: "Optional explicit classification for the log entry.",
        },
        classification_override: {
          type: "boolean",
          description: "Optional owner-only escape hatch for writes below the namespace floor.",
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
        limit: {
          type: "integer",
          description:
            "Optional. Max namespaces to return in the top-level listing (default 20, max 200). Ignored when a namespace is provided.",
        },
        offset: {
          type: "integer",
          description:
            "Optional. Skip first N namespaces for pagination of the top-level listing (default 0). Ignored when a namespace is provided.",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_history",
    description:
      "View the chronological audit trail of changes to memory. Returns a timeline of writes, updates, deletes, namespace deletes, and log appends. Use this to answer 'what changed recently?' or 'what happened in this namespace?' — unlike memory_query (which is relevance-based search), this is a change feed ordered by time. For agent sync, pass `cursor` to page forward through new mutations and use `next_cursor` from the response.",
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
          enum: ["write", "update", "delete", "delete_namespace", "log"],
          description: "Optional. Filter by action type.",
        },
        cursor: {
          type: "integer",
          description: "Optional. Exclusive lower-bound audit cursor. When provided, entries are returned in ascending audit order for sync/polling workflows.",
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
  {
    name: "memory_status",
    description:
      "Returns server capabilities, version, and feature availability. Use to discover what search modes, tools, and features are available on this server instance.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

function textResult(obj: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

function okResult(action: string, data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, action, ...data }) }] };
}

function errResult(action: string, error: string, message: string, extra?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, action, error, message, ...extra }) }] };
}

function accessDeniedResponse(ctx: AccessContext, action: string) {
  if (ctx.principalType === "agent") {
    return errResult(action, "access_denied", "Access denied.");
  }
  return okResult(action, { found: false });
}

function accessDeniedReadResponse(action: string) {
  return okResult(action, { found: false, message: "No entry found." });
}

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

export function registerTools(server: Server, db: Database.Database, sessionId?: string, ctx: AccessContext = ownerContext()): void {
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
            const conventions = ctx.principalType === "owner" ? readState(db, "meta/conventions", "conventions") : null;
            const namespaces = listVisibleNamespaces(db, ctx).filter(ns => canRead(ctx, ns.namespace));
            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_orient", sessionId);
            const orientRedactedSources: RedactableEntryMetadata[] = [...visibleTrackedStatuses.redacted];

            const response: Record<string, unknown> = {};

            // Conventions — owner only; compact by default, full on request
            if (ctx.principalType !== "owner") {
              response.conventions = null;
            } else if (conventions) {
              const filteredConventions = filterDerivedSources(
                db,
                ctx,
                [conventions],
                "memory_orient",
                (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                sessionId,
              );
              orientRedactedSources.push(...filteredConventions.redacted);

              if (filteredConventions.allowed.length > 0) {
                const parsed = parseEntry(filteredConventions.allowed[0]);
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
                response.conventions = null;
              }
            } else {
              response.conventions = {
                content: null,
                message: "No conventions found. Write to meta/conventions with key 'conventions' to set them up.",
              };
            }

            // Computed dashboard from tracked status entries
            const trackedStatusAssessments = visibleTrackedStatuses.allowed;
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
            const trackedNsWithStatus = new Set([
              ...trackedStatusAssessments.map((assessment) => assessment.row.namespace),
              ...visibleTrackedStatuses.redacted.map((entry) => entry.namespace),
            ]);
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

            // Curated overlay (meta/workbench-notes) — owner only
            if (ctx.principalType === "owner") {
              const notes = readState(db, "meta", "workbench-notes");
              if (notes) {
                const filteredNotes = filterDerivedSources(
                  db,
                  ctx,
                  [notes],
                  "memory_orient",
                  (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                  sessionId,
                );
                orientRedactedSources.push(...filteredNotes.redacted);
                if (filteredNotes.allowed.length > 0) {
                  response.notes = filteredNotes.allowed[0].content;
                }
              }

              // Reference index — data-driven discoverability for key entries
              const refIndex = readState(db, "meta", "reference-index");
              if (refIndex) {
                const filteredReferenceIndex = filterDerivedSources(
                  db,
                  ctx,
                  [refIndex],
                  "memory_orient",
                  (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                  sessionId,
                );
                orientRedactedSources.push(...filteredReferenceIndex.redacted);
                if (filteredReferenceIndex.allowed.length > 0) {
                  try {
                    const parsed = JSON.parse(filteredReferenceIndex.allowed[0].content);
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
                          updated_at: filteredReferenceIndex.allowed[0].updated_at,
                        };
                      }
                    }
                  } catch {
                    // Malformed JSON — skip silently, don't break orient
                  }
                }
              }
            }

            // Maintenance suggestions
            if (maintenanceNeeded.length > 0) {
              response.maintenance_needed = maintenanceNeeded;
            }

            // Legacy workbench (transition period) — owner only
            if (ctx.principalType === "owner") {
              const workbench = readState(db, "meta", "workbench");
              if (workbench) {
                const filteredWorkbench = filterDerivedSources(
                  db,
                  ctx,
                  [workbench],
                  "memory_orient",
                  (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                  sessionId,
                );
                orientRedactedSources.push(...filteredWorkbench.redacted);
                if (filteredWorkbench.allowed.length > 0) {
                  const parsed = parseEntry(filteredWorkbench.allowed[0]);
                  response.legacy_workbench = {
                    content: parsed.content,
                    updated_at: parsed.updated_at,
                    deprecation_note: "The workbench is deprecated. The computed dashboard above is now the source of truth for project/client state. Delete meta/workbench when ready.",
                  };
                }
              }
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

            const redactedSourcesSummary = summarizeRedactedSources(ctx, orientRedactedSources);
            response.librarian_summary = buildLibrarianRuntimeSummary(ctx, {
              redactedDashboardCount: visibleTrackedStatuses.redacted.length,
              redactedSourceCount: orientRedactedSources.length,
            });
            if (redactedSourcesSummary) {
              response.redacted_sources = redactedSourcesSummary;
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

            return okResult("orient", response);
          }

          case "memory_resume": {
            const resumeArgs = (args ?? {}) as ResumeParams;
            const includeAttention = resumeArgs.include_attention !== false;
            const includeHistory = resumeArgs.include_history === true;
            const limit = clampOptionalLimit(resumeArgs.limit, 10) ?? 6;

            if (resumeArgs.namespace !== undefined) {
              const namespaceCheck = validateNamespace(resumeArgs.namespace);
              if (!namespaceCheck.valid) {
                return errResult("resume", "validation_error", namespaceCheck.error!);
              }
            }
            if (
              typeof resumeArgs.project === "string" &&
              (resumeArgs.project.startsWith("projects/") || resumeArgs.project.startsWith("clients/"))
            ) {
              const projectNamespaceCheck = validateNamespace(resumeArgs.project);
              if (!projectNamespaceCheck.valid) {
                return errResult("resume", "validation_error", projectNamespaceCheck.error!);
              }
            }

            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_resume", sessionId);
            const scope = resolveResumeScope(resumeArgs, visibleTrackedStatuses.allowed);
            const hintTerms = extractResumeTerms(resumeArgs.opener, resumeArgs.project, scope);
            const resumeRedactedSources: RedactableEntryMetadata[] = [...visibleTrackedStatuses.redacted];

            const candidates: ResumeCandidate[] = [];
            const statusCandidates = visibleTrackedStatuses.allowed
              .map((assessment) => buildResumeStatusCandidate(assessment, scope, hintTerms, includeAttention))
              .filter((candidate): candidate is ResumeCandidate => candidate !== null)
              .sort(compareResumeCandidates);
            candidates.push(...statusCandidates);

            const focusNamespaces = new Set(statusCandidates.slice(0, 3).map((candidate) => candidate.item.namespace));

            const rawLogPool = queryEntriesByFilter(db, {
              namespace: scope,
              entryType: "log",
              limit: scope ? Math.max(limit, 4) : Math.max(limit * 2, 8),
            }).filter((entry) => canRead(ctx, entry.namespace));
            const logPool = filterDerivedSources(
              db,
              ctx,
              rawLogPool,
              "memory_resume",
              (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
              sessionId,
            );
            resumeRedactedSources.push(...logPool.redacted);

            for (const entry of logPool.allowed) {
              const matchedTerms = countResumeTermMatches(`${entry.namespace} ${entry.content}`, hintTerms);
              if (!scope && focusNamespaces.size > 0 && !focusNamespaces.has(entry.namespace) && matchedTerms === 0) {
                continue;
              }
              const candidate = buildResumeLogCandidate(entry, scope, hintTerms);
              if (candidate) candidates.push(candidate);
            }

            if (scope) {
              const rawScopedStateEntries = queryEntriesByFilter(db, {
                namespace: scope,
                entryType: "state",
                includeExpired: true,
                limit: 4,
              })
                .filter((entry) => canRead(ctx, entry.namespace))
                .filter((entry) => entry.key !== "status");
              const scopedStateEntries = filterDerivedSources(
                db,
                ctx,
                rawScopedStateEntries,
                "memory_resume",
                (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                sessionId,
              );
              resumeRedactedSources.push(...scopedStateEntries.redacted);

              for (const entry of scopedStateEntries.allowed) {
                candidates.push(buildResumeStateCandidate(entry, scope, hintTerms));
              }
            }

            if (includeHistory && scope) {
              const historyPage = getAuditHistoryPage(db, { namespace: scope, limit: 3 });
              const filteredHistory = filterDerivedSources(
                db,
                ctx,
                historyPage.entries.filter((historyEntry) => canRead(ctx, historyEntry.namespace)),
                "memory_resume",
                (entry) => buildAuditHistoryMetadata(db, entry),
                sessionId,
              );
              resumeRedactedSources.push(...filteredHistory.redacted);
              for (const entry of filteredHistory.allowed) {
                candidates.push(buildResumeHistoryCandidate(entry, scope));
              }
            }

            const dedupedCandidates: ResumeCandidate[] = [];
            const seenCandidateIds = new Set<string>();
            for (const candidate of candidates.sort(compareResumeCandidates)) {
              const dedupeKey = candidate.item.entry_id
                ? `entry:${candidate.item.entry_id}`
                : `${candidate.item.category}:${candidate.item.namespace}:${candidate.item.key ?? ""}:${candidate.item.updated_at}`;
              if (seenCandidateIds.has(dedupeKey)) continue;
              seenCandidateIds.add(dedupeKey);
              dedupedCandidates.push(candidate);
            }

            const selected = dedupedCandidates.slice(0, limit);

            const openLoops: ResumeOpenLoop[] = [];
            const seenLoops = new Set<string>();
            for (const loop of selected.flatMap((candidate) => candidate.openLoops)) {
              const loopKey = `${loop.namespace}:${loop.type}:${loop.summary}`;
              if (seenLoops.has(loopKey)) continue;
              seenLoops.add(loopKey);
              openLoops.push(loop);
              if (openLoops.length >= Math.max(4, limit)) break;
            }

            const suggestedReads: ResumeSuggestedRead[] = [];
            const seenReads = new Set<string>();
            for (const candidate of selected) {
              if (!candidate.suggestedRead) continue;
              const read = candidate.suggestedRead;
              const readKey = `${read.tool}:${read.namespace ?? ""}:${read.key ?? ""}:${read.id ?? ""}`;
              if (seenReads.has(readKey)) continue;
              seenReads.add(readKey);
              suggestedReads.push(read);
            }

            const whyThisSet: string[] = [];
            if (scope) {
              whyThisSet.push(`Focused on ${scope}.`);
            } else if (resumeArgs.project) {
              whyThisSet.push("Biased toward the supplied project hint.");
            } else if (resumeArgs.opener) {
              whyThisSet.push("Biased toward terms from the opener.");
            }
            if (selected.some((candidate) => candidate.item.category === "status")) {
              whyThisSet.push("Tracked statuses were prioritized over generic notes.");
            }
            if (selected.some((candidate) => candidate.item.category === "decision_log")) {
              whyThisSet.push("Recent decision logs were included for rationale.");
            }
            if (
              includeAttention &&
              selected.some((candidate) =>
                candidate.item.category === "status" &&
                (candidate.item.reason.includes("blocked") || candidate.item.reason.includes("attention-worthy"))
              )
            ) {
              whyThisSet.push("Blocked or attention-worthy work was ranked ahead of generic historical noise.");
            }
            if (includeHistory && selected.some((candidate) => candidate.item.category === "history")) {
              whyThisSet.push("Recent namespace history was included because include_history was enabled.");
            }
            if (whyThisSet.length === 0) {
              whyThisSet.push("Returned the most relevant accessible context available.");
            }

            const statusCount = selected.filter((candidate) => candidate.item.category === "status").length;
            const logCount = selected.filter((candidate) => candidate.item.category === "decision_log").length;
            const historyCount = selected.filter((candidate) => candidate.item.category === "history").length;
            const summaryPrefix = scope
              ? `Resume pack for ${scope}`
              : resumeArgs.project
                ? `Resume pack for ${resumeArgs.project}`
                : "Resume pack";
            const summary = selected.length === 0
              ? `${summaryPrefix}: no matching context found.`
              : `${summaryPrefix}: ${statusCount} tracked status item${statusCount === 1 ? "" : "s"}, ${logCount} recent decision log${logCount === 1 ? "" : "s"}, ${openLoops.length} open loop${openLoops.length === 1 ? "" : "s"}${historyCount > 0 ? `, ${historyCount} history item${historyCount === 1 ? "" : "s"}` : ""}.`;

            const response: Record<string, unknown> = {
              summary,
              items: selected.map((candidate) => candidate.item),
              open_loops: openLoops,
              suggested_reads: suggestedReads,
              why_this_set: whyThisSet,
            };
            if (scope) response.target_namespace = scope;
            const redactedSourcesSummary = summarizeRedactedSources(ctx, resumeRedactedSources);
            if (redactedSourcesSummary) {
              response.redacted_sources = redactedSourcesSummary;
            }

            return okResult("resume", response);
          }

          case "memory_extract": {
            const extractArgs = (args ?? {}) as unknown as ExtractParams;
            const maxSuggestions = clampOptionalLimit(extractArgs.max_suggestions, 10) ?? 5;

            if (typeof extractArgs.conversation_text !== "string" || extractArgs.conversation_text.trim().length === 0) {
              return errResult("extract", "validation_error", '"conversation_text" is required and must be a non-empty string.');
            }
            if (extractArgs.namespace_hint !== undefined) {
              const namespaceCheck = validateNamespace(extractArgs.namespace_hint);
              if (!namespaceCheck.valid) {
                return errResult("extract", "validation_error", namespaceCheck.error!);
              }
            }
            if (
              typeof extractArgs.project_hint === "string" &&
              (extractArgs.project_hint.startsWith("projects/") || extractArgs.project_hint.startsWith("clients/"))
            ) {
              const projectNamespaceCheck = validateNamespace(extractArgs.project_hint);
              if (!projectNamespaceCheck.valid) {
                return errResult("extract", "validation_error", projectNamespaceCheck.error!);
              }
            }

            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_extract", sessionId);
            const scope = resolveExtractNamespace(
              extractArgs,
              extractArgs.conversation_text,
              visibleTrackedStatuses.allowed,
              ctx,
            );
            const relatedEntries = buildExtractRelatedEntries(db, scope.primaryNamespace, ctx, sessionId);
            const signals = extractConversationSignals(extractArgs.conversation_text);
            const built = buildExtractSuggestions(signals, scope.primaryNamespace, relatedEntries.entries);
            const extractRedactedSources = combineRedactedSources(
              visibleTrackedStatuses.redacted,
              relatedEntries.redacted,
            );

            const response: Record<string, unknown> = {
              suggestions: built.suggestions.slice(0, maxSuggestions),
              candidate_namespaces: scope.candidateNamespaces,
              related_entries: relatedEntries.entries,
              capture_warnings: [...new Set([
                "Suggestions only — nothing has been written.",
                ...scope.warnings,
                ...built.warnings,
              ])],
            };
            const redactedSourcesSummary = summarizeRedactedSources(ctx, extractRedactedSources);
            if (redactedSourcesSummary) {
              response.redacted_sources = redactedSourcesSummary;
            }

            return okResult("extract", response);
          }

          case "memory_narrative": {
            const narrativeArgs = (args ?? {}) as unknown as NarrativeParams;
            const limit = clampOptionalLimit(narrativeArgs.limit, 20) ?? 8;

            const namespaceCheck = validateNamespace(narrativeArgs.namespace);
            if (!namespaceCheck.valid) {
              return errResult("narrative", "validation_error", namespaceCheck.error!);
            }

            let normalizedSince: string | undefined;
            if (narrativeArgs.since !== undefined) {
              const parsed = new Date(narrativeArgs.since);
              if (Number.isNaN(parsed.getTime())) {
                return errResult("narrative", "validation_error", '"since" must be a valid ISO 8601 timestamp.');
              }
              normalizedSince = parsed.toISOString();
            }

            const historyAccessPrefix = narrativeArgs.namespace.endsWith("/")
              ? narrativeArgs.namespace
              : `${narrativeArgs.namespace}/`;
            if (!canRead(ctx, narrativeArgs.namespace) && !canReadSubtree(ctx, historyAccessPrefix)) {
              const response: Record<string, unknown> = {
                namespace: narrativeArgs.namespace,
                summary: "No narrative context found.",
                signals: [],
                timeline: [],
              };
              if (narrativeArgs.include_sources) response.sources = [];
              return okResult("narrative", response);
            }

            const rawStatusEntry = resolveNarrativeStatusEntry(db, narrativeArgs.namespace);
            const statusEntry = rawStatusEntry && canRead(ctx, rawStatusEntry.namespace)
              ? rawStatusEntry
              : null;
            const filteredStatusEntry = statusEntry
              ? filterDerivedSources(
                db,
                ctx,
                [statusEntry],
                "memory_narrative",
                (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                sessionId,
              )
              : { allowed: [] as Entry[], redacted: [] as RedactableEntryMetadata[] };
            const rawLogs = queryEntriesByFilter(db, {
              namespace: narrativeArgs.namespace,
              entryType: "log",
              limit: Math.max(limit, 12),
              since: normalizedSince,
            }).filter((entry) => canRead(ctx, entry.namespace));
            const filteredLogs = filterDerivedSources(
              db,
              ctx,
              rawLogs,
              "memory_narrative",
              (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
              sessionId,
            );
            const rawHistory = getAuditHistoryPage(db, {
              namespace: narrativeArgs.namespace,
              since: normalizedSince,
              limit: Math.max(limit * 2, 12),
            }).entries.filter((entry) => canRead(ctx, entry.namespace));
            const filteredHistory = filterDerivedSources(
              db,
              ctx,
              rawHistory,
              "memory_narrative",
              (entry) => buildAuditHistoryMetadata(db, entry),
              sessionId,
            );
            const narrativeRedactedSources = combineRedactedSources(
              filteredStatusEntry.redacted,
              filteredLogs.redacted,
              filteredHistory.redacted,
            );
            const visibleStatusEntry = filteredStatusEntry.allowed[0] ?? null;
            const logs = filteredLogs.allowed;
            const history = filteredHistory.allowed;

            if (!visibleStatusEntry && logs.length === 0 && history.length === 0) {
              const response: Record<string, unknown> = {
                namespace: narrativeArgs.namespace,
                summary: "No narrative context found.",
                signals: [],
                timeline: [],
              };
              if (narrativeArgs.include_sources) response.sources = [];
              const redactedSourcesSummary = summarizeRedactedSources(ctx, narrativeRedactedSources);
              if (redactedSourcesSummary) response.redacted_sources = redactedSourcesSummary;
              return okResult("narrative", response);
            }

            const signals = buildNarrativeSignals(narrativeArgs.namespace, visibleStatusEntry, logs, history);
            const timeline = buildNarrativeTimeline(visibleStatusEntry, logs, history, limit);
            const sources = buildNarrativeSources(narrativeArgs.include_sources === true, visibleStatusEntry, logs, history);

            const recentActivity = timeline[0]?.timestamp;
            const summary = recentActivity
              ? `Narrative view for ${narrativeArgs.namespace}: ${signals.length} signal${signals.length === 1 ? "" : "s"} derived from current status, recent logs, and audit history. Most recent activity: ${recentActivity}.`
              : `Narrative view for ${narrativeArgs.namespace}: ${signals.length} signal${signals.length === 1 ? "" : "s"} derived from available context.`;

            const response: Record<string, unknown> = {
              namespace: narrativeArgs.namespace,
              summary,
              signals,
              timeline,
            };
            if (sources) response.sources = sources;
            const redactedSourcesSummary = summarizeRedactedSources(ctx, narrativeRedactedSources);
            if (redactedSourcesSummary) response.redacted_sources = redactedSourcesSummary;

            return okResult("narrative", response);
          }

          case "memory_commitments": {
            const { namespace, since, limit: rawLimit } = args as unknown as CommitmentsParams;
            const limit = clampOptionalLimit(rawLimit, 25) ?? 10;

            if (namespace) {
              const nsCheck = validateNamespace(namespace);
              if (!nsCheck.valid) {
                return errResult("commitments", "validation_error", nsCheck.error!);
              }
            }

            let normalizedSince: string | undefined;
            if (since !== undefined) {
              const sinceCheck = normalizeIsoTimestamp(since, "since");
              if (!sinceCheck.ok) {
                return errResult("commitments", "validation_error", sinceCheck.error);
              }
              normalizedSince = sinceCheck.value;
            }

            if (namespace) {
              const subtreeScope = namespace.endsWith("/") ? namespace : `${namespace}/`;
              if (!canRead(ctx, namespace) && !canReadSubtree(ctx, subtreeScope)) {
                return okResult("commitments", {
                  open: [],
                  at_risk: [],
                  overdue: [],
                  completed_recently: [],
                });
              }
            }

            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_commitments", sessionId);
            const trackedStatusByNamespace = mapTrackedStatusAssessmentsByNamespace(visibleTrackedStatuses.allowed);
            const { rows, redacted } = listFreshCommitmentRows(db, ctx, "memory_commitments", {
              namespace,
              since: normalizedSince,
              limit: Math.max(limit * 8, 80),
              includeResolved: true,
            }, sessionId);

            const response: Record<string, unknown> = {
              ...classifyCommitments(rows, trackedStatusByNamespace, limit),
            };
            const redactedSourcesSummary = summarizeRedactedSources(
              ctx,
              combineRedactedSources(visibleTrackedStatuses.redacted, redacted),
            );
            if (redactedSourcesSummary) {
              response.redacted_sources = redactedSourcesSummary;
            }

            return okResult("commitments", response);
          }

          case "memory_patterns": {
            const { namespace, topic, since, limit: rawLimit } = args as unknown as PatternsParams;
            const limit = clampOptionalLimit(rawLimit, 10) ?? 5;

            if (namespace) {
              const nsCheck = validateNamespace(namespace);
              if (!nsCheck.valid) {
                return errResult("patterns", "validation_error", nsCheck.error!);
              }
            }

            let normalizedSince: string | undefined;
            if (since !== undefined) {
              const sinceCheck = normalizeIsoTimestamp(since, "since");
              if (!sinceCheck.ok) {
                return errResult("patterns", "validation_error", sinceCheck.error);
              }
              normalizedSince = sinceCheck.value;
            }

            if (namespace) {
              const subtreeScope = namespace.endsWith("/") ? namespace : `${namespace}/`;
              if (!canRead(ctx, namespace) && !canReadSubtree(ctx, subtreeScope)) {
                return okResult("patterns", {
                  patterns: [],
                  heuristics: [],
                  supporting_sources: [],
                });
              }
            }

            const topicNeedle = normalizeCompareText(topic ?? "");
            const rawEntries = listEntriesForDerivation(db, {
              namespace,
              since: normalizedSince,
            }).filter((entry) => canRead(ctx, entry.namespace));
            const filteredEntries = filterDerivedSources(
              db,
              ctx,
              rawEntries,
              "memory_patterns",
              (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
              sessionId,
            );
            const allEntries = filteredEntries.allowed;

            const candidateEntries = topicNeedle
              ? allEntries.filter((entry) => normalizeCompareText(`${entry.namespace} ${entry.key ?? ""} ${entry.content}`).includes(topicNeedle))
              : allEntries;

            const patterns: PatternItem[] = [];
            const heuristics: HeuristicItem[] = [];
            const sourceIds = new Set<string>();

            const decisionLogs = candidateEntries.filter((entry) =>
              isStrictDecisionLikeLog(entry) &&
              !isNarrativeMetaDiscussion(entry.content) &&
              !isOperationalReleaseDecisionLog(entry)
            );
            const termSources = new Map<string, Set<string>>();
            for (const entry of decisionLogs) {
              for (const term of extractPatternTerms(entry.content)) {
                const ids = termSources.get(term) ?? new Set<string>();
                ids.add(entry.id);
                termSources.set(term, ids);
              }
            }

            const recurringTerms = [...termSources.entries()]
              .filter(([, ids]) => ids.size >= 2)
              .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
            if (recurringTerms.length >= 2 && recurringTerms[0][1].size >= 3) {
              const topTerms = recurringTerms.slice(0, 3);
              const ids = [...new Set(topTerms.flatMap(([, ids]) => [...ids]))];
              ids.forEach((id) => sourceIds.add(id));
              patterns.push({
                kind: "decision_theme",
                summary: `Decision work repeatedly references: ${topTerms.map(([term]) => term).join(", ")}.`,
                confidence: Math.min(0.95, 0.55 + topTerms[0][1].size * 0.1),
                source_entry_ids: ids.slice(0, 6),
                source_namespaces: [...new Set(ids
                  .map((id) => allEntries.find((entry) => entry.id === id)?.namespace)
                  .filter((value): value is string => typeof value === "string"))],
              });
              heuristics.push({
                summary: `Review the recurring decision terms before reopening this line of work.`,
                rationale: "Multiple decision logs repeated the same concern terms, suggesting stable evaluation criteria rather than a one-off thought.",
                source_entry_ids: ids.slice(0, 6),
              });
            }

            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_patterns", sessionId);
            const trackedStatusByNamespace = mapTrackedStatusAssessmentsByNamespace(visibleTrackedStatuses.allowed);
            const { rows: commitmentRows, redacted: redactedCommitmentSources } = listFreshCommitmentRows(db, ctx, "memory_patterns", {
              namespace,
              since: normalizedSince,
              limit: 200,
              includeResolved: true,
            }, sessionId);

            const undatedOpen = commitmentRows.filter((row) => row.status === "open" && !row.due_at);
            const undatedSources = new Set(undatedOpen.map((row) => row.source_entry_id));
            if (undatedSources.size >= 2) {
              undatedOpen.slice(0, 4).forEach((row) => sourceIds.add(row.source_entry_id));
              patterns.push({
                kind: "undated_next_steps",
                summary: "Open commitments in this scope are frequently undated.",
                confidence: Math.min(0.9, 0.5 + undatedOpen.length * 0.08),
                source_entry_ids: undatedOpen.slice(0, 6).map((row) => row.source_entry_id),
                source_namespaces: [...new Set(undatedOpen.slice(0, 6).map((row) => row.namespace))],
              });
              heuristics.push({
                summary: "Add explicit dates to next steps when they should survive across sessions.",
                rationale: "Multiple open commitments had no due date, which weakens reviewability and makes drop-off harder to spot.",
                source_entry_ids: undatedOpen.slice(0, 6).map((row) => row.source_entry_id),
              });
            }

            const overdueRows = commitmentRows.filter((row) => row.status === "open" && row.due_at && row.due_at < nowUTC());
            const blockedRows = commitmentRows.filter((row) => trackedStatusByNamespace.get(row.namespace)?.lifecycle === "blocked");
            const overdueSourceCount = new Set(overdueRows.map((row) => row.source_entry_id)).size;
            const blockedSourceCount = new Set(blockedRows.map((row) => row.source_entry_id)).size;
            if (overdueSourceCount >= 2 || blockedSourceCount >= 2) {
              const supporting = (overdueSourceCount >= 2 ? overdueRows : blockedRows).slice(0, 6);
              supporting.forEach((row) => sourceIds.add(row.source_entry_id));
              patterns.push({
                kind: overdueRows.length >= 2 ? "commitment_slip" : "blocked_followthrough",
                summary: overdueRows.length >= 2
                  ? "Explicit commitments are slipping past their written due dates."
                  : "Blocked work is carrying unresolved commitments.",
                confidence: Math.min(0.92, 0.56 + supporting.length * 0.08),
                source_entry_ids: supporting.map((row) => row.source_entry_id),
                source_namespaces: [...new Set(supporting.map((row) => row.namespace))],
              });
              heuristics.push({
                summary: overdueRows.length >= 2
                  ? "Review stale commitments before adding more follow-through items."
                  : "Clear or rewrite blocker-side commitments before reopening the work.",
                rationale: overdueRows.length >= 2
                  ? "Repeated overdue commitments suggest the current next-step layer is drifting from execution."
                  : "Blocked namespaces with lingering commitments create noisy handoffs and false progress signals.",
                source_entry_ids: supporting.map((row) => row.source_entry_id),
              });
            }

            const sortedPatterns = patterns
              .sort((a, b) => b.confidence - a.confidence || a.summary.localeCompare(b.summary))
              .slice(0, limit);
            const allowedPatternSourceIds = new Set(sortedPatterns.flatMap((pattern) => pattern.source_entry_ids));
            const supportingSources = buildPatternSources(allEntries, allowedPatternSourceIds).slice(0, limit * 3);

            const response: Record<string, unknown> = {
              patterns: sortedPatterns,
              heuristics: heuristics
                .filter((heuristic) => heuristic.source_entry_ids.some((id) => allowedPatternSourceIds.has(id)))
                .slice(0, limit),
              supporting_sources: supportingSources,
            };
            const redactedSourcesSummary = summarizeRedactedSources(
              ctx,
              combineRedactedSources(
                filteredEntries.redacted,
                visibleTrackedStatuses.redacted,
                redactedCommitmentSources,
              ),
            );
            if (redactedSourcesSummary) {
              response.redacted_sources = redactedSourcesSummary;
            }

            return okResult("patterns", response);
          }

          case "memory_handoff": {
            const { namespace, since, limit: rawLimit } = args as unknown as HandoffParams;
            const limit = clampOptionalLimit(rawLimit, 10) ?? 5;

            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return errResult("handoff", "validation_error", nsCheck.error!);
            }

            let normalizedSince: string | undefined;
            if (since !== undefined) {
              const sinceCheck = normalizeIsoTimestamp(since, "since");
              if (!sinceCheck.ok) {
                return errResult("handoff", "validation_error", sinceCheck.error);
              }
              normalizedSince = sinceCheck.value;
            }

            const subtreeScope = namespace.endsWith("/") ? namespace : `${namespace}/`;
            if (!canRead(ctx, namespace) && !canReadSubtree(ctx, subtreeScope)) {
              return okResult("handoff", {
                found: false,
                namespace,
                current_state: null,
                recent_decisions: [],
                open_loops: [],
                recent_actors: [],
                recommended_next_actions: [],
              });
            }

            const rawEntries = listEntriesForDerivation(db, {
              namespace,
              since: normalizedSince,
            }).filter((entry) => canRead(ctx, entry.namespace));
            const filteredEntries = filterDerivedSources(
              db,
              ctx,
              rawEntries,
              "memory_handoff",
              (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
              sessionId,
            );
            const allEntries = filteredEntries.allowed;
            const rawStatusEntry = resolveNarrativeStatusEntry(db, namespace);
            const statusEntry = rawStatusEntry && canRead(ctx, rawStatusEntry.namespace)
              ? rawStatusEntry
              : null;
            const filteredStatusEntry = statusEntry
              ? filterDerivedSources(
                db,
                ctx,
                [statusEntry],
                "memory_handoff",
                (entry) => buildRedactableEntryMetadata(parseEntry(entry)),
                sessionId,
              )
              : { allowed: [] as Entry[], redacted: [] as RedactableEntryMetadata[] };
            const visibleStatusEntry = filteredStatusEntry.allowed[0] ?? null;
            const logs = allEntries
              .filter((entry) => entry.entry_type === "log")
              .sort((a, b) => b.created_at.localeCompare(a.created_at));
            const filteredHistory = filterDerivedSources(
              db,
              ctx,
              getAuditHistoryPage(db, {
                namespace,
                since: normalizedSince,
                limit: Math.max(limit * 4, 20),
              }).entries.filter((entry) => canRead(ctx, entry.namespace)),
              "memory_handoff",
              (entry) => buildAuditHistoryMetadata(db, entry),
              sessionId,
            );
            const history = filteredHistory.allowed;
            const { rows: commitmentRows, redacted: redactedCommitmentSources } = listFreshCommitmentRows(db, ctx, "memory_handoff", {
              namespace,
              since: normalizedSince,
              limit: 200,
              includeResolved: true,
            }, sessionId);
            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_handoff", sessionId);
            const trackedStatusByNamespace = mapTrackedStatusAssessmentsByNamespace(visibleTrackedStatuses.allowed);
            const currentState = buildHandoffCurrentState(namespace, visibleStatusEntry, allEntries);

            const recentDecisions = logs
              .filter((entry) => isDecisionLikeLog(entry))
              .slice(0, limit)
              .map((entry) => ({
                timestamp: entry.created_at,
                summary: contentPreview(entry.content, 200),
                source_entry_id: entry.id,
              }));

            const openLoopSet = new Set<string>();
            const recommendedActionSet = new Set<string>();
            const statusAssessment = visibleStatusEntry ? trackedStatusByNamespace.get(visibleStatusEntry.namespace) : undefined;
            if (statusAssessment) {
              for (const loop of extractResumeOpenLoops(statusAssessment)) {
                openLoopSet.add(loop.summary);
                recommendedActionSet.add(loop.suggested_action);
              }
            }

            for (const row of commitmentRows) {
              if (row.status !== "open") continue;
              if (row.due_at && row.due_at < nowUTC()) {
                openLoopSet.add(`Overdue commitment: ${row.text}`);
                recommendedActionSet.add(`Resolve or reschedule the overdue commitment written for ${row.due_at}.`);
                continue;
              }
              const namespaceAssessment = trackedStatusByNamespace.get(row.namespace);
              if (namespaceAssessment?.lifecycle === "blocked") {
                openLoopSet.add(`Blocked commitment: ${row.text}`);
                recommendedActionSet.add("Unblock the namespace or clear the lingering commitment before handing work onward.");
                continue;
              }
              if (row.due_at && getDaysUntil(row.due_at) <= COMMITMENT_SOON_DAYS) {
                openLoopSet.add(`Due soon: ${row.text}`);
                recommendedActionSet.add(`Review the commitment due at ${row.due_at}.`);
              }
            }

            if (recommendedActionSet.size === 0 && recentDecisions.length > 0) {
              recommendedActionSet.add("Read the most recent decision log before making the next change.");
            }
            if (recommendedActionSet.size === 0 && currentState) {
              recommendedActionSet.add("Refresh the tracked status if the current state has drifted.");
            }

            const found = Boolean(currentState) || recentDecisions.length > 0 || history.length > 0 || commitmentRows.length > 0;
            const response: Record<string, unknown> = {
              found,
              namespace,
              current_state: currentState,
              recent_decisions: recentDecisions,
              open_loops: [...openLoopSet].slice(0, limit),
              recent_actors: buildHandoffRecentActors(history, limit),
              recommended_next_actions: [...recommendedActionSet].slice(0, limit),
            };
            const redactedSourcesSummary = summarizeRedactedSources(
              ctx,
              combineRedactedSources(
                filteredEntries.redacted,
                filteredStatusEntry.redacted,
                filteredHistory.redacted,
                redactedCommitmentSources,
                visibleTrackedStatuses.redacted,
              ),
            );
            if (redactedSourcesSummary) {
              response.redacted_sources = redactedSourcesSummary;
            }
            return okResult("handoff", response);
          }

          case "memory_write": {
            const {
              namespace,
              key,
              content,
              tags,
              valid_until,
              expected_updated_at,
              patch,
              classification,
              classification_override,
            } =
              args as unknown as WriteParams & { expected_updated_at?: string; patch?: PatchParams };

            // Validate namespace and key (always required)
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return errResult("write", "validation_error", nsCheck.error!);
            }
            const keyCheck = validateKey(key);
            if (!keyCheck.valid) {
              return errResult("write", "validation_error", keyCheck.error!);
            }

            // Mutually exclusive: patch and content cannot both be provided
            if (patch !== undefined && content !== undefined) {
              return errResult("write", "validation_error", "patch and content are mutually exclusive. Use patch for partial updates or content for a full write.");
            }
            if (patch !== undefined && valid_until !== undefined) {
              return errResult("write", "validation_error", "valid_until is only supported on full memory_write calls, not patch updates.");
            }
            const classificationInputError = validateClassificationInput(classification, classification_override);
            if (classificationInputError) {
              return errResult("write", "validation_error", classificationInputError);
            }
            if (classification_override === true && ctx.principalType !== "owner") {
              return errResult("write", "access_denied", "classification_override is only available to the owner principal.");
            }

            if (!canWrite(ctx, namespace)) {
              return accessDeniedResponse(ctx, "write");
            }

            // --- Patch path ---
            if (patch !== undefined) {
              // Validate any new tags being added
              if (patch.tags_add) {
                const tagsCheck = validateTags(patch.tags_add);
                if (!tagsCheck.valid) {
                  return errResult("write", "validation_error", tagsCheck.error!);
                }
              }

              let patchResult;
              try {
                patchResult = patchState(
                  db,
                  namespace,
                  key,
                  patch,
                  ctx.principalId,
                  expected_updated_at,
                  {
                    classification,
                    classificationOverride: classification_override,
                  },
                );
              } catch (error) {
                return errResult("write", "validation_error", (error as Error).message);
              }

              if (patchResult.status === "not_found") {
                return errResult("write", "not_found", `No entry found at ${namespace}/${key}. Use content (not patch) to create a new entry.`, { namespace, key });
              }

              if (patchResult.status === "conflict") {
                return errResult("write", "conflict", patchResult.message!, { namespace, key, current_updated_at: patchResult.current_updated_at });
              }

              if (patchResult.status === "secret_detected") {
                return errResult("write", "validation_error", patchResult.error!);
              }

              const otherKeysPatch = getOtherKeysInNamespace(db, namespace, key);
              const hintPatch = otherKeysPatch.length === 0
                ? "This is the first entry in this namespace."
                : `Related entries in this namespace: ${otherKeysPatch.join(", ")}`;

              if (sessionId) {
                logRetrievalOutcome(db, sessionId, { outcomeType: "write_in_result_namespace", namespace });
              }

              const patchedEntry = readState(db, namespace, key);
              if (patchedEntry) {
                syncCommitmentsForEntry(db, patchedEntry.id, extractCommitmentsFromEntry(patchedEntry));
              }

              return okResult("write", { status: "patched", id: patchResult.id, namespace, key, hint: hintPatch });
            }

            // --- Full write path ---
            if (typeof content !== "string") {
              return errResult("write", "validation_error", "Content is required and must be a non-empty string.");
            }
            const validation = validateWriteInput(namespace, key, content, tags, maxContentSize);
            if (!validation.valid) {
              return errResult("write", "validation_error", validation.error!);
            }

            let normalizedValidUntil: string | null = null;
            if (valid_until !== undefined && valid_until !== null) {
              const timestampCheck = normalizeIsoTimestamp(valid_until, "valid_until");
              if (!timestampCheck.ok) {
                return errResult("write", "validation_error", timestampCheck.error);
              }
              normalizedValidUntil = timestampCheck.value;
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

            let result;
            try {
              result = writeState(
                db,
                namespace,
                key,
                content,
                effectiveTags,
                ctx.principalId,
                expected_updated_at,
                normalizedValidUntil,
                {
                  classification,
                  classificationOverride: classification_override,
                },
              );
            } catch (error) {
              return errResult("write", "validation_error", (error as Error).message);
            }

            if (result.status === "conflict") {
              return errResult("write", "conflict", result.message!, {
                namespace,
                key,
                current_updated_at: result.current_updated_at,
              });
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
              updated_at: result.updated_at,
              classification: result.classification,
              hint,
              provenance: buildProvenance(ctx.principalId, ctx.principalId),
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

            if (result.id) {
              const writtenEntry = getById(db, result.id);
              if (writtenEntry) {
                syncCommitmentsForEntry(db, writtenEntry.id, extractCommitmentsFromEntry(writtenEntry));
              }
            }

            return okResult("write", response);
          }

          case "memory_update_status": {
            const {
              namespace,
              phase,
              current_work,
              blockers,
              next_steps,
              notes,
              lifecycle,
              expected_updated_at,
              classification,
              classification_override,
            } = args as unknown as StatusUpdateParams;

            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return errResult("update_status", "validation_error", nsCheck.error!);
            }
            if (!isTrackedNamespace(namespace)) {
              return errResult("update_status", "validation_error", "memory_update_status only supports tracked namespaces under projects/* or clients/*.");
            }
            if (!canWrite(ctx, namespace)) {
              return accessDeniedResponse(ctx, "update_status");
            }
            const classificationInputError = validateClassificationInput(classification, classification_override);
            if (classificationInputError) {
              return errResult("update_status", "validation_error", classificationInputError);
            }
            if (classification_override === true && ctx.principalType !== "owner") {
              return errResult("update_status", "access_denied", "classification_override is only available to the owner principal.");
            }
            if (next_steps !== undefined && (!Array.isArray(next_steps) || next_steps.some((item) => typeof item !== "string"))) {
              return errResult("update_status", "validation_error", "next_steps must be an array of strings.");
            }

            const existing = readState(db, namespace, "status");
            const existingParsed = existing ? parseEntry(existing) : null;
            const existingStructured = existingParsed ? parseStructuredStatus(existingParsed.content) : undefined;
            const hasExistingStructure = existingStructured
              ? Object.keys(existingStructured).length > 0
              : false;

            const hasRequestedUpdate = [
              phase,
              current_work,
              blockers,
              notes,
              lifecycle,
              next_steps,
            ].some((value) => value !== undefined);

            if (!existing && !hasRequestedUpdate) {
              return errResult("update_status", "validation_error", "Provide at least one status field or lifecycle when creating a new tracked status.");
            }
            if (existing && !hasRequestedUpdate) {
              return errResult("update_status", "validation_error", "No status fields were provided to update.");
            }

            const structured = buildStructuredStatus(
              {
                phase,
                current_work,
                blockers,
                next_steps,
                notes,
              },
              existingStructured,
            );
            const content = formatStructuredStatus(structured);

            const warnings: string[] = [];
            if (existing && !hasExistingStructure) {
              warnings.push("Existing status was not in the canonical structured format; missing sections were filled with defaults.");
            }

            const validation = validateWriteInput(namespace, "status", content, existingParsed?.tags, maxContentSize);
            if (!validation.valid) {
              return errResult("update_status", "validation_error", validation.error!);
            }

            const existingTags = existingParsed?.tags ?? [];
            const retainedTags = stripClassificationTags(
              existingTags.filter((tag) => !LIFECYCLE_TAGS.has(tag)),
            );
            const lifecycleTag = lifecycle ?? getLifecycleTags(existingTags)[0];
            const effectiveTags = lifecycleTag ? [...retainedTags, lifecycleTag] : retainedTags;

            if (!lifecycleTag) {
              warnings.push(`No lifecycle tag set. Consider one of: ${[...LIFECYCLE_TAGS].join(", ")}.`);
            }

            let result;
            try {
              result = writeState(
                db,
                namespace,
                "status",
                content,
                effectiveTags,
                ctx.principalId,
                expected_updated_at ?? existingParsed?.updated_at,
                undefined,
                {
                  classification,
                  classificationOverride: classification_override,
                },
              );
            } catch (error) {
              return errResult("update_status", "validation_error", (error as Error).message);
            }

            if (result.status === "conflict") {
              return errResult("update_status", "conflict", result.message!, {
                namespace,
                key: "status",
                current_updated_at: result.current_updated_at,
              });
            }

            if (sessionId) {
              logRetrievalOutcome(db, sessionId, {
                outcomeType: "write_in_result_namespace",
                namespace,
              });
            }

            if (result.id) {
              const statusEntry = getById(db, result.id);
              if (statusEntry) {
                syncCommitmentsForEntry(db, statusEntry.id, extractCommitmentsFromEntry(statusEntry));
              }
            }

            return okResult("update_status", {
              status: result.status,
              id: result.id,
              namespace,
              key: "status",
              updated_at: result.updated_at,
              classification: result.classification,
              content,
              structured_status: structured,
              warnings: warnings.length > 0 ? warnings : undefined,
              provenance: buildProvenance(ctx.principalId, ctx.principalId),
            });
          }

          case "memory_read": {
            const { namespace, key } = args as unknown as ReadParams;
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return errResult("read", "validation_error", nsCheck.error!);
            }
            const keyCheck = validateKey(key);
            if (!keyCheck.valid) {
              return errResult("read", "validation_error", keyCheck.error!);
            }
            if (!canRead(ctx, namespace)) {
              return accessDeniedReadResponse("read");
            }
            const entry = readState(db, namespace, key);
            if (entry) {
              const parsed = parseEntry(entry);
              const redacted = maybeRedactDirectEntry(db, ctx, parsed, "memory_read", sessionId);
              if (redacted) {
                return okResult("read", { found: true, ...redacted });
              }
              const response: Record<string, unknown> = { found: true, ...serializeParsedEntry(parsed) };
              if (isEntryExpired(parsed)) {
                response.expired = true;
              }
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
              return okResult("read", response);
            }
            const otherKeys = getOtherKeysInNamespace(db, namespace);
            const hint = otherKeys.length > 0
              ? `Other keys in this namespace: ${otherKeys.join(", ")}`
              : `No entries found in namespace "${namespace}".`;
            return okResult("read", {
              found: false,
              namespace,
              key,
              message: `No state entry found in namespace "${namespace}" with key "${key}".`,
              hint,
            });
          }

          case "memory_read_batch": {
            const { reads } = args as unknown as ReadBatchParams;
            if (!Array.isArray(reads) || reads.length === 0) {
              return errResult("read_batch", "validation_error", "reads must be a non-empty array of {namespace, key} pairs.");
            }
            if (reads.length > 20) {
              return errResult("read_batch", "validation_error", "Maximum 20 reads per batch.");
            }

            const results = reads.map(({ namespace: ns, key: k }) => {
              const nsCheck = validateNamespace(ns);
              if (!nsCheck.valid) return { found: false, namespace: ns, key: k, error: nsCheck.error };
              const keyCheck = validateKey(k);
              if (!keyCheck.valid) return { found: false, namespace: ns, key: k, error: keyCheck.error };
              if (!canRead(ctx, ns)) return { found: false, namespace: ns, key: k };

              const entry = readState(db, ns, k);
              if (entry) {
                const parsed = parseEntry(entry);
                const redacted = maybeRedactDirectEntry(db, ctx, parsed, "memory_read_batch", sessionId);
                if (redacted) {
                  return { found: true, ...redacted };
                }
                const result: Record<string, unknown> = { found: true, ...serializeParsedEntry(parsed) };
                if (isEntryExpired(parsed)) {
                  result.expired = true;
                }
                if (isStale(parsed.updated_at)) {
                  result.stale = true;
                }
                return result;
              }
              return { found: false, namespace: ns, key: k };
            });

            return okResult("read_batch", { results });
          }

          case "memory_get": {
            const { id } = args as unknown as GetParams;
            if (!id || typeof id !== "string") {
              return errResult("get", "validation_error", "ID is required.");
            }
            const entry = getById(db, id);
            if (entry && !canRead(ctx, entry.namespace)) {
              return accessDeniedReadResponse("get");
            }
            if (entry) {
              const parsed = parseEntry(entry);
              const redacted = maybeRedactDirectEntry(db, ctx, parsed, "memory_get", sessionId);
              if (redacted) {
                return okResult("get", { found: true, ...redacted });
              }
              const response: Record<string, unknown> = { found: true, ...serializeParsedEntry(parsed) };
              if (isEntryExpired(parsed)) {
                response.expired = true;
              }
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
              return okResult("get", response);
            }
            return okResult("get", {
              found: false,
              message: `No entry found with ID "${id}".`,
            });
          }

          case "memory_query": {
            const queryArgs = (args ?? {}) as unknown as QueryParams;
            const { query, namespace, entry_type, tags, limit, search_mode, since, until } = queryArgs;
            const explain = queryArgs.explain === true;
            const includeExpired = queryArgs.include_expired === true;
            const recencyWeightCheck = resolveSearchRecencyWeight(queryArgs);
            if (!recencyWeightCheck.ok) {
              return errResult("query", "validation_error", recencyWeightCheck.error);
            }
            const searchRecencyWeight = recencyWeightCheck.value;

            // Filter-only mode: no query text, just browse by filters
            if (!query || typeof query !== "string") {
              // Must have at least one filter to avoid returning everything
              if (!namespace && (!tags || tags.length === 0) && !since && !until && !entry_type) {
                return errResult("query", "validation_error", "Provide either a 'query' string for search, or at least one filter (namespace, tags, entry_type, since, until) to browse.");
              }
              const requestedLimit = Math.min(Math.max(limit ?? 10, 1), 50);
              const internalFilterLimit = Math.min(requestedLimit * QUERY_RERANK_OVERFETCH_MULTIPLIER, 50);
              let filterResults = queryEntriesByFilter(db, {
                namespace,
                entryType: entry_type,
                tags,
                limit: internalFilterLimit,
                includeExpired: true,
                since,
                until,
              });
              const filteredExpired = filterExpiredEntries(filterResults, includeExpired);
              filterResults = filterByAccess(ctx, filteredExpired.items).slice(0, requestedLimit);
              const formatted = filterResults.map((entry) => formatQueryResult(
                db,
                ctx,
                entry,
                "memory_query",
                sessionId,
                false,
                null,
                undefined,
                "lexical",
                new Map(),
                new Map(),
                new Map(),
              ));
              const redactedCount = formatted.filter((entry) => entry.redacted === true).length;

              // Analytics
              if (sessionId) {
                const resultIds = filterResults.map((entry) => entry.id);
                const resultNamespaces = filterResults.map((entry) => entry.namespace);
                const resultRanks = filterResults.map((_, i) => i + 1);
                logRetrievalEvent(db, {
                  sessionId,
                  toolName: "memory_query",
                  queryText: `[filter-only] ns=${namespace ?? "*"} tags=${tags?.join(",") ?? "*"} since=${since ?? "*"} until=${until ?? "*"}`,
                  requestedMode: "lexical",
                  actualMode: "lexical",
                  resultIds,
                  resultNamespaces,
                  resultRanks,
                });
              }

              return okResult("query", {
                results: formatted,
                total: formatted.length,
                redacted_count: redactedCount,
                search_mode: "filter",
                retrieval: {
                  reranked: false,
                  relaxed_lexical: false,
                  fallback_reason: null,
                  recency_applied: false,
                  search_recency_weight: 0,
                  expired_filtered_count: filteredExpired.expiredFilteredCount,
                },
              });
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
              search_recency_weight: searchRecencyWeight,
              include_expired: includeExpired,
              explain,
              since,
              until,
            };
            const requestedMode: SearchMode = search_mode ?? "hybrid";
            let actualMode: SearchMode = requestedMode;
            let warning: string | undefined;
            let fallbackReason: string | null = null;
            let relaxedLexical = false;
            let expiredFilteredCount = 0;
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
                  includeExpired: true,
                  since,
                  until,
                });
                const filteredExpired = filterExpiredEntries(semanticResults, includeExpired);
                semanticResults = filteredExpired.items;
                expiredFilteredCount = filteredExpired.expiredFilteredCount;
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
                  ftsOptions: { query, namespace, entryType: entry_type, tags, limit: internalLimit, includeExpired: true, since, until },
                  semanticOptions: { queryEmbedding: buf, namespace, entryType: entry_type, tags, limit: internalLimit, includeExpired: true, since, until },
                });
                const filteredExpired = filterExpiredEntries(hybridResults, includeExpired);
                hybridResults = filteredExpired.items;
                expiredFilteredCount = filteredExpired.expiredFilteredCount;
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
                includeExpired: true,
                since,
                until,
              });
              let filteredExpired = filterExpiredEntries(lexicalResults, includeExpired);
              lexicalResults = filteredExpired.items;
              expiredFilteredCount = filteredExpired.expiredFilteredCount;
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
                    includeExpired: true,
                    since,
                    until,
                  });
                  filteredExpired = filterExpiredEntries(lexicalResults, includeExpired);
                  lexicalResults = filteredExpired.items;
                  expiredFilteredCount = filteredExpired.expiredFilteredCount;
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
            results = filterByAccess(ctx, results);
            const completedTasks = shouldApplyDefaultQuerySuppression(queryParams)
              ? getCompletedTaskNamespaces(db)
              : new Set<string>();
            results = rerankQueryResults(results, queryParams, completedTasks, trackedStatuses).slice(0, requestedLimit);

            const lexicalById = new Map(lexicalResults.map((result) => [result.entry.id, result] as const));
            const semanticById = new Map(semanticResults.map((result) => [result.entry.id, result] as const));
            const hybridById = new Map(hybridResults.map((result) => [result.entry.id, result] as const));

            const queryLower = query.toLowerCase();
            const formatted = results.map((entry) => formatQueryResult(
              db,
              ctx,
              entry,
              "memory_query",
              sessionId,
              explain,
              queryLower,
              trackedStatuses,
              actualMode,
              lexicalById,
              semanticById,
              hybridById,
            ));
            const redactedCount = formatted.filter((entry) => entry.redacted === true).length;

            const response: Record<string, unknown> = {
              results: formatted,
              total: formatted.length,
              redacted_count: redactedCount,
              query,
              search_mode: requestedMode,
            };
            if (actualMode !== requestedMode) {
              response.search_mode_actual = actualMode;
            }
            if (warning) {
              response.warning = warning;
            }
            response.retrieval = {
              reranked: true,
              relaxed_lexical: relaxedLexical,
              fallback_reason: fallbackReason,
              recency_applied: searchRecencyWeight > 0,
              search_recency_weight: searchRecencyWeight,
              expired_filtered_count: expiredFilteredCount,
            };

            // Analytics: log retrieval event with result IDs and ranks
            if (sessionId) {
              const resultIds = results.map((entry) => entry.id);
              const resultNamespaces = results.map((entry) => entry.namespace);
              const resultRanks = results.map((_, i) => i + 1);
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

            return okResult("query", response);
          }

          case "memory_attention": {
            const attentionArgs = (args ?? {}) as AttentionParams;
            const includeBlocked = attentionArgs.include_blocked !== false;
            const includeStale = attentionArgs.include_stale !== false;
            const includeUpcomingEvents = attentionArgs.include_upcoming_events !== false;
            const includeExpiring = attentionArgs.include_expiring !== false;
            const includeMissingStatus = attentionArgs.include_missing_status !== false;
            const includeConflictingLifecycle = attentionArgs.include_conflicting_lifecycle !== false;
            const includeMissingLifecycle = attentionArgs.include_missing_lifecycle !== false;
            const limit = clampOptionalLimit(attentionArgs.limit, 50) ?? 20;

            const visibleTrackedStatuses = getVisibleTrackedStatusAssessments(db, ctx, "memory_attention", sessionId);
            const trackedStatusAssessments = visibleTrackedStatuses.allowed;
            const namespaces = listVisibleNamespaces(db, ctx).filter(ns => canRead(ctx, ns.namespace));
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
                if ((item.issue === "expiring_soon" || item.issue === "expired") && !includeExpiring) continue;
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
              const trackedNsWithStatus = new Set([
                ...trackedStatusAssessments.map((assessment) => assessment.row.namespace),
                ...visibleTrackedStatuses.redacted.map((entry) => entry.namespace),
              ]);
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

            const attentionResult: Record<string, unknown> = {
              generated_at: new Date().toISOString(),
              summary,
              items: limitedItems,
            };
            const redactedSourcesSummary = summarizeRedactedSources(ctx, visibleTrackedStatuses.redacted);
            if (redactedSourcesSummary) {
              attentionResult.redacted_sources = redactedSourcesSummary;
            }
            if (limitedItems.length === 0 && !redactedSourcesSummary) {
              attentionResult.message = "All tracked projects appear healthy. No items need attention.";
            } else if (limitedItems.length === 0 && redactedSourcesSummary) {
              attentionResult.message = "No attention items are visible on this connection.";
            }

            return okResult("attention", attentionResult);
          }

          case "memory_log": {
            const { namespace, content, tags, classification, classification_override } = args as unknown as LogParams;
            const validation = validateLogInput(namespace, content, tags, maxContentSize);
            if (!validation.valid) {
              return errResult("log", "validation_error", validation.error!);
            }
            const classificationInputError = validateClassificationInput(classification, classification_override);
            if (classificationInputError) {
              return errResult("log", "validation_error", classificationInputError);
            }
            if (classification_override === true && ctx.principalType !== "owner") {
              return errResult("log", "access_denied", "classification_override is only available to the owner principal.");
            }
            if (!canWrite(ctx, namespace)) {
              return accessDeniedResponse(ctx, "log");
            }
            let result;
            try {
              result = appendLog(db, namespace, content, tags ?? [], ctx.principalId, {
                classification,
                classificationOverride: classification_override,
              });
            } catch (error) {
              return errResult("log", "validation_error", (error as Error).message);
            }
            const logEntry = getById(db, result.id);
            if (logEntry) {
              syncCommitmentsForEntry(db, logEntry.id, extractCommitmentsFromEntry(logEntry));
            }
            // Analytics: log log outcome correlated to prior retrieval in this session
            if (sessionId) {
              logRetrievalOutcome(db, sessionId, {
                outcomeType: "log_in_result_namespace",
                namespace,
              });
            }
            return okResult("log", {
              status: "logged",
              id: result.id,
              namespace,
              timestamp: result.timestamp,
              classification: result.classification,
              provenance: buildProvenance(ctx.principalId, ctx.principalId),
            });
          }

          case "memory_list": {
            const { namespace, include_demo, include_completed_tasks, limit: rawLimit, offset: rawOffset } = (args ?? {}) as ListParams;
            if (!namespace) {
              const resolvedLimit = Math.min(Math.max(1, typeof rawLimit === "number" ? rawLimit : 20), 200);
              const resolvedOffset = Math.max(0, typeof rawOffset === "number" ? rawOffset : 0);
              const allNamespaces = listVisibleNamespaces(db, ctx);
              const completedTasks = include_completed_tasks ? new Set<string>() : getCompletedTaskNamespaces(db);
              const filtered = allNamespaces.filter((ns) => {
                if (!canRead(ctx, ns.namespace)) return false;
                if (!include_demo && (ns.namespace.startsWith("demo/") || ns.namespace === "demo")) return false;
                if (!include_completed_tasks && completedTasks.has(ns.namespace)) return false;
                return true;
              });
              const { namespaces, total, has_more } = listNamespacesPaged(filtered, resolvedLimit, resolvedOffset);
              return okResult("list", { namespaces, total, returned: namespaces.length, has_more });
            }
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return errResult("list", "validation_error", nsCheck.error!);
            }
            if (!canRead(ctx, namespace)) {
              return okResult("list", { namespace, state_entries: [], log_summary: { log_count: 0, earliest: null, latest: null, recent: [] } });
            }
            const { stateEntries, logSummary } = listNamespaceContents(db, namespace);
            const visibleLogSummary = isLibrarianEnabled()
              ? summarizeNamespaceLogsByClassification(db, namespace, getContextMaxClassification(ctx))
              : {
                  log_count: logSummary.log_count,
                  earliest: logSummary.earliest,
                  latest: logSummary.latest,
                };
            const serializedStateEntries = stateEntries.map((e) => {
              const tags = JSON.parse(e.tags) as string[];
              const redacted = maybeRedactEntryMetadata(db, ctx, {
                id: e.id,
                namespace,
                key: e.key,
                entry_type: "state",
                classification: e.classification,
                tags,
                updated_at: e.updated_at,
              }, "memory_list", sessionId);
              if (redacted) {
                return redacted;
              }
              return {
                id: e.id,
                key: e.key,
                preview: e.preview,
                tags,
                updated_at: e.updated_at,
                classification: e.classification,
                provenance: buildProvenance(e.agent_id, e.owner_principal_id),
              };
            });
            const serializedRecentLogs = logSummary.recent.map((l) => {
              const tags = JSON.parse(l.tags) as string[];
              const redacted = maybeRedactEntryMetadata(db, ctx, {
                id: l.id,
                namespace,
                key: null,
                entry_type: "log",
                classification: l.classification,
                tags,
                created_at: l.created_at,
              }, "memory_list", sessionId);
              if (redacted) {
                return redacted;
              }
              return {
                id: l.id,
                content_preview: l.content_preview,
                tags,
                created_at: l.created_at,
                classification: l.classification,
                provenance: buildProvenance(l.agent_id, l.owner_principal_id),
              };
            });
            return okResult("list", {
              namespace,
              state_entries: serializedStateEntries,
              log_summary: {
                log_count: visibleLogSummary.log_count,
                earliest: visibleLogSummary.earliest,
                latest: visibleLogSummary.latest,
                recent: serializedRecentLogs,
              },
            });
          }

          case "memory_delete": {
            const { namespace, key, delete_token } =
              args as unknown as DeleteParams;
            const nsCheck = validateNamespace(namespace);
            if (!nsCheck.valid) {
              return errResult("delete", "validation_error", nsCheck.error!);
            }
            if (key) {
              const keyCheck = validateKey(key);
              if (!keyCheck.valid) {
                return errResult("delete", "validation_error", keyCheck.error!);
              }
            }

            if (!canWrite(ctx, namespace)) {
              return accessDeniedResponse(ctx, "delete");
            }
            const allowGlobalNamespaceDelete = ctx.principalType === "owner";

            // Execute with token
            if (delete_token) {
              if (!consumeDeleteToken(delete_token, namespace, key)) {
                return errResult("delete", "invalid_token", "Delete token is invalid, expired, or doesn't match the requested namespace/key. Request a new preview first.");
              }
              const deletedCount = executeDelete(db, namespace, key, ctx.principalId, allowGlobalNamespaceDelete);
              const target = key ? `entry "${key}" in "${namespace}"` : `all entries in "${namespace}"`;
              return okResult("delete", {
                phase: "confirmed",
                namespace,
                key: key ?? undefined,
                deleted_count: deletedCount,
                message: `Deleted ${deletedCount} entries (${target}).`,
              });
            }

            // Preview
            const info = previewDelete(db, namespace, key, ctx.principalId, allowGlobalNamespaceDelete);
            const token = generateDeleteToken(namespace, key);
            const target = key ? `entry "${key}" in "${namespace}"` : `all entries in "${namespace}"`;
            return okResult("delete", {
              phase: "preview",
              namespace,
              key: key ?? undefined,
              will_delete: {
                state_count: info.stateCount,
                log_count: info.logCount,
                keys: info.keys.length > 0 ? info.keys : undefined,
              },
              delete_token: token,
              message: `Will delete ${info.stateCount} state entries and ${info.logCount} log entries (${target}). Call again with delete_token to confirm.`,
            });
          }

          case "memory_insights": {
            if (ctx.principalType !== "owner") {
              return okResult("insights", { entries: [], total: 0, min_impressions: 3 });
            }
            const insightsArgs = (args ?? {}) as InsightsParams;
            const minImpressions = typeof insightsArgs.min_impressions === "number"
              ? Math.max(1, Math.floor(insightsArgs.min_impressions))
              : 3;
            const insightsLimit = clampOptionalLimit(insightsArgs.limit, 50) ?? 20;

            const rows = getInsightsByEntry(db, insightsArgs.namespace, minImpressions, insightsLimit);
            const entries: EntryInsight[] = rows.map(computeEntryInsight);

            return okResult("insights", {
              entries,
              total: entries.length,
              min_impressions: minImpressions,
            });
          }

          case "memory_history": {
            const { namespace, since, action, limit, cursor } = (args ?? {}) as AuditHistoryParams;

            // Namespace subtree access check
            if (namespace) {
              const prefix = namespace.endsWith("/") ? namespace : namespace + "/";
              if (!canReadSubtree(ctx, prefix) && !canRead(ctx, namespace)) {
                return okResult("history", {
                  generated_at: new Date().toISOString(),
                  count: 0,
                  entries: [],
                  next_cursor: cursor ?? null,
                  has_more: false,
                });
              }
            }

            // Validate action enum if provided
            if (action !== undefined && !VALID_AUDIT_ACTIONS.includes(action as AuditAction | "delete_namespace" | "log")) {
              return errResult(
                "history",
                "validation_error",
                `Invalid action "${action}". Must be one of: write, update, delete, delete_namespace, log. Legacy aliases namespace_delete and log_append are also accepted.`,
              );
            }

            const historyPage = getAuditHistoryPage(db, {
              namespace,
              since,
              action,
              limit,
              cursor,
            });

            const filteredEntries = historyPage.entries
              .filter(e => canRead(ctx, e.namespace))
              .map((entry) => formatHistoryEntry(db, ctx, entry, sessionId));

            return okResult("history", {
              generated_at: new Date().toISOString(),
              count: filteredEntries.length,
              entries: filteredEntries,
              next_cursor: historyPage.nextCursor,
              has_more: historyPage.hasMore,
            });
          }

          case "memory_status": {
            const schemaVersion = getSchemaVersion(db);
            return okResult("status", {
              server: {
                name: "munin-memory",
                version: "0.1.0",
              },
              schema_version: schemaVersion,
              features: {
                embeddings: isEmbeddingAvailable(),
                semantic_search: isSemanticEnabled(),
                hybrid_search: isHybridEnabled(),
              },
              tools: {
                count: TOOL_DEFINITIONS.length,
                names: TOOL_DEFINITIONS.map((t) => t.name),
              },
              principal: {
                id: ctx.principalId,
                type: ctx.principalType,
              },
              librarian: {
                enabled: isLibrarianEnabled(),
                redaction_logging: isRedactionLogEnabled(),
                transport_type: getContextTransportType(ctx),
                max_classification: getContextMaxClassification(ctx),
              },
            });
          }

          default:
            return errResult("unknown", "unknown_tool", `Unknown tool: ${name}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, action: name ?? "unknown", error: "internal_error", message }),
          }],
          isError: true,
        };
      }
    },
  );
}
