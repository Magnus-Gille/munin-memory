/**
 * RAM-fit measurement v2 — PEAK ANON+SHMEM edition.
 *
 * Supersedes measure.mjs for the 2026-06-18 sweep. Same production code path
 * (dist/db, dist/embeddings, dist/migrations) but with the corrected primary
 * metric demanded by the prep:
 *
 *   PRIMARY  peak_anon_mb  = max over time of cgroup memory.stat (anon + shmem).
 *                            This is the un-reclaimable working set — the real
 *                            "must fit under MemoryMax with swap=0" demand.
 *   INFO     peak_current_mb = max over time of cgroup memory.current. Dominated
 *                            by reclaimable FILE CACHE (the 1.34GB DB copy on
 *                            /tmp ext4 in write mode), so it pins to the cap and
 *                            is cache-inflated/informational ONLY.
 *
 * The dispositive fit signal is still: no cgroup OOM-kill under MemoryMax with
 * MemorySwapMax=0 (the runner detects exit 137 / no-JSON as "did not fit").
 *
 * Modes (env MODE):
 *   query       — open snapshot read-only, run N semantic+hybrid queries
 *   write       — copy snapshot to /tmp (writable), insert ~50 entries, embed a batch
 *   concurrent  — sustained/burst: open a writable copy, insert a large embed backlog,
 *                 start the worker AND fire a burst of queries concurrently. This is
 *                 where anon peaks (model forward pass + KNN + query embeds at once).
 *
 * Env vars (config captured by dist/embeddings at import — must be set in the
 * spawned process env, which systemd-run `env ...` does):
 *   MUNIN_MEMORY_DB_PATH        (required — snapshot path)
 *   MODE                        (query | write | concurrent; default query)
 *   MUNIN_EMBEDDINGS_MODEL      (default Xenova/all-MiniLM-L6-v2)
 *   MUNIN_EMBEDDINGS_DTYPE      (unset = fp32; q8 | int8 | fp16)
 *   MUNIN_EMBEDDINGS_ENABLED    (false => lexical-only; no model load)
 *   MUNIN_EMBEDDINGS_BATCH_SIZE
 *   MUNIN_SQLITE_CACHE_KIB
 *   MUNIN_SQLITE_MMAP_BYTES
 *   OMP_NUM_THREADS
 *   RAMFIT_BURST_QUERIES        (concurrent mode: # queries in the burst; default 15)
 *   RAMFIT_BURST_BACKLOG        (concurrent mode: # entries to queue for embedding; default 50)
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
const embeddingsEnabled = (process.env.MUNIN_EMBEDDINGS_ENABLED ?? 'true') === 'true';
const batch = parseInt(process.env.MUNIN_EMBEDDINGS_BATCH_SIZE ?? '25', 10) || 25;
const cacheKib = process.env.MUNIN_SQLITE_CACHE_KIB ?? '';
const mmapBytes = process.env.MUNIN_SQLITE_MMAP_BYTES ?? '';
const threads = process.env.OMP_NUM_THREADS ?? '';
const burstQueries = parseInt(process.env.RAMFIT_BURST_QUERIES ?? '15', 10) || 15;
const burstBacklog = parseInt(process.env.RAMFIT_BURST_BACKLOG ?? '50', 10) || 50;

const isWriteMode = mode === 'write';
const isConcurrentMode = mode === 'concurrent';
const needsWritableDb = isWriteMode || isConcurrentMode;

// ── Load query strings from baseline.jsonl ───────────────────────────────────
const queriesPath = path.join(repoRoot, 'benchmark/queries/baseline.jsonl');
const allQueryStrings = readFileSync(queriesPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line).query);
const queryStrings = allQueryStrings.slice(0, 15);

// ── Open DB via better-sqlite3 ───────────────────────────────────────────────
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

let vecLoaded = false;
let db;
let tmpDbPath = null;

function baseResult(extra = {}) {
  return {
    model, dtype: dtype || 'fp32', batch, mode,
    embeddings_enabled: embeddingsEnabled,
    cache_kib: cacheKib || 'default',
    mmap: mmapBytes || 'default',
    threads: threads || 'default',
    peak_anon_mb: null,
    peak_current_mb: null,
    queries_run: 0,
    semantic_p50_ms: null,
    hybrid_p50_ms: null,
    vec_loaded: false,
    batch_embedded: null,
    burst_queries: isConcurrentMode ? burstQueries : null,
    burst_backlog: isConcurrentMode ? burstBacklog : null,
    errors: [],
    ...extra,
  };
}

try {
  if (needsWritableDb) {
    tmpDbPath = path.join(os.tmpdir(), `munin-ramfit-${randomUUID()}.db`);
    copyFileSync(dbPath, tmpDbPath);
    db = new Database(tmpDbPath, { fileMustExist: true });
  } else {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  if (cacheKib !== '') {
    const kib = parseInt(cacheKib, 10);
    if (Number.isFinite(kib) && kib > 0) db.pragma(`cache_size = -${kib}`);
  }
  if (mmapBytes !== '') {
    const bytes = parseInt(mmapBytes, 10);
    if (Number.isFinite(bytes) && bytes >= 0) db.pragma(`mmap_size = ${bytes}`);
  }

  sqliteVec.load(db);
  vecLoaded = true;
} catch (err) {
  if (tmpDbPath) { try { unlinkSync(tmpDbPath); } catch {} }
  const result = baseResult({ errors: [`db/vec init failed: ${err.message}`] });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(1);
}

// ── cgroup sampler — poll memory.current AND memory.stat(anon+shmem) @50ms ────
let cgroupDir = null;
try {
  const cgroupContent = readFileSync('/proc/self/cgroup', 'utf8');
  const match = cgroupContent.match(/^0::(.+)$/m);
  if (match) cgroupDir = `/sys/fs/cgroup${match[1].trim()}`;
} catch {}

const currentPath = cgroupDir ? `${cgroupDir}/memory.current` : null;
const statPath = cgroupDir ? `${cgroupDir}/memory.stat` : null;

let peakAnonBytes = 0;
let peakCurrentBytes = 0;
let samplerInterval = null;

function readStatAnonShmem() {
  // anon + shmem = un-reclaimable working set
  try {
    const txt = readFileSync(statPath, 'utf8');
    let anon = 0, shmem = 0;
    for (const line of txt.split('\n')) {
      if (line.startsWith('anon ')) anon = parseInt(line.slice(5), 10) || 0;
      else if (line.startsWith('shmem ')) shmem = parseInt(line.slice(6), 10) || 0;
    }
    return anon + shmem;
  } catch { return 0; }
}

function sampleOnce() {
  if (currentPath) {
    try {
      const cur = parseInt(readFileSync(currentPath, 'utf8').trim(), 10);
      if (Number.isFinite(cur) && cur > peakCurrentBytes) peakCurrentBytes = cur;
    } catch {}
  }
  if (statPath) {
    const a = readStatAnonShmem();
    if (a > peakAnonBytes) peakAnonBytes = a;
  }
}

function startSampler() {
  if (!statPath || !existsSync(statPath)) return;
  samplerInterval = setInterval(sampleOnce, 50);
  if (samplerInterval.unref) samplerInterval.unref();
}
function stopSampler() {
  if (samplerInterval !== null) { clearInterval(samplerInterval); samplerInterval = null; }
  sampleOnce(); // final read
}

startSampler();

// ── Load embedding model via dist/ functions ─────────────────────────────────
const distDb = await import(path.join(repoRoot, 'dist/db.js'));
const distEmb = await import(path.join(repoRoot, 'dist/embeddings.js'));
const distMigrations = await import(path.join(repoRoot, 'dist/migrations.js'));

distDb.setVecLoaded(true);
distMigrations.registerMuninUDFs(db);

const errors = [];
let embReady = false;
if (embeddingsEnabled) {
  // getEmbeddingCacheDir resolves <dirname(MUNIN_MEMORY_DB_PATH)>/hf-cache.
  // In write/concurrent mode MUNIN_MEMORY_DB_PATH still points at the snapshot
  // (the env var), so the cache resolves to snapshot/hf-cache — which we mirrored
  // to hold every model variant. Force offline so no network is attempted.
  process.env.MUNIN_EMBEDDINGS_LOCAL_ONLY = 'true';
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = distEmb.getEmbeddingCacheDir();
  transformers.env.allowRemoteModels = false;
  embReady = await distEmb.initEmbeddings();
  if (!embReady) {
    errors.push('initEmbeddings() returned false — semantic/hybrid results will be empty');
  }
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function embedToBuffer(text) {
  const f32 = await distEmb.generateEmbedding(text);
  if (!f32) return null;
  return distDb.embeddingToBuffer
    ? distDb.embeddingToBuffer(f32)
    : Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

const semanticTimings = [];
const hybridTimings = [];
let queriesRun = 0;
let batchEmbedded = null;

async function runQueryBurst(strings) {
  for (const queryText of strings) {
    let queryEmbedding = null;
    if (embReady) {
      try { queryEmbedding = await embedToBuffer(queryText); }
      catch (err) { errors.push(`embed error: ${err.message}`); }
    }
    if (queryEmbedding) {
      try {
        const t0 = performance.now();
        distDb.queryEntriesSemantic(db, { queryEmbedding, limit: 10, includeExpired: false });
        semanticTimings.push(performance.now() - t0);
      } catch (err) { errors.push(`semantic error: ${err.message}`); }
      try {
        const t0 = performance.now();
        distDb.queryEntriesHybrid(db, {
          ftsOptions: { query: queryText, limit: 10, includeExpired: false },
          semanticOptions: { queryEmbedding, limit: 10, includeExpired: false },
        });
        hybridTimings.push(performance.now() - t0);
      } catch (err) { errors.push(`hybrid error: ${err.message}`); }
    } else {
      // lexical-only path (no model): still exercise FTS to mirror real load
      try {
        const t0 = performance.now();
        distDb.queryEntriesHybrid(db, {
          ftsOptions: { query: queryText, limit: 10, includeExpired: false },
        });
        hybridTimings.push(performance.now() - t0);
      } catch { /* hybrid w/o semantic may noop; ignore */ }
    }
    queriesRun++;
    sampleOnce();
  }
}

function insertEntries(n) {
  for (let i = 0; i < n; i++) {
    const content =
      `ramfit write-path test entry ${i + 1}: ` +
      `The quick brown fox jumped over the lazy dog. ` +
      `Memory fit test payload for munin-memory embedding pipeline. ` +
      `Query text: ${queryStrings[i % queryStrings.length]}`;
    try {
      distDb.writeState(db, 'ramfit/test', `entry-${randomUUID()}`, content, ['ramfit', 'test'], 'ramfit-harness');
    } catch (err) { errors.push(`write error: ${err.message}`); }
  }
}

function countPending() {
  return db.prepare(
    "SELECT COUNT(*) as n FROM entries WHERE embedding_status IN ('pending','failed')"
  ).get()?.n ?? 0;
}

// ── MODE=query ────────────────────────────────────────────────────────────────
if (mode === 'query') {
  await runQueryBurst(queryStrings);
}

// ── MODE=write ────────────────────────────────────────────────────────────────
if (isWriteMode) {
  const WRITE_COUNT = 50;
  insertEntries(WRITE_COUNT);
  const pendingBefore = countPending();
  distEmb.startEmbeddingWorker(db);
  const target = Math.min(batch, pendingBefore || WRITE_COUNT);
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await new Promise(r => setTimeout(r, 200));
    sampleOnce();
    if (pendingBefore - countPending() >= target) break;
  }
  await distEmb.stopEmbeddingWorker();
  batchEmbedded = pendingBefore - countPending();
}

// ── MODE=concurrent — sustained burst: backlog embed + query burst together ───
if (isConcurrentMode) {
  insertEntries(burstBacklog);
  const pendingBefore = countPending();
  // Fire the worker (drains the backlog) AND a concurrent query burst.
  distEmb.startEmbeddingWorker(db);
  // Run the query burst while the worker churns through the embed backlog.
  const burstPromise = runQueryBurst(allQueryStrings.slice(0, burstQueries));
  await burstPromise;
  // Keep sampling until the backlog drains or a ceiling (this is the anon peak window).
  const start = Date.now();
  while (Date.now() - start < 45_000) {
    await new Promise(r => setTimeout(r, 100));
    sampleOnce();
    if (countPending() === 0) break;
  }
  await distEmb.stopEmbeddingWorker();
  batchEmbedded = pendingBefore - countPending();
}

stopSampler();

if (needsWritableDb) {
  try { db.close(); } catch {}
  if (tmpDbPath) { try { unlinkSync(tmpDbPath); } catch {} }
}

const peakAnonMb = peakAnonBytes > 0 ? Math.round(peakAnonBytes / (1024 * 1024)) : null;
const peakCurrentMb = peakCurrentBytes > 0 ? Math.round(peakCurrentBytes / (1024 * 1024)) : null;

const result = baseResult({
  peak_anon_mb: peakAnonMb,
  peak_current_mb: peakCurrentMb,
  queries_run: queriesRun,
  semantic_p50_ms: semanticTimings.length ? Math.round(median(semanticTimings)) : null,
  hybrid_p50_ms: hybridTimings.length ? Math.round(median(hybridTimings)) : null,
  vec_loaded: vecLoaded,
  batch_embedded: batchEmbedded,
  errors,
});

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
