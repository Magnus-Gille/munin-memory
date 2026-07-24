/**
 * A/B driver for the answer-quality eval harness.
 *
 * Runs the same retrieval pipeline with two serialization variants
 * (linear vs boundary) and emits a single A/B report with deltas.
 *
 * Both variants share the same snapshot, queries, models, and retrieval
 * configuration — the ONLY variable is the `serialization` mode.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAnswerQuality, type AnswerQualityOptions } from "./runner.js";
import type {
  AnswerQualityAbReport,
} from "./types.js";

/** Options for the A/B run — same as AnswerQualityOptions but without `serialization`. */
export type AnswerQualityAbOptions = Omit<AnswerQualityOptions, "serialization">;

/**
 * Run linear and boundary serialization variants back-to-back and compute deltas.
 *
 * The A/B identity contract: both variants MUST share the same
 * `snapshot_path`, `query_set_checksum`, `snapshot_schema_version`,
 * `answer_model`, and `judge_model`.
 */
export async function runAnswerQualityAb(
  opts: AnswerQualityAbOptions,
): Promise<AnswerQualityAbReport> {
  const runAt = new Date().toISOString();

  // Run both variants sequentially (same API key, same models)
  const linear = await runAnswerQuality({ ...opts, serialization: "linear" });
  const boundary = await runAnswerQuality({ ...opts, serialization: "boundary" });

  // Compute deltas
  const overallAccuracyDelta = boundary.overall_accuracy - linear.overall_accuracy;
  const overallMeanScoreDelta = boundary.overall_mean_score - linear.overall_mean_score;

  // Per-category delta: union of both variants' categories
  const allCategories = new Set([
    ...linear.by_category.map((c) => c.category),
    ...boundary.by_category.map((c) => c.category),
  ]);

  const byCategoryDelta = Array.from(allCategories)
    .sort()
    .map((category) => {
      const linearCat = linear.by_category.find((c) => c.category === category);
      const boundaryCat = boundary.by_category.find((c) => c.category === category);
      const linearAcc = linearCat?.accuracy ?? 0;
      const boundaryAcc = boundaryCat?.accuracy ?? 0;
      const linearScore = linearCat?.mean_score ?? 0;
      const boundaryScore = boundaryCat?.mean_score ?? 0;
      return {
        category,
        accuracy_delta: boundaryAcc - linearAcc,
        score_delta: boundaryScore - linearScore,
      };
    });

  return {
    report_kind: "answer_quality_ab",
    report_schema_version: 3,
    run_at: runAt,
    variable: "serialization",
    // Identity contract
    snapshot_path: opts.snapshotPath,
    query_set_checksum: linear.query_set_checksum,
    snapshot_schema_version: linear.snapshot_schema_version,
    answer_model: opts.answerModel,
    judge_model: opts.judgeModel,
    variant_linear: linear,
    variant_boundary: boundary,
    delta: {
      overall_accuracy: overallAccuracyDelta,
      overall_mean_score: overallMeanScoreDelta,
      by_category: byCategoryDelta,
    },
  };
}

/**
 * Write an A/B report to disk.
 * Reports land in benchmark/reports/answer-quality/.
 */
export function writeAbReport(
  report: AnswerQualityAbReport,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = join(outputDir, `aq-ab-report-${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

/**
 * Print a human-readable summary of an A/B report.
 */
export function printAbSummary(report: AnswerQualityAbReport): void {
  const { delta, variant_linear: lin, variant_boundary: bnd } = report;
  const sign = (n: number) => (n >= 0 ? "+" : "");

  console.log("\n=== Answer Quality A/B: linear vs boundary serialization ===");
  console.log(`Snapshot:     ${report.snapshot_path}`);
  console.log(`Answer model: ${report.answer_model}`);
  console.log(`Judge model:  ${report.judge_model}`);
  console.log(`Queries:      ${lin.query_count} (${lin.skipped_no_reference} skipped — no reference answer)`);
  console.log("");
  console.log("Overall");
  console.log(`  Linear:   accuracy=${lin.overall_accuracy.toFixed(3)}  score=${lin.overall_mean_score.toFixed(3)}`);
  console.log(`  Boundary: accuracy=${bnd.overall_accuracy.toFixed(3)}  score=${bnd.overall_mean_score.toFixed(3)}`);
  console.log(`  Delta:    accuracy=${sign(delta.overall_accuracy)}${delta.overall_accuracy.toFixed(3)}  score=${sign(delta.overall_mean_score)}${delta.overall_mean_score.toFixed(3)}`);

  if (delta.by_category.length > 0) {
    console.log("\nBy category");
    for (const cat of delta.by_category) {
      console.log(
        `  ${cat.category.padEnd(30)} acc Δ=${sign(cat.accuracy_delta)}${cat.accuracy_delta.toFixed(3)}  score Δ=${sign(cat.score_delta)}${cat.score_delta.toFixed(3)}`,
      );
    }
  }
  console.log("");
}
