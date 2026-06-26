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
import { ensureSafeGeneratedPath } from "../adapters/shared.js";
import { shouldSkipForMissingKey, runAnswerQuality, writeAnswerQualityReport } from "./runner.js";
import { runAnswerQualityAb, writeAbReport, printAbSummary } from "./ab.js";
import type { SerializationMode } from "./types.js";
import type { RunnerMode } from "../types.js";
import type { SearchMode } from "../../src/types.js";

export function parseArgs(argv: string[]): {
  queriesPath: string | null;
  snapshotPath: string | null;
  serialization: SerializationMode;
  runnerMode: RunnerMode;
  searchMode: SearchMode;
  /** Raw --top-k string as given on the CLI, or null when absent. Validated by validateParsedArgs. */
  topKRaw: string | null;
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

  // Preserve raw --top-k string so validateParsedArgs can apply strict validation.
  // When --top-k is present but its value was consumed as the next arg, args.get("top-k")
  // holds the string. When --top-k appears as a bare flag (no following value), it lands in
  // flags — treat that as an empty string (invalid, caught by validateParsedArgs).
  let topKRaw: string | null = null;
  if (args.has("top-k")) {
    topKRaw = args.get("top-k")!;
  } else if (flags.has("top-k")) {
    topKRaw = "";  // --top-k present but no value — invalid
  }
  // topKRaw === null means --top-k was absent entirely → default 10 applied after validation

  return {
    queriesPath: args.get("queries") ? resolve(args.get("queries")!) : null,
    snapshotPath: args.get("snapshot") ? resolve(args.get("snapshot")!) : null,
    serialization: (args.get("serialization") ?? "linear") as SerializationMode,
    runnerMode: (args.get("runner-mode") ?? "production_ranker") as RunnerMode,
    searchMode: (args.get("search-mode") ?? "hybrid") as SearchMode,
    topKRaw,
    answerModel: args.get("answer-model") ?? defaultAnswerModel,
    judgeModel: args.get("judge-model") ?? defaultJudgeModel,
    outputDir: resolve(
      args.get("output-dir") ?? "benchmark/reports/answer-quality",
    ),
    ab: flags.has("ab"),
  };
}

// --- Argument validation ---

export interface ParsedArgsSubset {
  serialization: SerializationMode;
  runnerMode: RunnerMode;
  searchMode: SearchMode;
  /**
   * Raw --top-k string from the CLI, or null when the flag was absent.
   * null → validated as "absent, default to 10".
   * "" or non-positive-integer string → validation error.
   */
  topKRaw: string | null;
}

/**
 * Validate the parsed CLI arguments for enum membership and numeric bounds.
 * Returns { ok: true; topK: number } on success (topK is the coerced value),
 * or { ok: false; error: string } on failure.
 * Exported for unit testing.
 */
export function validateParsedArgs(
  parsed: ParsedArgsSubset,
): { ok: true; topK: number } | { ok: false; error: string } {
  const validSerializations: SerializationMode[] = ["linear", "boundary"];
  if (!validSerializations.includes(parsed.serialization)) {
    return {
      ok: false,
      error: `Invalid --serialization value "${String(parsed.serialization)}". Must be one of: ${validSerializations.join(", ")}.`,
    };
  }
  const validRunnerModes: RunnerMode[] = ["raw", "production_ranker"];
  if (!validRunnerModes.includes(parsed.runnerMode)) {
    return {
      ok: false,
      error: `Invalid --runner-mode value "${String(parsed.runnerMode)}". Must be one of: ${validRunnerModes.join(", ")}.`,
    };
  }
  const validSearchModes: SearchMode[] = ["lexical", "semantic", "hybrid"];
  if (!validSearchModes.includes(parsed.searchMode)) {
    return {
      ok: false,
      error: `Invalid --search-mode value "${String(parsed.searchMode)}". Must be one of: ${validSearchModes.join(", ")}.`,
    };
  }
  // topKRaw validation: null = absent (default 10); any other value must be a strict
  // positive integer string (/^[1-9]\d*$/) that is a safe integer.
  let topK: number;
  if (parsed.topKRaw === null) {
    topK = 10;
  } else {
    const raw = parsed.topKRaw;
    if (!/^[1-9]\d*$/.test(raw)) {
      return {
        ok: false,
        error: `Invalid --top-k value "${raw}". Must be a finite positive integer (e.g. 10).`,
      };
    }
    const parsed_n = Number(raw);
    if (!Number.isSafeInteger(parsed_n)) {
      return {
        ok: false,
        error: `Invalid --top-k value "${raw}". Must be a finite positive integer (e.g. 10).`,
      };
    }
    topK = parsed_n;
  }
  return { ok: true, topK };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.queriesPath || !parsed.snapshotPath) {
    console.error("Usage: tsx benchmark/answer-quality/run.ts --queries <path> --snapshot <path> [options]");
    process.exit(1);
  }

  const validation = validateParsedArgs(parsed);
  if (!validation.ok) {
    console.error(`Argument error: ${validation.error}`);
    process.exit(1);
  }
  // topK is coerced from topKRaw only after validation passes
  const topK = validation.topK;

  // Check for missing API key — clean exit (not an error)
  const skipReason = shouldSkipForMissingKey(null, undefined);
  if (skipReason) {
    console.log(`Skipping answer-quality eval: ${skipReason}`);
    process.exit(0);
  }

  // Guard: snapshot must live under benchmark/generated/ to prevent accidental
  // writes against the live Munin DB (hybrid/semantic runs embed in-place).
  ensureSafeGeneratedPath(parsed.snapshotPath, "Answer-quality snapshot");

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
      topK,
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
      topK,
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

// Guard: only invoke main() when this file is run directly (not imported as a module).
// This allows test files to import exported helpers (e.g. validateParsedArgs)
// without triggering the CLI entry point.
const isEntryPoint =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/run.ts") ||
    process.argv[1].endsWith("/run.js") ||
    process.argv[1].includes("answer-quality/run"));
if (isEntryPoint) {
  main().catch((err) => {
    console.error("Answer-quality eval failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
