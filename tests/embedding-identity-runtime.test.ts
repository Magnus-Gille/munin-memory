import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, readState, storeEmbedding, writeState } from "../src/db.js";
import {
  _embeddingConfig, _setExtractorForTesting, _setPipelineFactoryForTesting, isEmbeddingCircuitBreakerTripped,
  embeddingToBuffer, generateEmbedding, getActiveEmbeddingIdentity,
  getConfiguredEmbeddingIdentity, getEmbeddingStatusReason, initEmbeddings,
  isEmbeddingAvailable, startEmbeddingWorker, stopEmbeddingWorker,
} from "../src/embeddings.js";
import { resolveEmbeddingIdentity } from "../src/internal/embedding-identity.js";

const REVISION = "a".repeat(40);
const NEXT_REVISION = "b".repeat(40);
const runtime = { transformers: "4.3.1", onnxruntimeNode: "1.30.0" };
const original = { ..._embeddingConfig };
const fakeVector = () => new Float32Array(384).fill(0.1);
let db: Database.Database;
beforeEach(() => {
  Object.assign(_embeddingConfig, original, { embeddingsEnabled: true, batchDelayMs: 5 });
  db = initDatabase(":memory:");
  _setExtractorForTesting(null);
});
afterEach(async () => {
  await stopEmbeddingWorker();
  _setPipelineFactoryForTesting(null);
  _setExtractorForTesting(null);
  Object.assign(_embeddingConfig, original);
  db.close();
});

it("serializes a deterministic complete manifest and distinguishes model, revision, dtype and runtime", () => {
  const config = { model: "Xenova/bge-small-en-v1.5", revision: REVISION, dtype: undefined };
  const baseline = resolveEmbeddingIdentity(config, runtime).identity;
  expect(JSON.parse(baseline!)).toEqual({
    version: 1, model: config.model, revision: REVISION, dtype: "fp32", dimensions: 384,
    pooling: "mean", normalize: true, preprocessing: "raw-text-v1",
    transformers_version: "4.3.1", onnxruntime_node_version: "1.30.0",
    platform: process.platform, arch: process.arch, execution_provider: "cpu",
  });
  expect(resolveEmbeddingIdentity(config, runtime).identity).toBe(baseline);
  for (const delta of [{ model: "custom/model" }, { revision: NEXT_REVISION }, { dtype: "q8" }]) {
    expect(resolveEmbeddingIdentity({ ...config, ...delta }, runtime).identity).not.toBe(baseline);
  }
  expect(resolveEmbeddingIdentity(config, { ...runtime, transformers: "4.3.2" }).identity).not.toBe(baseline);
  expect(resolveEmbeddingIdentity(config, { ...runtime, onnxruntimeNode: "1.30.1" }).identity).not.toBe(baseline);
  expect(resolveEmbeddingIdentity(config, null).identity).toBeNull();
});

it("uses verified built-in pins and requires immutable custom revisions", () => {
  expect(JSON.parse(resolveEmbeddingIdentity({ model: "Xenova/bge-small-en-v1.5" }, runtime).identity!).revision).toBe("ea104dacec62c0de699686887e3f920caeb4f3e3");
  expect(JSON.parse(resolveEmbeddingIdentity({ model: "Xenova/all-MiniLM-L6-v2" }, runtime).identity!).revision).toBe("751bff37182d3f1213fa05d7196b954e230abad9");
  for (const config of [{ model: "custom/model" }, { model: "Xenova/bge-small-en-v1.5", revision: "main" }, { model: "Xenova/bge-small-en-v1.5", revision: "" }]) {
    expect(resolveEmbeddingIdentity(config, runtime)).toMatchObject({ identity: null, reason: expect.stringContaining("MUNIN_EMBEDDINGS_REVISION") });
  }
});

it("rejects local paths and URLs that cannot be bound to a Hub revision", () => {
  for (const model of ["/tmp/model", "./model", "../model", "https://example.invalid/model", "file:///tmp/model", "model"]) {
    expect(resolveEmbeddingIdentity({ model, revision: REVISION }, runtime).identity).toBeNull();
  }
});

it("never loads a model or mutates the queue for unknown custom identity, even with an old extractor", async () => {
  _setExtractorForTesting(async () => ({ data: fakeVector() }));
  const { id } = writeState(db, "projects/runtime", "status", "human content", []);
  db.prepare("UPDATE entries SET embedding_status='processing' WHERE id=?").run(id);
  Object.assign(_embeddingConfig, { model: "custom/unpinned", revision: undefined });
  const factory = vi.fn();
  _setPipelineFactoryForTesting(factory);
  expect(await initEmbeddings()).toBe(false);
  expect(getConfiguredEmbeddingIdentity()).toBeNull();
  expect(getActiveEmbeddingIdentity()).toBeNull();
  expect(isEmbeddingAvailable()).toBe(false);
  expect(getEmbeddingStatusReason()).toContain("MUNIN_EMBEDDINGS_REVISION");
  expect(await generateEmbedding("query")).toBeNull();
  startEmbeddingWorker(db);
  expect(readState(db, "projects/runtime", "status")!.embedding_status).toBe("processing");
  expect(factory).not.toHaveBeenCalled();
});

it("pins CPU, revision and effective dtype, reuses matching identity and rebuilds on changes", async () => {
  const factory = vi.fn(async () => async () => ({ data: fakeVector() }));
  _setPipelineFactoryForTesting(factory);
  expect(await initEmbeddings()).toBe(true);
  const initial = getActiveEmbeddingIdentity();
  expect(factory.mock.calls[0]![2]).toMatchObject({ device: "cpu", dtype: "fp32", revision: "ea104dacec62c0de699686887e3f920caeb4f3e3" });
  expect(await initEmbeddings()).toBe(true);
  expect(factory).toHaveBeenCalledTimes(1);
  _embeddingConfig.dtype = "q8";
  expect(isEmbeddingAvailable()).toBe(false);
  expect(await generateEmbedding("stale query")).toBeNull();
  expect(await initEmbeddings()).toBe(true);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(getActiveEmbeddingIdentity()).not.toBe(initial);
  _embeddingConfig.revision = NEXT_REVISION;
  expect(await initEmbeddings()).toBe(true);
  expect(factory).toHaveBeenCalledTimes(3);
});

it("rebuilds the extractor when its cache directory changes even if identity matches", async () => {
  const previousPath = process.env.MUNIN_MEMORY_DB_PATH;
  const factory = vi.fn(async () => async () => ({ data: fakeVector() }));
  _setPipelineFactoryForTesting(factory);
  try {
    expect(await initEmbeddings()).toBe(true);
    const identity = getActiveEmbeddingIdentity();
    process.env.MUNIN_MEMORY_DB_PATH = "/private/tmp/munin-374-alternate-cache/memory.db";
    expect(getActiveEmbeddingIdentity()).toBeNull();
    expect(await initEmbeddings()).toBe(true);
    expect(getActiveEmbeddingIdentity()).toBe(identity);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[0]![2]).not.toEqual(factory.mock.calls[1]![2]);
  } finally {
    if (previousPath === undefined) delete process.env.MUNIN_MEMORY_DB_PATH;
    else process.env.MUNIN_MEMORY_DB_PATH = previousPath;
  }
});

it("discards a result when configuration changes while extraction is awaiting", async () => {
  let complete!: (value: { data: Float32Array }) => void;
  const waiting = new Promise<{ data: Float32Array }>((resolve) => { complete = resolve; });
  _setExtractorForTesting(async () => waiting);
  const result = generateEmbedding("query");
  _embeddingConfig.revision = NEXT_REVISION;
  complete({ data: fakeVector() });
  expect(await result).toBeNull();
  expect(isEmbeddingAvailable()).toBe(false);
});

it("does not count an old extractor's failure against a newly rebound extractor", async () => {
  let fail!: (error: Error) => void;
  _embeddingConfig.maxFailures = 1;
  _setExtractorForTesting(async () => new Promise((_resolve, reject) => { fail = reject; }));
  const oldResult = generateEmbedding("old query");
  _embeddingConfig.revision = NEXT_REVISION;
  _setExtractorForTesting(async () => ({ data: fakeVector() }));
  fail(new Error("obsolete extractor failed"));
  expect(await oldResult).toBeNull();
  expect(isEmbeddingCircuitBreakerTripped()).toBe(false);
  expect(isEmbeddingAvailable()).toBe(true);
});

it("discards initialization that finishes after configuration changes", async () => {
  let complete!: (value: () => Promise<{ data: Float32Array }>) => void;
  _setPipelineFactoryForTesting(async () => new Promise((resolve) => { complete = resolve; }));
  const loading = initEmbeddings();
  _embeddingConfig.revision = NEXT_REVISION;
  complete(async () => ({ data: fakeVector() }));
  expect(await loading).toBe(false);
  expect(getActiveEmbeddingIdentity()).toBeNull();
});

it("converges legacy and mismatched identity vectors without altering human content or timestamps", async () => {
  const { id: legacy } = writeState(db, "projects/runtime", "legacy", "old memory", []);
  const { id: stale } = writeState(db, "projects/runtime", "stale", "stale memory", []);
  storeEmbedding(db, legacy, embeddingToBuffer(fakeVector()), _embeddingConfig.model);
  storeEmbedding(db, stale, embeddingToBuffer(fakeVector()), _embeddingConfig.model, "old-identity");
  const before = db.prepare("SELECT id, content, updated_at FROM entries ORDER BY id").all();
  _setExtractorForTesting(async () => ({ data: fakeVector() }));
  const identity = getActiveEmbeddingIdentity();
  startEmbeddingWorker(db);
  await vi.waitFor(() => {
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE embedding_status='generated' AND embedding_identity=?").get(identity)).toEqual({ n: 2 });
  });
  await stopEmbeddingWorker();
  expect(db.prepare("SELECT id, content, updated_at FROM entries ORDER BY id").all()).toEqual(before);
});

it("requeues a whole claimed batch when settings change mid-generation and writes stay nonblocking", async () => {
  let complete!: (value: { data: Float32Array }) => void;
  let entered = false;
  _setExtractorForTesting(async () => {
    entered = true;
    return new Promise((resolve) => { complete = resolve; });
  });
  const first = writeState(db, "projects/runtime", "one", "one memory", []);
  const second = writeState(db, "projects/runtime", "two", "two memory", []);
  const before = db.prepare("SELECT id, content, updated_at FROM entries ORDER BY id").all();
  startEmbeddingWorker(db);
  await vi.waitFor(() => { expect(entered).toBe(true); });
  // A normal human write completes while the optional model awaits.
  writeState(db, "projects/runtime", "new", "another memory", []);
  _embeddingConfig.revision = NEXT_REVISION;
  complete({ data: fakeVector() });
  await stopEmbeddingWorker();
  for (const id of [first.id, second.id]) {
    expect(db.prepare("SELECT embedding_status, embedding_identity FROM entries WHERE id=?").get(id)).toEqual({ embedding_status: "pending", embedding_identity: null });
  }
  expect(db.prepare("SELECT id, content, updated_at FROM entries WHERE key != 'new' ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT count(*) AS n FROM entries_vec").get()).toEqual({ n: 0 });
});
