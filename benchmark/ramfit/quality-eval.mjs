/**
 * RAM-fit QUALITY evaluation for munin-memory.
 *
 * Given an embedding config (model + dtype) via env, this script:
 *   1. Copies the quality fixture (benchmark/fixtures/memory-snapshot-2026-04-07.db)
 *      to a writable temp DB.
 *   2. RE-EMBEDS the entire corpus under the target model+dtype, reusing the
 *      production embedding path (src/embeddings.ts worker + src/db.ts vec writes
 *      from dist/). Re-embedding is mandatory: a query embedded with model X must
 *      be scored against a corpus embedded with model X, or recall is meaningless.
 *   3. Runs the repo IR benchmark (benchmark/runner.ts runBenchmark) over
 *      baseline.jsonl + baseline-claude.jsonl (read-only on the re-embedded copy).
 *   4. Prints ONE JSON line with R@5/R@10/R@20/MRR/nDCG (overall + per search_mode),
 *      plus config + corpus/query lineage.
 *
 * MUST be run with `tsx` (it imports benchmark/runner.ts, a TS file). Run from the
 * repo root so module resolution finds node_modules and dist/.
 *
 *   tsx benchmark/ramfit/quality-eval.mjs
 *
 * Env vars read:
 *   MUNIN_EMBEDDINGS_MODEL   (default: Xenova/all-MiniLM-L6-v2)
 *   MUNIN_EMBEDDINGS_DTYPE   (unset = fp32; q8 | int8 | fp16 | …)
 *   MUNIN_EMBEDDINGS_ENABLED ("false" => lexical-only: skip re-embed, no model)
 *   MUNIN_EMBEDDINGS_BATCH_SIZE (default 25)
 *   TRANSFORMERS_CACHE       (HF cache dir; default ~/munin-ramfit/hf-cache)
 *   QEVAL_TMP_DIR            (where the writable temp DB lives; default ~/munin-ramfit)
 *                            NOTE: src/embeddings.getEmbeddingCacheDir derives the HF
 *                            cache from <dirname(dbPath)>/hf-cache, so the temp DB MUST
 *                            sit in a dir whose hf-cache holds the precached models.
 *                            Default ~/munin-ramfit keeps ~/munin-ramfit/hf-cache.
 */

import { copyFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../');

// ── Config from env ──────────────────────────────────────────────────────────
const model = process.env.MUNIN_EMBEDDINGS_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
const dtype = process.env.MUNIN_EMBEDDINGS_DTYPE ?? '';
const embeddingsEnabled = (process.env.MUNIN_EMBEDDINGS_ENABLED ?? 'true') === 'true';
const batchSize = parseInt(process.env.MUNIN_EMBEDDINGS_BATCH_SIZE ?? '25', 10) || 25;

const hfCache = process.env.TRANSFORMERS_CACHE
  ?? path.join(os.homedir(), 'munin-ramfit', 'hf-cache');

// The temp DB must live in a dir whose `<dir>/hf-cache` holds the precached models,
// because src/embeddings.getEmbeddingCacheDir() resolves the cache from the DB's
// data dir (dirname). Default to ~/munin-ramfit so it picks up ~/munin-ramfit/hf-cache.
const tmpDir = process.env.QEVAL_TMP_DIR ?? path.join(os.homedir(), 'munin-ramfit');

const fixturePath = path.join(repoRoot, 'benchmark/fixtures/memory-snapshot-2026-04-07.db');
const goldsetBaseline = path.join(repoRoot, 'benchmark/queries/baseline.jsonl');
const goldsetClaude = path.join(repoRoot, 'benchmark/queries/baseline-claude.jsonl');

function fail(stage, err) {
  process.stdout.write(JSON.stringify({
    ok: false,
    model,
    dtype: dtype || 'fp32',
    embeddings_enabled: embeddingsEnabled,
    stage,
    error: String(err?.message ?? err).slice(0, 500),
  }) + '\n');
  process.exit(1);
}

if (!existsSync(fixturePath)) fail('preflight', `fixture not found: ${fixturePath}`);
if (!existsSync(goldsetBaseline)) fail('preflight', `goldset not found: ${goldsetBaseline}`);
if (!existsSync(goldsetClaude)) fail('preflight', `goldset not found: ${goldsetClaude}`);

// Ensure tmpDir exists and that its hf-cache is the precached one.
mkdirSync(tmpDir, { recursive: true });
process.env.TRANSFORMERS_CACHE = hfCache;

// Unique writable temp DB next to the precached hf-cache.
const tmpDbPath = path.join(tmpDir, `qeval-${randomUUID()}.db`);
copyFileSync(fixturePath, tmpDbPath);
// Drop any stray WAL/SHM from the source so we open clean.
for (const ext of ['-wal', '-shm']) {
  const p = tmpDbPath + ext;
  if (existsSync(p)) { try { rmSync(p); } catch {} }
}

// Critical: initDatabase() and getEmbeddingCacheDir() both read MUNIN_MEMORY_DB_PATH.
// Point it at the temp copy so the embedding cache resolves to <tmpDir>/hf-cache.
process.env.MUNIN_MEMORY_DB_PATH = tmpDbPath;

let reEmbedded = 0;
let corpusCount = 0;
let pendingAfter = null;

async function cleanup() {
  for (const ext of ['', '-wal', '-shm']) {
    const p = tmpDbPath + ext;
    if (existsSync(p)) { try { rmSync(p); } catch {} }
  }
}

try {
  // ── dist modules (compiled production code) ────────────────────────────────
  const distDb = await import(path.join(repoRoot, 'dist/db.js'));
  const distEmb = await import(path.join(repoRoot, 'dist/embeddings.js'));

  // Point transformers cache before any model load.
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = hfCache;

  // ── Re-embed the corpus (skip entirely in lexical-only mode) ───────────────
  if (embeddingsEnabled) {
    // Open the writable copy as a real munin DB: loads sqlite-vec, runs migrations,
    // ensures entries_vec(float[384]), registers UDFs, sets vecLoaded=true.
    const wdb = distDb.initDatabase(tmpDbPath);

    corpusCount = wdb.prepare('SELECT COUNT(*) AS n FROM entries').get().n;

    // Wipe all stored vectors and reset every entry to 'pending' so the worker
    // re-embeds the WHOLE corpus under the target model+dtype.
    wdb.exec('DELETE FROM entries_vec');
    wdb.prepare("UPDATE entries SET embedding_status = 'pending', embedding_model = NULL").run();

    const pendingBefore = wdb
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE embedding_status IN ('pending','failed')")
      .get().n;

    // Load the model. initEmbeddings() reads MUNIN_EMBEDDINGS_MODEL/DTYPE from env
    // (captured in dist/embeddings config at import) and the HF cache from
    // getEmbeddingCacheDir() == <tmpDir>/hf-cache == precached dir.
    const ready = await distEmb.initEmbeddings();
    if (!ready) {
      try { wdb.close(); } catch {}
      await cleanup();
      fail('init-embeddings', `initEmbeddings() returned false for model=${model} dtype=${dtype || 'fp32'} (model load failed or vec unavailable)`);
    }

    // Drive the worker to completion over the whole corpus.
    distEmb.startEmbeddingWorker(wdb);

    const startWait = Date.now();
    const maxWaitMs = 20 * 60 * 1000; // 20 min ceiling for ~3k entries
    let lastPending = pendingBefore;
    let stalls = 0;
    while (Date.now() - startWait < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 500));
      const now = wdb
        .prepare("SELECT COUNT(*) AS n FROM entries WHERE embedding_status IN ('pending','failed')")
        .get().n;
      if (now === 0) break;
      // Stall detection: if no progress for 60 consecutive polls (~30s), bail.
      if (now === lastPending) {
        stalls += 1;
        if (stalls >= 60) break;
      } else {
        stalls = 0;
        lastPending = now;
      }
    }

    await distEmb.stopEmbeddingWorker();

    pendingAfter = wdb
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE embedding_status IN ('pending','failed')")
      .get().n;
    const generated = wdb
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE embedding_status = 'generated'")
      .get().n;
    const vecRows = wdb.prepare('SELECT COUNT(*) AS n FROM entries_vec').get().n;
    reEmbedded = generated;

    wdb.close();

    if (pendingAfter > 0) {
      await cleanup();
      fail('re-embed', `re-embed incomplete: ${pendingAfter} entries still pending/failed (generated=${generated}, vec_rows=${vecRows})`);
    }
    if (vecRows !== generated) {
      await cleanup();
      fail('re-embed', `vec row count (${vecRows}) != generated (${generated}) — vec write path inconsistent`);
    }
  } else {
    // Lexical-only: still report the corpus size; no re-embed, no model.
    const wdb = distDb.initDatabase(tmpDbPath);
    corpusCount = wdb.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
    wdb.close();
  }

  // ── Run the IR benchmark over the re-embedded copy ─────────────────────────
  const runnerMod = await import(path.join(repoRoot, 'benchmark/runner.ts'));
  const { runBenchmark, loadQueriesWithSource } = runnerMod;

  const { queries: q1, source: s1 } = loadQueriesWithSource(goldsetBaseline);
  const { queries: q2, source: s2 } = loadQueriesWithSource(goldsetClaude);
  let queries = [...q1, ...q2];

  // In lexical-only mode, force every query through the lexical path so we
  // measure the no-embedding floor (semantic/hybrid queries would otherwise
  // try to embed with no model and degrade per-query — same end state, but
  // forcing lexical makes the intent explicit and deterministic).
  if (!embeddingsEnabled) {
    queries = queries.map((q) => ({ ...q, search_mode: 'lexical' }));
  }

  const report = await runBenchmark(tmpDbPath, queries, {
    querySetSources: [s1, s2],
    runnerMode: 'raw',
  });

  await cleanup();

  const o = report.overall;
  const bySearchMode = {};
  for (const [mode, sc] of Object.entries(report.by_search_mode ?? {})) {
    bySearchMode[mode] = {
      r_at_5: round(sc.recallAt5),
      r_at_10: round(sc.recallAt10),
      r_at_20: round(sc.recallAt20),
      mrr: round(sc.mrr),
      ndcg_at_5: round(sc.ndcgAt5),
      ndcg_at_20: round(sc.ndcgAt20),
    };
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    model,
    dtype: dtype || 'fp32',
    embeddings_enabled: embeddingsEnabled,
    batch: batchSize,
    corpus_entries: corpusCount,
    re_embedded: reEmbedded,
    query_count: report.query_count,
    evaluation_count: report.evaluation_count,
    // Headline overall metrics
    r_at_5: round(o.recallAt5),
    r_at_10: round(o.recallAt10),
    r_at_20: round(o.recallAt20),
    mrr: round(o.mrr),
    ndcg_at_5: round(o.ndcgAt5),
    ndcg_at_20: round(o.ndcgAt20),
    by_search_mode: bySearchMode,
    query_set_checksum: report.query_set_checksum,
    relaxed_lexical_fallback_count: report.relaxed_lexical_fallback_count,
    warnings: report.warnings ?? [],
  }) + '\n');
  process.exit(0);
} catch (err) {
  await cleanup();
  fail('run', err);
}

function round(x) {
  return typeof x === 'number' ? Math.round(x * 10000) / 10000 : x;
}
