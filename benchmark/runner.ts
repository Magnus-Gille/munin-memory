/**
 * Benchmark runner: loads a snapshot DB + query set, executes retrieval,
 * scores results, and produces a report.
 *
 * Calls db.ts query functions directly (not through MCP tool layer)
 * to avoid Server scaffolding overhead.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { basename, join, dirname, resolve } from "node:path";
import {
  queryEntriesLexicalScored,
  queryEntriesHybridScored,
  queryEntriesSemanticScored,
  getCompletedTaskNamespaces,
  setVecLoaded,
} from "../src/db.js";
import { generateEmbedding, embeddingToBuffer, initEmbeddings } from "../src/embeddings.js";
import {
  buildRelaxedLexicalQuery,
  QUERY_RERANK_OVERFETCH_MULTIPLIER,
  DEFAULT_SEARCH_RECENCY_WEIGHT,
  shouldApplyDefaultQuerySuppression,
  getTrackedStatusAssessments,
  injectCanonicalQueryEntries,
  injectAttentionQueryEntries,
  rerankQueryResults,
} from "../src/tools.js";
import type { Entry, QueryParams } from "../src/types.js";
import {
  scoreQuery,
  aggregateScores,
  percentilesFromDurations,
  type ScoringResult,
} from "./scorer.js";
import type {
  BenchmarkQuery,
  BenchmarkReport,
  QueryBenchmarkResult,
  CategoryResult,
  QuerySetSource,
  DurationSummary,
  RunnerMode,
} from "./types.js";
import type { SearchMode } from "../src/types.js";

/**
 * Hash raw bytes with SHA-256, return lowercase hex.
 */
function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Load benchmark queries from a JSONL file.
 *
 * Backward-compatible thin wrapper around `loadQueriesWithSource`. New
 * callers should prefer that helper so the loaded file's lineage
 * metadata (SHA-256, byte count, record count) flows into the
 * BenchmarkReport.
 */
export function loadQueries(filePath: string): BenchmarkQuery[] {
  return loadQueriesWithSource(filePath).queries;
}

/**
 * Load benchmark queries from a JSONL file together with byte-level
 * lineage metadata.
 *
 * Behavior:
 * - Reads raw bytes once; SHA-256 is computed from the unmodified buffer
 *   so the checksum matches what `shasum -a 256 <file>` would report and
 *   what `benchmark/queries/retrieval-v1.manifest.json` pins.
 * - Empty files return `{ queries: [], source: { ..., record_count: 0 } }`
 *   without throwing — the caller can surface a warning.
 * - Per-line parse failures include the file path, line number, and the
 *   first 12 chars of the file's SHA so the error message is debuggable
 *   without re-reading the file.
 */
export function loadQueriesWithSource(filePath: string): {
  queries: BenchmarkQuery[];
  source: QuerySetSource;
} {
  const rawBytes = readFileSync(filePath);
  const sha = sha256Hex(rawBytes);
  const bytes = rawBytes.length;

  // 0-byte file: SHA is the well-known empty-string digest. No queries.
  if (bytes === 0) {
    return {
      queries: [],
      source: {
        path: filePath,
        filename: basename(filePath),
        record_count: 0,
        sha256: sha,
        bytes,
        manifest_match: "manifest_not_provided",
      },
    };
  }

  const text = rawBytes.toString("utf-8");
  const queries: BenchmarkQuery[] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trim().startsWith("//")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to parse JSONL at ${filePath}:${i + 1}: ${reason} [sha256=${sha.slice(0, 12)}]`,
      );
    }

    const q = parsed as Record<string, unknown>;
    if (!q.id || typeof q.id !== "string") {
      throw new Error(
        `Query at ${filePath}:${i + 1} missing required field "id" (string) [sha256=${sha.slice(0, 12)}]`,
      );
    }
    if (!q.query || typeof q.query !== "string") {
      throw new Error(
        `Query "${q.id}" at ${filePath}:${i + 1} missing required field "query" (string) [sha256=${sha.slice(0, 12)}]`,
      );
    }
    if (!q.category || typeof q.category !== "string") {
      throw new Error(
        `Query "${q.id}" at ${filePath}:${i + 1} missing required field "category" (string) [sha256=${sha.slice(0, 12)}]`,
      );
    }
    if (!q.search_mode || typeof q.search_mode !== "string") {
      throw new Error(
        `Query "${q.id}" at ${filePath}:${i + 1} missing required field "search_mode" [sha256=${sha.slice(0, 12)}]`,
      );
    }
    queries.push(parsed as BenchmarkQuery);
  }

  return {
    queries,
    source: {
      path: filePath,
      filename: basename(filePath),
      record_count: queries.length,
      sha256: sha,
      bytes,
      manifest_match: "manifest_not_provided",
    },
  };
}

/**
 * Load queries from all JSONL files in a directory.
 */
export function loadQueriesFromDir(dirPath: string): BenchmarkQuery[] {
  return loadQueriesFromDirWithSources(dirPath).queries;
}

/**
 * Load queries from every `.jsonl` file in a directory together with the
 * per-file lineage metadata for each one.
 */
export function loadQueriesFromDirWithSources(dirPath: string): {
  queries: BenchmarkQuery[];
  sources: QuerySetSource[];
} {
  const files: string[] = readdirSync(dirPath).sort();
  const queries: BenchmarkQuery[] = [];
  const sources: QuerySetSource[] = [];
  for (const file of files) {
    if (file.endsWith(".jsonl")) {
      const { queries: q, source } = loadQueriesWithSource(join(dirPath, file));
      queries.push(...q);
      sources.push(source);
    }
  }
  return { queries, sources };
}

/**
 * Combine per-file SHAs into a single deterministic checksum.
 *
 * Sorts by filename so the order in which sources were loaded doesn't
 * affect the result. Each entry is `${filename}\t${sha256}`; a trailing
 * newline disambiguates "one source" from "no sources" at the byte level.
 */
export function computeQuerySetChecksum(sources: QuerySetSource[]): string {
  const lines = sources
    .map((s) => `${s.filename}\t${s.sha256}`)
    .sort();
  return sha256Hex(lines.join("\n") + "\n");
}

/**
 * Manifest source entry shape — just the fields we read.
 */
interface ManifestSource {
  id: string;
  filename: string;
  sha256: string;
  repo?: string;
}

/**
 * Cross-check `QuerySetSource[]` against a `retrieval-v1.manifest.json`.
 *
 * - Loads the manifest from `manifestPath` (must exist).
 * - For each source, looks up the manifest entry whose `filename` matches.
 * - Sets `manifest_source_id` and updates `manifest_match` accordingly.
 *
 * SHA mismatch is a warning, not an error. Local edits during PR 4-style
 * ablations are expected. PR 1's separate manifest CI test (with seven
 * negative cases) is the load-bearing guardrail.
 */
export function crossCheckManifest(
  sources: QuerySetSource[],
  manifestPath: string,
): { updated: QuerySetSource[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!existsSync(manifestPath)) {
    warnings.push(`Manifest cross-check skipped — file not found: ${manifestPath}`);
    return { updated: sources.map((s) => ({ ...s })), warnings };
  }

  let manifest: { sources?: ManifestSource[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { sources?: ManifestSource[] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`Manifest cross-check skipped — parse error: ${reason}`);
    return { updated: sources.map((s) => ({ ...s })), warnings };
  }

  const manifestSources = manifest.sources ?? [];
  const byFilename = new Map<string, ManifestSource>();
  for (const entry of manifestSources) {
    if (entry?.filename) byFilename.set(entry.filename, entry);
  }

  const updated = sources.map((s) => {
    const entry = byFilename.get(s.filename);
    if (!entry) {
      return { ...s, manifest_match: "unmatched" as const };
    }
    if (entry.sha256?.toLowerCase() === s.sha256.toLowerCase()) {
      return {
        ...s,
        manifest_source_id: entry.id,
        manifest_match: "matched" as const,
      };
    }
    warnings.push(
      `Manifest SHA mismatch on ${s.filename}: file=${s.sha256.slice(0, 12)} manifest=${(entry.sha256 ?? "").slice(0, 12)}`,
    );
    return {
      ...s,
      manifest_source_id: entry.id,
      manifest_match: "filename_match_sha_mismatch" as const,
    };
  });

  return { updated, warnings };
}

/**
 * Options bag for `runBenchmark`.
 *
 * All fields optional. Backwards-compatible with the original
 * `runBenchmark(snapshotPath, queries)` signature: callers that pass no
 * options get the same behavior as before, except the report now
 * includes the new v2 fields with sensible defaults.
 */
export interface RunBenchmarkOptions {
  /**
   * Lineage metadata for the loaded query files. Pass the result of
   * `loadQueriesWithSource` / `loadQueriesFromDirWithSources`. When
   * omitted, the report records an empty `query_set_sources[]` and a
   * `warnings[]` entry noting that lineage is untracked.
   */
  querySetSources?: QuerySetSource[];
  /**
   * Optional path to `retrieval-v1.manifest.json`. When provided, each
   * `QuerySetSource` is cross-checked against the manifest and the
   * resulting `manifest_source_id` / `manifest_match` fields are
   * populated. Pass `null` to explicitly skip even auto-detection.
   */
  manifestPath?: string | null;
  /**
   * Which runner code path to use. Defaults to `"raw"`.
   *
   * - `"raw"` — calls `src/db.ts` query functions directly with
   *   `limit=10`. Faster, no rerank, no injectors. Useful for isolating
   *   retrieval-recall changes from ranker behavior.
   * - `"production_ranker"` — over-fetches by `QUERY_RERANK_OVERFETCH_MULTIPLIER`
   *   and runs results through the same canonical/attention injectors +
   *   `rerankQueryResults` + completed-task filter that `memory_query`
   *   uses in production, then slices to the requested limit. End-to-end
   *   parity with what production users see.
   */
  runnerMode?: RunnerMode;
  /**
   * Opt-in fallback when the prerequisites for `runnerMode` are not met
   * (e.g. snapshot too old for `production_ranker`).
   *
   * Default behavior is fail-loud — the runner throws. Set
   * `fallbackRunnerMode: "raw"` to instead downgrade with a
   * `warnings[]` entry and emit `runner_mode: "raw"` /
   * `runner_mode_requested: "production_ranker"` so post-hoc consumers
   * can detect the degraded run.
   */
  fallbackRunnerMode?: "raw";
  /**
   * Recency weight passed into the production reranker. Defaults to
   * `DEFAULT_SEARCH_RECENCY_WEIGHT` (0.2). Ignored in raw mode (no
   * rerank). Range [0, 1].
   */
  searchRecencyWeight?: number;
}

/**
 * Resolve expected IDs for a query.
 * If expected_ids is set, use those directly.
 * If expected_namespaces is set, returns empty (namespace matching is handled
 * separately via scoreQueryWithNamespaces to avoid the "all entries are relevant"
 * trap — we only need ANY result from the namespace, not ALL results).
 */
function resolveExpectedIds(query: BenchmarkQuery): string[] {
  if (query.expected_ids && query.expected_ids.length > 0) {
    return query.expected_ids;
  }
  return [];
}

/**
 * Check if any result comes from one of the expected namespaces.
 * Returns a synthetic "hit" ID list for scoring: one hit if any result matches,
 * against one expected item — giving binary recall (0 or 1).
 */
function scoreByNamespace(
  resultNamespaces: string[],
  expectedNamespaces: string[],
  k: number,
): { resultIds: string[]; expectedIds: string[] } {
  const nsSet = new Set(expectedNamespaces);
  const topK = resultNamespaces.slice(0, k);
  const hit = topK.some((ns) => nsSet.has(ns));
  // Model as: 1 expected item, either found (hit) or not
  return {
    resultIds: hit ? ["ns-hit"] : [],
    expectedIds: ["ns-hit"],
  };
}

/**
 * Run a single query through a specific search mode and return the
 * matching entries together with whether the relaxed-lexical fallback
 * fired.
 *
 * Returns full `Entry` objects (not just IDs) so the caller can either
 * project to IDs+namespaces (raw mode) or feed them through the
 * production reranker pipeline (production_ranker mode). The previous
 * IDs-only return shape was insufficient because the reranker needs the
 * full entries.
 *
 * `limit` controls the per-source fetch size:
 * - raw mode: pass the user-facing limit (typically 10)
 * - production_ranker: pass `requestedLimit * QUERY_RERANK_OVERFETCH_MULTIPLIER`
 *   (clamped to 50 by `queryEntriesLexicalScored` internally) so the
 *   reranker has room to reorder.
 */
async function executeQuery(
  db: Database.Database,
  query: string,
  mode: SearchMode,
  limit: number = 10,
): Promise<{ entries: Entry[]; relaxed: boolean; effectiveMode: SearchMode }> {
  if (mode === "lexical") {
    return runLexical(db, query, limit);
  }

  if (mode === "semantic") {
    const emb = await generateEmbedding(query);
    if (!emb) {
      // Mirror memory_query's per-query semantic→lexical degradation
      // (src/tools.ts:5828-5831): when embedding generation fails, fall
      // back to lexical with the same strict-then-relaxed sequence so
      // the report's actual_mode and the result IDs both stay parity
      // with production. Previous behavior (return empty) was a silent
      // divergence — M3 from the PR 2b internal review.
      const fallback = await runLexical(db, query, limit);
      return { ...fallback, effectiveMode: "lexical" };
    }
    const buf = embeddingToBuffer(emb);
    const results = queryEntriesSemanticScored(db, {
      queryEmbedding: buf,
      limit,
      includeExpired: true,
    });
    return { entries: results.map((r) => r.entry), relaxed: false, effectiveMode: "semantic" };
  }

  // hybrid
  const emb = await generateEmbedding(query);
  if (!emb) {
    // memory_query degrades hybrid→lexical on embedding failure (strict
    // first, then relaxed). Mirror it. Previously we ran strict-only
    // without the relaxed fallback, which is a subtle parity gap.
    const fallback = await runLexical(db, query, limit);
    return { ...fallback, effectiveMode: "lexical" };
  }
  const buf = embeddingToBuffer(emb);
  const relaxedQuery = buildRelaxedLexicalQuery(query);
  const hybridScored = queryEntriesHybridScored(db, {
    ftsOptions: { query, limit, includeExpired: true },
    semanticOptions: { queryEmbedding: buf, limit, includeExpired: true },
    ftsFallbackOptions: relaxedQuery
      ? { query: relaxedQuery, limit, includeExpired: true, rawFts5: true }
      : undefined,
  });
  return {
    entries: hybridScored.results.map((r) => r.entry),
    relaxed: hybridScored.ftsRelaxed,
    effectiveMode: "hybrid",
  };
}

/**
 * Run the lexical pipeline: strict FTS5 first, then the relaxed
 * OR-of-content-terms fallback if strict returned nothing. Mirrors
 * memory_query's lexical branch.
 */
function runLexical(
  db: Database.Database,
  query: string,
  limit: number,
): { entries: Entry[]; relaxed: boolean; effectiveMode: "lexical" } {
  let results = queryEntriesLexicalScored(db, {
    query,
    limit,
    includeExpired: true,
  });
  let relaxed = false;
  if (results.length === 0) {
    const relaxedQuery = buildRelaxedLexicalQuery(query);
    if (relaxedQuery) {
      results = queryEntriesLexicalScored(db, {
        query: relaxedQuery,
        limit,
        includeExpired: true,
        rawFts5: true,
      });
      relaxed = results.length > 0;
    }
  }
  return { entries: results.map((r) => r.entry), relaxed, effectiveMode: "lexical" };
}

/**
 * Replicate the production rerank pipeline from `src/tools.ts:5924-5936`,
 * minus `filterByAccess` (the benchmark always runs as owner). Called
 * per-query so `shouldApplyDefaultQuerySuppression` is evaluated against
 * each query's params — caching the tracked-status / completed-task maps
 * across queries would be incorrect because the predicate gate differs.
 *
 * The pipeline order is load-bearing:
 *   1. Inject canonical entries (reference-index, magnus profile, …)
 *   2. Inject blocked/attention statuses if the query is a triage query
 *   3. Filter completed-task namespaces if default suppression applies
 *   4. Rerank by heuristic + freshness, then slice to requestedLimit
 *
 * Any divergence from this order is a parity bug — the parity test in
 * `tests/runner-parity.test.ts` is the safety net.
 */
function applyProductionReranker(
  db: Database.Database,
  rawResults: Entry[],
  queryParams: QueryParams,
  requestedLimit: number,
): Entry[] {
  // Memoize the gate predicate. Production memory_query gates on
  // `shouldApplyDefaultQuerySuppression(...) || explain`; the benchmark
  // always sets `explain: false`, so the `|| explain` branch is dead
  // here. If that changes in the future, lift it back into the gate.
  const applyDefaults = shouldApplyDefaultQuerySuppression(queryParams);

  const trackedStatuses = applyDefaults ? getTrackedStatusAssessments(db) : undefined;

  let results: Entry[] = injectCanonicalQueryEntries(db, rawResults, queryParams);
  if (trackedStatuses) {
    results = injectAttentionQueryEntries(results, queryParams, trackedStatuses);
  }
  const completedTasks = applyDefaults
    ? getCompletedTaskNamespaces(db)
    : new Set<string>();
  return rerankQueryResults(results, queryParams, completedTasks, trackedStatuses).slice(
    0,
    requestedLimit,
  );
}

/**
 * Fail-loud prerequisite check for production_ranker mode.
 *
 * Production_ranker only runs against a snapshot whose schema is new
 * enough to carry every column the rerank pipeline reads (canonical
 * entries, tracked-status detection, completed-task namespaces). If
 * something is missing we either throw (default) or downgrade to raw
 * mode with a `warnings[]` entry (opt-in via `fallbackRunnerMode: "raw"`).
 */
function checkProductionRankerPrereqs(
  db: Database.Database,
  snapshotSchemaVersion: number,
): { ok: true } | { ok: false; reason: string } {
  // v5 introduces the principals table — the schema the multi-principal
  // pipeline depends on. Older snapshots predate every column the rerank
  // pipeline reads (notably `entries.owner_principal_id`), so we refuse
  // to silently invent missing data.
  if (snapshotSchemaVersion < 5) {
    return {
      ok: false,
      reason: `Snapshot schema v${snapshotSchemaVersion} is too old for production_ranker (need v5+).`,
    };
  }
  // Sanity: the entries table must exist and carry the v5 columns the
  // tracked-status query reads.
  const entriesRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
    .get() as { name: string } | undefined;
  if (!entriesRow) {
    return { ok: false, reason: "Snapshot is missing required table 'entries'." };
  }
  const columns = db
    .prepare("PRAGMA table_info(entries)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(columns.map((c) => c.name));
  for (const required of ["owner_principal_id", "classification", "valid_until"]) {
    if (!colNames.has(required)) {
      return {
        ok: false,
        reason: `Snapshot entries table missing required column '${required}' for production_ranker.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Round a duration to 0.01 ms precision so report diffs stay readable
 * without losing sub-millisecond signal.
 */
function roundDuration(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * Run the full benchmark and produce a report.
 */
export async function runBenchmark(
  snapshotPath: string,
  queries: BenchmarkQuery[],
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  // Open snapshot DB read-only. The function wraps the body in try/finally
  // so any early throw (e.g. failed production_ranker prereq check)
  // still closes the connection — m5 from the PR 2b internal review.
  const db = new Database(snapshotPath, { readonly: true });
  try {
    return await runBenchmarkInner(db, snapshotPath, queries, options);
  } finally {
    db.close();
  }
}

async function runBenchmarkInner(
  db: Database.Database,
  snapshotPath: string,
  queries: BenchmarkQuery[],
  options: RunBenchmarkOptions,
): Promise<BenchmarkReport> {
  sqliteVec.load(db);
  setVecLoaded(true);

  // Get DB metadata
  const schemaRow = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number } | undefined;
  const snapshotSchemaVersion = schemaRow?.v ?? 0;
  const countRow = db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number };
  const entryCount = countRow.c;

  const warnings: string[] = [];

  // Resolve query-set lineage.
  let querySetSources: QuerySetSource[] = (options.querySetSources ?? []).map((s) => ({ ...s }));
  if (options.querySetSources === undefined) {
    warnings.push(
      "query_set_sources not tracked — pass via loadQueriesWithSource for reproducibility",
    );
  }

  // Optional manifest cross-check.
  let manifestPath: string | null;
  if (options.manifestPath === null) {
    manifestPath = null;
  } else if (typeof options.manifestPath === "string") {
    manifestPath = options.manifestPath;
  } else if (querySetSources.length > 0) {
    // Auto-detect a manifest sitting next to the loaded files.
    const candidate = join(dirname(querySetSources[0].path), "retrieval-v1.manifest.json");
    manifestPath = existsSync(candidate) ? candidate : null;
  } else {
    manifestPath = null;
  }

  if (manifestPath && querySetSources.length > 0) {
    const { updated, warnings: mfWarnings } = crossCheckManifest(querySetSources, manifestPath);
    querySetSources = updated;
    warnings.push(...mfWarnings);
  }

  const querySetChecksum = computeQuerySetChecksum(querySetSources);

  // Resolve runner mode. fail-loud is the default; opt-in fallback to raw
  // is allowed when the caller explicitly sets `fallbackRunnerMode: "raw"`.
  const requestedRunnerMode: RunnerMode = options.runnerMode ?? "raw";
  let effectiveRunnerMode: RunnerMode = requestedRunnerMode;
  if (requestedRunnerMode === "production_ranker") {
    const check = checkProductionRankerPrereqs(db, snapshotSchemaVersion);
    if (!check.ok) {
      if (options.fallbackRunnerMode === "raw") {
        warnings.push(
          `production_ranker prereq failed — downgraded to raw mode. Reason: ${check.reason}`,
        );
        effectiveRunnerMode = "raw";
      } else {
        // The outer try/finally in `runBenchmark` owns db lifecycle.
        throw new Error(
          `production_ranker prerequisites not met: ${check.reason}. Pass fallbackRunnerMode: "raw" to opt into silent downgrade.`,
        );
      }
    }
  }

  // Recency weight is only meaningful for production_ranker. Reporting it
  // as `null` for raw mode keeps reports unambiguous: a 0 value would
  // imply "rerank ran but recency was zeroed out", which is a different
  // story.
  const searchRecencyWeight =
    effectiveRunnerMode === "production_ranker"
      ? options.searchRecencyWeight ?? DEFAULT_SEARCH_RECENCY_WEIGHT
      : null;

  const requiresEmbeddings = queries.some(
    (query) => query.search_mode === "semantic" || query.search_mode === "hybrid" || query.search_mode === "all",
  );
  const embeddingsAvailable = requiresEmbeddings
    ? await initEmbeddings()
    : false;
  if (requiresEmbeddings && !embeddingsAvailable) {
    warnings.push("Embeddings unavailable — semantic and hybrid modes will return empty results or fall back to lexical.");
  }

  const allResults: QueryBenchmarkResult[] = [];
  let skippedUnresolved = 0;
  let relaxedLexicalFallbackCount = 0;

  for (const query of queries) {
    const expectedIds = resolveExpectedIds(query);
    const useNamespaceScoring =
      expectedIds.length === 0 &&
      query.expected_namespaces &&
      query.expected_namespaces.length > 0;

    // Skip queries with no ground truth at all
    if (expectedIds.length === 0 && !useNamespaceScoring) {
      skippedUnresolved++;
      continue;
    }

    const modes: SearchMode[] =
      query.search_mode === "all"
        ? ["lexical", "semantic", "hybrid"]
        : [query.search_mode];

    for (const mode of modes) {
      // Per-query limit and fetch size. Raw mode uses a tight limit=10
      // (preserving PR 2a behavior). production_ranker over-fetches by
      // QUERY_RERANK_OVERFETCH_MULTIPLIER so the rerank pipeline has the
      // same candidate window as memory_query.
      const requestedLimit = 10;
      const internalLimit =
        effectiveRunnerMode === "production_ranker"
          ? Math.min(requestedLimit * QUERY_RERANK_OVERFETCH_MULTIPLIER, 50)
          : requestedLimit;

      // Pre-flight: if embeddings init returned unavailable, every
      // semantic/hybrid query degrades to lexical. We still pass the
      // requested mode into `executeQuery`, which performs the actual
      // per-query embedding attempt and reports the resolved
      // `effectiveMode` — that way a transient per-query embedding
      // failure on a snapshot that DOES have a working model is still
      // reported correctly (M3 from the PR 2b internal review).
      const queryStart = performance.now();
      const { entries: rawEntries, relaxed, effectiveMode } = await executeQuery(
        db,
        query.query,
        mode,
        internalLimit,
      );
      const actualMode = effectiveMode;

      let finalEntries: Entry[];
      if (effectiveRunnerMode === "production_ranker") {
        // Build the QueryParams memory_query would synthesize from the
        // request. Mirror src/tools.ts:5788-5800. The benchmark doesn't
        // carry namespace/entry_type/tags filters per-query today, so
        // those stay undefined and the suppression heuristics fire as
        // they would for a bare query string. The runner sets
        // `explain: false`, which means the `|| explain` clause in
        // memory_query at src/tools.ts:5924 is dead here — runner
        // gating reduces to `shouldApplyDefaultQuerySuppression` alone.
        const queryParams: QueryParams = {
          query: query.query,
          limit: requestedLimit,
          search_mode: actualMode,
          search_recency_weight: searchRecencyWeight ?? DEFAULT_SEARCH_RECENCY_WEIGHT,
          include_expired: true,
          explain: false,
        };
        finalEntries = applyProductionReranker(db, rawEntries, queryParams, requestedLimit);
      } else {
        finalEntries = rawEntries.slice(0, requestedLimit);
      }
      const durationMs = performance.now() - queryStart;

      const resultIds = finalEntries.map((e) => e.id);
      const resultNamespaces = finalEntries.map((e) => e.namespace);
      if (relaxed) {
        relaxedLexicalFallbackCount += 1;
      }

      let scores: ScoringResult;
      if (useNamespaceScoring) {
        // Namespace-based scoring: binary hit/miss per k-level
        const ns = query.expected_namespaces!;
        const r1 = scoreByNamespace(resultNamespaces, ns, 1).resultIds.length > 0 ? 1 : 0;
        const r5 = scoreByNamespace(resultNamespaces, ns, 5).resultIds.length > 0 ? 1 : 0;
        const r10 = scoreByNamespace(resultNamespaces, ns, 10).resultIds.length > 0 ? 1 : 0;
        const r20 = scoreByNamespace(resultNamespaces, ns, 20).resultIds.length > 0 ? 1 : 0;
        scores = {
          recallAt1: r1,
          recallAt5: r5,
          recallAt10: r10,
          recallAt20: r20,
          ndcgAt5: r5,
          ndcgAt20: r20,
          mrr: (() => {
            const nsSet = new Set(ns);
            for (let i = 0; i < resultNamespaces.length; i++) {
              if (nsSet.has(resultNamespaces[i])) return 1 / (i + 1);
            }
            return 0;
          })(),
        };
      } else {
        scores = scoreQuery({
          resultIds,
          expectedIds,
          idealRanking: query.expected_at_rank,
        });
      }

      const negativeViolations = query.negatives
        ? query.negatives.filter((neg) => resultIds.slice(0, 5).includes(neg))
        : [];

      allResults.push({
        query_id: query.id,
        search_mode: mode,
        actual_mode: actualMode !== mode ? actualMode : undefined,
        result_ids: resultIds,
        result_namespaces: resultNamespaces,
        expected_ids: useNamespaceScoring ? [] : expectedIds,
        scores,
        negative_violations: negativeViolations,
        duration_ms: roundDuration(durationMs),
      });
    }
  }

  if (skippedUnresolved > 0) {
    warnings.push(`${skippedUnresolved} queries skipped — no ground truth (no expected_ids or expected_namespaces).`);
  }

  // Aggregate overall
  const overall = aggregateScores(allResults.map((r) => r.scores));
  const overallDuration = summarizeDurations(allResults.map((r) => r.duration_ms));

  // Aggregate by category
  const categoryScores = new Map<string, ScoringResult[]>();
  const categoryDurations = new Map<string, number[]>();
  for (const result of allResults) {
    const query = queries.find((q) => q.id === result.query_id)!;
    const cat = query.category;
    if (!categoryScores.has(cat)) categoryScores.set(cat, []);
    if (!categoryDurations.has(cat)) categoryDurations.set(cat, []);
    categoryScores.get(cat)!.push(result.scores);
    categoryDurations.get(cat)!.push(result.duration_ms);
  }
  const byCategory: CategoryResult[] = Array.from(categoryScores.entries()).map(
    ([category, scores]) => ({
      category,
      query_count: scores.length,
      scores: aggregateScores(scores),
      duration: summarizeDurations(categoryDurations.get(category)!),
    }),
  );

  // Aggregate by requested search mode (NOT actual_mode — keeps latency
  // bucket aligned with the recall bucket below).
  const modeScores = new Map<string, ScoringResult[]>();
  const modeDurations = new Map<string, number[]>();
  for (const result of allResults) {
    if (!modeScores.has(result.search_mode)) modeScores.set(result.search_mode, []);
    if (!modeDurations.has(result.search_mode)) modeDurations.set(result.search_mode, []);
    modeScores.get(result.search_mode)!.push(result.scores);
    modeDurations.get(result.search_mode)!.push(result.duration_ms);
  }
  const bySearchMode: Record<string, ScoringResult> = {};
  const bySearchModeDuration: Record<string, DurationSummary> = {};
  for (const [mode, scores] of modeScores.entries()) {
    bySearchMode[mode] = aggregateScores(scores);
    bySearchModeDuration[mode] = summarizeDurations(modeDurations.get(mode)!);
  }

  // db lifecycle is owned by the outer try/finally in `runBenchmark`.

  return {
    run_at: new Date().toISOString(),
    snapshot_path: snapshotPath,
    snapshot_schema_version: snapshotSchemaVersion,
    schema_version: snapshotSchemaVersion, // deprecated alias for one release
    report_schema_version: 2,
    entry_count: entryCount,
    query_count: queries.length,
    evaluation_count: allResults.length,
    runner_mode: effectiveRunnerMode,
    runner_mode_requested: requestedRunnerMode,
    search_recency_weight: searchRecencyWeight,
    principal_id: "owner",
    query_set_sources: querySetSources,
    query_set_checksum: querySetChecksum,
    overall,
    overall_duration: overallDuration,
    by_category: byCategory,
    by_search_mode: bySearchMode,
    by_search_mode_duration: bySearchModeDuration,
    queries: allResults,
    warnings: warnings.length > 0 ? warnings : undefined,
    relaxed_lexical_fallback_count: relaxedLexicalFallbackCount,
  };
}

/**
 * Sort and pass through to `percentilesFromDurations`. Centralized here
 * so callers don't have to remember the sort step.
 */
function summarizeDurations(durations: number[]): DurationSummary {
  const sorted = [...durations].sort((a, b) => a - b);
  const pct = percentilesFromDurations(sorted);
  return {
    p50_ms: pct.p50_ms === null ? null : roundDuration(pct.p50_ms),
    p95_ms: pct.p95_ms === null ? null : roundDuration(pct.p95_ms),
    total_ms: roundDuration(pct.total_ms),
  };
}

/**
 * Write a benchmark report to disk.
 */
export function writeReport(report: BenchmarkReport, outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = join(outputDir, `report-${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}
