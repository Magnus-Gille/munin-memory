/**
 * CLI entry point for the answer-quality eval harness.
 *
 * Usage:
 *   tsx benchmark/answer-quality/run.ts [options]
 *
 * Options:
 *   --queries <path>          JSONL query file (required)
 *   --snapshot <path>         SQLite snapshot DB (required)
 *   --serialization <mode>    "linear" or "boundary" (default: linear)
 *   --runner-mode <mode>      "raw" or "production_ranker" (default: production_ranker)
 *   --search-mode <mode>      "lexical", "semantic", or "hybrid" (default: hybrid)
 *   --top-k <n>               Entries in context (default: 10)
 *   --answer-model <id>       OpenRouter model ID for answers
 *   --judge-model <id>        OpenRouter model ID for judging
 *   --output-dir <path>       Report output directory (default: benchmark/reports/answer-quality)
 *   --ab                      Run A/B: linear vs boundary (overrides --serialization)
 *
 * Environment variables:
 *   OPENROUTER_API_KEY        Required. The eval exits cleanly (exit 0) if unset.
 *   MUNIN_ANSWER_MODEL        Default answer model if --answer-model not given.
 *   MUNIN_JUDGE_MODEL         Default judge model if --judge-model not given.
 */

import { resolve } from "node:path";
import { loadQueriesWithSource } from "../runner.js";
import { shouldSkipForMissingKey, runAnswerQuality, writeAnswerQualityReport } from "./runner.js";
import { runAnswerQualityAb, writeAbReport, printAbSummary } from "./ab.js";
import type { SerializationMode } from "./types.js";
import type { RunnerMode } from "../types.js";
import type { SearchMode } from "../../src/types.js";

function parseArgs(argv: string[]): {
  queriesPath: string | null;
  snapshotPath: string | null;
  serialization: SerializationMode;
  runnerMode: RunnerMode;
  searchMode: SearchMode;
  topK: number;
  answerModel: string;
  judgeModel: string;
  outputDir: string;
  ab: boolean;
} {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    args.set(key, next);
    i++;
  }

  const defaultAnswerModel =
    process.env.MUNIN_ANSWER_MODEL ?? "anthropic/claude-haiku-4-5";
  const defaultJudgeModel =
    process.env.MUNIN_JUDGE_MODEL ?? "anthropic/claude-sonnet-4-5";

  return {
    queriesPath: args.get("queries") ? resolve(args.get("queries")!) : null,
    snapshotPath: args.get("snapshot") ? resolve(args.get("snapshot")!) : null,
    serialization: (args.get("serialization") ?? "linear") as SerializationMode,
    runnerMode: (args.get("runner-mode") ?? "production_ranker") as RunnerMode,
    searchMode: (args.get("search-mode") ?? "hybrid") as SearchMode,
    topK: args.has("top-k") ? parseInt(args.get("top-k")!, 10) || 10 : 10,
    answerModel: args.get("answer-model") ?? defaultAnswerModel,
    judgeModel: args.get("judge-model") ?? defaultJudgeModel,
    outputDir: resolve(
      args.get("output-dir") ?? "benchmark/reports/answer-quality",
    ),
    ab: flags.has("ab"),
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.queriesPath || !parsed.snapshotPath) {
    console.error("Usage: tsx benchmark/answer-quality/run.ts --queries <path> --snapshot <path> [options]");
    process.exit(1);
  }

  // Check for missing API key — clean exit (not an error)
  const skipReason = shouldSkipForMissingKey(null, undefined);
  if (skipReason) {
    console.log(`Skipping answer-quality eval: ${skipReason}`);
    process.exit(0);
  }

  // Load queries
  const { queries, source } = loadQueriesWithSource(parsed.queriesPath);
  console.log(`Loaded ${queries.length} queries from ${parsed.queriesPath}`);

  if (parsed.ab) {
    // A/B mode
    console.log("Running A/B: linear vs boundary serialization...");
    const report = await runAnswerQualityAb({
      snapshotPath: parsed.snapshotPath,
      queries,
      runnerMode: parsed.runnerMode,
      searchMode: parsed.searchMode,
      topK: parsed.topK,
      answerModel: parsed.answerModel,
      judgeModel: parsed.judgeModel,
      querySetSources: [source],
    });

    const filePath = writeAbReport(report, parsed.outputDir);
    printAbSummary(report);
    console.log(`A/B report written to: ${filePath}`);
  } else {
    // Single variant
    console.log(`Running answer-quality eval (serialization=${parsed.serialization})...`);
    const report = await runAnswerQuality({
      snapshotPath: parsed.snapshotPath,
      queries,
      serialization: parsed.serialization,
      runnerMode: parsed.runnerMode,
      searchMode: parsed.searchMode,
      topK: parsed.topK,
      answerModel: parsed.answerModel,
      judgeModel: parsed.judgeModel,
      querySetSources: [source],
    });

    if (report.skipped) {
      console.log(`Skipped: ${report.skip_reason}`);
      process.exit(0);
    }

    const filePath = writeAnswerQualityReport(report, parsed.outputDir);
    console.log(`\nResults: accuracy=${report.overall_accuracy.toFixed(3)} score=${report.overall_mean_score.toFixed(3)} (${report.query_count} queries, ${report.judge_parse_failures} judge parse failures)`);
    console.log(`Report written to: ${filePath}`);
  }
}

main().catch((err) => {
  console.error("Answer-quality eval failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
