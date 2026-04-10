import Database from "better-sqlite3";
import { initDatabase, storeEmbedding } from "../../src/db.js";
import { embeddingToBuffer, generateEmbedding, initEmbeddings } from "../../src/embeddings.js";

export function ensureSafeGeneratedPath(path: string, label: string): void {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.includes("/benchmark/generated/")) {
    throw new Error(
      `${label} must live under benchmark/generated/ to avoid accidental writes against live data: ${path}`,
    );
  }
}

export interface CorpusEmbeddingSummary {
  total: number;
  generated: number;
  failed: number;
  skipped: number;
}

/**
 * Generate embeddings for every entry in a benchmark DB that does not already
 * have one. Safe to rerun: rows stuck in `processing` from an interrupted run
 * are reset to `pending`, and rows already marked `generated` are skipped.
 */
export async function populateCorpusEmbeddings(dbPath: string): Promise<CorpusEmbeddingSummary> {
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
    const skipped = totalRows.cnt - rows.length;
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
      storeEmbedding(
        db,
        row.id,
        embeddingToBuffer(embedding),
        process.env.MUNIN_EMBEDDINGS_MODEL ?? "Xenova/all-MiniLM-L6-v2",
      );
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
