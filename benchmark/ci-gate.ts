/**
 * Retrieval CI regression gate.
 *
 * Turns the benchmark harness from "runnable" into "automatically catches a
 * bad ranking change". On every CI run it:
 *
 *   1. Builds a small, fully synthetic corpus into an ephemeral SQLite DB
 *      (nothing binary is committed — the corpus is `ci-gate/corpus.json`).
 *   2. Runs the benchmark in `raw` + `lexical` mode. bm25 over a fixed corpus
 *      with no embeddings, no network, and no recency/time dependence is
 *      deterministic across machines, so the numbers are stable run-to-run.
 *   3. Compares the aggregate scores against the committed baseline
 *      (`ci-gate/baseline.json`) and fails if any gated metric regresses.
 *
 * Scope: this gate covers the retrieval-recall + lexical-ranking layer (the
 * `raw` path). The production reranker is intentionally NOT gated here because
 * its freshness/attention inputs are time-relative and would rot a committed
 * baseline; raw-vs-production parity is guarded separately by
 * tests/runner-parity.test.ts.
 *
 * CLI:
 *   npm run benchmark:ci-gate                  # run the gate, exit 1 on regression
 *   npm run benchmark:ci-gate -- --update-baseline   # re-bless the baseline
 *   npm run benchmark:ci-gate -- --tolerance 0.01     # override FP tolerance
 */

import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db.js";
import { runBenchmark, loadQueriesWithSource } from "./runner.js";
import type { BenchmarkReport } from "./types.js";
import {
  compareToBaseline,
  formatVerdict,
  validateBaseline,
  DEFAULT_GATE_TOLERANCE,
  type GatedScores,
  type GateBaseline,
  type GateVerdict,
} from "./ci-gate-policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CiGatePaths {
  corpusPath: string;
  queriesPath: string;
  baselinePath: string;
}

export const DEFAULT_PATHS: CiGatePaths = {
  corpusPath: join(HERE, "ci-gate", "corpus.json"),
  queriesPath: join(HERE, "ci-gate", "queries.jsonl"),
  baselinePath: join(HERE, "ci-gate", "baseline.json"),
};

interface CorpusEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  created_at: string;
}

export interface CiGateResult {
  current: GatedScores;
  lineage: { corpus_sha256: string; query_set_checksum: string; query_count: number };
  baseline: GateBaseline | null;
  /** null when no baseline file exists yet (first run / pre-bless). */
  verdict: GateVerdict | null;
  report: BenchmarkReport;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the synthetic fixture DB from the committed corpus. Mirrors the
 * direct-insert pattern used by the dataset adapters (the AFTER INSERT trigger
 * on `entries` populates the FTS index automatically).
 */
function buildFixtureDb(corpus: CorpusEntry[], dbPath: string): void {
  const db: Database.Database = initDatabase(dbPath);
  try {
    const insert = db.prepare(`
      INSERT INTO entries (
        id, namespace, key, entry_type, content, tags,
        agent_id, owner_principal_id, created_at, updated_at,
        valid_until, classification, embedding_status, embedding_model
      ) VALUES (?, ?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((rows: CorpusEntry[]) => {
      for (const e of rows) {
        insert.run(
          e.id,
          e.namespace,
          e.key,
          e.content,
          JSON.stringify(e.tags),
          "ci-gate",
          "ci-gate",
          e.created_at,
          e.created_at,
          null,
          "public",
          "pending",
          null,
        );
      }
    });
    tx(corpus);
    // Checkpoint so the read-only connection opened by runBenchmark sees all
    // rows even if the WAL hasn't been auto-checkpointed yet.
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * Run the gate end to end and return a structured result. Does NOT call
 * process.exit — the CLI wrapper owns the exit code so tests can import this.
 */
export async function runCiGate(
  opts: { paths?: Partial<CiGatePaths>; tolerance?: number } = {},
): Promise<CiGateResult> {
  const paths = { ...DEFAULT_PATHS, ...opts.paths };

  const corpusBytes = readFileSync(paths.corpusPath);
  const corpus = JSON.parse(corpusBytes.toString("utf-8")) as CorpusEntry[];
  const corpusSha = sha256Hex(corpusBytes);

  const { queries, source } = loadQueriesWithSource(paths.queriesPath);

  const tmpDir = mkdtempSync(join(tmpdir(), "munin-ci-gate-"));
  const dbPath = join(tmpDir, "fixture.db");
  let report: BenchmarkReport;
  try {
    buildFixtureDb(corpus, dbPath);
    report = await runBenchmark(dbPath, queries, {
      runnerMode: "raw",
      querySetSources: [source],
      manifestPath: null,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const current: GatedScores = {
    recallAt1: report.overall.recallAt1,
    recallAt5: report.overall.recallAt5,
    recallAt10: report.overall.recallAt10,
    ndcgAt5: report.overall.ndcgAt5,
    mrr: report.overall.mrr,
  };
  const lineage = {
    corpus_sha256: corpusSha,
    query_set_checksum: report.query_set_checksum,
    query_count: report.query_count,
  };

  // Distinguish "no baseline yet" (file missing → null, pre-bless) from a
  // malformed/outdated baseline (hard failure). A corrupt baseline must never
  // be silently treated as absent, and never trusted — a missing/non-finite
  // metric would make `current - baseline` NaN and mask a real regression.
  let baseline: GateBaseline | null = null;
  let raw: string | null = null;
  try {
    raw = readFileSync(paths.baselinePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      raw = null;
    } else {
      throw new Error(`Could not read baseline at ${paths.baselinePath}: ${(err as Error).message}`);
    }
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`baseline.json is not valid JSON (${paths.baselinePath}): ${(err as Error).message}`);
    }
    baseline = validateBaseline(parsed);
  }

  const verdict = baseline
    ? compareToBaseline(current, baseline, { tolerance: opts.tolerance, lineage })
    : null;

  return { current, lineage, baseline, verdict, report };
}

/**
 * Build a fresh baseline file from a gate result. Used by --update-baseline.
 */
export function makeBaseline(result: CiGateResult, generatedAt: string): GateBaseline {
  return {
    baseline_schema_version: 1,
    generated_at: generatedAt,
    corpus_sha256: result.lineage.corpus_sha256,
    query_set_checksum: result.lineage.query_set_checksum,
    query_count: result.lineage.query_count,
    overall: result.current,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const tolIdx = args.indexOf("--tolerance");
  const tolerance = tolIdx >= 0 ? Number(args[tolIdx + 1]) : undefined;
  if (tolIdx >= 0 && !Number.isFinite(tolerance)) {
    console.error(`Invalid --tolerance value: ${args[tolIdx + 1]}`);
    process.exit(2);
  }

  const result = await runCiGate({ tolerance });

  if (result.report.warnings && result.report.warnings.length > 0) {
    for (const w of result.report.warnings) console.error(`  runner warning: ${w}`);
  }

  if (updateBaseline) {
    const baseline = makeBaseline(result, new Date().toISOString());
    writeFileSync(DEFAULT_PATHS.baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`Baseline re-blessed → ${DEFAULT_PATHS.baselinePath}`);
    console.log(
      `  R@1=${pct(baseline.overall.recallAt1)} R@5=${pct(baseline.overall.recallAt5)} R@10=${pct(baseline.overall.recallAt10)} nDCG@5=${pct(baseline.overall.ndcgAt5)} MRR=${pct(baseline.overall.mrr)} over ${baseline.query_count} queries`,
    );
    return;
  }

  if (!result.verdict) {
    console.error(
      `No baseline at ${DEFAULT_PATHS.baselinePath}. Generate one with: npm run benchmark:ci-gate -- --update-baseline`,
    );
    process.exit(2);
  }

  console.log(formatVerdict(result.verdict));
  if (!result.verdict.pass) {
    process.exit(1);
  }
}

function pct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

// Run only when invoked directly (tsx benchmark/ci-gate.ts), not when imported
// by the test suite. The DEFAULT_GATE_TOLERANCE import keeps the policy module's
// default discoverable from here for callers that pass no override.
void DEFAULT_GATE_TOLERANCE;
const invokedPath = process.argv[1] ?? "";
if (/ci-gate\.(ts|js|mjs)$/.test(invokedPath)) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
