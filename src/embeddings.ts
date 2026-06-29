import { mkdirSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { getDataDir, vecLoaded, storeEmbedding } from "./db.js";
import { resolveKnob } from "./profiles.js";

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
 *  - the value is undefined or empty string (unset — fall through to library default)
 *  - the value is set but not in the allowed list (warn + fall through to library default)
 *
 * Exported for unit testing.
 */
export function resolveEmbeddingsDtype(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if ((VALID_DTYPES as readonly string[]).includes(raw)) return raw;
  console.warn(
    `[munin] MUNIN_EMBEDDINGS_DTYPE="${raw}" is not a recognised dtype — ignored, using library default. Allowed: ${VALID_DTYPES.join(", ")}`,
  );
  return undefined;
}

const config = {
  embeddingsEnabled:
    (resolveKnob("MUNIN_EMBEDDINGS_ENABLED", "true") ?? "true") === "true",
  semanticEnabled: (process.env.MUNIN_SEMANTIC_ENABLED ?? "true") === "true",
  hybridEnabled: (process.env.MUNIN_HYBRID_ENABLED ?? "true") === "true",
  model: process.env.MUNIN_EMBEDDINGS_MODEL ?? "Xenova/bge-small-en-v1.5",
  // ONNX weight precision for the embedding model. Unset = library default
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
      extractor = fn;
      circuitBreakerFailures = 0;
      circuitBreakerDisabled = false;
    } else {
      extractor = null;
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
  if (!config.embeddingsEnabled) {
    return false;
  }

  if (!vecLoaded()) {
    return false;
  }

  try {
    if (_testExtractor) {
      extractor = _testExtractor;
      return true;
    }

    const cacheDir = getEmbeddingCacheDir();

    // Short-circuit only when the extractor is already loaded AND bound to the
    // same cache_dir. If the DB path (and therefore cache_dir) changed, rebuild.
    if (extractor && !circuitBreakerDisabled && extractorCacheDir === cacheDir) {
      return true;
    }

    const pipelineOptions: Record<string, unknown> = { cache_dir: cacheDir };
    if (config.localOnly) {
      pipelineOptions.local_files_only = true;
    }
    if (config.dtype !== undefined && config.dtype !== "") {
      pipelineOptions.dtype = config.dtype;
    }

    const pipe = await loadFeatureExtractionPipeline(config.model, pipelineOptions, cacheDir);
    extractor = async (text: string, options: { pooling: PoolingType; normalize: boolean }) => {
      const result = await pipe(text, { pooling: options.pooling, normalize: options.normalize });
      return { data: result.data };
    };
    extractorCacheDir = cacheDir;
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

  // Point model cache to the data directory (writable under systemd sandboxing)
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  }
  transformers.env.cacheDir = cacheDir;

  return transformers.pipeline(
    "feature-extraction",
    model,
    options,
  ) as unknown as Promise<LoadedPipeline>;
}

// --- Embedding generation ---

export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  if (!extractor || circuitBreakerDisabled) {
    return null;
  }

  try {
    const result = await extractor(text, { pooling: "mean", normalize: true });
    circuitBreakerFailures = 0;
    return result.data;
  } catch (err) {
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

export function isEmbeddingAvailable(): boolean {
  return extractor !== null && !circuitBreakerDisabled && vecLoaded();
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
  if (!extractor) return "Embedding model failed to load";
  if (circuitBreakerDisabled) return `Circuit breaker tripped after ${config.maxFailures} consecutive failures`;
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
 * configured (library default, typically fp32). Use this instead of reading
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

export function startEmbeddingWorker(db: Database.Database): void {
  if (!isEmbeddingAvailable()) return;
  workerDb = db;
  scheduleNextBatch();
}

export async function stopEmbeddingWorker(): Promise<void> {
  if (workerTimer !== null) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  // Await in-flight batch
  if (workerInflightPromise) {
    await workerInflightPromise;
    workerInflightPromise = null;
  }
  workerDb = null;
}

function scheduleNextBatch(): void {
  if (!workerDb) return;
  workerTimer = setTimeout(() => {
    if (!workerDb || workerProcessing) return;
    workerInflightPromise = processBatch().finally(() => {
      workerInflightPromise = null;
      if (workerDb) {
        scheduleNextBatch();
      }
    });
  }, config.batchDelayMs);
}

async function processBatch(): Promise<void> {
  if (!workerDb || !isEmbeddingAvailable()) return;
  workerProcessing = true;

  try {
    const db = workerDb;

    // Atomically claim rows: UPDATE with subquery for LIMIT.
    // In addition to 'pending'/'failed' entries, also claim entries that were
    // previously embedded with a DIFFERENT model (embedding_model != current) or
    // have NULL embedding_model (SQL `!= ?` evaluates to UNKNOWN for NULL, so the
    // IS NULL guard is required to reclaim legacy/partially-written rows).
    // This ensures that a MUNIN_EMBEDDINGS_MODEL change triggers a full
    // re-embedding of the corpus on the next worker pass, so stale vectors
    // from the old model are replaced and no longer served via the model filter.
    const claimed = db
      .prepare(
        `UPDATE entries SET embedding_status = 'processing'
         WHERE id IN (
           SELECT id FROM entries
           WHERE embedding_status IN ('pending', 'failed')
              OR (embedding_status = 'generated'
                  AND (embedding_model IS NULL OR embedding_model != ?))
           ORDER BY created_at ASC
           LIMIT ?
         )
         RETURNING id, content, updated_at`,
      )
      .all(config.model, config.batchSize) as Array<{ id: string; content: string; updated_at: string }>;

    if (claimed.length === 0) return;

    for (const row of claimed) {
      if (circuitBreakerDisabled) break;

      const embedding = await generateEmbedding(row.content);
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
          .prepare("SELECT updated_at FROM entries WHERE id = ?")
          .get(row.id) as { updated_at: string } | undefined;

        if (!current || current.updated_at !== row.updated_at) {
          // Entry was modified since we claimed it — skip, it'll be re-queued as 'pending'
          return;
        }

        storeEmbedding(db, row.id, buf, config.model);
      });

      txn();
    }
  } finally {
    workerProcessing = false;
  }
}

export { config as _embeddingConfig };
