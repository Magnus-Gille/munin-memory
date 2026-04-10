import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLongMemEvalArtifacts, type BuildMetadata, type BuildOptions } from "./build.js";
import { loadQueries, runBenchmark, writeReport } from "../../runner.js";
import { initDatabase, storeEmbedding } from "../../../src/db.js";
import { embeddingToBuffer, generateEmbedding, initEmbeddings } from "../../../src/embeddings.js";
import type { SearchMode } from "../../../src/types.js";

interface RunOptions extends BuildOptions {
  reportDir: string;
  reuseExisting: boolean;
}

function parseArgs(argv: string[]): RunOptions {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, value);
    i += 1;
  }

  const split = args.get("split") ?? "s";
  const granularity = (args.get("granularity") ?? "session") as BuildOptions["granularity"];
  const searchMode = (args.get("search-mode") ?? "lexical") as SearchMode;
  const queryBase = granularity === "session"
    ? `benchmark/generated/longmemeval-${split}`
    : `benchmark/generated/longmemeval-${split}-${granularity}`;
  const outputBase = searchMode === "lexical" ? queryBase : `${queryBase}-${searchMode}`;
  const inputPath = args.get("input")
    ?? (split === "m"
      ? "benchmark/data/raw/longmemeval/longmemeval_m_cleaned.json"
      : "benchmark/data/raw/longmemeval/longmemeval_s_cleaned.json");

  return {
    split,
    granularity,
    searchMode,
    inputPath: resolve(inputPath),
    dbPath: resolve(args.get("db") ?? `${outputBase}.db`),
    queryPath: resolve(args.get("queries") ?? `${outputBase}.jsonl`),
    provenancePath: resolve(args.get("provenance") ?? `${outputBase}.provenance.json`),
    reportDir: resolve(args.get("report-dir") ?? "benchmark/reports"),
    limit: args.has("limit") ? Number(args.get("limit")) : undefined,
    reuseExisting: (args.get("reuse-existing") ?? "true") !== "false",
  };
}

function ensureSafeGeneratedPath(path: string, label: string): void {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.includes("/benchmark/generated/")) {
    throw new Error(
      `${label} must live under benchmark/generated/ to avoid accidental writes against live data: ${path}`,
    );
  }
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
  return metadata.adapter === "longmemeval"
    && metadata.split === options.split
    && metadata.granularity === options.granularity
    && metadata.search_mode === options.searchMode
    && metadata.input_path === options.inputPath
    && metadata.db_path === options.dbPath
    && metadata.query_path === options.queryPath
    && metadata.limit === options.limit
    && existsSync(options.dbPath)
    && existsSync(options.queryPath);
}

async function populateCorpusEmbeddings(dbPath: string): Promise<{ total: number; generated: number; failed: number; skipped: number }> {
  const db: Database.Database = initDatabase(dbPath);
  try {
    const ready = await initEmbeddings();
    if (!ready) {
      throw new Error("Embedding system could not be initialized for hybrid/semantic benchmark run.");
    }

    // Recover rows left mid-flight by a previous interrupted run.
    db.prepare("UPDATE entries SET embedding_status = 'pending' WHERE embedding_status = 'processing'").run();

    const rows = db
      .prepare("SELECT id, content FROM entries WHERE embedding_status != 'generated' ORDER BY created_at ASC")
      .all() as Array<{ id: string; content: string }>;
    const totalRows = db.prepare("SELECT COUNT(*) as cnt FROM entries").get() as { cnt: number };

    let generated = 0;
    let failed = 0;
    let skipped = totalRows.cnt - rows.length;
    const startedAt = Date.now();

    if (skipped > 0) {
      console.log(`Reusing ${skipped} existing embeddings from prior benchmark work.`);
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const embedding = await generateEmbedding(row.content);
      if (!embedding) {
        db.prepare("UPDATE entries SET embedding_status = 'failed' WHERE id = ?").run(row.id);
        failed += 1;
        continue;
      }
      storeEmbedding(db, row.id, embeddingToBuffer(embedding), process.env.MUNIN_EMBEDDINGS_MODEL ?? "Xenova/all-MiniLM-L6-v2");
      generated += 1;

      const processed = index + 1;
      if (processed % 250 === 0 || processed === rows.length) {
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 1);
        const rate = processed / elapsedSeconds;
        console.log(
          `Embedding progress: ${processed}/${rows.length} pending rows processed (${generated} generated, ${failed} failed, ${rate.toFixed(1)} rows/s)`,
        );
      }
    }

    return { total: totalRows.cnt, generated, failed, skipped };
  } finally {
    db.close();
  }
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
    : buildLongMemEvalArtifacts(options);
  let embeddingSummary: { total: number; generated: number; failed: number; skipped: number } | null = null;
  if (options.searchMode === "hybrid" || options.searchMode === "semantic") {
    embeddingSummary = await populateCorpusEmbeddings(options.dbPath);
  }
  const queries = loadQueries(options.queryPath);
  const report = await runBenchmark(options.dbPath, queries);
  const reportPath = writeReport(report, options.reportDir);

  console.log("LongMemEval benchmark completed");
  console.log(`  Split:      ${options.split}`);
  console.log(`  Gran:       ${options.granularity}`);
  console.log(`  Mode:       ${options.searchMode}`);
  console.log(`  Input:      ${options.inputPath}`);
  if (reusedExisting) {
    console.log("  Build:      reused existing generated benchmark artifacts");
  } else {
    console.log("  Build:      rebuilt generated benchmark artifacts");
  }
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
