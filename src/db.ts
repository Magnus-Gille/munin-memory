import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type {
  ClassificationLevel,
  CommitmentStatus,
  Entry,
  AuditAction,
  AuditEntry,
  EntryType,
  TrackedStatusRow,
  TransportType,
  ConsolidationMetadata,
  ConsolidationCandidate,
  CrossReference,
} from "./types.js";
import { runMigrations } from "./migrations.js";
import { scanForSecrets } from "./security.js";
import {
  CLASSIFICATION_LEVELS,
  compareClassificationLevels,
  FALLBACK_RESTRICTED_CLASSIFICATION,
  listNamespaceClassificationFloors as listNamespaceClassificationFloorsFromPolicy,
  normalizeStoredClassification,
  parseExplicitClassification,
  resolveNamespaceClassificationFloor,
  resolveNamespaceClassificationFloorFromRows,
  resolveStoredClassification,
  syncClassificationTag,
  validateClassificationPattern,
} from "./librarian.js";

let _vecLoaded = false;

export function nowUTC(): string {
  return new Date().toISOString();
}

export function resolveDbPath(configuredPath?: string): string {
  const raw = configuredPath || "~/.munin-memory/memory.db";
  return raw.replace(/^~/, homedir());
}

export function getDataDir(configuredDbPath?: string): string {
  return dirname(resolveDbPath(configuredDbPath));
}

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = resolveDbPath(dbPath);
  const dir = getDataDir(dbPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(resolvedPath);

  // Set permissions on the DB file (owner read/write only)
  try {
    chmodSync(resolvedPath, 0o600);
  } catch {
    // May fail if file doesn't exist yet; will be created on first write
  }

  // Pragmas per debate resolution #3
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  // Load sqlite-vec extension (soft dependency — vec features disabled if unavailable)
  try {
    sqliteVec.load(db);
    _vecLoaded = true;
  } catch {
    _vecLoaded = false;
  }

  runMigrations(db);

  // Create vec0 table idempotently after migrations (not version-gated)
  if (_vecLoaded) {
    ensureVecSchema(db);
  }

  return db;
}

export function vecLoaded(): boolean {
  return _vecLoaded;
}

/**
 * Mark sqlite-vec as loaded externally (e.g. benchmark runner
 * that opens its own DB and calls sqliteVec.load() directly).
 */
export function setVecLoaded(loaded: boolean): void {
  _vecLoaded = loaded;
}

/**
 * Idempotently create the entries_vec vec0 table.
 * Called on every startup when sqlite-vec is available.
 * NOT part of the migration system — vec0 tables can't be created
 * without the extension loaded.
 */
function ensureVecSchema(db: Database.Database): void {
  const hasVec = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'",
    )
    .get();

  if (!hasVec) {
    db.exec(`
      CREATE VIRTUAL TABLE entries_vec USING vec0(
        entry_id TEXT,
        embedding float[384]
      );
    `);
  }
}

// Rebuild FTS index — for maintenance (debate resolution #7)
export function rebuildFTS(db: Database.Database): void {
  db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
}

// --- Tracked status queries ---

export function getTrackedStatuses(db: Database.Database): TrackedStatusRow[] {
  return db
    .prepare(
      `SELECT id, namespace, key, substr(content, 1, 300) as content_preview, content, tags, agent_id, owner_principal_id, created_at, updated_at, valid_until, classification
       FROM entries
       WHERE entry_type = 'state' AND key = 'status'
         AND (namespace LIKE 'projects/%' ESCAPE '\\' OR namespace LIKE 'clients/%' ESCAPE '\\')
       ORDER BY updated_at DESC`,
    )
    .all() as TrackedStatusRow[];
}

// --- State entry operations ---

export interface WriteStateResult {
  status: "created" | "updated" | "conflict";
  id?: string;
  updated_at?: string;
  classification?: ClassificationLevel;
  tags?: string[];
  message?: string;
  current_updated_at?: string;
}

export interface ClassificationWriteOptions {
  classification?: ClassificationLevel;
  classificationOverride?: boolean;
}

export interface ExpirableEntryLike {
  entry_type: EntryType;
  valid_until?: string | null;
}

export function isEntryExpired(entry: ExpirableEntryLike, now = nowUTC()): boolean {
  return entry.entry_type === "state"
    && typeof entry.valid_until === "string"
    && entry.valid_until <= now;
}

function insertAuditRow(
  db: Database.Database,
  timestamp: string,
  agentId: string,
  action: AuditAction | string,
  namespace: string,
  key: string | null,
  detail: string | null,
  entryId: string | null = null,
): void {
  db.prepare(
    "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(timestamp, agentId, action, namespace, key, detail, entryId);
}

function resolveWriteClassification(
  db: Database.Database,
  namespace: string,
  tags: string[],
  options: ClassificationWriteOptions | undefined,
  existingClassification?: string | null,
): { classification: ClassificationLevel; tags: string[]; usedOverride: boolean } {
  const explicitClassification = parseExplicitClassification({
    classification: options?.classification,
    tags,
  });
  const namespaceFloor = resolveNamespaceClassificationFloor(db, namespace);
  const resolved = resolveStoredClassification({
    namespace,
    namespaceFloor,
    explicitClassification,
    existingClassification,
    allowBelowFloorOverride: options?.classificationOverride === true,
  });

  return {
    classification: resolved.classification,
    tags: syncClassificationTag(tags, resolved.classification),
    usedOverride: resolved.usedOverride,
  };
}

export function writeState(
  db: Database.Database,
  namespace: string,
  key: string,
  content: string,
  tags: string[],
  agentId = "default",
  expectedUpdatedAt?: string,
  validUntil?: string | null,
  classificationOptions?: ClassificationWriteOptions,
): WriteStateResult {
  const now = nowUTC();

  // Check if exists
  const existing = db.prepare(
    "SELECT id, content, updated_at, valid_until, owner_principal_id, classification FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
  ).get(namespace, key) as {
    id: string;
    content: string;
    updated_at: string;
    valid_until: string | null;
    owner_principal_id: string | null;
    classification: string | null;
  } | undefined;

  // Compare-and-swap: reject if entry was modified since caller last read it
  if (expectedUpdatedAt && existing && existing.updated_at !== expectedUpdatedAt) {
    return {
      status: "conflict",
      message: `Entry was updated at ${existing.updated_at}, expected ${expectedUpdatedAt}. Read the current version before overwriting.`,
      current_updated_at: existing.updated_at,
    };
  }

  const resolvedClassification = resolveWriteClassification(
    db,
    namespace,
    tags,
    classificationOptions,
    existing?.classification,
  );
  const tagsJson = JSON.stringify(resolvedClassification.tags);

  const txn = db.transaction(() => {
    if (existing) {
      const nextValidUntil = validUntil === undefined ? existing.valid_until : validUntil;
      db.prepare(
        `UPDATE entries SET content = ?, tags = ?, updated_at = ?, valid_until = ?, classification = ?, agent_id = ?,
         embedding_status = 'pending', embedding_model = NULL
         WHERE namespace = ? AND key = ? AND entry_type = 'state'`,
      ).run(
        content,
        tagsJson,
        now,
        nextValidUntil ?? null,
        resolvedClassification.classification,
        agentId,
        namespace,
        key,
      );

      const overrideSuffix = resolvedClassification.usedOverride
        ? `; classification_override ${resolvedClassification.classification}`
        : "";
      const updateDetail = `updated (${existing.content.length} → ${content.length} chars)${overrideSuffix}`;
      insertAuditRow(db, now, agentId, "update", namespace, key, updateDetail, existing.id);

      return {
        status: "updated" as const,
        id: existing.id,
        updated_at: now,
        classification: resolvedClassification.classification,
        tags: resolvedClassification.tags,
      };
    } else {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, owner_principal_id, created_at, updated_at, valid_until, classification)
         VALUES (?, ?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        namespace,
        key,
        content,
        tagsJson,
        agentId,
        agentId,
        now,
        now,
        validUntil ?? null,
        resolvedClassification.classification,
      );

      const writePreview = content.length > 80 ? content.slice(0, 80) + "..." : content;
      const overrideSuffix = resolvedClassification.usedOverride
        ? `; classification_override ${resolvedClassification.classification}`
        : "";
      insertAuditRow(db, now, agentId, "write", namespace, key, `${writePreview}${overrideSuffix}`, id);

      return {
        status: "created" as const,
        id,
        updated_at: now,
        classification: resolvedClassification.classification,
        tags: resolvedClassification.tags,
      };
    }
  });

  return txn();
}

export interface PatchParams {
  content_append?: string;
  content_prepend?: string;
  tags_add?: string[];
  tags_remove?: string[];
}

export type PatchStateResult =
  | { status: "patched"; id: string }
  | { status: "not_found" }
  | { status: "conflict"; message: string; current_updated_at: string }
  | { status: "secret_detected"; error: string };

export function patchState(
  db: Database.Database,
  namespace: string,
  key: string,
  patch: PatchParams,
  agentId = "default",
  expectedUpdatedAt?: string,
  classificationOptions?: ClassificationWriteOptions,
): PatchStateResult {
  const existing = db.prepare(
    "SELECT id, content, tags, updated_at, classification FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
  ).get(namespace, key) as {
    id: string;
    content: string;
    tags: string;
    updated_at: string;
    classification: string | null;
  } | undefined;

  if (!existing) {
    return { status: "not_found" };
  }

  // Compare-and-swap: reject if entry was modified since caller last read it
  if (expectedUpdatedAt && existing.updated_at !== expectedUpdatedAt) {
    return {
      status: "conflict",
      message: `Entry was updated at ${existing.updated_at}, expected ${expectedUpdatedAt}. Read the current version before overwriting.`,
      current_updated_at: existing.updated_at,
    };
  }

  // Apply content patches
  let content = existing.content;
  if (patch.content_prepend !== undefined) {
    content = patch.content_prepend + "\n" + content;
  }
  if (patch.content_append !== undefined) {
    content = content + "\n" + patch.content_append;
  }

  // Apply tag patches
  let tags: string[] = JSON.parse(existing.tags) as string[];
  if (patch.tags_add && patch.tags_add.length > 0) {
    const existing_set = new Set(tags);
    for (const t of patch.tags_add) {
      if (!existing_set.has(t)) {
        tags.push(t);
      }
    }
  }
  if (patch.tags_remove && patch.tags_remove.length > 0) {
    const remove_set = new Set(patch.tags_remove);
    tags = tags.filter((t) => !remove_set.has(t));
  }

  // Security check on final content
  const secCheck = scanForSecrets(content);
  if (!secCheck.valid) {
    return { status: "secret_detected", error: secCheck.error! };
  }

  const now = nowUTC();
  const resolvedClassification = resolveWriteClassification(
    db,
    namespace,
    tags,
    classificationOptions,
    existing.classification,
  );
  const tagsJson = JSON.stringify(resolvedClassification.tags);

  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE entries SET content = ?, tags = ?, updated_at = ?, classification = ?, agent_id = ?,
       embedding_status = 'pending', embedding_model = NULL
       WHERE namespace = ? AND key = ? AND entry_type = 'state'`,
    ).run(
      content,
      tagsJson,
      now,
      resolvedClassification.classification,
      agentId,
      namespace,
      key,
    );

    const patchOps: string[] = [];
    if (patch.content_prepend !== undefined) patchOps.push("content_prepend");
    if (patch.content_append !== undefined) patchOps.push("content_append");
    if (patch.tags_add && patch.tags_add.length > 0) patchOps.push("tags_add");
    if (patch.tags_remove && patch.tags_remove.length > 0) patchOps.push("tags_remove");
    if (resolvedClassification.usedOverride) patchOps.push(`classification_override:${resolvedClassification.classification}`);
    const patchDetail = patchOps.length > 0 ? patchOps.join(", ") : "no-op";
    insertAuditRow(db, now, agentId, "patch", namespace, key, patchDetail, existing.id);

    return { status: "patched" as const, id: existing.id };
  });

  return txn();
}

export function readState(
  db: Database.Database,
  namespace: string,
  key: string,
): Entry | null {
  return (
    db
      .prepare(
        "SELECT * FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
      )
      .get(namespace, key) as Entry | undefined
  ) ?? null;
}

export function getById(db: Database.Database, id: string): Entry | null {
  return (
    db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Entry | undefined
  ) ?? null;
}

// --- Log entry operations ---

export function appendLog(
  db: Database.Database,
  namespace: string,
  content: string,
  tags: string[],
  agentId = "default",
  classificationOptions?: ClassificationWriteOptions,
): { id: string; timestamp: string; classification: ClassificationLevel; tags: string[] } {
  const now = nowUTC();
  const id = randomUUID();
  const resolvedClassification = resolveWriteClassification(
    db,
    namespace,
    tags,
    classificationOptions,
  );
  const tagsJson = JSON.stringify(resolvedClassification.tags);

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, owner_principal_id, created_at, updated_at, classification)
       VALUES (?, ?, NULL, 'log', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      namespace,
      content,
      tagsJson,
      agentId,
      agentId,
      now,
      now,
      resolvedClassification.classification,
    );

    const logPreview = content.length > 80 ? content.slice(0, 80) + "..." : content;
    const overrideSuffix = resolvedClassification.usedOverride
      ? `; classification_override ${resolvedClassification.classification}`
      : "";
    insertAuditRow(db, now, agentId, "log_append", namespace, null, `${logPreview}${overrideSuffix}`, id);
  });

  txn();
  return {
    id,
    timestamp: now,
    classification: resolvedClassification.classification,
    tags: resolvedClassification.tags,
  };
}

// --- Query / search operations ---

function escapeFtsQuery(query: string): string {
  // Tokenize the query into (a) balanced quoted phrases, preserved as FTS5
  // phrase tokens, and (b) unquoted whitespace-separated words. Both forms
  // are wrapped in double quotes in the output so special FTS5 characters
  // (hyphens, colons, etc.) are treated as literals, and joined with
  // explicit AND so multi-word queries find entries containing all tokens
  // in any order. Stray or unbalanced quotes in unquoted tokens are
  // removed -- this prevents natural-language questions (e.g. a question
  // that embeds a book title in quotes, or has a dangling opening quote)
  // from producing invalid FTS5 syntax.
  const tokens: string[] = [];
  const tokenizer = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenizer.exec(query)) !== null) {
    const raw = match[1] !== undefined ? match[1] : (match[2] ?? "");
    const cleaned = raw.replace(/"/g, "").trim();
    if (cleaned.length > 0) {
      tokens.push(`"${cleaned}"`);
    }
  }
  if (tokens.length === 0) {
    // FTS5 rejects empty queries; return a phrase that matches nothing.
    return '""';
  }
  return tokens.join(" AND ");
}

function escapeForLike(s: string): string {
  // Debate resolution #10: escape LIKE wildcards
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface QueryOptions {
  query: string;
  namespace?: string;
  entryType?: EntryType;
  tags?: string[];
  limit?: number;
  includeExpired?: boolean;
  since?: string;
  until?: string;
  /**
   * When true, treat `query` as a pre-formed FTS5 expression and pass it
   * through without tokenization or escaping. Callers that opt in are
   * responsible for producing valid FTS5 syntax (e.g. `buildRelaxedLexicalQuery`).
   */
  rawFts5?: boolean;
}

export interface LexicalQueryResult {
  entry: Entry;
  score: number;
  rank: number;
}

export interface SemanticQueryResult {
  entry: Entry;
  distance: number;
  rank: number;
}

export interface HybridQueryResult {
  entry: Entry;
  score: number;
  lexicalRank?: number;
  lexicalScore?: number;
  semanticRank?: number;
  semanticDistance?: number;
}

export function queryEntries(
  db: Database.Database,
  options: QueryOptions,
): Entry[] {
  return queryEntriesLexicalScored(db, options).map((result) => result.entry);
}

export function queryEntriesLexicalScored(
  db: Database.Database,
  options: QueryOptions,
): LexicalQueryResult[] {
  const { query, namespace, entryType, tags, limit = 10, includeExpired = false, since, until, rawFts5 = false } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 50);
  const now = nowUTC();

  let sql = `
    SELECT e.*, bm25(entries_fts) as lexical_score FROM entries e
    JOIN entries_fts fts ON e.rowid = fts.rowid
    WHERE entries_fts MATCH ?
  `;
  const params: unknown[] = [rawFts5 ? query : escapeFtsQuery(query)];

  if (namespace) {
    if (namespace.endsWith("/")) {
      sql += " AND e.namespace LIKE ? ESCAPE '\\'";
      params.push(escapeForLike(namespace) + "%");
    } else {
      sql += " AND e.namespace = ?";
      params.push(namespace);
    }
  }

  if (entryType) {
    sql += " AND e.entry_type = ?";
    params.push(entryType);
  }

  if (!includeExpired) {
    sql += " AND (e.entry_type != 'state' OR e.valid_until IS NULL OR e.valid_until > ?)";
    params.push(now);
  }

  // Apply tag filtering in SQL before LIMIT so that limit semantics
  // are truthful — callers expect limit to apply to the filtered set,
  // not to an internal candidate window that is post-filtered.
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      sql += " AND EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)";
      params.push(tag);
    }
  }

  if (since) {
    sql += " AND e.updated_at >= ?";
    params.push(since);
  }

  if (until) {
    sql += " AND e.updated_at <= ?";
    params.push(until);
  }

  sql += " ORDER BY lexical_score LIMIT ?";
  params.push(clampedLimit);

  const rows = db.prepare(sql).all(...params) as Array<Entry & { lexical_score: number }>;

  return rows.map((row, index) => {
    const { lexical_score, ...entry } = row;
    return {
      entry,
      score: lexical_score,
      rank: index + 1,
    };
  });
}

export interface FilterOptions {
  namespace?: string;
  entryType?: EntryType;
  tags?: string[];
  limit?: number;
  includeExpired?: boolean;
  since?: string;
  until?: string;
}

/**
 * Query entries by filters only (no FTS search text). Results ordered by updated_at DESC.
 * Used when memory_query is called without a query string — pure browse-by-filter.
 */
export function queryEntriesByFilter(
  db: Database.Database,
  options: FilterOptions,
): Entry[] {
  const { namespace, entryType, tags, limit = 10, includeExpired = false, since, until } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 50);
  const now = nowUTC();

  let sql = "SELECT * FROM entries WHERE 1=1";
  const params: unknown[] = [];

  if (namespace) {
    if (namespace.endsWith("/")) {
      sql += " AND namespace LIKE ? ESCAPE '\\'";
      params.push(escapeForLike(namespace) + "%");
    } else {
      sql += " AND namespace = ?";
      params.push(namespace);
    }
  }

  if (entryType) {
    sql += " AND entry_type = ?";
    params.push(entryType);
  }

  if (!includeExpired) {
    sql += " AND (entry_type != 'state' OR valid_until IS NULL OR valid_until > ?)";
    params.push(now);
  }

  if (tags && tags.length > 0) {
    for (const tag of tags) {
      sql += " AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
      params.push(tag);
    }
  }

  if (since) {
    sql += " AND updated_at >= ?";
    params.push(since);
  }

  if (until) {
    sql += " AND updated_at <= ?";
    params.push(until);
  }

  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(clampedLimit);

  return db.prepare(sql).all(...params) as Entry[];
}

// --- List operations ---

export interface NamespaceCount {
  namespace: string;
  state_count: number;
  log_count: number;
  last_activity_at: string;
}

function getVisibleClassificationLevels(
  maxClassification: ClassificationLevel,
): ClassificationLevel[] {
  return CLASSIFICATION_LEVELS.filter((level) => compareClassificationLevels(level, maxClassification) <= 0);
}

export function listNamespaces(db: Database.Database): NamespaceCount[] {
  return db
    .prepare(
      `SELECT namespace,
              SUM(CASE WHEN entry_type = 'state' THEN 1 ELSE 0 END) as state_count,
              SUM(CASE WHEN entry_type = 'log' THEN 1 ELSE 0 END) as log_count,
              MAX(updated_at) as last_activity_at
       FROM entries
       GROUP BY namespace
       ORDER BY namespace`,
    )
    .all() as NamespaceCount[];
}

export function listNamespacesByClassification(
  db: Database.Database,
  maxClassification: ClassificationLevel,
): NamespaceCount[] {
  const visibleLevels = getVisibleClassificationLevels(maxClassification);
  const placeholders = visibleLevels.map(() => "?").join(", ");

  return db
    .prepare(
      `SELECT namespace,
              SUM(CASE WHEN entry_type = 'state' THEN 1 ELSE 0 END) as state_count,
              SUM(CASE WHEN entry_type = 'log' THEN 1 ELSE 0 END) as log_count,
              MAX(updated_at) as last_activity_at
       FROM entries
       WHERE classification IN (${placeholders})
       GROUP BY namespace
       ORDER BY namespace`,
    )
    .all(...visibleLevels) as NamespaceCount[];
}

export interface ListNamespacesResult {
  namespaces: NamespaceCount[];
  total: number;
  has_more: boolean;
}

export function listNamespacesPaged(
  allNamespaces: NamespaceCount[],
  limit: number,
  offset: number,
): ListNamespacesResult {
  const total = allNamespaces.length;
  const paged = allNamespaces.slice(offset, offset + limit);
  return { namespaces: paged, total, has_more: offset + paged.length < total };
}

export interface StateEntryPreview {
  id: string;
  key: string;
  preview: string;
  tags: string;
  agent_id: string;
  owner_principal_id: string | null;
  updated_at: string;
  classification: ClassificationLevel;
}

export interface LogPreview {
  id: string;
  content_preview: string;
  tags: string;
  agent_id: string;
  owner_principal_id: string | null;
  created_at: string;
  classification: ClassificationLevel;
}

export interface LogSummary {
  log_count: number;
  earliest: string | null;
  latest: string | null;
  recent: LogPreview[];
}

export function summarizeNamespaceLogsByClassification(
  db: Database.Database,
  namespace: string,
  maxClassification: ClassificationLevel,
): Omit<LogSummary, "recent"> {
  const visibleLevels = getVisibleClassificationLevels(maxClassification);
  const placeholders = visibleLevels.map(() => "?").join(", ");

  return (
    db
      .prepare(
        `SELECT COUNT(*) as log_count, MIN(created_at) as earliest, MAX(created_at) as latest
         FROM entries
         WHERE namespace = ?
           AND entry_type = 'log'
           AND classification IN (${placeholders})`,
      )
      .get(namespace, ...visibleLevels) as Omit<LogSummary, "recent">
  ) ?? { log_count: 0, earliest: null, latest: null };
}

export function listNamespaceContents(
  db: Database.Database,
  namespace: string,
): { stateEntries: StateEntryPreview[]; logSummary: LogSummary } {
  const stateEntries = db
    .prepare(
      `SELECT id, key, substr(content, 1, 100) as preview, tags, agent_id, owner_principal_id, updated_at, classification
       FROM entries WHERE namespace = ? AND entry_type = 'state' ORDER BY key`,
    )
    .all(namespace) as StateEntryPreview[];

  const logStats = (db
    .prepare(
      `SELECT COUNT(*) as log_count, MIN(created_at) as earliest, MAX(created_at) as latest
       FROM entries WHERE namespace = ? AND entry_type = 'log'`,
    )
    .get(namespace) as { log_count: number; earliest: string | null; latest: string | null }) ?? { log_count: 0, earliest: null, latest: null };

  const recentLogs = db
    .prepare(
      `SELECT id, substr(content, 1, 200) as content_preview, tags, agent_id, owner_principal_id, created_at, classification
       FROM entries WHERE namespace = ? AND entry_type = 'log'
       ORDER BY rowid DESC LIMIT 5`,
    )
    .all(namespace) as LogPreview[];

  const logSummary: LogSummary = {
    ...logStats,
    recent: recentLogs,
  };

  return { stateEntries, logSummary };
}

export interface DerivationEntryOptions {
  namespace?: string;
  since?: string;
}

export function listEntriesForDerivation(
  db: Database.Database,
  options: DerivationEntryOptions = {},
): Entry[] {
  const { namespace, since } = options;
  let sql = "SELECT * FROM entries WHERE 1=1";
  const params: unknown[] = [];

  if (namespace) {
    if (namespace.endsWith("/")) {
      sql += " AND namespace LIKE ? ESCAPE '\\'";
      params.push(escapeForLike(namespace) + "%");
    } else {
      sql += " AND (namespace = ? OR namespace LIKE ? ESCAPE '\\')";
      params.push(namespace);
      params.push(escapeForLike(namespace) + "/%");
    }
  }

  if (since) {
    sql += " AND updated_at >= ?";
    params.push(since);
  }

  sql += " ORDER BY updated_at DESC";
  return db.prepare(sql).all(...params) as Entry[];
}

export interface DerivedCommitmentInput {
  sourceType: string;
  fingerprint: string;
  text: string;
  dueAt?: string | null;
  confidence: number;
}

export interface CommitmentRow {
  id: string;
  namespace: string;
  source_entry_id: string;
  source_type: string;
  source_fingerprint: string;
  text: string;
  due_at: string | null;
  status: CommitmentStatus;
  confidence: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  source_key: string | null;
  source_excerpt: string;
  source_classification: ClassificationLevel;
}

export interface ListCommitmentsOptions {
  namespace?: string;
  since?: string;
  limit?: number;
  includeResolved?: boolean;
}

export function syncCommitmentsForEntry(
  db: Database.Database,
  entryId: string,
  derivedCommitments: DerivedCommitmentInput[],
): void {
  const source = db
    .prepare("SELECT id, namespace, key, entry_type, classification FROM entries WHERE id = ?")
    .get(entryId) as {
      id: string;
      namespace: string;
      key: string | null;
      entry_type: EntryType;
      classification: string | null;
    } | undefined;

  if (!source) return;
  const sourceClassification = normalizeStoredClassification(source.classification);

  const existingRows = db
    .prepare(
      `SELECT id, source_type, source_fingerprint, status
       FROM commitments
       WHERE source_entry_id = ?`,
    )
    .all(entryId) as Array<{ id: string; source_type: string; source_fingerprint: string; status: CommitmentStatus }>;

  const existingByFingerprint = new Map(existingRows.map((row) => [row.source_fingerprint, row]));
  const nextFingerprints = new Set(derivedCommitments.map((commitment) => commitment.fingerprint));
  const now = nowUTC();

  const insertCommitment = db.prepare(
    `INSERT INTO commitments
       (id, namespace, source_entry_id, source_type, source_fingerprint, text, due_at, status, confidence, created_at, updated_at, resolved_at, source_classification)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?)`,
  );
  const updateCommitment = db.prepare(
    `UPDATE commitments
     SET namespace = ?, source_type = ?, text = ?, due_at = ?, confidence = ?, status = 'open', updated_at = ?, resolved_at = NULL, source_classification = ?
     WHERE id = ?`,
  );
  const resolveCommitment = db.prepare(
    `UPDATE commitments
     SET status = ?, updated_at = ?, resolved_at = COALESCE(resolved_at, ?)
     WHERE id = ? AND status = 'open'`,
  );

  const txn = db.transaction(() => {
    if (sourceClassification === "client-restricted") {
      db.prepare("DELETE FROM commitments WHERE source_entry_id = ?").run(source.id);
      return;
    }

    for (const commitment of derivedCommitments) {
      const existing = existingByFingerprint.get(commitment.fingerprint);
      if (existing) {
        updateCommitment.run(
          source.namespace,
          commitment.sourceType,
          commitment.text,
          commitment.dueAt ?? null,
          commitment.confidence,
          now,
          sourceClassification,
          existing.id,
        );
        continue;
      }

      insertCommitment.run(
        randomUUID(),
        source.namespace,
        source.id,
        commitment.sourceType,
        commitment.fingerprint,
        commitment.text,
        commitment.dueAt ?? null,
        commitment.confidence,
        now,
        now,
        sourceClassification,
      );
    }

    for (const existing of existingRows) {
      if (nextFingerprints.has(existing.source_fingerprint)) continue;
      const resolvedStatus: CommitmentStatus = existing.source_type === "tracked_next_step"
        ? "done"
        : "cancelled";
      resolveCommitment.run(resolvedStatus, now, now, existing.id);
    }
  });

  txn();
}

export function listCommitments(
  db: Database.Database,
  options: ListCommitmentsOptions = {},
): CommitmentRow[] {
  const { namespace, since, limit = 100, includeResolved = true } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 200);

  let sql = `
    SELECT c.*,
           e.key AS source_key,
           substr(e.content, 1, 220) AS source_excerpt,
           COALESCE(c.source_classification, e.classification, '${FALLBACK_RESTRICTED_CLASSIFICATION}') AS source_classification
    FROM commitments c
    JOIN entries e ON e.id = c.source_entry_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (namespace) {
    if (namespace.endsWith("/")) {
      sql += " AND c.namespace LIKE ? ESCAPE '\\'";
      params.push(escapeForLike(namespace) + "%");
    } else {
      sql += " AND (c.namespace = ? OR c.namespace LIKE ? ESCAPE '\\')";
      params.push(namespace);
      params.push(escapeForLike(namespace) + "/%");
    }
  }

  if (since) {
    sql += " AND c.updated_at >= ?";
    params.push(since);
  }

  if (!includeResolved) {
    sql += " AND c.status = 'open'";
  }

  sql += " ORDER BY CASE WHEN c.due_at IS NULL THEN 1 ELSE 0 END, c.due_at ASC, c.updated_at DESC LIMIT ?";
  params.push(clampedLimit);

  return db.prepare(sql).all(...params) as CommitmentRow[];
}

export interface ClassificationFloorRow {
  namespace_pattern: string;
  min_classification: ClassificationLevel;
  created_at: string;
  updated_at: string;
}

export interface ClassificationAuditRow {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: EntryType;
  classification: ClassificationLevel;
  namespace_floor: ClassificationLevel;
  tags: string;
}

export interface RedactionLogInput {
  sessionId?: string | null;
  principalId: string;
  transportType: TransportType;
  entryId: string;
  entryNamespace: string;
  entryClassification: ClassificationLevel;
  connectionMaxClassification: ClassificationLevel;
  toolName: string;
}

export function listNamespaceClassificationFloors(
  db: Database.Database,
): ClassificationFloorRow[] {
  return listNamespaceClassificationFloorsFromPolicy(db) as ClassificationFloorRow[];
}

export function setNamespaceClassificationFloor(
  db: Database.Database,
  namespacePattern: string,
  minClassification: ClassificationLevel,
  agentId = "munin-admin",
): ClassificationFloorRow {
  validateClassificationPattern(namespacePattern);
  const now = nowUTC();
  const existing = db.prepare(
    `SELECT namespace_pattern, min_classification, created_at, updated_at
     FROM namespace_classification
     WHERE namespace_pattern = ?`,
  ).get(namespacePattern) as ClassificationFloorRow | undefined;

  const txn = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE namespace_classification
         SET min_classification = ?, updated_at = ?
         WHERE namespace_pattern = ?`,
      ).run(minClassification, now, namespacePattern);
      insertAuditRow(
        db,
        now,
        agentId,
        "classification_floor_update",
        "admin/classification",
        namespacePattern,
        `min_classification ${existing.min_classification} -> ${minClassification}`,
      );
    } else {
      db.prepare(
        `INSERT INTO namespace_classification (namespace_pattern, min_classification, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(namespacePattern, minClassification, now, now);
      insertAuditRow(
        db,
        now,
        agentId,
        "classification_floor_set",
        "admin/classification",
        namespacePattern,
        `min_classification ${minClassification}`,
      );
    }
  });

  txn();
  return db.prepare(
    `SELECT namespace_pattern, min_classification, created_at, updated_at
     FROM namespace_classification
     WHERE namespace_pattern = ?`,
  ).get(namespacePattern) as ClassificationFloorRow;
}

export function listEntriesBelowNamespaceFloor(
  db: Database.Database,
  namespace?: string,
): ClassificationAuditRow[] {
  const floors = listNamespaceClassificationFloors(db);
  let sql = `
    SELECT id, namespace, key, entry_type, classification, tags
    FROM entries
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (namespace) {
    if (namespace.endsWith("/")) {
      sql += " AND namespace LIKE ? ESCAPE '\\'";
      params.push(escapeForLike(namespace) + "%");
    } else {
      sql += " AND (namespace = ? OR namespace LIKE ? ESCAPE '\\')";
      params.push(namespace);
      params.push(escapeForLike(namespace) + "/%");
    }
  }

  sql += " ORDER BY namespace ASC, key ASC, id ASC";

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    namespace: string;
    key: string | null;
    entry_type: EntryType;
    classification: string | null;
    tags: string;
  }>;

  return rows.flatMap((row) => {
    const namespaceFloor = resolveNamespaceClassificationFloorFromRows(row.namespace, floors);
    const classification = normalizeStoredClassification(row.classification);
    if (compareClassificationLevels(classification, namespaceFloor) >= 0) {
      return [];
    }
    return [{
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      entry_type: row.entry_type,
      classification,
      namespace_floor: namespaceFloor,
      tags: row.tags,
    }];
  });
}

export function insertRedactionLog(
  db: Database.Database,
  input: RedactionLogInput,
): void {
  db.prepare(
    `INSERT INTO redaction_log
       (id, session_id, principal_id, transport_type, entry_id, entry_namespace, entry_classification, connection_max_classification, tool_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.sessionId ?? null,
    input.principalId,
    input.transportType,
    input.entryId,
    input.entryNamespace,
    input.entryClassification,
    input.connectionMaxClassification,
    input.toolName,
    nowUTC(),
  );
}

export function pruneRedactionLog(
  db: Database.Database,
  retentionDays: number,
): number {
  const cutoff = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000)).toISOString();
  const result = db.prepare("DELETE FROM redaction_log WHERE created_at < ?").run(cutoff);
  return result.changes;
}

// --- Delete operations ---

export interface DeleteInfo {
  stateCount: number;
  logCount: number;
  keys: string[];
}

function classificationInClause(levels: ClassificationLevel[]): string {
  return levels.map(() => "?").join(", ");
}

export function previewDelete(
  db: Database.Database,
  namespace: string,
  key?: string,
  agentId = "default",
  allowGlobalNamespaceDelete = false,
): DeleteInfo {
  if (key) {
    const sql = allowGlobalNamespaceDelete
      ? "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'"
      : "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ?";
    const params = allowGlobalNamespaceDelete ? [namespace, key] : [namespace, key, agentId];
    const entry = db.prepare(sql).get(...params) as { id: string } | undefined;
    return {
      stateCount: entry ? 1 : 0,
      logCount: 0,
      keys: entry ? [key] : [],
    };
  }

  const stateSql = allowGlobalNamespaceDelete
    ? "SELECT key FROM entries WHERE namespace = ? AND entry_type = 'state' ORDER BY key"
    : "SELECT key FROM entries WHERE namespace = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ? ORDER BY key";
  const stateParams = allowGlobalNamespaceDelete ? [namespace] : [namespace, agentId];
  const stateKeys = db.prepare(stateSql).all(...stateParams) as Array<{ key: string }>;

  const logSql = allowGlobalNamespaceDelete
    ? "SELECT COUNT(*) as cnt FROM entries WHERE namespace = ? AND entry_type = 'log'"
    : "SELECT COUNT(*) as cnt FROM entries WHERE namespace = ? AND entry_type = 'log' AND COALESCE(owner_principal_id, agent_id) = ?";
  const logParams = allowGlobalNamespaceDelete ? [namespace] : [namespace, agentId];
  const logCount = (db.prepare(logSql).get(...logParams) as { cnt: number }).cnt;

  return {
    stateCount: stateKeys.length,
    logCount,
    keys: stateKeys.map((r) => r.key),
  };
}

export function previewDeleteByClassification(
  db: Database.Database,
  namespace: string,
  maxClassification: ClassificationLevel,
  key?: string,
  agentId = "default",
  allowGlobalNamespaceDelete = false,
): DeleteInfo {
  const visibleLevels = getVisibleClassificationLevels(maxClassification);
  const placeholders = classificationInClause(visibleLevels);

  if (key) {
    const sql = allowGlobalNamespaceDelete
      ? `SELECT id FROM entries
         WHERE namespace = ? AND key = ? AND entry_type = 'state'
           AND classification IN (${placeholders})`
      : `SELECT id FROM entries
         WHERE namespace = ? AND key = ? AND entry_type = 'state'
           AND COALESCE(owner_principal_id, agent_id) = ?
           AND classification IN (${placeholders})`;
    const params = allowGlobalNamespaceDelete
      ? [namespace, key, ...visibleLevels]
      : [namespace, key, agentId, ...visibleLevels];
    const entry = db.prepare(sql).get(...params) as { id: string } | undefined;
    return {
      stateCount: entry ? 1 : 0,
      logCount: 0,
      keys: entry ? [key] : [],
    };
  }

  const stateSql = allowGlobalNamespaceDelete
    ? `SELECT key FROM entries
       WHERE namespace = ? AND entry_type = 'state'
         AND classification IN (${placeholders})
       ORDER BY key`
    : `SELECT key FROM entries
       WHERE namespace = ? AND entry_type = 'state'
         AND COALESCE(owner_principal_id, agent_id) = ?
         AND classification IN (${placeholders})
       ORDER BY key`;
  const stateParams = allowGlobalNamespaceDelete
    ? [namespace, ...visibleLevels]
    : [namespace, agentId, ...visibleLevels];
  const stateKeys = db.prepare(stateSql).all(...stateParams) as Array<{ key: string }>;

  const logSql = allowGlobalNamespaceDelete
    ? `SELECT COUNT(*) as cnt FROM entries
       WHERE namespace = ? AND entry_type = 'log'
         AND classification IN (${placeholders})`
    : `SELECT COUNT(*) as cnt FROM entries
       WHERE namespace = ? AND entry_type = 'log'
         AND COALESCE(owner_principal_id, agent_id) = ?
         AND classification IN (${placeholders})`;
  const logParams = allowGlobalNamespaceDelete
    ? [namespace, ...visibleLevels]
    : [namespace, agentId, ...visibleLevels];
  const logCount = (db.prepare(logSql).get(...logParams) as { cnt: number }).cnt;

  return {
    stateCount: stateKeys.length,
    logCount,
    keys: stateKeys.map((r) => r.key),
  };
}

export function executeDeleteByClassification(
  db: Database.Database,
  namespace: string,
  maxClassification: ClassificationLevel,
  key?: string,
  agentId = "default",
  allowGlobalNamespaceDelete = false,
): number {
  const now = nowUTC();
  const visibleLevels = getVisibleClassificationLevels(maxClassification);
  const placeholders = classificationInClause(visibleLevels);

  const txn = db.transaction(() => {
    // App-level vec cleanup (no SQL trigger — extension may not be loaded)
    if (_vecLoaded) {
      if (key) {
        const selectSql = allowGlobalNamespaceDelete
          ? `SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND classification IN (${placeholders})`
          : `SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ? AND classification IN (${placeholders})`;
        const selectParams = allowGlobalNamespaceDelete
          ? [namespace, key, ...visibleLevels]
          : [namespace, key, agentId, ...visibleLevels];
        const entry = db.prepare(selectSql).get(...selectParams) as { id: string } | undefined;
        if (entry) {
          db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entry.id);
        }
      } else {
        const idsSql = allowGlobalNamespaceDelete
          ? `SELECT id FROM entries WHERE namespace = ? AND classification IN (${placeholders})`
          : `SELECT id FROM entries WHERE namespace = ? AND COALESCE(owner_principal_id, agent_id) = ? AND classification IN (${placeholders})`;
        const idsParams = allowGlobalNamespaceDelete
          ? [namespace, ...visibleLevels]
          : [namespace, agentId, ...visibleLevels];
        const ids = db.prepare(idsSql).all(...idsParams) as Array<{ id: string }>;
        const deleteVec = db.prepare("DELETE FROM entries_vec WHERE entry_id = ?");
        for (const { id } of ids) {
          deleteVec.run(id);
        }
      }
    }

    let deletedCount: number;

    if (key) {
      const selectSql = allowGlobalNamespaceDelete
        ? `SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND classification IN (${placeholders})`
        : `SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ? AND classification IN (${placeholders})`;
      const selectParams = allowGlobalNamespaceDelete
        ? [namespace, key, ...visibleLevels]
        : [namespace, key, agentId, ...visibleLevels];
      const entry = db.prepare(selectSql).get(...selectParams) as { id: string } | undefined;
      const deleteSql = allowGlobalNamespaceDelete
        ? `DELETE FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND classification IN (${placeholders})`
        : `DELETE FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ? AND classification IN (${placeholders})`;
      const deleteParams = allowGlobalNamespaceDelete
        ? [namespace, key, ...visibleLevels]
        : [namespace, key, agentId, ...visibleLevels];
      const result = db.prepare(deleteSql).run(...deleteParams);
      deletedCount = result.changes;

      if (deletedCount > 0) {
        insertAuditRow(db, now, agentId, "delete", namespace, key, null, entry?.id ?? null);
      }
    } else {
      const deleteSql = allowGlobalNamespaceDelete
        ? `DELETE FROM entries WHERE namespace = ? AND classification IN (${placeholders})`
        : `DELETE FROM entries WHERE namespace = ? AND COALESCE(owner_principal_id, agent_id) = ? AND classification IN (${placeholders})`;
      const deleteParams = allowGlobalNamespaceDelete
        ? [namespace, ...visibleLevels]
        : [namespace, agentId, ...visibleLevels];
      const result = db.prepare(deleteSql).run(...deleteParams);
      deletedCount = result.changes;

      if (deletedCount > 0) {
        insertAuditRow(db, now, agentId, "namespace_delete", namespace, null, `deleted ${deletedCount} entries (classification-scoped)`);
      }
    }

    return deletedCount;
  });

  return txn();
}

export function executeDelete(
  db: Database.Database,
  namespace: string,
  key?: string,
  agentId = "default",
  allowGlobalNamespaceDelete = false,
): number {
  const now = nowUTC();

  const txn = db.transaction(() => {
    // App-level vec cleanup (no SQL trigger — extension may not be loaded)
    if (_vecLoaded) {
      if (key) {
        const selectSql = allowGlobalNamespaceDelete
          ? "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'"
          : "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ?";
        const selectParams = allowGlobalNamespaceDelete ? [namespace, key] : [namespace, key, agentId];
        const entry = db.prepare(selectSql).get(...selectParams) as { id: string } | undefined;
        if (entry) {
          db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entry.id);
        }
      } else {
        const idsSql = allowGlobalNamespaceDelete
          ? "SELECT id FROM entries WHERE namespace = ?"
          : "SELECT id FROM entries WHERE namespace = ? AND COALESCE(owner_principal_id, agent_id) = ?";
        const idsParams = allowGlobalNamespaceDelete ? [namespace] : [namespace, agentId];
        const ids = db.prepare(idsSql).all(...idsParams) as Array<{ id: string }>;
        const deleteVec = db.prepare("DELETE FROM entries_vec WHERE entry_id = ?");
        for (const { id } of ids) {
          deleteVec.run(id);
        }
      }
    }

    let deletedCount: number;

    if (key) {
      const selectSql = allowGlobalNamespaceDelete
        ? "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'"
        : "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ?";
      const selectParams = allowGlobalNamespaceDelete ? [namespace, key] : [namespace, key, agentId];
      const entry = db.prepare(selectSql).get(...selectParams) as { id: string } | undefined;
      const deleteSql = allowGlobalNamespaceDelete
        ? "DELETE FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'"
        : "DELETE FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state' AND COALESCE(owner_principal_id, agent_id) = ?";
      const deleteParams = allowGlobalNamespaceDelete ? [namespace, key] : [namespace, key, agentId];
      const result = db.prepare(deleteSql).run(...deleteParams);
      deletedCount = result.changes;

      if (deletedCount > 0) {
        insertAuditRow(db, now, agentId, "delete", namespace, key, null, entry?.id ?? null);
      }
    } else {
      const deleteSql = allowGlobalNamespaceDelete
        ? "DELETE FROM entries WHERE namespace = ?"
        : "DELETE FROM entries WHERE namespace = ? AND COALESCE(owner_principal_id, agent_id) = ?";
      const deleteParams = allowGlobalNamespaceDelete ? [namespace] : [namespace, agentId];
      const result = db.prepare(deleteSql).run(...deleteParams);
      deletedCount = result.changes;

      if (deletedCount > 0) {
        insertAuditRow(db, now, agentId, "namespace_delete", namespace, null, `deleted ${deletedCount} entries`);
      }
    }

    return deletedCount;
  });

  return txn();
}

// --- Semantic search operations ---

export interface SemanticQueryOptions {
  queryEmbedding: Buffer;
  namespace?: string;
  entryType?: EntryType;
  tags?: string[];
  limit?: number;
  includeExpired?: boolean;
  since?: string;
  until?: string;
}

export function queryEntriesSemantic(
  db: Database.Database,
  options: SemanticQueryOptions,
): Entry[] {
  return queryEntriesSemanticScored(db, options).map((result) => result.entry);
}

export function queryEntriesSemanticScored(
  db: Database.Database,
  options: SemanticQueryOptions,
): SemanticQueryResult[] {
  const { queryEmbedding, namespace, entryType, tags, limit = 10, includeExpired = false, since, until } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 50);
  const now = nowUTC();

  // Fetch enough KNN candidates to satisfy clampedLimit after filtering.
  // vec0 KNN queries can't include tag/namespace predicates, so we
  // over-fetch and filter inline, stopping once we have enough matches.
  const knnFetch = Math.min(Math.max(clampedLimit * 10, 100), 500);

  // KNN query via vec0
  const vecResults = db
    .prepare(
      `SELECT v.entry_id, v.distance
       FROM entries_vec v
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(queryEmbedding, knnFetch) as Array<{ entry_id: string; distance: number }>;

  if (vecResults.length === 0) return [];

  // Fetch full entries and apply ALL filters (namespace, type, tags)
  // inline so that clampedLimit applies to the filtered result set.
  const getEntry = db.prepare("SELECT * FROM entries WHERE id = ?");
  const results: SemanticQueryResult[] = [];

  for (const { entry_id, distance } of vecResults) {
    if (results.length >= clampedLimit) break;

    const entry = getEntry.get(entry_id) as Entry | undefined;
    if (!entry) continue;

    if (namespace) {
      if (namespace.endsWith("/")) {
        if (!entry.namespace.startsWith(namespace)) continue;
      } else {
        if (entry.namespace !== namespace) continue;
      }
    }

    if (entryType && entry.entry_type !== entryType) continue;

    if (!includeExpired && isEntryExpired(entry, now)) continue;

    if (tags && tags.length > 0) {
      const entryTags: string[] = JSON.parse(entry.tags);
      if (!tags.every((t) => entryTags.includes(t))) continue;
    }

    if (since && entry.updated_at < since) continue;
    if (until && entry.updated_at > until) continue;

    results.push({
      entry,
      distance,
      rank: results.length + 1,
    });
  }

  return results;
}

export interface HybridQueryOptions {
  ftsOptions: QueryOptions;
  semanticOptions: SemanticQueryOptions;
  /**
   * Optional relaxed FTS query to retry with when the primary FTS query
   * returns zero matches. Lets the hybrid path mirror the lexical-mode
   * relaxed-token fallback: a natural-language question with more words
   * than any single entry contains should still surface lexical signal
   * via an OR-of-content-terms retry before the result collapses to
   * semantic-only.
   */
  ftsFallbackOptions?: QueryOptions;
}

export interface HybridQueryScored {
  results: HybridQueryResult[];
  ftsRelaxed: boolean;
}

export function queryEntriesHybrid(
  db: Database.Database,
  options: HybridQueryOptions,
): Entry[] {
  return queryEntriesHybridScored(db, options).results.map((result) => result.entry);
}

export function queryEntriesHybridScored(
  db: Database.Database,
  options: HybridQueryOptions,
): HybridQueryScored {
  const { ftsOptions, semanticOptions, ftsFallbackOptions } = options;
  const limit = Math.min(Math.max(ftsOptions.limit ?? 10, 1), 50);

  // Over-fetch from both sources (5x limit per Codex finding)
  const overFetchLimit = limit * 5;

  let ftsResults = queryEntriesLexicalScored(db, { ...ftsOptions, limit: overFetchLimit });
  let ftsRelaxed = false;
  if (ftsResults.length === 0 && ftsFallbackOptions) {
    const relaxed = queryEntriesLexicalScored(db, { ...ftsFallbackOptions, limit: overFetchLimit });
    if (relaxed.length > 0) {
      ftsResults = relaxed;
      ftsRelaxed = true;
    }
  }
  const vecResults = queryEntriesSemanticScored(db, { ...semanticOptions, limit: overFetchLimit });

  // Build 1-indexed rank maps
  const ftsRanks = new Map<string, number>();
  const ftsScores = new Map<string, number>();
  ftsResults.forEach((result) => {
    ftsRanks.set(result.entry.id, result.rank);
    ftsScores.set(result.entry.id, result.score);
  });

  const vecRanks = new Map<string, number>();
  const vecDistances = new Map<string, number>();
  vecResults.forEach((result) => {
    vecRanks.set(result.entry.id, result.rank);
    vecDistances.set(result.entry.id, result.distance);
  });

  // Collect all unique entry IDs
  const allIds = new Set<string>([...ftsRanks.keys(), ...vecRanks.keys()]);

  // RRF scoring (k = 60)
  const k = 60;
  const scored: HybridQueryResult[] = [];

  // Build entry map for quick lookup
  const entryMap = new Map<string, Entry>();
  for (const result of ftsResults) entryMap.set(result.entry.id, result.entry);
  for (const result of vecResults) entryMap.set(result.entry.id, result.entry);

  for (const id of allIds) {
    const entry = entryMap.get(id)!;
    let score = 0;

    const ftsRank = ftsRanks.get(id);
    const vecRank = vecRanks.get(id);

    // No Infinity sentinel — explicit conditional (Codex finding #6)
    if (ftsRank !== undefined) {
      score += 1 / (k + ftsRank);
    }
    if (vecRank !== undefined) {
      score += 1 / (k + vecRank);
    }

    scored.push({
      entry,
      score,
      lexicalRank: ftsRank,
      lexicalScore: ftsScores.get(id),
      semanticRank: vecRank,
      semanticDistance: vecDistances.get(id),
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return { results: scored.slice(0, limit), ftsRelaxed };
}

// --- Vec helpers (used by embeddings.ts) ---

export function storeEmbedding(
  db: Database.Database,
  entryId: string,
  embedding: Buffer,
  model: string,
): void {
  // Delete existing, then insert (vec0 doesn't support UPSERT)
  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entryId);
  db.prepare(
    "INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)",
  ).run(entryId, embedding);

  db.prepare(
    "UPDATE entries SET embedding_status = 'generated', embedding_model = ? WHERE id = ? AND updated_at = (SELECT updated_at FROM entries WHERE id = ?)",
  ).run(model, entryId, entryId);
}

export function removeEmbedding(
  db: Database.Database,
  entryId: string,
): void {
  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entryId);
}

// --- Task filtering ---

/**
 * Returns the set of `tasks/*` namespaces (excluding `tasks`, `tasks/admin`,
 * `tasks/_heartbeat`) where the `status` state entry has a `completed` or
 * `failed` tag.  Used to suppress finished task-run namespaces from default
 * listings.
 */
export function getCompletedTaskNamespaces(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT e.namespace FROM entries e, json_each(e.tags) t
       WHERE e.namespace LIKE 'tasks/%'
         AND e.namespace NOT IN ('tasks/admin', 'tasks/_heartbeat')
         AND e.entry_type = 'state'
         AND e.key = 'status'
         AND t.value IN ('completed', 'failed')
       GROUP BY e.namespace`,
    )
    .all() as Array<{ namespace: string }>;
  return new Set(rows.map((r) => r.namespace));
}

/**
 * Returns the set of namespaces whose `status` state entry carries a
 * terminal lifecycle tag (`completed`, `archived`, `stopped`, or `failed`).
 *
 * Used by commitment extraction to suppress derivations from entries that
 * live in an already-resolved namespace: task result documents,
 * post-mortems, and archived projects typically contain forward-looking
 * dated language that is historical, not an open commitment.
 */
export function getResolvedNamespaces(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT e.namespace FROM entries e, json_each(e.tags) t
       WHERE e.entry_type = 'state'
         AND e.key = 'status'
         AND t.value IN ('completed', 'archived', 'stopped', 'failed')
       GROUP BY e.namespace`,
    )
    .all() as Array<{ namespace: string }>;
  return new Set(rows.map((r) => r.namespace));
}

// --- Retrieval analytics ---

// Correlation window: 5 minutes
const RETRIEVAL_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

// Retention period for sessions cursor cache: 7 days
const RETRIEVAL_SESSION_RETENTION_DAYS = 7;

export interface RetrievalEventInput {
  sessionId: string;
  toolName: "memory_query" | "memory_orient" | "memory_attention";
  queryText?: string;
  requestedMode?: string;
  actualMode?: string;
  resultIds: string[];
  resultNamespaces: string[];
  resultRanks: number[];
  detail?: Record<string, unknown>;
}

export interface RetrievalOutcomeInput {
  outcomeType:
    | "opened_result"
    | "opened_namespace_context"
    | "write_in_result_namespace"
    | "log_in_result_namespace"
    | "query_reformulated"
    | "no_followup_timeout";
  entryId?: string;
  namespace?: string;
  detail?: Record<string, unknown>;
}

export interface EntryInsightRow {
  entry_id: string;
  namespace: string | null;
  key: string | null;
  content_preview: string | null;
  impressions: number;
  opens: number;
  write_outcomes: number;
  log_outcomes: number;
  /** Events where any follow-through action occurred (open, write, or log). Always ≤ impressions. */
  followthrough_events: number;
  opened_when_stale_count: number;
  updated_at: string;
}

/**
 * Log a retrieval event and update the session cursor.
 * Also checks for query_reformulated: if there is a prior event in the same
 * session within the correlation window that has zero positive outcomes, records
 * a query_reformulated outcome on it before inserting the new event.
 * Never throws — all errors are silently swallowed.
 */
export function logRetrievalEvent(
  db: Database.Database,
  input: RetrievalEventInput,
): string | null {
  try {
    const now = nowUTC();
    const eventId = randomUUID();

    const txn = db.transaction(() => {
      // Look up the prior event via the session cursor (O(1) — no range scan)
      const sessionRow = db
        .prepare(
          "SELECT last_event_id, last_event_timestamp FROM retrieval_sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as
        | { last_event_id: string | null; last_event_timestamp: string }
        | undefined;

      if (sessionRow?.last_event_id) {
        const priorTs = new Date(sessionRow.last_event_timestamp).getTime();
        const nowMs = new Date(now).getTime();
        const withinWindow = nowMs - priorTs <= RETRIEVAL_CORRELATION_WINDOW_MS;

        if (withinWindow) {
          // Check for query_reformulated: prior event has no positive outcomes
          const positiveOutcomeCount = (
            db
              .prepare(
                `SELECT COUNT(*) as cnt FROM retrieval_outcomes
                 WHERE retrieval_event_id = ?
                   AND outcome_type IN (
                     'opened_result','opened_namespace_context',
                     'write_in_result_namespace','log_in_result_namespace'
                   )`,
              )
              .get(sessionRow.last_event_id) as { cnt: number }
          ).cnt;

          if (positiveOutcomeCount === 0) {
            db.prepare(
              `INSERT INTO retrieval_outcomes
                 (id, retrieval_event_id, timestamp, outcome_type, entry_id, namespace, detail)
               VALUES (?, ?, ?, 'query_reformulated', NULL, NULL, NULL)`,
            ).run(randomUUID(), sessionRow.last_event_id, now);
          }
        }
      }

      // Insert the new retrieval event
      db.prepare(
        `INSERT INTO retrieval_events
           (id, session_id, timestamp, tool_name, query_text, requested_mode, actual_mode,
            result_ids, result_namespaces, result_ranks, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        input.sessionId,
        now,
        input.toolName,
        input.queryText ?? null,
        input.requestedMode ?? null,
        input.actualMode ?? null,
        JSON.stringify(input.resultIds),
        JSON.stringify(input.resultNamespaces),
        JSON.stringify(input.resultRanks),
        input.detail ? JSON.stringify(input.detail) : null,
      );

      // Upsert the session cursor
      db.prepare(
        `INSERT INTO retrieval_sessions (session_id, last_event_id, last_event_timestamp, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_event_id = excluded.last_event_id,
           last_event_timestamp = excluded.last_event_timestamp`,
      ).run(input.sessionId, eventId, now, now);
    });

    txn();
    return eventId;
  } catch {
    return null;
  }
}

/**
 * Log a retrieval outcome tied to the most recent retrieval event in this session
 * within the correlation window.
 * Never throws — all errors are silently swallowed.
 */
export function logRetrievalOutcome(
  db: Database.Database,
  sessionId: string,
  input: RetrievalOutcomeInput,
): void {
  try {
    const now = nowUTC();
    const nowMs = new Date(now).getTime();

    // Look up the prior event via the session cursor (O(1))
    const sessionRow = db
      .prepare(
        "SELECT last_event_id, last_event_timestamp FROM retrieval_sessions WHERE session_id = ?",
      )
      .get(sessionId) as
      | { last_event_id: string | null; last_event_timestamp: string }
      | undefined;

    if (!sessionRow?.last_event_id) return;

    const priorTs = new Date(sessionRow.last_event_timestamp).getTime();
    if (nowMs - priorTs > RETRIEVAL_CORRELATION_WINDOW_MS) return;

    db.prepare(
      `INSERT INTO retrieval_outcomes
         (id, retrieval_event_id, timestamp, outcome_type, entry_id, namespace, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      sessionRow.last_event_id,
      now,
      input.outcomeType,
      input.entryId ?? null,
      input.namespace ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
    );
  } catch {
    // Never interrupt tool execution
  }
}

/**
 * Compute per-entry insight aggregates.
 * Impressions counted only from memory_query and memory_attention events
 * (result_ids non-empty). staleness_pressure = fraction of opened_result outcomes
 * where the entry was older than 14 days at the time of opening.
 */
export function getInsightsByEntry(
  db: Database.Database,
  namespace?: string,
  minImpressions = 3,
  limit = 20,
): EntryInsightRow[] {
  const clampedLimit = Math.min(Math.max(limit, 1), 50);

  // Build namespace filter clause (applies to e.namespace from LEFT JOIN entries)
  let nsFilter = "";
  const nsParams: unknown[] = [];
  if (namespace) {
    if (namespace.endsWith("/")) {
      nsFilter = "AND e.namespace LIKE ? ESCAPE '\\'";
      nsParams.push(namespace.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%");
    } else {
      nsFilter = "AND e.namespace = ?";
      nsParams.push(namespace);
    }
  }

  const sql = `
    WITH impressions_cte AS (
      -- One row per (entry_id, event_id) from query/attention events with results
      SELECT
        e_json.value AS entry_id,
        rev.id AS event_id
      FROM retrieval_events rev,
           json_each(rev.result_ids) AS e_json
      WHERE rev.tool_name IN ('memory_query', 'memory_attention')
        AND json_array_length(rev.result_ids) > 0
    ),
    opens_cte AS (
      SELECT ro.entry_id, ro.retrieval_event_id
      FROM retrieval_outcomes ro
      WHERE ro.outcome_type = 'opened_result'
        AND ro.entry_id IS NOT NULL
    )
    SELECT
      imp.entry_id,
      e.namespace,
      e.key,
      SUBSTR(e.content, 1, 60) AS content_preview,
      COUNT(DISTINCT imp.event_id) AS impressions,
      COUNT(DISTINCT op.retrieval_event_id) AS opens,
      COUNT(DISTINCT CASE WHEN ro_w.outcome_type = 'write_in_result_namespace' THEN ro_w.retrieval_event_id END) AS write_outcomes,
      COUNT(DISTINCT CASE WHEN ro_l.outcome_type = 'log_in_result_namespace' THEN ro_l.retrieval_event_id END) AS log_outcomes,
      -- followthrough_events: distinct impression events where ANY follow-through action occurred.
      -- Counting a single combined column avoids double-counting events that have multiple
      -- outcome types (e.g. both opened_result AND write_in_result_namespace), which would
      -- inflate (opens + write_outcomes + log_outcomes) / impressions above 1.0.
      COUNT(DISTINCT CASE
        WHEN op.retrieval_event_id IS NOT NULL
          OR ro_w.retrieval_event_id IS NOT NULL
          OR ro_l.retrieval_event_id IS NOT NULL
        THEN imp.event_id
      END) AS followthrough_events,
      COUNT(DISTINCT CASE
        WHEN op.retrieval_event_id IS NOT NULL
          AND e.updated_at IS NOT NULL
          AND (julianday(ro_open.timestamp) - julianday(e.updated_at)) > 14
        THEN op.retrieval_event_id
      END) AS opened_when_stale_count,
      COALESCE(e.updated_at, '') AS updated_at
    FROM impressions_cte imp
    LEFT JOIN entries e ON e.id = imp.entry_id
    LEFT JOIN opens_cte op ON op.entry_id = imp.entry_id AND op.retrieval_event_id = imp.event_id
    LEFT JOIN retrieval_outcomes ro_open ON ro_open.entry_id = imp.entry_id
      AND ro_open.outcome_type = 'opened_result'
      AND ro_open.retrieval_event_id = imp.event_id
    LEFT JOIN retrieval_outcomes ro_w ON ro_w.retrieval_event_id = imp.event_id
      AND ro_w.outcome_type = 'write_in_result_namespace'
    LEFT JOIN retrieval_outcomes ro_l ON ro_l.retrieval_event_id = imp.event_id
      AND ro_l.outcome_type = 'log_in_result_namespace'
    WHERE TRUE
      ${nsFilter}
    GROUP BY imp.entry_id, e.namespace, e.updated_at
    HAVING COUNT(DISTINCT imp.event_id) >= ?
    ORDER BY impressions DESC
    LIMIT ?
  `;

  return db
    .prepare(sql)
    .all(...nsParams, minImpressions, clampedLimit) as EntryInsightRow[];
}

/**
 * Prune old retrieval analytics data.
 * Events/outcomes: delete where timestamp < now - retentionDays.
 * Sessions: delete where last_event_timestamp < now - 7 days.
 * Never throws.
 */
export function pruneRetrievalAnalytics(
  db: Database.Database,
  retentionDays: number,
): void {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const sessionCutoff = new Date(
      Date.now() - RETRIEVAL_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const txn = db.transaction(() => {
      // Outcomes are cascade-deleted when their event is deleted
      db.prepare(
        "DELETE FROM retrieval_events WHERE timestamp < ?",
      ).run(cutoff);

      db.prepare(
        "DELETE FROM retrieval_sessions WHERE last_event_timestamp < ?",
      ).run(sessionCutoff);
    });

    txn();
  } catch {
    // Never interrupt startup or cleanup
  }
}

// --- Retrieval feedback ---

export interface RetrievalFeedbackInput {
  sessionId: string;
  feedbackType: "bad_results" | "missing_result" | "wrong_order" | "stale_results" | "good_results";
  queryText?: string;
  expectedNamespace?: string;
  expectedKey?: string;
  expectedEntryId?: string;
  detail?: string;
}

/**
 * Log explicit retrieval quality feedback.
 * Auto-links to the most recent retrieval event in the session (if within correlation window).
 * Never throws.
 */
export function logRetrievalFeedback(
  db: Database.Database,
  input: RetrievalFeedbackInput,
): string | null {
  try {
    const now = nowUTC();
    const id = randomUUID();
    const nowMs = new Date(now).getTime();

    // Try to link to most recent retrieval event in session
    let eventId: string | null = null;
    const sessionRow = db
      .prepare(
        "SELECT last_event_id, last_event_timestamp FROM retrieval_sessions WHERE session_id = ?",
      )
      .get(input.sessionId) as
      | { last_event_id: string | null; last_event_timestamp: string }
      | undefined;

    if (sessionRow?.last_event_id) {
      const priorTs = new Date(sessionRow.last_event_timestamp).getTime();
      if (nowMs - priorTs <= RETRIEVAL_CORRELATION_WINDOW_MS) {
        eventId = sessionRow.last_event_id;
      }
    }

    db.prepare(
      `INSERT INTO retrieval_feedback
         (id, retrieval_event_id, session_id, feedback_type, query_text,
          expected_namespace, expected_key, expected_entry_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      eventId,
      input.sessionId,
      input.feedbackType,
      input.queryText ?? null,
      input.expectedNamespace ?? null,
      input.expectedKey ?? null,
      input.expectedEntryId ?? null,
      input.detail ?? null,
      now,
    );

    return id;
  } catch {
    return null;
  }
}

/**
 * Compute aggregate retrieval health metrics over a time window.
 */
export function getRetrievalAggregates(
  db: Database.Database,
  since?: string,
  until?: string,
): {
  period_start: string;
  period_end: string;
  total_events: number;
  total_outcomes: number;
  reformulation_count: number;
  positive_outcome_count: number;
  feedback_counts: Record<string, number>;
  total_feedback: number;
  total_sessions: number;
  multi_event_sessions: number;
  multi_event_events: number;
} {
  const periodEnd = until ?? nowUTC();
  const periodStart = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const eventCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM retrieval_events WHERE timestamp >= ? AND timestamp <= ?")
      .get(periodStart, periodEnd) as { cnt: number }
  ).cnt;

  const outcomeCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE re.timestamp >= ? AND re.timestamp <= ?`,
      )
      .get(periodStart, periodEnd) as { cnt: number }
  ).cnt;

  const reformulationCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE ro.outcome_type = 'query_reformulated'
           AND re.timestamp >= ? AND re.timestamp <= ?`,
      )
      .get(periodStart, periodEnd) as { cnt: number }
  ).cnt;

  const positiveOutcomeCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM retrieval_outcomes ro
         JOIN retrieval_events re ON re.id = ro.retrieval_event_id
         WHERE ro.outcome_type IN (
           'opened_result', 'opened_namespace_context',
           'write_in_result_namespace', 'log_in_result_namespace'
         )
         AND re.timestamp >= ? AND re.timestamp <= ?`,
      )
      .get(periodStart, periodEnd) as { cnt: number }
  ).cnt;

  // Session segmentation: multi-event sessions (≥2 retrieval events) are
  // the only ones where reformulation can be detected. Single-event sessions
  // (typically HTTP clients with per-request session IDs) inflate the
  // denominator without contributing signal.
  const sessionCounts = db
    .prepare(
      `SELECT
         COUNT(DISTINCT session_id) AS total_sessions,
         COUNT(DISTINCT CASE WHEN cnt >= 2 THEN session_id END) AS multi_event_sessions,
         SUM(CASE WHEN cnt >= 2 THEN cnt ELSE 0 END) AS multi_event_events
       FROM (
         SELECT session_id, COUNT(*) AS cnt
         FROM retrieval_events
         WHERE timestamp >= ? AND timestamp <= ?
         GROUP BY session_id
       )`,
    )
    .get(periodStart, periodEnd) as {
      total_sessions: number;
      multi_event_sessions: number;
      multi_event_events: number;
    };

  // Feedback counts by type
  const feedbackRows = db
    .prepare(
      `SELECT feedback_type, COUNT(*) as cnt FROM retrieval_feedback
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY feedback_type`,
    )
    .all(periodStart, periodEnd) as Array<{ feedback_type: string; cnt: number }>;

  const feedbackCounts: Record<string, number> = {};
  let totalFeedback = 0;
  for (const row of feedbackRows) {
    feedbackCounts[row.feedback_type] = row.cnt;
    totalFeedback += row.cnt;
  }

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_events: eventCount,
    total_outcomes: outcomeCount,
    reformulation_count: reformulationCount,
    positive_outcome_count: positiveOutcomeCount,
    feedback_counts: feedbackCounts,
    total_feedback: totalFeedback,
    total_sessions: sessionCounts.total_sessions,
    multi_event_sessions: sessionCounts.multi_event_sessions,
    multi_event_events: sessionCounts.multi_event_events,
  };
}

// --- Audit history ---

export interface AuditHistoryOptions {
  namespace?: string;   // exact or prefix match (with trailing /)
  since?: string;       // ISO 8601 — filter timestamp >= since
  action?: string;      // filter by action type
  limit?: number;       // default 20, max 100
  cursor?: number;      // exclusive lower bound on audit_log.id for sync
}

export interface AuditHistoryEntry {
  id: number;
  timestamp: string;
  agent_id: string;
  action: AuditAction;
  namespace: string;
  key: string | null;
  entry_id: string | null;
  detail: string | null;
}

export interface AuditHistoryPage {
  entries: AuditHistoryEntry[];
  hasMore: boolean;
  nextCursor: number | null;
}

function normalizeAuditAction(action: string): AuditAction {
  if (action === "log") return "log_append";
  if (action === "delete_namespace") return "namespace_delete";
  return action as AuditAction;
}

function normalizeAuditActionFilter(action?: string): string | undefined {
  if (!action) return undefined;
  if (action === "log") return "log_append";
  if (action === "delete_namespace") return "namespace_delete";
  return action;
}

export function getAuditHistory(
  db: Database.Database,
  options: AuditHistoryOptions,
): AuditHistoryEntry[] {
  const { namespace, since, action, limit = 20 } = options;

  // Clamp limit to 1–100
  const clampedLimit = Math.min(Math.max(limit, 1), 100);

  // Validate since as ISO 8601 if provided
  if (since !== undefined) {
    const d = new Date(since);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid "since" value: "${since}". Must be a valid ISO 8601 timestamp.`);
    }
  }

  let sql = "SELECT id, timestamp, agent_id, action, namespace, key, detail, entry_id FROM audit_log WHERE 1=1";
  const params: unknown[] = [];

  if (namespace !== undefined) {
    if (namespace.endsWith("/")) {
      // Prefix match: e.g. "projects/" → namespace LIKE 'projects/%'
      sql += " AND (namespace LIKE ? ESCAPE '\\')";
      params.push(escapeForLike(namespace) + "%");
    } else {
      // Exact OR prefix match: e.g. "projects/foo" → exact OR starts with 'projects/foo/'
      sql += " AND (namespace = ? OR namespace LIKE ? ESCAPE '\\')";
      params.push(namespace);
      params.push(escapeForLike(namespace) + "/%");
    }
  }

  if (since !== undefined) {
    sql += " AND timestamp >= ?";
    params.push(since);
  }

  const normalizedAction = normalizeAuditActionFilter(action);
  if (normalizedAction !== undefined) {
    sql += " AND action = ?";
    params.push(normalizedAction);
  }

  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(clampedLimit);

  const rows = db.prepare(sql).all(...params) as Array<AuditHistoryEntry & { action: string }>;
  return rows.map((row) => ({
    ...row,
    action: normalizeAuditAction(row.action),
  }));
}

export function getAuditHistoryPage(
  db: Database.Database,
  options: AuditHistoryOptions,
): AuditHistoryPage {
  const { namespace, since, action, limit = 20, cursor } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 100);

  if (since !== undefined) {
    const d = new Date(since);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid "since" value: "${since}". Must be a valid ISO 8601 timestamp.`);
    }
  }

  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) {
    throw new Error(`Invalid "cursor" value: "${cursor}". Must be a non-negative integer.`);
  }

  let sql = "SELECT id, timestamp, agent_id, action, namespace, key, detail, entry_id FROM audit_log WHERE 1=1";
  const params: unknown[] = [];

  if (namespace !== undefined) {
    if (namespace.endsWith("/")) {
      sql += " AND (namespace LIKE ? ESCAPE '\\')";
      params.push(escapeForLike(namespace) + "%");
    } else {
      sql += " AND (namespace = ? OR namespace LIKE ? ESCAPE '\\')";
      params.push(namespace);
      params.push(escapeForLike(namespace) + "/%");
    }
  }

  if (since !== undefined) {
    sql += " AND timestamp >= ?";
    params.push(since);
  }

  const normalizedAction = normalizeAuditActionFilter(action);
  if (normalizedAction !== undefined) {
    sql += " AND action = ?";
    params.push(normalizedAction);
  }

  if (cursor !== undefined) {
    sql += " AND id > ?";
    params.push(cursor);
    sql += " ORDER BY id ASC LIMIT ?";
  } else {
    sql += " ORDER BY timestamp DESC LIMIT ?";
  }
  params.push(clampedLimit + 1);

  const rawRows = db.prepare(sql).all(...params) as Array<AuditHistoryEntry & { action: string }>;
  const hasMore = rawRows.length > clampedLimit;
  const rows = rawRows.slice(0, clampedLimit).map((row) => ({
    ...row,
    action: normalizeAuditAction(row.action),
  }));

  return {
    entries: rows,
    hasMore,
    nextCursor: rows.length > 0 ? rows[rows.length - 1].id : cursor ?? null,
  };
}

// --- Hint helpers ---

export function getOtherKeysInNamespace(
  db: Database.Database,
  namespace: string,
  excludeKey?: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT key FROM entries WHERE namespace = ? AND entry_type = 'state' AND key != ? ORDER BY key",
    )
    .all(namespace, excludeKey ?? "") as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

export function getOtherKeysInNamespaceByClassification(
  db: Database.Database,
  namespace: string,
  maxClassification: ClassificationLevel,
  excludeKey?: string,
): string[] {
  const visibleLevels = getVisibleClassificationLevels(maxClassification);
  const rows = db
    .prepare(
      `SELECT key FROM entries
       WHERE namespace = ?
         AND entry_type = 'state'
         AND key != ?
         AND classification IN (${classificationInClause(visibleLevels)})
       ORDER BY key`,
    )
    .all(namespace, excludeKey ?? "", ...visibleLevels) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

/**
 * Return all state entries in a namespace. Used for tag-based relational linking.
 */
export function getNamespaceStateEntries(
  db: Database.Database,
  namespace: string,
): Entry[] {
  return db
    .prepare(
      "SELECT * FROM entries WHERE namespace = ? AND entry_type = 'state' ORDER BY key",
    )
    .all(namespace) as Entry[];
}

/**
 * Return the unique set of tags used across all state entries in a namespace.
 * Used for tag vocabulary / consistency checking.
 */
export function getNamespaceTagVocabulary(
  db: Database.Database,
  namespace: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT value FROM entries, json_each(entries.tags) WHERE namespace = ? AND entry_type = 'state'",
    )
    .all(namespace) as Array<{ value: string }>;
  return rows.map((r) => r.value);
}

// --- Consolidation operations ---

/**
 * Return namespaces (projects/*, clients/*) that have at least minLogs unincorporated
 * log entries — i.e., logs created after the last consolidation checkpoint.
 */
export function getNamespacesNeedingConsolidation(
  db: Database.Database,
  minLogs: number = 3,
): ConsolidationCandidate[] {
  const sql = `
    SELECT
      e.namespace,
      COUNT(*) as unincorporated_log_count,
      cm.last_consolidated_at
    FROM entries e
    LEFT JOIN consolidation_metadata cm ON cm.namespace = e.namespace
    WHERE e.entry_type = 'log'
      AND (e.namespace LIKE 'projects/%' ESCAPE '\\' OR e.namespace LIKE 'clients/%' ESCAPE '\\')
      AND e.created_at > COALESCE(cm.last_log_created_at, '1970-01-01T00:00:00.000Z')
    GROUP BY e.namespace
    HAVING COUNT(*) >= ?
    ORDER BY unincorporated_log_count DESC
  `;
  return db.prepare(sql).all(minLogs) as ConsolidationCandidate[];
}

/**
 * Fetch log entries for a namespace, optionally filtered to entries created after
 * sinceTimestamp. Returns entries ordered by created_at ASC.
 */
export function getLogsForConsolidation(
  db: Database.Database,
  namespace: string,
  sinceTimestamp?: string | null,
): Entry[] {
  if (sinceTimestamp) {
    return db
      .prepare(
        `SELECT * FROM entries
         WHERE namespace = ? AND entry_type = 'log' AND created_at > ?
         ORDER BY created_at ASC`,
      )
      .all(namespace, sinceTimestamp) as Entry[];
  }
  return db
    .prepare(
      `SELECT * FROM entries
       WHERE namespace = ? AND entry_type = 'log'
       ORDER BY created_at ASC`,
    )
    .all(namespace) as Entry[];
}

/**
 * Retrieve consolidation metadata for a namespace, or null if not yet consolidated.
 */
export function getConsolidationMetadata(
  db: Database.Database,
  namespace: string,
): ConsolidationMetadata | null {
  return (
    db
      .prepare("SELECT * FROM consolidation_metadata WHERE namespace = ?")
      .get(namespace) as ConsolidationMetadata | undefined
  ) ?? null;
}

/**
 * Insert or update consolidation metadata for a namespace.
 * created_at is set on first insert; updated_at is always set to nowUTC().
 */
export function upsertConsolidationMetadata(
  db: Database.Database,
  metadata: Omit<ConsolidationMetadata, "created_at" | "updated_at">,
): void {
  const now = nowUTC();
  db
    .prepare(
      `INSERT INTO consolidation_metadata
         (namespace, last_consolidated_at, last_log_id, last_log_created_at,
          synthesis_model, synthesis_token_count, run_duration_ms,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace) DO UPDATE SET
         last_consolidated_at = excluded.last_consolidated_at,
         last_log_id = excluded.last_log_id,
         last_log_created_at = excluded.last_log_created_at,
         synthesis_model = excluded.synthesis_model,
         synthesis_token_count = excluded.synthesis_token_count,
         run_duration_ms = excluded.run_duration_ms,
         updated_at = excluded.updated_at`,
    )
    .run(
      metadata.namespace,
      metadata.last_consolidated_at,
      metadata.last_log_id ?? null,
      metadata.last_log_created_at ?? null,
      metadata.synthesis_model,
      metadata.synthesis_token_count ?? null,
      metadata.run_duration_ms ?? null,
      now,
      now,
    );
}

/**
 * Replace all cross-references from sourceNamespace with a new set.
 * Runs in a transaction: deletes existing refs then inserts the new ones.
 */
export function replaceCrossReferences(
  db: Database.Database,
  sourceNamespace: string,
  refs: Array<Omit<CrossReference, "id" | "extracted_at" | "source_synthesis_id">>,
  sourceSynthesisId?: string,
): void {
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM cross_references WHERE source_namespace = ?").run(sourceNamespace);

    const insert = db.prepare(
      `INSERT INTO cross_references
         (id, source_namespace, target_namespace, reference_type, context,
          confidence, extracted_at, source_synthesis_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const extractedAt = nowUTC();
    for (const ref of refs) {
      insert.run(
        randomUUID(),
        ref.source_namespace,
        ref.target_namespace,
        ref.reference_type,
        ref.context ?? null,
        ref.confidence,
        extractedAt,
        sourceSynthesisId ?? null,
      );
    }
  });

  txn();
}

/**
 * Count log entries in a namespace that were incorporated into synthesis
 * (created_at <= last_log_created_at from consolidation_metadata).
 * Returns null if the namespace has no consolidation metadata.
 */
export function countLogsIncorporated(
  db: Database.Database,
  namespace: string,
): number | null {
  const meta = (
    db
      .prepare("SELECT last_log_created_at FROM consolidation_metadata WHERE namespace = ?")
      .get(namespace) as { last_log_created_at: string | null } | undefined
  );
  if (!meta || !meta.last_log_created_at) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM entries
       WHERE namespace = ? AND entry_type = 'log' AND created_at <= ?`,
    )
    .get(namespace, meta.last_log_created_at) as { cnt: number };
  return row.cnt;
}

/**
 * Return all cross-references where namespace is either source or target,
 * ordered by extracted_at DESC.
 */
export function getCrossReferences(
  db: Database.Database,
  namespace: string,
): CrossReference[] {
  return db
    .prepare(
      `SELECT * FROM cross_references
       WHERE source_namespace = ? OR target_namespace = ?
       ORDER BY extracted_at DESC`,
    )
    .all(namespace, namespace) as CrossReference[];
}
