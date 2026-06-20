/**
 * RAM-fit measurement script for munin-memory.
 * Runs on the host under systemd-run --user --scope (no Docker).
 *
 * Modes:
 *   MODE=query (default) — open snapshot DB read-only, run 15 representative queries
 *   MODE=write           — copy snapshot to /tmp (writable), insert ~50 entries, drive
 *                          embedding worker to process at least one full batch
 *
 * Peak memory: cgroup sampler polls /sys/fs/cgroup<path>/memory.current every ~50ms
 * and records the max. Falls back to memory.peak if available, then to process RSS.
 *
 * Env vars read:
 *   MUNIN_MEMORY_DB_PATH       (required — path to snapshot)
 *   MODE                       (query | write; default: query)
 *   MUNIN_EMBEDDINGS_MODEL     (default: Xenova/all-MiniLM-L6-v2)
 *   MUNIN_EMBEDDINGS_DTYPE     (unset = fp32, "q8" = quantised)
 *   MUNIN_EMBEDDINGS_BATCH_SIZE
 *   MUNIN_SQLITE_CACHE_KIB
 *   MUNIN_SQLITE_MMAP_BYTES
 *   OMP_NUM_THREADS
 *   TRANSFORMERS_CACHE          (HF model cache dir; default: ~/munin-ramfit/hf-cache)
 */

import { readFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../');

// ── Config from env ──────────────────────────────────────────────────────────
const dbPath = process.env.MUNIN_MEMORY_DB_PATH ?? '/snap/memory.db';
const mode = (process.env.MODE ?? 'query').toLowerCase();
const model = process.env.MUNIN_EMBEDDINGS_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
const dtype = process.env.MUNIN_EMBEDDINGS_DTYPE ?? '';
const batch = parseInt(process.env.MUNIN_EMBEDDINGS_BATCH_SIZE ?? '25', 10) || 25;
const cacheKib = process.env.MUNIN_SQLITE_CACHE_KIB ?? '';
const mmapBytes = process.env.MUNIN_SQLITE_MMAP_BYTES ?? '';
const threads = process.env.OMP_NUM_THREADS ?? '';

// HF cache: honour TRANSFORMERS_CACHE env, fall back to ~/munin-ramfit/hf-cache
const hfCache = process.env.TRANSFORMERS_CACHE
  ?? path.join(os.homedir(), 'munin-ramfit', 'hf-cache');

// ── Load query strings from baseline.jsonl ───────────────────────────────────
const queriesPath = path.join(repoRoot, 'benchmark/queries/baseline.jsonl');
const queryStrings = readFileSync(queriesPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .slice(0, 15)
  .map(line => JSON.parse(line).query);

// ── Open DB via better-sqlite3 ───────────────────────────────────────────────
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

let vecLoaded = false;
let db;
let tmpDbPath = null; // track /tmp copy for cleanup in write mode

const isWriteMode = mode === 'write';

try {
  if (isWriteMode) {
    // Copy snapshot to a unique /tmp path so we can write to it
    tmpDbPath = path.join(os.tmpdir(), `munin-ramfit-${randomUUID()}.db`);
    copyFileSync(dbPath, tmpDbPath);
    db = new Database(tmpDbPath, { fileMustExist: true });
  } else {
    // Query mode: open snapshot read-only
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  // Apply SQLite memory knobs
  if (cacheKib !== '') {
    const kib = parseInt(cacheKib, 10);
    if (Number.isFinite(kib) && kib > 0) db.pragma(`cache_size = -${kib}`);
  }
  if (mmapBytes !== '') {
    const bytes = parseInt(mmapBytes, 10);
    if (Number.isFinite(bytes) && bytes >= 0) db.pragma(`mmap_size = ${bytes}`);
  }

  // Load sqlite-vec extension — critical on arm64
  sqliteVec.load(db);
  vecLoaded = true;
} catch (err) {
  if (tmpDbPath) { try { unlinkSync(tmpDbPath); } catch {} }
  const result = {
    model, dtype: dtype || 'fp32', batch, mode,
    cache_kib: cacheKib || 'default',
    mmap: mmapBytes || 'default',
    threads: threads || 'default',
    peak_rss_mb: null,
    queries_run: 0,
    semantic_p50_ms: null,
    hybrid_p50_ms: null,
    vec_loaded: false,
    batch_embedded: null,
    errors: [`db/vec init failed: ${err.message}`],
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(1);
}

// ── cgroup sampler — background polling of memory.current every 50ms ─────────
// Find our cgroup path from /proc/self/cgroup (unified hierarchy, line 0::/<path>)
let cgroupCurrentPath = null;
let cgroupPeakPath = null;

try {
  const cgroupContent = readFileSync('/proc/self/cgroup', 'utf8');
  const match = cgroupContent.match(/^0::(.+)$/m);
  if (match) {
    const cgroupSubPath = match[1].trim();
    cgroupCurrentPath = `/sys/fs/cgroup${cgroupSubPath}/memory.current`;
    cgroupPeakPath = `/sys/fs/cgroup${cgroupSubPath}/memory.peak`;
  } else {
    cgroupPeakPath = '/sys/fs/cgroup/memory.peak';
  }
} catch {}

let samplerPeakBytes = 0;
let samplerInterval = null;

function startSampler() {
  if (!cgroupCurrentPath || !existsSync(cgroupCurrentPath)) return;
  samplerInterval = setInterval(() => {
    try {
      const raw = readFileSync(cgroupCurrentPath, 'utf8').trim();
      const bytes = parseInt(raw, 10);
      if (bytes > samplerPeakBytes) samplerPeakBytes = bytes;
    } catch {}
  }, 50);
  // Allow interval to not block process exit
  if (samplerInterval.unref) samplerInterval.unref();
}

function stopSampler() {
  if (samplerInterval !== null) {
    clearInterval(samplerInterval);
    samplerInterval = null;
  }
}

startSampler();

// ── Load embedding model via dist/ functions ──────────────────────────────────
process.env.TRANSFORMERS_CACHE = hfCache;

const distDb = await import(path.join(repoRoot, 'dist/db.js'));
const distEmb = await import(path.join(repoRoot, 'dist/embeddings.js'));
const distMigrations = await import(path.join(repoRoot, 'dist/migrations.js'));

// Mark vec as loaded in dist singleton
distDb.setVecLoaded(true);

// Register custom UDFs (munin_split_tokens etc.) needed by write-path SQL triggers.
// In write mode the db handle is writable and writeState() fires triggers that call
// munin_split_tokens() — without this registration the query fails with "no such function".
// Safe to call in query mode too (it only registers JS functions on the db handle).
distMigrations.registerMuninUDFs(db);

// Patch the HF cache directory BEFORE initEmbeddings
const transformers = await import('@huggingface/transformers');
transformers.env.cacheDir = hfCache;

const embReady = await distEmb.initEmbeddings();

const errors = [];
if (!embReady) {
  errors.push('initEmbeddings() returned false — semantic/hybrid results will be empty');
}

// ── Timing helpers ────────────────────────────────────────────────────────────
function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ── MODE=query: run semantic + hybrid queries ─────────────────────────────────
const semanticTimings = [];
const hybridTimings = [];
let queriesRun = 0;
let batchEmbedded = null;

if (!isWriteMode) {
  for (const queryText of queryStrings) {
    let queryEmbedding = null;
    try {
      const f32 = await distEmb.generateEmbedding(queryText);
      if (f32) {
        queryEmbedding = distDb.embeddingToBuffer
          ? distDb.embeddingToBuffer(f32)
          : Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
      }
    } catch (err) {
      errors.push(`embed error for "${queryText}": ${err.message}`);
    }

    if (!queryEmbedding) {
      errors.push(`no embedding for query: ${queryText}`);
      continue;
    }

    try {
      const t0 = performance.now();
      distDb.queryEntriesSemantic(db, {
        queryEmbedding,
        limit: 10,
        includeExpired: false,
      });
      semanticTimings.push(performance.now() - t0);
    } catch (err) {
      errors.push(`semantic error: ${err.message}`);
    }

    try {
      const t0 = performance.now();
      distDb.queryEntriesHybrid(db, {
        ftsOptions: { query: queryText, limit: 10, includeExpired: false },
        semanticOptions: { queryEmbedding, limit: 10, includeExpired: false },
      });
      hybridTimings.push(performance.now() - t0);
    } catch (err) {
      errors.push(`hybrid error: ${err.message}`);
    }

    queriesRun++;
  }
}

// ── MODE=write: insert entries + drive embedding worker ───────────────────────
if (isWriteMode) {
  const WRITE_COUNT = 50;
  const BATCH_SIZE = batch; // respect MUNIN_EMBEDDINGS_BATCH_SIZE

  // Insert ~50 new entries into the writable DB copy
  const writeContents = Array.from({ length: WRITE_COUNT }, (_, i) =>
    `ramfit write-path test entry ${i + 1}: ` +
    `The quick brown fox jumped over the lazy dog. ` +
    `Memory fit test payload for munin-memory embedding pipeline. ` +
    `Query text: ${queryStrings[i % queryStrings.length]}`
  );

  for (const content of writeContents) {
    try {
      distDb.writeState(db, 'ramfit/test', `entry-${randomUUID()}`, content, ['ramfit', 'test'], 'ramfit-harness');
    } catch (err) {
      errors.push(`write error: ${err.message}`);
    }
  }

  // Count pending entries before starting the worker
  const pendingBefore = db.prepare(
    "SELECT COUNT(*) as n FROM entries WHERE embedding_status IN ('pending', 'failed')"
  ).get();

  // Start embedding worker to process the batch
  distEmb.startEmbeddingWorker(db);

  // Wait for at least one full batch to be processed.
  // The worker runs with a batchDelayMs delay; we poll until pending count drops
  // or until a timeout (30s max to avoid hanging on OOM-adjacent scenarios).
  const targetProcessed = Math.min(BATCH_SIZE, pendingBefore?.n ?? WRITE_COUNT);
  const startWait = Date.now();
  const maxWaitMs = 30_000;

  while (Date.now() - startWait < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const pendingNow = db.prepare(
      "SELECT COUNT(*) as n FROM entries WHERE embedding_status IN ('pending', 'failed')"
    ).get();
    const processedCount = (pendingBefore?.n ?? 0) - (pendingNow?.n ?? 0);
    if (processedCount >= targetProcessed) break;
  }

  // Stop the worker and await any in-flight batch
  await distEmb.stopEmbeddingWorker();

  // Count how many were actually embedded
  const pendingAfter = db.prepare(
    "SELECT COUNT(*) as n FROM entries WHERE embedding_status IN ('pending', 'failed')"
  ).get();
  batchEmbedded = (pendingBefore?.n ?? 0) - (pendingAfter?.n ?? 0);

  // Clean up /tmp copy
  try {
    db.close();
    if (tmpDbPath) unlinkSync(tmpDbPath);
  } catch {}
}

stopSampler();

// ── Peak RSS — sampler max, then cgroup memory.peak, then process RSS ─────────
let peakRssMb = null;

if (samplerPeakBytes > 0) {
  // Sampler-observed max is the true peak
  peakRssMb = Math.round(samplerPeakBytes / (1024 * 1024));
} else if (cgroupPeakPath && existsSync(cgroupPeakPath)) {
  // Fall back to cgroup memory.peak (monotonically increasing)
  try {
    const raw = readFileSync(cgroupPeakPath, 'utf8').trim();
    peakRssMb = Math.round(parseInt(raw, 10) / (1024 * 1024));
    errors.push('cgroup sampler produced no data — used memory.peak fallback');
  } catch (err) {
    errors.push(`cgroup memory.peak read error: ${err.message}`);
  }
} else {
  // Last resort: process RSS
  peakRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  errors.push('no cgroup data — using process RSS fallback');
}

// ── Emit result ───────────────────────────────────────────────────────────────
const result = {
  model,
  dtype: dtype || 'fp32',
  batch,
  mode,
  cache_kib: cacheKib || 'default',
  mmap: mmapBytes || 'default',
  threads: threads || 'default',
  peak_rss_mb: peakRssMb,
  queries_run: queriesRun,
  semantic_p50_ms: semanticTimings.length > 0 ? Math.round(median(semanticTimings)) : null,
  hybrid_p50_ms: hybridTimings.length > 0 ? Math.round(median(hybridTimings)) : null,
  vec_loaded: vecLoaded,
  batch_embedded: batchEmbedded,
  errors,
};

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(errors.some(e => e.includes('failed')) ? 2 : 0);
