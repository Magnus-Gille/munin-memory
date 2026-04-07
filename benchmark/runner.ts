/**
 * Benchmark runner: loads a snapshot DB + query set, executes retrieval,
 * scores results, and produces a report.
 *
 * Calls db.ts query functions directly (not through MCP tool layer)
 * to avoid Server scaffolding overhead.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  queryEntriesLexicalScored,
  queryEntriesHybridScored,
  queryEntriesSemanticScored,
  type QueryOptions,
  type HybridQueryOptions,
  type SemanticQueryOptions,
} from "../src/db.js";
import { generateEmbedding, embeddingToBuffer, initEmbeddings } from "../src/embeddings.js";
import { scoreQuery, aggregateScores, type ScoringResult } from "./scorer.js";
import type {
  BenchmarkQuery,
  BenchmarkReport,
  QueryBenchmarkResult,
  CategoryResult,
} from "./types.js";
import type { SearchMode } from "../src/types.js";

/**
 * Load benchmark queries from a JSONL file.
 */
export function loadQueries(filePath: string): BenchmarkQuery[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("//"))
    .map((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Failed to parse JSON at line ${i + 1} in ${filePath}`);
      }
      const q = parsed as Record<string, unknown>;
      if (!q.id || typeof q.id !== "string") {
        throw new Error(`Query at line ${i + 1} in ${filePath} missing required field "id" (string).`);
      }
      if (!q.query || typeof q.query !== "string") {
        throw new Error(`Query "${q.id}" at line ${i + 1} in ${filePath} missing required field "query" (string).`);
      }
      if (!q.category || typeof q.category !== "string") {
        throw new Error(`Query "${q.id}" at line ${i + 1} in ${filePath} missing required field "category" (string).`);
      }
      if (!q.search_mode || typeof q.search_mode !== "string") {
        throw new Error(`Query "${q.id}" at line ${i + 1} in ${filePath} missing required field "search_mode".`);
      }
      return parsed as BenchmarkQuery;
    });
}

/**
 * Load queries from all JSONL files in a directory.
 */
export function loadQueriesFromDir(dirPath: string): BenchmarkQuery[] {
  const files: string[] = readdirSync(dirPath);
  const queries: BenchmarkQuery[] = [];
  for (const file of files) {
    if (file.endsWith(".jsonl")) {
      queries.push(...loadQueries(join(dirPath, file)));
    }
  }
  return queries;
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
 * Run a single query through a specific search mode and return result IDs.
 */
async function executeQuery(
  db: Database.Database,
  query: string,
  mode: SearchMode,
  limit: number = 10,
): Promise<{ ids: string[]; namespaces: string[] }> {
  if (mode === "lexical") {
    const results = queryEntriesLexicalScored(db, {
      query,
      limit,
      includeExpired: true,
    });
    return {
      ids: results.map((r) => r.entry.id),
      namespaces: results.map((r) => r.entry.namespace),
    };
  }

  if (mode === "semantic") {
    const emb = await generateEmbedding(query);
    if (!emb) {
      return { ids: [], namespaces: [] };
    }
    const buf = embeddingToBuffer(emb);
    const results = queryEntriesSemanticScored(db, {
      queryEmbedding: buf,
      limit,
      includeExpired: true,
    });
    return {
      ids: results.map((r) => r.entry.id),
      namespaces: results.map((r) => r.entry.namespace),
    };
  }

  // hybrid
  const emb = await generateEmbedding(query);
  if (!emb) {
    // Fall back to lexical
    const results = queryEntriesLexicalScored(db, {
      query,
      limit,
      includeExpired: true,
    });
    return {
      ids: results.map((r) => r.entry.id),
      namespaces: results.map((r) => r.entry.namespace),
    };
  }
  const buf = embeddingToBuffer(emb);
  const results = queryEntriesHybridScored(db, {
    ftsOptions: { query, limit, includeExpired: true },
    semanticOptions: { queryEmbedding: buf, limit, includeExpired: true },
  });
  return {
    ids: results.map((r) => r.entry.id),
    namespaces: results.map((r) => r.entry.namespace),
  };
}

/**
 * Run the full benchmark and produce a report.
 */
export async function runBenchmark(
  snapshotPath: string,
  queries: BenchmarkQuery[],
): Promise<BenchmarkReport> {
  // Open snapshot DB read-only
  const db = new Database(snapshotPath, { readonly: true });
  sqliteVec.load(db);

  // Get DB metadata
  const schemaRow = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number } | undefined;
  const schemaVersion = schemaRow?.v ?? 0;
  const countRow = db.prepare("SELECT COUNT(*) as c FROM entries").get() as { c: number };
  const entryCount = countRow.c;

  // Initialize embeddings for semantic/hybrid queries
  const embeddingsAvailable = await initEmbeddings();
  const warnings: string[] = [];
  if (!embeddingsAvailable) {
    warnings.push("Embeddings unavailable — semantic and hybrid modes will return empty results or fall back to lexical.");
  }

  const allResults: QueryBenchmarkResult[] = [];
  let skippedUnresolved = 0;

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
      // Track when embeddings are unavailable and mode is affected
      let actualMode = mode;
      if ((mode === "semantic" || mode === "hybrid") && !embeddingsAvailable) {
        actualMode = "lexical";
      }

      const { ids: resultIds, namespaces: resultNamespaces } = await executeQuery(
        db,
        query.query,
        mode,
        10,
      );

      let scores: ScoringResult;
      if (useNamespaceScoring) {
        // Namespace-based scoring: binary hit/miss per k-level
        const ns = query.expected_namespaces!;
        scores = {
          recallAt1: scoreByNamespace(resultNamespaces, ns, 1).resultIds.length > 0 ? 1 : 0,
          recallAt5: scoreByNamespace(resultNamespaces, ns, 5).resultIds.length > 0 ? 1 : 0,
          recallAt10: scoreByNamespace(resultNamespaces, ns, 10).resultIds.length > 0 ? 1 : 0,
          ndcgAt5: scoreByNamespace(resultNamespaces, ns, 5).resultIds.length > 0 ? 1 : 0,
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
      });
    }
  }

  if (skippedUnresolved > 0) {
    warnings.push(`${skippedUnresolved} queries skipped — no ground truth (no expected_ids or expected_namespaces).`);
  }

  // Aggregate overall
  const overall = aggregateScores(allResults.map((r) => r.scores));

  // Aggregate by category
  const categoryMap = new Map<string, ScoringResult[]>();
  for (const result of allResults) {
    const query = queries.find((q) => q.id === result.query_id)!;
    const cat = query.category;
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push(result.scores);
  }
  const byCategory: CategoryResult[] = Array.from(categoryMap.entries()).map(
    ([category, scores]) => ({
      category,
      query_count: scores.length,
      scores: aggregateScores(scores),
    }),
  );

  // Aggregate by search mode
  const modeMap = new Map<string, ScoringResult[]>();
  for (const result of allResults) {
    if (!modeMap.has(result.search_mode)) modeMap.set(result.search_mode, []);
    modeMap.get(result.search_mode)!.push(result.scores);
  }
  const bySearchMode: Record<string, ScoringResult> = {};
  for (const [mode, scores] of modeMap.entries()) {
    bySearchMode[mode] = aggregateScores(scores);
  }

  db.close();

  return {
    run_at: new Date().toISOString(),
    snapshot_path: snapshotPath,
    schema_version: schemaVersion,
    entry_count: entryCount,
    query_count: queries.length,
    evaluation_count: allResults.length,
    overall,
    by_category: byCategory,
    by_search_mode: bySearchMode,
    queries: allResults,
    warnings: warnings.length > 0 ? warnings : undefined,
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
