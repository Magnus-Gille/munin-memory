#!/usr/bin/env node

/**
 * Exercise the native ARM64 runtime and the production embedding path.
 *
 * The parent process runs each configuration twice: once to populate a
 * temporary, model-specific cache and once in a fresh process with
 * local_files_only enabled. The second pass is the meaningful cache-reload
 * check; no production data or configured cache is ever used.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS = new Map([
  ["Xenova/bge-small-en-v1.5", "bge-small-en-v1.5"],
  ["Xenova/all-MiniLM-L6-v2", "all-MiniLM-L6-v2"],
]);
const DIMS = 384;
const SCRIPT = fileURLToPath(import.meta.url);

function usageError(message) {
  throw new Error(`${message}\nUsage: node scripts/native-runtime-smoke.mjs`);
}

function hasFiles(directory) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFiles(path)) return true;
  }
  return false;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseChildArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usageError(`Unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usageError(`Missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }
  const phase = values.get("--phase");
  const dtype = values.get("--dtype");
  const model = values.get("--model");
  const root = values.get("--root");
  assert(phase === "download" || phase === "reload", `Invalid phase: ${phase}`);
  assert(dtype === "fp32" || dtype === "q8", `Invalid dtype: ${dtype}`);
  assert(MODELS.has(model), `Invalid model: ${model}`);
  assert(root !== undefined, "Missing --root");
  return { phase, dtype, model, root };
}

async function runChild(argv) {
  const { phase, dtype, model, root } = parseChildArgs(argv);
  // Use a fresh database per process while sharing only the model cache. This
  // keeps the SQLite/FTS/vector assertions independent between download and
  // local-only reload phases.
  const dbPath = join(root, `${phase}.db`);
  const cacheDir = join(root, "hf-cache");

  if (phase === "reload") {
    assert(hasFiles(cacheDir), `local cache missing for ${model} ${dtype}: ${cacheDir}`);
  }

  let db;
  try {
    const require = createRequire(import.meta.url);
    let Database;
    let sqliteVec;
    try {
      Database = require("better-sqlite3");
    } catch (error) {
      throw new Error(`better-sqlite3 native support unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      sqliteVec = require("sqlite-vec");
    } catch (error) {
      throw new Error(`sqlite-vec native support unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const { initDatabase, vecLoaded, writeState, readState, storeEmbedding } = await import("../dist/db.js");
    const {
      embeddingToBuffer,
      generateEmbedding,
      getActiveEmbeddingDtype,
      getActiveEmbeddingModel,
      getEmbeddingCacheDir,
      initEmbeddings,
    } = await import("../dist/embeddings.js");

    // Confirm the extension can load independently before initDatabase's
    // production soft-failure path is checked below.
    const nativeProbe = new Database(":memory:");
    try {
      try {
        sqliteVec.load(nativeProbe);
      } catch (error) {
        throw new Error(`sqlite-vec native support unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      nativeProbe.prepare("SELECT vec_version() AS version").get();
    } finally {
      nativeProbe.close();
    }

    db = initDatabase(dbPath);
    assert(vecLoaded(), "sqlite-vec failed to load in initDatabase");
    const ftsTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'",
    ).get();
    assert(ftsTable?.name === "entries_fts", "SQLite FTS5 table was not created");
    const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get()?.version;
    assert(typeof sqliteVersion === "string" && sqliteVersion.length > 0, "SQLite version probe failed");

    const writeResult = writeState(
      db,
      "native-runtime-smoke",
      "synthetic",
      "Synthetic native runtime fts marker for ARM64 smoke testing.",
      [],
      "native-runtime-smoke",
      undefined,
      undefined,
      { createIfAbsent: true },
    );
    assert(writeResult.status === "created" && writeResult.id, `Synthetic SQLite write failed: ${JSON.stringify(writeResult)}`);
    const ftsRows = db.prepare(
      "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?",
    ).all("fts marker");
    assert(ftsRows.length === 1, "SQLite FTS5 MATCH did not find the synthetic entry");

    process.env.MUNIN_MEMORY_DB_PATH = dbPath;
    assert(getEmbeddingCacheDir(dbPath) === cacheDir, "Embedding cache was not isolated beside the temporary DB");
    assert(getActiveEmbeddingModel() === model, `Unexpected embedding model: ${getActiveEmbeddingModel()}`);
    const expectedDtype = dtype === "fp32" ? null : dtype;
    assert(getActiveEmbeddingDtype() === expectedDtype, `Unexpected resolved dtype for ${dtype}: ${getActiveEmbeddingDtype()}`);

    const ready = await initEmbeddings();
    assert(ready, `Embedding initialization failed for ${model} ${dtype} (${phase})`);
    const vector = await generateEmbedding("Synthetic embedding text for native ARM64 inference.");
    assert(vector instanceof Float32Array, "Embedding output was not a Float32Array");
    assert(vector.length === DIMS, `Expected ${DIMS}-dimension embedding, got ${vector.length}`);
    let squaredNorm = 0;
    for (const value of vector) {
      assert(Number.isFinite(value), "Embedding contains a non-finite value");
      squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    assert(Math.abs(norm - 1) <= 1e-3, `Embedding was not L2-normalized: norm=${norm}`);

    const entry = readState(db, "native-runtime-smoke", "synthetic");
    assert(entry?.id, "Synthetic entry disappeared before vector storage");
    storeEmbedding(db, entry.id, embeddingToBuffer(vector), model);
    const vectorRow = db.prepare(
      "SELECT entry_id, vec_distance_L2(embedding, ?) AS distance FROM entries_vec WHERE entry_id = ?",
    ).get(embeddingToBuffer(vector), entry.id);
    assert(vectorRow?.entry_id === entry.id, "sqlite-vec vector row was not stored");
    assert(Number.isFinite(vectorRow.distance) && vectorRow.distance <= 1e-3, `sqlite-vec distance probe failed: ${vectorRow.distance}`);

    const stored = db.prepare(
      "SELECT embedding_status, embedding_model FROM entries WHERE id = ?",
    ).get(entry.id);
    assert(stored?.embedding_status === "generated" && stored.embedding_model === model, "Embedding metadata was not persisted");

    console.log(
      `Native runtime smoke PASS (${phase}; dtype=${dtype}; model=${model}; `
      + `sqlite=${sqliteVersion}; cache=${cacheDir}; dimension=${vector.length}; norm=${norm.toFixed(6)})`,
    );
  } catch (error) {
    throw new Error(
      `Native runtime smoke failed (${phase}; dtype=${dtype}; model=${model}): `
      + `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    db?.close();
  }
}

async function runParent() {
  const root = mkdtempSync(join(tmpdir(), "munin-native-runtime-smoke-"));
  try {
    for (const [model, modelKey] of MODELS) {
      for (const dtype of ["fp32", "q8"]) {
        const configRoot = join(root, modelKey, dtype);
        const env = {
          ...process.env,
          MUNIN_EMBEDDINGS_ENABLED: "true",
          MUNIN_EMBEDDINGS_LOCAL_ONLY: "false",
          MUNIN_EMBEDDINGS_MODEL: model,
          MUNIN_EMBEDDINGS_DTYPE: dtype === "fp32" ? "" : dtype,
          MUNIN_PROFILE: "",
        };
        for (const phase of ["download", "reload"]) {
          if (phase === "reload") env.MUNIN_EMBEDDINGS_LOCAL_ONLY = "true";
          const result = spawnSync(process.execPath, [SCRIPT, "--phase", phase, "--model", model, "--dtype", dtype, "--root", configRoot], {
            env,
            stdio: "inherit",
          });
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error(`Child smoke process exited with status ${result.status}`);
        }
      }
    }
    console.log("Native runtime smoke completed for both models, fp32/q8, with local-cache reloads.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const isChild = process.argv.includes("--phase");
try {
  await (isChild ? runChild(process.argv.slice(2)) : runParent());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
