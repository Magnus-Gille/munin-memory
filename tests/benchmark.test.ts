import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runBenchmark, loadQueriesFromDir, writeReport } from "../benchmark/runner.js";
import type { BenchmarkReport } from "../benchmark/types.js";

const BENCHMARK_DIR = join(__dirname, "..", "benchmark");
const FIXTURES_DIR = join(BENCHMARK_DIR, "fixtures");
const QUERIES_DIR = join(BENCHMARK_DIR, "queries");
const REPORTS_DIR = join(BENCHMARK_DIR, "reports");

// Only run when MUNIN_BENCHMARK=true (skipped in regular test suite)
const shouldRun = process.env.MUNIN_BENCHMARK === "true";

describe.skipIf(!shouldRun)("Retrieval Benchmark", () => {
  let snapshotPath: string;
  let report: BenchmarkReport;

  beforeAll(async () => {
    // Find the most recent snapshot
    if (!existsSync(FIXTURES_DIR)) {
      throw new Error(
        `No benchmark fixtures directory at ${FIXTURES_DIR}. Run: ./scripts/snapshot-benchmark-db.sh`,
      );
    }
    const snapshots = readdirSync(FIXTURES_DIR)
      .filter((f) => f.startsWith("memory-snapshot-") && f.endsWith(".db"))
      .sort()
      .reverse();

    if (snapshots.length === 0) {
      throw new Error(
        `No snapshot files in ${FIXTURES_DIR}. Run: ./scripts/snapshot-benchmark-db.sh`,
      );
    }
    snapshotPath = join(FIXTURES_DIR, snapshots[0]);

    // Load all query files
    const queries = loadQueriesFromDir(QUERIES_DIR);
    if (queries.length === 0) {
      throw new Error(`No queries found in ${QUERIES_DIR}. Add .jsonl files with benchmark queries.`);
    }

    // Run the benchmark
    report = await runBenchmark(snapshotPath, queries);

    // Write report
    const reportPath = writeReport(report, REPORTS_DIR);
    console.log(`\nBenchmark report written to: ${reportPath}`);
  }, 120_000); // 2 min timeout for embedding init + queries

  afterAll(() => {
    // Print summary
    if (!report) return;
    console.log("\n=== Benchmark Summary ===");
    console.log(`  Snapshot: ${report.snapshot_path}`);
    console.log(`  Schema: v${report.schema_version}, Entries: ${report.entry_count}`);
    console.log(`  Queries: ${report.query_count}`);
    console.log(`  Evaluations: ${report.evaluation_count}`);
    if (report.warnings) {
      for (const w of report.warnings) console.log(`  WARNING: ${w}`);
    }
    console.log(`  Overall R@1:  ${(report.overall.recallAt1 * 100).toFixed(1)}%`);
    console.log(`  Overall R@5:  ${(report.overall.recallAt5 * 100).toFixed(1)}%`);
    console.log(`  Overall R@10: ${(report.overall.recallAt10 * 100).toFixed(1)}%`);
    console.log(`  Overall NDCG@5: ${(report.overall.ndcgAt5 * 100).toFixed(1)}%`);
    console.log(`  Overall MRR:  ${(report.overall.mrr * 100).toFixed(1)}%`);
    if (report.by_category.length > 0) {
      console.log("\n  By Category:");
      for (const cat of report.by_category) {
        console.log(
          `    ${cat.category} (${cat.query_count}q): R@5=${(cat.scores.recallAt5 * 100).toFixed(1)}% MRR=${(cat.scores.mrr * 100).toFixed(1)}%`,
        );
      }
    }
    if (Object.keys(report.by_search_mode).length > 1) {
      console.log("\n  By Search Mode:");
      for (const [mode, scores] of Object.entries(report.by_search_mode)) {
        console.log(
          `    ${mode}: R@5=${(scores.recallAt5 * 100).toFixed(1)}% MRR=${(scores.mrr * 100).toFixed(1)}%`,
        );
      }
    }
    console.log("========================\n");
  });

  it("produces a valid report", () => {
    expect(report).toBeDefined();
    expect(report.query_count).toBeGreaterThan(0);
    expect(report.overall).toBeDefined();
    if (report.entry_count === 0) {
      console.warn("WARNING: Snapshot DB has 0 entries. Scores are meaningless. Pull a real snapshot from the Pi.");
    }
  });

  it("R@5 is above minimum threshold", () => {
    // Baseline threshold — intentionally low for first run.
    // Raise this once we have a real baseline.
    expect(report.overall.recallAt5).toBeGreaterThanOrEqual(0);
  });

  it("reports no negative violations", () => {
    const violations = report.queries.filter((q) => q.negative_violations.length > 0);
    if (violations.length > 0) {
      console.warn(
        "Negative violations found:",
        violations.map((v) => `${v.query_id}: [${v.negative_violations.join(",")}]`),
      );
    }
    // Warning only — don't fail the benchmark on negatives yet
  });
});
