import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { vecLoaded, storeEmbedding, removeEmbedding } from "./db.js";

// --- Configuration from env vars ---

const config = {
  embeddingsEnabled: (process.env.MUNIN_EMBEDDINGS_ENABLED ?? "true") === "true",
  semanticEnabled: (process.env.MUNIN_SEMANTIC_ENABLED ?? "true") === "true",
  hybridEnabled: (process.env.MUNIN_HYBRID_ENABLED ?? "true") === "true",
  model: process.env.MUNIN_EMBEDDINGS_MODEL ?? "Xenova/all-MiniLM-L6-v2",
  backfill: (process.env.MUNIN_EMBEDDINGS_BACKFILL ?? "true") === "true",
  batchSize: parseInt(process.env.MUNIN_EMBEDDINGS_BATCH_SIZE ?? "25", 10) || 25,
  batchDelayMs: parseInt(process.env.MUNIN_EMBEDDINGS_BATCH_DELAY_MS ?? "200", 10) || 200,
  maxFailures: parseInt(process.env.MUNIN_EMBEDDINGS_MAX_FAILURES ?? "5", 10) || 5,
  localOnly: (process.env.MUNIN_EMBEDDINGS_LOCAL_ONLY ?? "false") === "true",
};

const EMBEDDING_DIM = 384;

// --- State ---

type PoolingType = "none" | "mean" | "cls";
let extractor: ((text: string, options: { pooling: PoolingType; normalize: boolean }) => Promise<{ data: Float32Array }>) | null = null;
let circuitBreakerFailures = 0;
let circuitBreakerDisabled = false;
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

// --- Float32Array → Buffer conversion ---

export function embeddingToBuffer(f32: Float32Array): Buffer {
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  if (buf.length !== EMBEDDING_DIM * 4) {
    throw new Error(
      `Embedding buffer size mismatch: expected ${EMBEDDING_DIM * 4} bytes, got ${buf.length}`,
    );
  }
  return buf;
}

// --- Initialization ---

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

    const transformers = await import("@huggingface/transformers");

    // Point model cache to the data directory (writable under systemd sandboxing)
    const dbDir = process.env.MUNIN_MEMORY_DB_PATH
      ? path.dirname(process.env.MUNIN_MEMORY_DB_PATH)
      : path.join(os.homedir(), ".munin-memory");
    const cacheDir = path.join(dbDir, "hf-cache");
    transformers.env.cacheDir = cacheDir;

    const pipelineOptions: Record<string, unknown> = { cache_dir: cacheDir };
    if (config.localOnly) {
      pipelineOptions.local_files_only = true;
    }
    const pipe = await transformers.pipeline("feature-extraction", config.model, pipelineOptions);
    extractor = async (text: string, options: { pooling: PoolingType; normalize: boolean }) => {
      const result = await pipe(text, { pooling: options.pooling, normalize: options.normalize });
      return { data: result.data as Float32Array };
    };
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to initialize embedding model: ${message}`);
    return false;
  }
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

export function isSemanticEnabled(): boolean {
  return config.semanticEnabled && isEmbeddingAvailable();
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

    // Atomically claim rows: UPDATE with subquery for LIMIT
    const claimed = db
      .prepare(
        `UPDATE entries SET embedding_status = 'processing'
         WHERE id IN (
           SELECT id FROM entries
           WHERE embedding_status IN ('pending', 'failed')
           ORDER BY created_at ASC
           LIMIT ?
         )
         RETURNING id, content, updated_at`,
      )
      .all(config.batchSize) as Array<{ id: string; content: string; updated_at: string }>;

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
