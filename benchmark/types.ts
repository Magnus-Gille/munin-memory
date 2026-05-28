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

/**
 * Runner mode toggle.
 *
 * - `raw` — runner calls `src/db.ts` query functions directly. Default.
 *   Faster, no MCP scaffolding, no rerank, no canonical/attention
 *   injectors. Useful for isolating retrieval-recall changes without
 *   ranker interference.
 * - `production_ranker` — runner additionally runs results through
 *   `rerankQueryResults` + canonical / attention injectors + completed-task
 *   filter, matching what `memory_query` does in production. The benchmark
 *   numbers reflect end-to-end production behavior.
 *
 * Wired in PR 2b. PR 2a emits only `"raw"`; the type lives here so the
 * report shape is stable across both PRs.
 */
export type RunnerMode = "raw" | "production_ranker";

/**
 * One loaded JSONL query-set file with byte-level integrity metadata.
 *
 * Records the path, line count, raw-bytes SHA-256, byte size, and
 * optional pin to a `retrieval-v1.manifest.json` source entry. The
 * `manifest_match` field tells consumers whether a manifest cross-check
 * was performed and what it found.
 */
export interface QuerySetSource {
  /** Path the runner was given (absolute or repo-relative). */
  path: string;
  /** Basename of the file (filename portion of the path). */
  filename: string;
  /** Number of non-blank non-comment lines parsed into queries. */
  record_count: number;
  /** SHA-256 hash over the raw bytes of the file (lowercase hex). */
  sha256: string;
  /** File size in bytes. */
  bytes: number;
  /**
   * When a manifest was loaded and a sources[] entry's filename matched
   * this file: that source's id (e.g. `"munin-native-baseline"`). Absent
   * otherwise.
   */
  manifest_source_id?: string;
  /**
   * Cross-check outcome:
   * - `matched` — basename and on-disk SHA both match a manifest entry.
   * - `filename_match_sha_mismatch` — basename matches but contents differ.
   * - `unmatched` — manifest was loaded but no matching entry.
   * - `manifest_not_provided` — no manifest was given to the runner.
   */
  manifest_match: "matched" | "filename_match_sha_mismatch" | "unmatched" | "manifest_not_provided";
}

/**
 * Duration aggregate for a bucket (overall, per search mode, per category).
 *
 * Percentiles computed with the same nearest-rank algorithm as
 * `src/db.ts:computeP95`. See `benchmark/scorer.ts:percentilesFromDurations`.
 */
export interface DurationSummary {
  /** 50th percentile wall-time in milliseconds (null for n=0). */
  p50_ms: number | null;
  /** 95th percentile wall-time in milliseconds (null for n=0). */
  p95_ms: number | null;
  /** Sum of all sample durations in milliseconds. Useful for sanity. */
  total_ms: number;
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
  /** Wall-time for this evaluation, captured with performance.now(). */
  duration_ms: number;
}

/** Per-category aggregate. */
export interface CategoryResult {
  category: string;
  query_count: number;
  scores: ScoringResult;
  duration: DurationSummary;
}

/** Full benchmark report. */
export interface BenchmarkReport {
  /** ISO 8601 timestamp of when the benchmark was run. */
  run_at: string;
  /** DB snapshot file used. */
  snapshot_path: string;
  /**
   * Schema version of the snapshot DB used for the run.
   * Renamed from `schema_version` to disambiguate from `report_schema_version`.
   */
  snapshot_schema_version: number;
  /**
   * Version of the BenchmarkReport JSON shape itself. Bumped additively
   * when new fields are introduced. Old consumers should treat unknown
   * fields as optional and branch on this when consuming new ones.
   *
   * - `1` — implicit version of all pre-PR-2a reports.
   * - `2` — PR 2a additions (query_set_sources, query_set_checksum,
   *   overall_duration, by_search_mode_duration, snapshot_schema_version,
   *   runner_mode, CategoryResult.duration, QueryBenchmarkResult.duration_ms,
   *   ScoringResult.recallAt20/ndcgAt20).
   * - `3` — removed the deprecated `schema_version` alias (#58). Read
   *   `snapshot_schema_version` for the snapshot DB migration version.
   */
  report_schema_version: 3;
  /** Number of entries in the snapshot DB. */
  entry_count: number;
  /** Total queries in the query set. */
  query_count: number;
  /** Total evaluations (queries × modes; differs from query_count when search_mode is "all"). */
  evaluation_count: number;
  /**
   * Which runner code path actually produced these numbers. PR 2a emitted
   * only `"raw"`; PR 2b adds `"production_ranker"`. Compare with
   * `runner_mode_requested` to detect a degraded run (e.g. caller asked
   * for `production_ranker` but the runner downgraded to `raw` because a
   * prerequisite was missing and `fallbackRunnerMode: "raw"` was set).
   */
  runner_mode: RunnerMode;
  /**
   * Which runner mode the caller asked for. Always present as of PR 2b.
   * Equal to `runner_mode` for non-degraded runs. When they differ, the
   * runner downgraded — `warnings[]` carries the reason.
   */
  runner_mode_requested: RunnerMode;
  /**
   * Recency weight applied during reranking. Only meaningful for
   * `production_ranker`; in `raw` mode the reranker is skipped entirely
   * and this is reported as `null` for traceability.
   */
  search_recency_weight: number | null;
  /**
   * Principal identifier the runner ran as. Always `"owner"` in PR 2b —
   * benchmarks run with full owner access and skip `filterByAccess`. The
   * field is typed `string` so a future multi-principal benchmarking
   * mode can populate it (e.g. `"family:sara"`, `"agent:skuld"`) without
   * forcing every TypeScript consumer through a widening bump. Today's
   * reports always carry the literal `"owner"`.
   */
  principal_id: string;
  /** Per-file lineage metadata for the query set(s) loaded into this run. */
  query_set_sources: QuerySetSource[];
  /**
   * Deterministic SHA-256 over the sorted (filename, sha256) pairs of all
   * query_set_sources. Useful for one-shot comparison across reports:
   * same checksum ⟹ same query set bytes.
   */
  query_set_checksum: string;
  /** Overall aggregated scores. */
  overall: ScoringResult;
  /** Wall-time percentiles + total across every evaluation. */
  overall_duration: DurationSummary;
  /** Per-category breakdown. */
  by_category: CategoryResult[];
  /** Per-search-mode breakdown. */
  by_search_mode: Record<string, ScoringResult>;
  /**
   * Per-search-mode wall-time summary. Bucket key is the requested mode
   * (mirroring `by_search_mode`), not `actual_mode`, so a query that
   * requested semantic but ran lexical contributes to the `semantic` bucket
   * to keep latency comparable to recall.
   */
  by_search_mode_duration: Record<string, DurationSummary>;
  /** Individual query results (for debugging). */
  queries: QueryBenchmarkResult[];
  /** Warnings about degraded conditions (e.g., embeddings unavailable). */
  warnings?: string[];
  /** Count of lexical queries that fell back to the relaxed OR form because strict AND returned nothing. Mirrors memory_query's production fallback; see benchmark/runner.ts executeQuery. */
  relaxed_lexical_fallback_count?: number;
}
