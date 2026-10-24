import type Database from "better-sqlite3";
import { getDataDir, vecLoaded, storeEmbedding } from "./db.js";
import { resolveKnob } from "./profiles.js";
import { resolveEmbeddingIdentity } from "./internal/embedding-identity.js";
import { withPinnedEmbeddingSource } from "./internal/embedding-source.js";

// --- Configuration from env vars ---
//
// The three appliance-relevant knobs (ENABLED, DTYPE, BATCH_SIZE) flow through
// resolveKnob, which applies precedence: explicit env var > MUNIN_PROFILE
// default > hard default. With MUNIN_PROFILE unset, resolveKnob collapses to the
// prior `process.env.X ?? hardDefault` read — byte-for-byte current behavior.

/** Valid ONNX weight precision values accepted by Transformers.js v3. */
export const VALID_DTYPES = ["fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4"] as const;
export type ValidDtype = (typeof VALID_DTYPES)[number];

/**
 * Validate the resolved dtype against the known-good Transformers.js v3 set.
 * Returns the dtype if valid, or `undefined` if:
 *  - the value is undefined or empty string (unset — use explicit CPU fp32)
 *  - the value is set but not in the allowed list (warn + use explicit CPU fp32)
 *
 * Exported for unit testing.
 */
export function resolveEmbeddingsDtype(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if ((VALID_DTYPES as readonly string[]).includes(raw)) return raw;
  console.warn(
    `[munin] MUNIN_EMBEDDINGS_DTYPE="${raw}" is not a recognised dtype — ignored, using CPU fp32. Allowed: ${VALID_DTYPES.join(", ")}`,
  );
  return undefined;
}

const config = {
  embeddingsEnabled:
    (resolveKnob("MUNIN_EMBEDDINGS_ENABLED", "true") ?? "true") === "true",
  semanticEnabled: (process.env.MUNIN_SEMANTIC_ENABLED ?? "true") === "true",
  hybridEnabled: (process.env.MUNIN_HYBRID_ENABLED ?? "true") === "true",
  model:
    resolveKnob("MUNIN_EMBEDDINGS_MODEL", "Xenova/bge-small-en-v1.5") ??
    "Xenova/bge-small-en-v1.5",
  revision: process.env.MUNIN_EMBEDDINGS_REVISION,
  // ONNX weight precision for the embedding model. Unset = explicit CPU fp32
  // (fp32 for all-MiniLM). Lower precision (e.g. "q8"/"int8") cuts resident
  // model memory ~3-4x, the primary lever for fitting embeddings on
  // zero/zero-plus appliance RAM. Valid values follow Transformers.js v3:
  // fp32 | fp16 | q8 | int8 | uint8 | q4 | bnb4.
  dtype: resolveEmbeddingsDtype(resolveKnob("MUNIN_EMBEDDINGS_DTYPE", undefined)),
  batchSize: parseInt(resolveKnob("MUNIN_EMBEDDINGS_BATCH_SIZE", "25") ?? "25", 10) || 25,
  batchDelayMs: parseInt(process.env.MUNIN_EMBEDDINGS_BATCH_DELAY_MS ?? "200", 10) || 200,
  maxFailures: parseInt(process.env.MUNIN_EMBEDDINGS_MAX_FAILURES ?? "5", 10) || 5,
  localOnly: (process.env.MUNIN_EMBEDDINGS_LOCAL_ONLY ?? "false") === "true",
  // Optional L2 distance cutoff for semantic/hybrid KNN. Unset = unbounded
  // (current behavior). A finite, non-negative value drops vector candidates
  // farther than the cutoff so unrelated "nearest" neighbours aren't returned.
  semanticMaxDistance: (() => {
    const raw = process.env.MUNIN_SEMANTIC_MAX_DISTANCE;
    if (raw === undefined || raw === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  })(),
};

const EMBEDDING_DIM = 384;

// --- State ---

type PoolingType = "none" | "mean" | "cls";
let extractor: ((text: string, options: { pooling: PoolingType; normalize: boolean }) => Promise<{ data: Float32Array }>) | null = null;
let circuitBreakerFailures = 0;
let circuitBreakerDisabled = false;
let extractorCacheDir: string | null = null;
let extractorIdentity: string | null = null;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerProcessing = false;
let workerInflightPromise: Promise<void> | null = null;
let workerDb: Database.Database | null = null;

// --- Test hook ---

type ExtractorFn = (text: string, options: { pooling: PoolingType; normalize: boolean }) => Promise<{ data: Float32Array }>;
let _testExtractor: ExtractorFn | null = null;

export function _setExtractorForTesting(fn: ExtractorFn | null): void {
  if (process.env.VITEST) {
    _testExtractor = fn;
    if (fn) {
      extractorIdentity = getConfiguredEmbeddingIdentity();
      extractorCacheDir = getEmbeddingCacheDir();
      extractor = extractorIdentity === null ? null : fn;
      circuitBreakerFailures = 0;
      circuitBreakerDisabled = false;
    } else {
      extractor = null;
      extractorIdentity = null;
      extractorCacheDir = null;
    }
  }
}

// --- Test hook: pipeline factory seam ---
//
// Production initEmbeddings dynamically imports @huggingface/transformers and
// calls transformers.pipeline(). The _testExtractor hook above short-circuits
// before that path, so the construction of pipelineOptions — notably the
// dtype -> pipelineOptions.dtype wiring — was never exercised by tests. This
// seam lets a test inject a fake pipeline factory to assert those options
// without loading the real model. (#126 follow-up.)

type LoadedPipeline = (
  text: string,
  options: { pooling: PoolingType; normalize: boolean },
) => Promise<{ data: Float32Array }>;

type PipelineFactory = (
  task: string,
  model: string,
  options: Record<string, unknown>,
) => Promise<LoadedPipeline>;

let _testPipelineFactory: PipelineFactory | null = null;

export function _setPipelineFactoryForTesting(fn: PipelineFactory | null): void {
  if (process.env.VITEST) {
    _testPipelineFactory = fn;
  }
}

// --- Float32Array → Buffer conversion ---

export function embeddingToBuffer(f32: Float32Array): Buffer {
  // Must pass byteOffset+byteLength — bare Buffer.from(f32) silently truncates when backed by a shared ArrayBuffer
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  if (buf.length !== EMBEDDING_DIM * 4) {
    throw new Error(
      `Embedding buffer size mismatch: expected ${EMBEDDING_DIM * 4} bytes, got ${buf.length}`,
    );
  }
  return buf;
}

// --- Initialization ---

export function getEmbeddingCacheDir(configuredDbPath = process.env.MUNIN_MEMORY_DB_PATH): string {
  return `${getDataDir(configuredDbPath)}/hf-cache`;
}

export async function initEmbeddings(): Promise<boolean> {
  const resolved = resolveEmbeddingIdentity(config);
  if (!config.embeddingsEnabled || !vecLoaded() || resolved.identity === null) {
    extractor = null;
    extractorIdentity = null;
    extractorCacheDir = null;
    return false;
  }

  const cacheDir = getEmbeddingCacheDir();
  const identity = resolved.identity;
  if (extractor && !circuitBreakerDisabled && extractorCacheDir === cacheDir && extractorIdentity === identity) {
    return true;
  }
  // Invalidate an old binding before any asynchronous initialization can fail.
  extractor = null;
  extractorIdentity = null;
  extractorCacheDir = null;
  try {
    const model = config.model;
    const pipelineOptions: Record<string, unknown> = {
      cache_dir: cacheDir,
      device: "cpu",
      dtype: resolved.dtype,
      revision: resolved.revision,
    };
    if (config.localOnly) pipelineOptions.local_files_only = true;
    const pipe = _testExtractor ?? await loadFeatureExtractionPipeline(model, pipelineOptions, cacheDir);
    if (!config.embeddingsEnabled || getConfiguredEmbeddingIdentity() !== identity || getEmbeddingCacheDir() !== cacheDir) {
      return false;
    }
    extractor = async (text: string, options: { pooling: PoolingType; normalize: boolean }) => {
      const result = await pipe(text, { pooling: options.pooling, normalize: options.normalize });
      return { data: result.data };
    };
    extractorCacheDir = cacheDir;
    extractorIdentity = identity;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to initialize embedding model: ${message}`);
    return false;
  }
}

/**
 * Load the feature-extraction pipeline. In production this dynamically imports
 * @huggingface/transformers, points its cache at the writable data dir, and
 * builds the pipeline with the resolved options (cache_dir, local_files_only,
 * dtype). Under test, a factory injected via _setPipelineFactoryForTesting
 * stands in, so the options wiring can be asserted without loading a model.
 */
async function loadFeatureExtractionPipeline(
  model: string,
  options: Record<string, unknown>,
  cacheDir: string,
): Promise<LoadedPipeline> {
  if (_testPipelineFactory) {
    return _testPipelineFactory("feature-extraction", model, options);
  }

  const transformers = await import("@huggingface/transformers");

  return withPinnedEmbeddingSource(transformers.env, cacheDir, () => transformers.pipeline(
    "feature-extraction",
    model,
    options,
  ) as unknown as Promise<LoadedPipeline>);
}

// --- Embedding generation ---

export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  const identity = getActiveEmbeddingIdentity();
  const loadedExtractor = extractor;
  if (identity === null || loadedExtractor === null) return null;

  try {
    const result = await loadedExtractor(text, { pooling: "mean", normalize: true });
    // A result belongs to the extractor captured before awaiting. Never relabel
    // it with a configuration or runtime binding that changed in the meantime.
    if (!isExtractorBindingCurrent(identity) || extractor !== loadedExtractor) return null;
    circuitBreakerFailures = 0;
    return result.data;
  } catch (err) {
    if (!isExtractorBindingCurrent(identity) || extractor !== loadedExtractor) return null;
    circuitBreakerFailures++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Embedding generation failed (${circuitBreakerFailures}/${config.maxFailures}): ${message}`);

    if (circuitBreakerFailures >= config.maxFailures) {
      circuitBreakerDisabled = true;
      console.error("Circuit breaker tripped: embedding generation disabled");
    }

    return null;
  }
}

// --- Status checks ---

function isExtractorBindingCurrent(identity: string): boolean {
  return config.embeddingsEnabled && extractor !== null && extractorIdentity === identity
    && getConfiguredEmbeddingIdentity() === identity && extractorCacheDir === getEmbeddingCacheDir();
}

export function getConfiguredEmbeddingIdentity(): string | null {
  return resolveEmbeddingIdentity(config).identity;
}

export function getActiveEmbeddingIdentity(): string | null {
  return extractorIdentity !== null && !circuitBreakerDisabled && vecLoaded()
    && isExtractorBindingCurrent(extractorIdentity) ? extractorIdentity : null;
}

export function isEmbeddingAvailable(): boolean {
  return getActiveEmbeddingIdentity() !== null;
}

/**
 * Return the embedding model name that is currently active (i.e. the model
 * whose vectors must match the `queryEmbeddingModel` filter on retrieval and
 * whose name is stored on `entries.embedding_model` when the worker writes a
 * new embedding). Callers that build a query embedding use the same model name
 * as the corpus filter so that mixed-space vectors are always rejected.
 */
export function getActiveEmbeddingModel(): string {
  return config.model;
}

export function isSemanticEnabled(): boolean {
  return config.semanticEnabled && isEmbeddingAvailable();
}

/**
 * Optional configured L2 distance cutoff for semantic/hybrid KNN, or undefined
 * when MUNIN_SEMANTIC_MAX_DISTANCE is unset/invalid (unbounded — default).
 */
export function getSemanticMaxDistance(): number | undefined {
  return config.semanticMaxDistance;
}

export function isHybridEnabled(): boolean {
  return config.hybridEnabled && isEmbeddingAvailable();
}

export function getEmbeddingStatusReason(): string {
  if (!config.embeddingsEnabled) return "Embeddings disabled via MUNIN_EMBEDDINGS_ENABLED=false";
  if (!vecLoaded()) return "sqlite-vec extension not available";
  const resolved = resolveEmbeddingIdentity(config);
  if (resolved.reason !== null) return resolved.reason;
  if (!extractor) return "Embedding model failed to load";
  if (circuitBreakerDisabled) return `Circuit breaker tripped after ${config.maxFailures} consecutive failures`;
  if (getActiveEmbeddingIdentity() === null) return "Embedding configuration changed; reinitialize the embedding model";
  return "Embedding system operational";
}

export function getSearchModeUnavailableReason(mode: "semantic" | "hybrid"): string {
  if (!isEmbeddingAvailable()) return getEmbeddingStatusReason();
  if (mode === "semantic" && !config.semanticEnabled) return "Semantic search disabled via MUNIN_SEMANTIC_ENABLED=false";
  if (mode === "hybrid" && !config.hybridEnabled) return "Hybrid search disabled via MUNIN_HYBRID_ENABLED=false";
  return getEmbeddingStatusReason();
}

export function resetCircuitBreaker(): void {
  circuitBreakerFailures = 0;
  circuitBreakerDisabled = false;
}

/**
 * Returns true if the embedding circuit breaker has tripped (consecutive
 * failures ≥ MUNIN_EMBEDDINGS_MAX_FAILURES). Distinct from
 * `isEmbeddingAvailable()`: available=false covers config-disabled,
 * sqlite-vec missing, and model-not-loaded — none of which are a trip.
 */
export function isEmbeddingCircuitBreakerTripped(): boolean {
  return circuitBreakerDisabled;
}

/**
 * Returns the ONNX dtype resolved for the embedding model (explicit env var
 * > MUNIN_PROFILE default > hard default). Returns null when no dtype was
 * configured (the effective CPU dtype is still explicit fp32). Use this instead of reading
 * process.env.MUNIN_EMBEDDINGS_DTYPE directly so that profile-resolved
 * defaults (e.g. zero-appliance → "q8") are reflected.
 */
export function getActiveEmbeddingDtype(): string | null {
  return config.dtype ?? null;
}

/** Test hook: directly set circuitBreakerDisabled for state testing. */
export function _forceCircuitBreakerTrippedForTesting(tripped: boolean): void {
  if (process.env.VITEST) {
    circuitBreakerDisabled = tripped;
  }
}

// --- Background worker ---

/**
 * Reset orphaned `processing` rows back to `pending` so they get re-claimed.
 *
 * A row is only set to `processing` by the in-process worker while it holds it
 * mid-batch; the status is never persisted as a stable state. Therefore any row
 * found in `processing` at worker startup is an orphan from a prior process that
 * crashed or was restarted mid-batch — no live worker can legitimately own it.
 * Left alone, such rows are never re-claimed (the claim query only picks up
 * `pending`/`failed`/stale-`generated`), so they stay un-embedded forever and,
 * under the model-identity guard, invisible to semantic search (#155).
 *
 * Returns the number of rows reset. `updated_at` is deliberately NOT touched so
 * the reset does not disturb CAS timestamps or surface as a content change.
 *
 * ASSUMPTION — single embedding worker per database. This treats *every*
 * `processing` row as an orphan, which is correct when at most one worker
 * process runs against a given DB (the production deployment: one HTTP server
 * on the Pi, many clients). It does NOT distinguish an orphan from a row a
 * *concurrent* worker in another process legitimately holds in-flight, so two
 * embedding workers sharing one DB file (only possible via concurrent stdio
 * sessions — a dev-only footgun, see CLAUDE.md "Concurrent Sessions") could
 * race: a second startup resets the first's in-flight row. Self-heals on the
 * next pass (the row re-embeds), but wastes work and can transiently leave a
 * row `failed` with a vector present. Hardening this to true multi-worker
 * safety needs an explicit claim token (`embedding_claimed_at`/worker id) and
 * age-bounded reset — tracked as a fast-follow, deliberately out of scope for
 * this single-worker self-heal (#155).
 */
export function resetOrphanedProcessingRows(db: Database.Database): number {
  const result = db
    .prepare(`UPDATE entries SET embedding_status = 'pending'
               WHERE embedding_status = 'processing'
                 AND NOT EXISTS (SELECT 1 FROM code_health_records chr WHERE chr.entry_id = entries.id)`)
    .run();
  return result.changes;
}

export function startEmbeddingWorker(db: Database.Database): void {
  if (!isEmbeddingAvailable()) return;
  const reclaimed = resetOrphanedProcessingRows(db);
  if (reclaimed > 0) {
    console.error(`[embeddings] reset ${reclaimed} orphaned 'processing' row(s) to 'pending' on startup`);
  }
  workerDb = db;
  scheduleNextBatch();
}

export async function stopEmbeddingWorker(): Promise<void> {
  // Detach the DB first: the in-flight batch's .finally re-arms the timer only
  // while workerDb is set, so nulling it before we await keeps a stopped worker
  // from scheduling a timer that nothing would ever clear.
  workerDb = null;
  if (workerTimer !== null) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  try {
    // Await in-flight batch. It may reject (e.g. a failed status write); the
    // state reset below must still run so the caller sees a fully stopped worker.
    if (workerInflightPromise) await workerInflightPromise;
  } finally {
    workerInflightPromise = null;
    if (workerTimer !== null) {
      clearTimeout(workerTimer);
      workerTimer = null;
    }
  }
}

function scheduleNextBatch(): void {
  if (!workerDb) return;
  workerTimer = setTimeout(() => {
    workerTimer = null;
    if (!workerDb || workerProcessing) return;
    workerInflightPromise = processBatch().finally(() => {
      workerInflightPromise = null;
      if (workerDb) {
        scheduleNextBatch();
      }
    });
  }, config.batchDelayMs);
  // Never keep the process alive just for the next batch; the transport does that.
  workerTimer.unref();
}

async function processBatch(): Promise<void> {
  if (!workerDb || !isEmbeddingAvailable()) return;
  workerProcessing = true;

  try {
    const db = workerDb;
    const identity = getActiveEmbeddingIdentity();
    if (identity === null) return;
    const model = config.model;

    // Atomically claim rows: UPDATE with subquery for LIMIT.
    // In addition to 'pending'/'failed' entries, also claim entries that were
    // previously embedded with a different model or identity, or missing either
    // provenance field. SQL != does not match NULL, so legacy/unknown vectors
    // need explicit IS NULL guards. Only the captured batch identity may be stored.
    const claimed = db
      .prepare(
        `UPDATE entries SET embedding_status = 'processing'
         WHERE id IN (
           SELECT id FROM entries
           WHERE is_current = 1
             AND NOT EXISTS (SELECT 1 FROM code_health_records chr WHERE chr.entry_id = entries.id)
             AND (embedding_status IN ('pending', 'failed')
              OR (embedding_status = 'generated'
                  AND (embedding_model IS NULL OR embedding_model != ?
                    OR embedding_identity IS NULL OR embedding_identity != ?)))
           ORDER BY created_at ASC
           LIMIT ?
         )
         RETURNING id, content, updated_at`,
      )
      .all(model, identity, config.batchSize) as Array<{ id: string; content: string; updated_at: string }>;

    if (claimed.length === 0) return;

    const requeueClaimed = () => {
      const requeue = db.prepare(
        "UPDATE entries SET embedding_status = 'pending' WHERE id = ? AND updated_at = ? AND embedding_status = 'processing'",
      );
      db.transaction(() => {
        for (const row of claimed) requeue.run(row.id, row.updated_at);
      })();
    };
    for (const row of claimed) {
      if (circuitBreakerDisabled || !isExtractorBindingCurrent(identity)) {
        requeueClaimed();
        break;
      }

      const embedding = await generateEmbedding(row.content);
      if (!isExtractorBindingCurrent(identity)) {
        requeueClaimed();
        break;
      }
      if (!embedding) {
        // Mark as failed if embedding generation failed
        db.prepare(
          "UPDATE entries SET embedding_status = 'failed' WHERE id = ? AND updated_at = ?",
        ).run(row.id, row.updated_at);
        continue;
      }

      const buf = embeddingToBuffer(embedding);

      // Guarded by updated_at to prevent stale embeddings
      const txn = db.transaction(() => {
        const current = db
          .prepare("SELECT updated_at FROM entries WHERE id = ? AND is_current = 1")
          .get(row.id) as { updated_at: string } | undefined;

        if (!current || current.updated_at !== row.updated_at) {
          // Entry was modified since we claimed it — skip, it'll be re-queued as 'pending'
          return;
        }

        storeEmbedding(db, row.id, buf, model, identity);
      });

      txn();
    }
  } finally {
    workerProcessing = false;
  }
}

export { config as _embeddingConfig };
