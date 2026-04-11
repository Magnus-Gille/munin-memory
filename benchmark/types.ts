import type { SearchMode } from "../src/types.js";
import type { ScoringResult } from "./scorer.js";

/** A single benchmark query with ground truth. */
export interface BenchmarkQuery {
  /** Stable identifier for tracking across runs. */
  id: string;
  /** The query string to pass to the retrieval pipeline. */
  query: string;
  /** Ground truth source: manual, derived from retrieval analytics, or synthetic. */
  source: "manual" | "derived" | "synthetic";
  /** Category for per-category breakdowns. */
  category:
    | "project-status"
    | "decision-lookup"
    | "person-context"
    | "temporal"
    | "cross-project"
    | "tag-search"
    | "broad-orientation"
    | string;
  /** Which search mode to test. "all" runs all three. */
  search_mode: SearchMode | "all";
  /** UUIDs of entries that should appear in results. */
  expected_ids?: string[];
  /** Alternative: any entry from these namespaces counts as relevant. */
  expected_namespaces?: string[];
  /** Stricter positional expectations: entry ID → expected rank (1-indexed). */
  expected_at_rank?: Record<string, number>;
  /** Entry IDs that should NOT appear in top results. */
  negatives?: string[];
  /** Optional notes for maintainers. */
  notes?: string;
}

/** Result of running a single query through a specific search mode. */
export interface QueryBenchmarkResult {
  query_id: string;
  search_mode: SearchMode;
  /** Set when embeddings are unavailable and mode was silently downgraded. */
  actual_mode?: SearchMode;
  result_ids: string[];
  result_namespaces: string[];
  expected_ids: string[];
  scores: ScoringResult;
  negative_violations: string[];
}

/** Per-category aggregate. */
export interface CategoryResult {
  category: string;
  query_count: number;
  scores: ScoringResult;
}

/** Full benchmark report. */
export interface BenchmarkReport {
  /** ISO 8601 timestamp of when the benchmark was run. */
  run_at: string;
  /** DB snapshot file used. */
  snapshot_path: string;
  /** Schema version of the snapshot DB. */
  schema_version: number;
  /** Number of entries in the snapshot DB. */
  entry_count: number;
  /** Total queries in the query set. */
  query_count: number;
  /** Total evaluations (queries × modes; differs from query_count when search_mode is "all"). */
  evaluation_count: number;
  /** Overall aggregated scores. */
  overall: ScoringResult;
  /** Per-category breakdown. */
  by_category: CategoryResult[];
  /** Per-search-mode breakdown. */
  by_search_mode: Record<string, ScoringResult>;
  /** Individual query results (for debugging). */
  queries: QueryBenchmarkResult[];
  /** Warnings about degraded conditions (e.g., embeddings unavailable). */
  warnings?: string[];
  /** Count of lexical queries that fell back to the relaxed OR form because strict AND returned nothing. Mirrors memory_query's production fallback; see benchmark/runner.ts executeQuery. */
  relaxed_lexical_fallback_count?: number;
}
