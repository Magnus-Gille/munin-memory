import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { Entry, AuditEntry, EntryType, TrackedStatusRow } from "./types.js";
import { runMigrations } from "./migrations.js";

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
      `SELECT id, namespace, key, substr(content, 1, 300) as content_preview, content, tags, created_at, updated_at
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
  message?: string;
  current_updated_at?: string;
}

export function writeState(
  db: Database.Database,
  namespace: string,
  key: string,
  content: string,
  tags: string[],
  agentId = "default",
  expectedUpdatedAt?: string,
): WriteStateResult {
  const now = nowUTC();
  const tagsJson = JSON.stringify(tags);

  // Check if exists
  const existing = db.prepare(
    "SELECT id, updated_at FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
  ).get(namespace, key) as { id: string; updated_at: string } | undefined;

  // Compare-and-swap: reject if entry was modified since caller last read it
  if (expectedUpdatedAt && existing && existing.updated_at !== expectedUpdatedAt) {
    return {
      status: "conflict",
      message: `Entry was updated at ${existing.updated_at}, expected ${expectedUpdatedAt}. Read the current version before overwriting.`,
      current_updated_at: existing.updated_at,
    };
  }

  const txn = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE entries SET content = ?, tags = ?, updated_at = ?, agent_id = ?,
         embedding_status = 'pending', embedding_model = NULL
         WHERE namespace = ? AND key = ? AND entry_type = 'state'`,
      ).run(content, tagsJson, now, agentId, namespace, key);

      db.prepare(
        "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(now, agentId, "update", namespace, key, "overwritten previous value");

      return { status: "updated" as const, id: existing.id };
    } else {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'state', ?, ?, ?, ?, ?)`,
      ).run(id, namespace, key, content, tagsJson, agentId, now, now);

      db.prepare(
        "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(now, agentId, "write", namespace, key, null);

      return { status: "created" as const, id };
    }
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
): { id: string; timestamp: string } {
  const now = nowUTC();
  const id = randomUUID();
  const tagsJson = JSON.stringify(tags);

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO entries (id, namespace, key, entry_type, content, tags, agent_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'log', ?, ?, ?, ?, ?)`,
    ).run(id, namespace, content, tagsJson, agentId, now, now);

    db.prepare(
      "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(now, agentId, "log", namespace, null, null);
  });

  txn();
  return { id, timestamp: now };
}

// --- Query / search operations ---

function escapeFtsQuery(query: string): string {
  // If the query already contains double quotes, assume the caller
  // is using FTS5 syntax intentionally and pass through as-is
  if (query.includes('"')) {
    return query;
  }
  // Wrap each whitespace-separated token in double quotes so that
  // special FTS5 characters (hyphens, colons, etc.) are treated as
  // literals. Implicit AND between quoted tokens.
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" ");
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
  const { query, namespace, entryType, tags, limit = 10 } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 50);

  let sql = `
    SELECT e.*, bm25(entries_fts) as lexical_score FROM entries e
    JOIN entries_fts fts ON e.rowid = fts.rowid
    WHERE entries_fts MATCH ?
  `;
  const params: unknown[] = [escapeFtsQuery(query)];

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

  // Apply tag filtering in SQL before LIMIT so that limit semantics
  // are truthful — callers expect limit to apply to the filtered set,
  // not to an internal candidate window that is post-filtered.
  if (tags && tags.length > 0) {
    for (const tag of tags) {
      sql += " AND EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)";
      params.push(tag);
    }
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

// --- List operations ---

export interface NamespaceCount {
  namespace: string;
  state_count: number;
  log_count: number;
  last_activity_at: string;
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

export interface StateEntryPreview {
  key: string;
  preview: string;
  tags: string;
  updated_at: string;
}

export interface LogPreview {
  id: string;
  content_preview: string;
  tags: string;
  created_at: string;
}

export interface LogSummary {
  log_count: number;
  earliest: string | null;
  latest: string | null;
  recent: LogPreview[];
}

export function listNamespaceContents(
  db: Database.Database,
  namespace: string,
): { stateEntries: StateEntryPreview[]; logSummary: LogSummary } {
  const stateEntries = db
    .prepare(
      `SELECT key, substr(content, 1, 100) as preview, tags, updated_at
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
      `SELECT id, substr(content, 1, 200) as content_preview, tags, created_at
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

// --- Delete operations ---

export interface DeleteInfo {
  stateCount: number;
  logCount: number;
  keys: string[];
}

export function previewDelete(
  db: Database.Database,
  namespace: string,
  key?: string,
): DeleteInfo {
  if (key) {
    const entry = db
      .prepare(
        "SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'",
      )
      .get(namespace, key) as { id: string } | undefined;
    return {
      stateCount: entry ? 1 : 0,
      logCount: 0,
      keys: entry ? [key] : [],
    };
  }

  const stateKeys = db
    .prepare(
      "SELECT key FROM entries WHERE namespace = ? AND entry_type = 'state' ORDER BY key",
    )
    .all(namespace) as Array<{ key: string }>;

  const logCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM entries WHERE namespace = ? AND entry_type = 'log'")
      .get(namespace) as { cnt: number }
  ).cnt;

  return {
    stateCount: stateKeys.length,
    logCount,
    keys: stateKeys.map((r) => r.key),
  };
}

export function executeDelete(
  db: Database.Database,
  namespace: string,
  key?: string,
  agentId = "default",
): number {
  const now = nowUTC();

  const txn = db.transaction(() => {
    // App-level vec cleanup (no SQL trigger — extension may not be loaded)
    if (_vecLoaded) {
      if (key) {
        const entry = db
          .prepare("SELECT id FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'")
          .get(namespace, key) as { id: string } | undefined;
        if (entry) {
          db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entry.id);
        }
      } else {
        const ids = db
          .prepare("SELECT id FROM entries WHERE namespace = ?")
          .all(namespace) as Array<{ id: string }>;
        const deleteVec = db.prepare("DELETE FROM entries_vec WHERE entry_id = ?");
        for (const { id } of ids) {
          deleteVec.run(id);
        }
      }
    }

    let deletedCount: number;

    if (key) {
      const result = db
        .prepare("DELETE FROM entries WHERE namespace = ? AND key = ? AND entry_type = 'state'")
        .run(namespace, key);
      deletedCount = result.changes;

      db.prepare(
        "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(now, agentId, "delete", namespace, key, null);
    } else {
      const result = db
        .prepare("DELETE FROM entries WHERE namespace = ?")
        .run(namespace);
      deletedCount = result.changes;

      db.prepare(
        "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(now, agentId, "delete_namespace", namespace, null, `deleted ${deletedCount} entries`);
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
  const { queryEmbedding, namespace, entryType, tags, limit = 10 } = options;
  const clampedLimit = Math.min(Math.max(limit, 1), 50);

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

    if (tags && tags.length > 0) {
      const entryTags: string[] = JSON.parse(entry.tags);
      if (!tags.every((t) => entryTags.includes(t))) continue;
    }

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
}

export function queryEntriesHybrid(
  db: Database.Database,
  options: HybridQueryOptions,
): Entry[] {
  return queryEntriesHybridScored(db, options).map((result) => result.entry);
}

export function queryEntriesHybridScored(
  db: Database.Database,
  options: HybridQueryOptions,
): HybridQueryResult[] {
  const { ftsOptions, semanticOptions } = options;
  const limit = Math.min(Math.max(ftsOptions.limit ?? 10, 1), 50);

  // Over-fetch from both sources (5x limit per Codex finding)
  const overFetchLimit = limit * 5;

  const ftsResults = queryEntriesLexicalScored(db, { ...ftsOptions, limit: overFetchLimit });
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

  return scored.slice(0, limit);
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
