import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLocomoArtifacts, type BuildMetadata, type BuildOptions } from "./build.js";
import { loadQueries, runBenchmark, writeReport } from "../../runner.js";
import { ensureSafeGeneratedPath, populateCorpusEmbeddings, type CorpusEmbeddingSummary } from "../shared.js";
import type { SearchMode } from "../../../src/types.js";

interface RunOptions extends BuildOptions {
  reportDir: string;
  reuseExisting: boolean;
}

function parseArgs(argv: string[]): RunOptions {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    args.set(key, next);
    i += 1;
  }

  const granularity = (args.get("granularity") ?? "session") as BuildOptions["granularity"];
  const searchMode = (args.get("search-mode") ?? "lexical") as SearchMode;
  const includeAdversarial = flags.has("include-adversarial");
  const suffix = granularity === "session" ? "locomo" : `locomo-${granularity}`;
  const outputBase = searchMode === "lexical"
    ? `benchmark/generated/${suffix}`
    : `benchmark/generated/${suffix}-${searchMode}`;
  const inputPath = args.get("input") ?? "benchmark/data/raw/locomo/locomo10.json";

  return {
    granularity,
    searchMode,
    includeAdversarial,
    inputPath: resolve(inputPath),
    dbPath: resolve(args.get("db") ?? `${outputBase}.db`),
    queryPath: resolve(args.get("queries") ?? `${outputBase}.jsonl`),
    provenancePath: resolve(args.get("provenance") ?? `${outputBase}.provenance.json`),
    reportDir: resolve(args.get("report-dir") ?? "benchmark/reports"),
    limit: args.has("limit") ? Number(args.get("limit")) : undefined,
    reuseExisting: (args.get("reuse-existing") ?? "true") !== "false",
  };
}

function readBuildMetadata(path: string): BuildMetadata | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BuildMetadata;
  } catch {
    return null;
  }
}

function canReuseExistingArtifacts(options: RunOptions, metadata: BuildMetadata | null): boolean {
  if (!options.reuseExisting) return false;
  if (!metadata) return false;
  return metadata.adapter === "locomo"
    && metadata.granularity === options.granularity
    && metadata.search_mode === options.searchMode
    && metadata.include_adversarial === (options.includeAdversarial ?? false)
    && metadata.input_path === options.inputPath
    && metadata.db_path === options.dbPath
    && metadata.query_path === options.queryPath
    && metadata.limit === options.limit
    && existsSync(options.dbPath)
    && existsSync(options.queryPath);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureSafeGeneratedPath(options.dbPath, "Benchmark DB");
  ensureSafeGeneratedPath(options.queryPath, "Benchmark query file");
  ensureSafeGeneratedPath(options.provenancePath, "Benchmark provenance file");

  if (options.searchMode === "lexical") {
    process.env.MUNIN_EMBEDDINGS_ENABLED = "false";
  } else {
    process.env.MUNIN_EMBEDDINGS_ENABLED = "true";
  }

  const existingMetadata = readBuildMetadata(options.provenancePath);
  const reusedExisting = canReuseExistingArtifacts(options, existingMetadata);
  const buildResult = reusedExisting
    ? {
      entries: [],
      queries: [],
      stats: existingMetadata!.stats,
    }
    : buildLocomoArtifacts(options);
  let embeddingSummary: CorpusEmbeddingSummary | null = null;
  if (options.searchMode === "hybrid" || options.searchMode === "semantic") {
    embeddingSummary = await populateCorpusEmbeddings(options.dbPath);
  }
  const queries = loadQueries(options.queryPath);
  const report = await runBenchmark(options.dbPath, queries);
  const reportPath = writeReport(report, options.reportDir);

  console.log("LoCoMo benchmark completed");
  console.log(`  Gran:       ${options.granularity}`);
  console.log(`  Mode:       ${options.searchMode}`);
  console.log(`  Adversarial:${options.includeAdversarial ? " included" : " skipped"}`);
  console.log(`  Input:      ${options.inputPath}`);
  if (reusedExisting) {
    console.log("  Build:      reused existing generated benchmark artifacts");
  } else {
    console.log("  Build:      rebuilt generated benchmark artifacts");
  }
  console.log(`  Samples:    ${buildResult.stats.sample_count}`);
  console.log(`  Entries:    ${buildResult.stats.entry_count}`);
  console.log(`  Queries:    ${buildResult.stats.query_count}`);
  console.log(`  DB:         ${options.dbPath}`);
  console.log(`  Query file: ${options.queryPath}`);
  console.log(`  Report:     ${reportPath}`);
  if (embeddingSummary) {
    console.log(`  Embeddings: ${embeddingSummary.generated} new, ${embeddingSummary.skipped} reused, ${embeddingSummary.total} total`);
    if (embeddingSummary.failed > 0) {
      console.log(`  Emb Fail:   ${embeddingSummary.failed}`);
    }
  }
  console.log(`  R@1:        ${report.overall.recallAt1.toFixed(4)}`);
  console.log(`  R@5:        ${report.overall.recallAt5.toFixed(4)}`);
  console.log(`  R@10:       ${report.overall.recallAt10.toFixed(4)}`);
  console.log(`  NDCG@5:     ${report.overall.ndcgAt5.toFixed(4)}`);
  console.log(`  MRR:        ${report.overall.mrr.toFixed(4)}`);
  if (report.warnings && report.warnings.length > 0) {
    for (const warning of report.warnings) {
      console.log(`  Warning:    ${warning}`);
    }
  }
}

await main();
