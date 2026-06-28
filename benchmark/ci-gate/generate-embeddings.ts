/**
 * One-time generator for the hybrid CI gate's frozen-embeddings fixture.
 *
 * Runs the REAL embedding model locally over the committed corpus + hybrid
 * query set and writes their vectors to `embeddings.json`. The gate then loads
 * these frozen vectors instead of the model, so CI stays hermetic and
 * deterministic (see ci-gate.ts). This script is NOT run in CI — only when the
 * corpus, the hybrid query set, or the embedding model changes. After running
 * it, re-bless the baseline:
 *
 *   npm run benchmark:ci-gate:embeddings        # regenerate embeddings.json
 *   npm run benchmark:ci-gate -- --hybrid --update-baseline
 *
 * Vectors are stored as plain number[] of length 384; float32 round-trips
 * losslessly through JSON, so Float32Array.from() reproduces the exact bytes.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, vecLoaded } from "../../src/db.js";
import { generateEmbedding, initEmbeddings } from "../../src/embeddings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMBEDDING_DIM = 384;
const MODEL = process.env.MUNIN_EMBEDDINGS_MODEL ?? "Xenova/all-MiniLM-L6-v2";

interface CorpusEntry {
  id: string;
  content: string;
}

interface HybridQuery {
  id: string;
  query: string;
}

function loadCorpus(): CorpusEntry[] {
  return JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf-8")) as CorpusEntry[];
}

function loadQueries(): HybridQuery[] {
  const text = readFileSync(join(HERE, "queries-hybrid.jsonl"), "utf-8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .map((l) => JSON.parse(l) as HybridQuery);
}

async function embed(text: string, label: string): Promise<number[]> {
  const vec = await generateEmbedding(text);
  if (!vec) throw new Error(`Embedding generation returned null for ${label}`);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding for ${label} has ${vec.length} dims, expected ${EMBEDDING_DIM}`);
  }
  // Array.from(Float32Array) widens each float32 to an exact double; JSON
  // round-trips it and Float32Array.from() narrows back to the same bytes.
  return Array.from(vec);
}

async function main(): Promise<void> {
  // initDatabase loads sqlite-vec and sets the vecLoaded() flag that
  // initEmbeddings checks before loading the model.
  const tmpDir = mkdtempSync(join(tmpdir(), "munin-embed-gen-"));
  try {
    const probe = initDatabase(join(tmpDir, "probe.db"));
    probe.close();
    if (!vecLoaded()) {
      throw new Error("sqlite-vec is unavailable — cannot initialize the embedding model on this platform.");
    }
    const ready = await initEmbeddings();
    if (!ready) {
      throw new Error("Failed to initialize the embedding model (check MUNIN_EMBEDDINGS_* env + model cache).");
    }

    const corpus = loadCorpus();
    const queries = loadQueries();

    const corpusVectors: Record<string, number[]> = {};
    for (const e of corpus) {
      corpusVectors[e.id] = await embed(e.content, `corpus:${e.id}`);
    }

    const queryVectors: Record<string, number[]> = {};
    for (const q of queries) {
      queryVectors[q.id] = await embed(q.query, `query:${q.id}`);
    }

    const fixture = {
      model: MODEL,
      dim: EMBEDDING_DIM,
      generated_at: new Date().toISOString(),
      corpus: corpusVectors,
      queries: queryVectors,
    };

    const outPath = join(HERE, "embeddings.json");
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
    console.log(
      `Wrote ${outPath}: ${corpus.length} corpus + ${queries.length} query vectors (model=${MODEL}, dim=${EMBEDDING_DIM}).`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
