/**
 * Retrieval CI regression gate.
 *
 * Turns the benchmark harness from "runnable" into "automatically catches a
 * bad ranking change". It runs in two modes over the same synthetic corpus:
 *
 *   - `lexical` (default) — builds `ci-gate/corpus.json` into an ephemeral
 *     SQLite DB and runs the benchmark in `raw` + `lexical` mode. bm25 over a
 *     fixed corpus with no embeddings, no network, and no recency/time
 *     dependence is deterministic across machines.
 *   - `hybrid` (`--hybrid`) — additionally loads committed FROZEN embedding
 *     vectors (`ci-gate/embeddings.json`) for both the corpus and the query
 *     set, so the production hybrid path (FTS5 + vector KNN fused by RRF) runs
 *     WITHOUT loading the embedding model. Freezing both vector sets keeps the
 *     run hermetic and deterministic — CI never downloads a model — while
 *     still exercising the vector + fusion code that the lexical gate cannot
 *     reach. This guards the raw FTS5 + vector + RRF layer that underlies
 *     `memory_query`'s default hybrid mode (the production reranker on top is
 *     covered separately by tests/runner-parity.test.ts).
 *
 * Each mode compares aggregate scores against its committed baseline
 * (`ci-gate/baseline.json` / `ci-gate/baseline-hybrid.json`) and fails if any
 * gated metric regresses.
 *
 * Scope: both gates cover the retrieval-recall + ranking layer (the `raw`
 * path). The production reranker is intentionally NOT gated here because its
 * freshness/attention inputs are time-relative and would rot a committed
 * baseline; raw-vs-production parity is guarded separately by
 * tests/runner-parity.test.ts. The hybrid gate freezes the embedding *vectors*
 * (not the model), so it guards the KNN + RRF fusion logic, not the embedding
 * model itself — a deliberate model swap is an intentional re-bless.
 *
 * The hybrid gate requires sqlite-vec. Consistent with the codebase's
 * soft-vec stance (initDatabase treats vec as optional), it SKIPS with a loud
 * warning and exit 0 when vec is unavailable rather than failing the build.
 *
 * CLI:
 *   npm run benchmark:ci-gate                         # lexical gate
 *   npm run benchmark:ci-gate -- --hybrid             # hybrid gate
 *   npm run benchmark:ci-gate -- --update-baseline    # re-bless lexical baseline
 *   npm run benchmark:ci-gate -- --hybrid --update-baseline  # re-bless hybrid baseline
 *   npm run benchmark:ci-gate -- --tolerance 0.01     # override FP tolerance
 */

import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, storeEmbedding, vecLoaded } from "../src/db.js";
import { embeddingToBuffer } from "../src/embeddings.js";
import { runBenchmark, loadQueriesWithSource } from "./runner.js";
import type { BenchmarkReport } from "./types.js";
import {
  compareToBaseline,
  formatVerdict,
  validateBaseline,
  DEFAULT_GATE_TOLERANCE,
  HYBRID_GATED_METRICS,
  type GatedScores,
  type GateBaseline,
  type GateVerdict,
} from "./ci-gate-policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Which retrieval layer the gate exercises. */
export type GateMode = "lexical" | "hybrid";

/** The dimensionality of every frozen embedding vector (MiniLM-L6). */
export const EMBEDDING_DIM = 384;

export interface CiGatePaths {
  corpusPath: string;
  queriesPath: string;
  baselinePath: string;
  /** Frozen embeddings fixture — hybrid mode only. */
  embeddingsPath: string;
}

export const DEFAULT_PATHS: CiGatePaths = {
  corpusPath: join(HERE, "ci-gate", "corpus.json"),
  queriesPath: join(HERE, "ci-gate", "queries.jsonl"),
  baselinePath: join(HERE, "ci-gate", "baseline.json"),
  embeddingsPath: join(HERE, "ci-gate", "embeddings.json"),
};

export const DEFAULT_HYBRID_PATHS: CiGatePaths = {
  corpusPath: join(HERE, "ci-gate", "corpus.json"),
  queriesPath: join(HERE, "ci-gate", "queries-hybrid.jsonl"),
  baselinePath: join(HERE, "ci-gate", "baseline-hybrid.json"),
  embeddingsPath: join(HERE, "ci-gate", "embeddings.json"),
};

export function defaultPathsForMode(mode: GateMode): CiGatePaths {
  return mode === "hybrid" ? DEFAULT_HYBRID_PATHS : DEFAULT_PATHS;
}

interface CorpusEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  created_at: string;
}

/**
 * Frozen-embeddings fixture shape. Vectors are stored as plain `number[]` of
 * length EMBEDDING_DIM; float32 round-trips losslessly through JSON, so
 * `Float32Array.from(arr)` reproduces the original bytes the model emitted.
 */
interface FrozenEmbeddings {
  model: string;
  dim: number;
  generated_at: string;
  /** entry_id → 384-dim vector */
  corpus: Record<string, number[]>;
  /** query_id → 384-dim vector */
  queries: Record<string, number[]>;
}

/** Convert a frozen `number[]` vector to the Buffer the vec table expects. */
function frozenVectorToBuffer(vec: number[], label: string): Buffer {
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `Frozen embedding for ${label} must be a ${EMBEDDING_DIM}-dim array (got ${Array.isArray(vec) ? vec.length : typeof vec}).`,
    );
  }
  return embeddingToBuffer(Float32Array.from(vec));
}

/** Load and structurally validate the frozen-embeddings fixture. */
function loadFrozenEmbeddings(path: string): { fixture: FrozenEmbeddings; sha256: string } {
  const bytes = readFileSync(path);
  const sha256 = sha256Hex(bytes);
  const parsed = JSON.parse(bytes.toString("utf-8")) as FrozenEmbeddings;
  // `typeof null === "object"` and arrays are objects too — reject both so a
  // null/array corpus surfaces the actionable message here rather than a later
  // opaque TypeError in the entry loop.
  const isPlainObject = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.corpus) || !isPlainObject(parsed.queries)) {
    throw new Error(
      `Malformed embeddings fixture at ${path}: corpus and queries must each be an object mapping id -> vector.`,
    );
  }
  return { fixture: parsed, sha256 };
}

export interface CiGateResult {
  mode: GateMode;
  current: GatedScores;
  lineage: {
    corpus_sha256: string;
    /** Present only for the hybrid gate. */
    embeddings_sha256?: string;
    query_set_checksum: string;
    query_count: number;
  };
  baseline: GateBaseline | null;
  /** null when no baseline file exists yet (first run / pre-bless). */
  verdict: GateVerdict | null;
  report: BenchmarkReport;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Probe whether sqlite-vec is available on this platform. initDatabase loads
 * vec as a soft dependency and records the result in the module-level
 * `vecLoaded()` flag. The hybrid gate skips (rather than fails) when this is
 * false, matching how tests/embeddings.test.ts guards vec-dependent suites.
 */
export function isVecAvailable(): boolean {
  const tmpDir = mkdtempSync(join(tmpdir(), "munin-vec-probe-"));
  const dbPath = join(tmpDir, "probe.db");
  try {
    // Deliberately do NOT catch: a genuine init failure (migration/DB bug) must
    // surface loudly, not be silently swallowed as "vec unavailable" — that
    // would mask an unrelated regression behind the skip-green path. Only a
    // clean init where the vec extension didn't load returns false.
    const db = initDatabase(dbPath);
    db.close();
    return vecLoaded();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Build the synthetic fixture DB from the committed corpus. Mirrors the
 * direct-insert pattern used by the dataset adapters (the AFTER INSERT trigger
 * on `entries` populates the FTS index automatically).
 *
 * When `frozenCorpus` is provided (hybrid mode), each entry's committed vector
 * is stored into `entries_vec` via the same `storeEmbedding` path production
 * uses, so the KNN the gate exercises is byte-identical to production storage.
 */
function buildFixtureDb(
  corpus: CorpusEntry[],
  dbPath: string,
  frozenCorpus?: { vectors: Record<string, number[]>; model: string },
): void {
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

    if (frozenCorpus) {
      // Fail loud on any missing/malformed corpus vector — a silent gap would
      // drop that entry out of the KNN and produce a falsely-blessed baseline.
      for (const e of corpus) {
        const vec = frozenCorpus.vectors[e.id];
        if (vec === undefined) {
          throw new Error(`Frozen embeddings fixture is missing corpus entry "${e.id}".`);
        }
        storeEmbedding(db, e.id, frozenVectorToBuffer(vec, `corpus:${e.id}`), frozenCorpus.model);
      }
    }

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
 *
 * Note: `mode: "hybrid"` assumes sqlite-vec is loaded (it builds the vec table
 * and runs KNN); it throws inside the runner if vec is unavailable. The skip-on-
 * missing-vec behavior lives in the CLI `main()`, so programmatic callers must
 * gate on `isVecAvailable()` themselves (as `main()` and the tests do).
 */
export async function runCiGate(
  opts: { mode?: GateMode; paths?: Partial<CiGatePaths>; tolerance?: number } = {},
): Promise<CiGateResult> {
  const mode: GateMode = opts.mode ?? "lexical";
  const paths = { ...defaultPathsForMode(mode), ...opts.paths };

  const corpusBytes = readFileSync(paths.corpusPath);
  const corpus = JSON.parse(corpusBytes.toString("utf-8")) as CorpusEntry[];
  const corpusSha = sha256Hex(corpusBytes);

  const { queries, source } = loadQueriesWithSource(paths.queriesPath);

  // Hybrid mode: load the frozen vectors and wire a query-embedding provider
  // so the run never touches the live model. Every query MUST resolve to a
  // committed vector — a miss would silently degrade that query to lexical and
  // bless a baseline that doesn't actually exercise the vector path.
  let frozenCorpus: { vectors: Record<string, number[]>; model: string } | undefined;
  let queryEmbeddingProvider: ((queryText: string) => Float32Array | null) | undefined;
  let embeddingsSha: string | undefined;
  if (mode === "hybrid") {
    const { fixture, sha256 } = loadFrozenEmbeddings(paths.embeddingsPath);
    embeddingsSha = sha256;
    frozenCorpus = { vectors: fixture.corpus, model: fixture.model };

    const textToVector = new Map<string, Float32Array>();
    for (const q of queries) {
      const vec = fixture.queries[q.id];
      if (vec === undefined) {
        throw new Error(`Frozen embeddings fixture is missing query "${q.id}".`);
      }
      // frozenVectorToBuffer throws on wrong dimensionality — call it for that
      // validation side-effect, then map the query TEXT (what executeQuery
      // receives) to its frozen vector. Identical texts share a vector
      // (last-writer-wins), which is correct.
      frozenVectorToBuffer(vec, `query:${q.id}`);
      textToVector.set(q.query, Float32Array.from(vec));
    }
    queryEmbeddingProvider = (text: string): Float32Array | null => textToVector.get(text) ?? null;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "munin-ci-gate-"));
  const dbPath = join(tmpDir, "fixture.db");
  let report: BenchmarkReport;
  try {
    buildFixtureDb(corpus, dbPath, frozenCorpus);
    report = await runBenchmark(dbPath, queries, {
      runnerMode: "raw",
      querySetSources: [source],
      manifestPath: null,
      queryEmbeddingProvider,
      // Pass the frozen fixture's model so the mixed-space guard matches the
      // committed corpus vectors. In lexical mode frozenCorpus is undefined and
      // the field is absent — no model filter applied (correct, no vectors).
      ...(frozenCorpus ? { queryEmbeddingModel: frozenCorpus.model } : {}),
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
    ...(embeddingsSha ? { embeddings_sha256: embeddingsSha } : {}),
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
    ? compareToBaseline(current, baseline, {
        tolerance: opts.tolerance,
        // Hybrid enforces only the membership-recall metrics (R@5/R@10); the
        // rank-order metrics are reported but not gated, because the baseline is
        // blessed off the CI platform. See HYBRID_GATED_METRICS.
        enforcedMetrics: mode === "hybrid" ? HYBRID_GATED_METRICS : undefined,
        lineage,
      })
    : null;

  return { mode, current, lineage, baseline, verdict, report };
}

/**
 * Build a fresh baseline file from a gate result. Used by --update-baseline.
 * Carries `embeddings_sha256` only for the hybrid gate (it is absent from the
 * lexical lineage), so re-blessing a lexical baseline never adds the field.
 */
export function makeBaseline(result: CiGateResult, generatedAt: string): GateBaseline {
  return {
    baseline_schema_version: 1,
    generated_at: generatedAt,
    corpus_sha256: result.lineage.corpus_sha256,
    ...(result.lineage.embeddings_sha256
      ? { embeddings_sha256: result.lineage.embeddings_sha256 }
      : {}),
    query_set_checksum: result.lineage.query_set_checksum,
    query_count: result.lineage.query_count,
    overall: result.current,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const mode: GateMode = args.includes("--hybrid") ? "hybrid" : "lexical";
  // On a runner that MUST support vectors (CI), treat a vec-unavailable skip as a
  // hard failure instead — otherwise the gate (and every skipIf'd vector test)
  // could silently no-op if sqlite-vec stopped loading, masking a regression.
  const requireVec = args.includes("--require-vec");
  const tolIdx = args.indexOf("--tolerance");
  const tolerance = tolIdx >= 0 ? Number(args[tolIdx + 1]) : undefined;
  if (tolIdx >= 0 && !Number.isFinite(tolerance)) {
    console.error(`Invalid --tolerance value: ${args[tolIdx + 1]}`);
    process.exit(2);
  }

  const baselinePath = defaultPathsForMode(mode).baselinePath;
  const blessCmd = `npm run benchmark:ci-gate${mode === "hybrid" ? " -- --hybrid --update-baseline" : " -- --update-baseline"}`;

  // Hybrid mode needs sqlite-vec. Consistent with the codebase's soft-vec
  // stance, SKIP (exit 0) rather than failing the build when it is missing —
  // unless --require-vec says this runner must have it (CI), in which case a
  // missing extension is an environment regression and we fail loud.
  if (mode === "hybrid" && !isVecAvailable()) {
    if (requireVec) {
      console.error("Retrieval CI gate — hybrid: sqlite-vec is REQUIRED here (--require-vec) but did not load.");
      console.error("  This runner is configured to enforce the vector path, so a missing/broken");
      console.error("  sqlite-vec is an environment regression — failing rather than silently skipping.");
      process.exit(1);
    }
    console.log("Retrieval CI gate — hybrid (FTS5 + vector RRF)");
    console.log("");
    console.log("  SKIPPED — sqlite-vec is unavailable on this platform, so the");
    console.log("  vector path cannot run. The lexical gate still enforces ranking;");
    console.log("  the hybrid gate is enforced wherever sqlite-vec loads.");
    return;
  }

  const result = await runCiGate({ mode, tolerance });

  if (result.report.warnings && result.report.warnings.length > 0) {
    for (const w of result.report.warnings) console.error(`  runner warning: ${w}`);
  }

  if (updateBaseline) {
    const baseline = makeBaseline(result, new Date().toISOString());
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`${mode} baseline re-blessed → ${baselinePath}`);
    console.log(
      `  R@1=${pct(baseline.overall.recallAt1)} R@5=${pct(baseline.overall.recallAt5)} R@10=${pct(baseline.overall.recallAt10)} nDCG@5=${pct(baseline.overall.ndcgAt5)} MRR=${pct(baseline.overall.mrr)} over ${baseline.query_count} queries`,
    );
    return;
  }

  if (!result.verdict) {
    console.error(`No baseline at ${baselinePath}. Generate one with: ${blessCmd}`);
    process.exit(2);
  }

  console.log(formatVerdict(result.verdict, mode));
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
