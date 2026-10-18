#!/usr/bin/env node
/** Explicit, fresh artifact generation. Evaluation remains a separate model-free command. */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { BuildOptions, ConvertResult } from "../adapters/longmemeval/build.js";
import type { CorpusEmbeddingSummary } from "../adapters/shared.js";
import { canonical, validateQueries, validateVectors, type FrozenVectors } from "./metric.js";
import { normalizeAsOf, withFrozenClock } from "./clock.js";

export const BGE_MODEL = "Xenova/bge-small-en-v1.5";
export const BGE_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
export const LONGMEMEVAL_S_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
const DATASET_URL = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_FILES = [
  "benchmark/evidence-metric/prepare.ts", "benchmark/evidence-metric/clock.ts", "benchmark/evidence-metric/metric.ts",
  "benchmark/evidence-metric/evaluate.ts", "benchmark/evidence-metric/run.ts", "benchmark/adapters/longmemeval/build.ts", "benchmark/adapters/shared.ts",
  "benchmark/runner.ts", "benchmark/scorer.ts", "benchmark/types.ts", "benchmark/answer-quality/serialize.ts",
  "src/db.ts", "src/migrations.ts", "src/embeddings.ts", "src/profiles.ts", "src/internal/embedding-identity.ts", "src/internal/embedding-source.ts",
  "src/internal/reranker.ts", "src/internal/retrieval-shared.ts", "src/internal/hybrid-fusion.ts", "src/internal/query-probe.ts", "src/internal/namespace-filter.ts",
];
export interface PreparationOptions { input: string; outputDir: string; asOf: string; allowModelDownload?: boolean }
/** Tests inject an inert provider; the CLI always uses the production modules and fixed full counts. */
export interface PreparationRuntime {
  build(options: BuildOptions): ConvertResult;
  initialize(): Promise<boolean>;
  identity(): string | null;
  model(): string;
  generate(text: string): Promise<Float32Array | null>;
  populate(path: string): Promise<CorpusEmbeddingSummary>;
}
export interface PreparationDependencies {
  loadRuntime: () => Promise<PreparationRuntime>;
  expectedCounts: { questions: number; entries: number };
  expectedInputSha256: string;
}
interface FileDigest { path: string; bytes: number; sha256: string }
export interface PreparationManifest {
  schema_version: 1;
  status: "prepared";
  measurement: "new_reproduction_not_historical_provenance";
  as_of: string;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  input: FileDigest;
  dataset: { adapter: "longmemeval"; split: "s"; granularity: "session"; search_mode: "hybrid"; haystack_policy: "per_question_namespace"; source_url: string; expected_input_sha256: string };
  embedding: { model: string; identity: string; dimensions: 384; local_files_only: boolean };
  runtime: { node: string; versions: NodeJS.ProcessVersions; platform: string; arch: string };
  source: { revision: string; dirty: boolean; source_sha256: Record<string, string>; package_lock_sha256: string };
  model_artifacts: FileDigest[];
  counts: { questions: number; entries: number; generated: number; failed: number; skipped: number; vector_rows: number; unique_query_texts: number };
  files: Record<"snapshot" | "queries" | "vectors" | "build_provenance", FileDigest>;
}
export function hashFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256"); const chunk = Buffer.alloc(1024 * 1024); let count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, count));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
function digest(path: string, base?: string): FileDigest {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Artifact must be a regular file: ${path}`);
  return { path: base ? relative(base, path).split(sep).join("/") : path, bytes: info.size, sha256: hashFile(path) };
}
function sourceIdentity(): PreparationManifest["source"] {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Cannot establish source revision");
  return {
    revision,
    dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: ROOT, encoding: "utf8" }).trim().length > 0,
    source_sha256: Object.fromEntries(SOURCE_FILES.map((path) => [path, hashFile(join(ROOT, path))])),
    package_lock_sha256: hashFile(join(ROOT, "package-lock.json")),
  };
}
/** Refuse aliases before creating anything. Only new descendants of benchmark/generated are owned. */
function ownOutputDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("output-dir must be absolute beneath benchmark/generated/");
  const output = resolve(path); const marker = `${sep}benchmark${sep}generated${sep}`;
  const position = output.lastIndexOf(marker);
  if (position < 0) throw new Error("output-dir must be beneath benchmark/generated/");
  const generated = output.slice(0, position + marker.length - 1);
  const relativeParts = relative(generated, output).split(sep);
  if (relativeParts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid generated output directory");
  // The owning repository/benchmark parent must already exist. Do not create an arbitrary repository root.
  const benchmark = dirname(generated);
  if (!statSync(benchmark).isDirectory()) throw new Error("benchmark parent must exist");
  if (lstatSync(benchmark).isSymbolicLink()) throw new Error("output-dir parent cannot be a symlink");
  let current = generated;
  for (let index = 0; index <= relativeParts.length; index++) {
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new Error("output-dir cannot contain symlink aliases");
    if (index === relativeParts.length) {
      if (info) throw new Error("output-dir already exists; preparation never resumes or overwrites");
      mkdirSync(current, { mode: 0o700 });
      return realpathSync(current);
    }
    if (info && !info.isDirectory()) throw new Error("output-dir parent is not a directory");
    if (!info) mkdirSync(current, { mode: 0o700 });
    current = join(current, relativeParts[index]);
  }
  throw new Error("Invalid output-dir");
}
function modelArtifacts(outputDir: string): FileDigest[] {
  const root = join(outputDir, "hf-cache", BGE_MODEL, BGE_REVISION);
  const files: FileDigest[] = [];
  function visit(path: string): void {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("Model artifacts cannot be symlinks");
    if (info.isDirectory()) { for (const child of readdirSync(path).sort()) visit(join(path, child)); }
    else { const file = digest(path, root); if (file.bytes === 0) throw new Error("Empty model artifact"); files.push(file); }
  }
  visit(root);
  for (const required of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"]) {
    if (!files.some((file) => file.path === required)) throw new Error(`Missing pinned model artifact: ${required}`);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function checkBinding(runtime: PreparationRuntime, identity: string): void {
  if (runtime.identity() !== identity || runtime.model() !== BGE_MODEL) throw new Error("Active embedding binding changed during preparation");
}
function validateIdentity(value: string | null): string {
  if (value === null) throw new Error("Active immutable embedding identity unavailable");
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const expected = { version: 1, model: BGE_MODEL, revision: BGE_REVISION, dtype: "fp32", dimensions: 384, pooling: "mean", normalize: true, preprocessing: "raw-text-v1", platform: process.platform, arch: process.arch, execution_provider: "cpu" };
  for (const [key, item] of Object.entries(expected)) if (parsed[key] !== item) throw new Error(`Unexpected embedding identity: ${key}`);
  for (const key of ["transformers_version", "onnxruntime_node_version"]) {
    if (typeof parsed[key] !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(parsed[key])) throw new Error("Missing runtime embedding identity");
  }
  return value;
}
async function productionRuntime(): Promise<PreparationRuntime> {
  const [builder, embeddings, shared] = await Promise.all([import("../adapters/longmemeval/build.js"), import("../../src/embeddings.js"), import("../adapters/shared.js")]);
  return { build: builder.buildLongMemEvalArtifacts, initialize: embeddings.initEmbeddings, identity: embeddings.getActiveEmbeddingIdentity, model: embeddings.getActiveEmbeddingModel, generate: embeddings.generateEmbedding, populate: shared.populateCorpusEmbeddings };
}
function checkNoSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) if (existsSync(path + suffix)) throw new Error(`Snapshot sidecar remains: ${suffix}`);
}
async function detachSnapshot(dbPath: string, snapshot: string, identity: string, expectedEntries: number): Promise<void> {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    sqliteVec.load(db);
    const rows = db.prepare(`WITH vector_rows AS MATERIALIZED (SELECT entry_id, vec_length(embedding) AS dimensions FROM entries_vec)
      SELECT COUNT(*) AS total, SUM(CASE WHEN e.is_current = 1 AND e.embedding_status = 'generated'
      AND e.embedding_model = ? AND e.embedding_identity = ? AND v.dimensions = 384 THEN 1 ELSE 0 END) AS compatible
      FROM entries e LEFT JOIN vector_rows v ON e.id = v.entry_id`).get(BGE_MODEL, identity) as { total: number; compatible: number };
    const vectors = db.prepare("SELECT COUNT(*) AS count FROM entries_vec").get() as { count: number };
    if (rows.total !== expectedEntries || rows.compatible !== expectedEntries || vectors.count !== expectedEntries) throw new Error("Incomplete or incompatible corpus vectors");
    const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (checkpoint.some((row) => row.busy !== 0)) throw new Error("Corpus checkpoint remained busy");
    await db.backup(snapshot);
  } finally { db.close(); }
  const copy = new Database(snapshot, { fileMustExist: true });
  try {
    if (copy.pragma("journal_mode = DELETE", { simple: true }) !== "delete") throw new Error("Cannot detach snapshot journal mode");
    if (copy.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Snapshot integrity check failed");
    if ((copy.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Snapshot foreign-key check failed");
  } finally { copy.close(); }
  const fd = openSync(snapshot, "r");
  try { const header = Buffer.alloc(100); if (readSync(fd, header, 0, 100, 0) !== 100 || header[18] !== 1 || header[19] !== 1) throw new Error("Snapshot lacks detached DELETE header"); }
  finally { closeSync(fd); }
  checkNoSidecars(snapshot);
  chmodSync(snapshot, 0o600);
}
/** Failure leaves the exclusively owned directory and diagnostic receipt for inspection. */
export async function prepare(options: PreparationOptions, dependencies: PreparationDependencies = { loadRuntime: productionRuntime, expectedCounts: { questions: 500, entries: 23854 }, expectedInputSha256: LONGMEMEVAL_S_SHA256 }): Promise<PreparationManifest> {
  // Transformers 4.3.1 discovery drops local_files_only before model loading.
  // A fresh owned cache cannot support an honest offline preparation promise.
  if (!options.allowModelDownload) throw new Error("Fresh preparation requires explicit --allow-model-download; no output or model initialization was attempted");
  const asOf = normalizeAsOf(options.asOf);
  if (!isAbsolute(options.input)) throw new Error("input must be an explicit absolute path");
  const input = realpathSync(options.input); const inputDigest = digest(input);
  if (inputDigest.sha256 !== dependencies.expectedInputSha256) throw new Error("Raw input hash differs from the pinned LongMemEval-S dataset");
  const source = sourceIdentity();
  const outputDir = ownOutputDirectory(options.outputDir);
  const started = performance.now(); const startedAt = new Date().toISOString();
  const dbPath = join(outputDir, "corpus.db"); const queryPath = join(outputDir, "queries.jsonl");
  const provenancePath = join(outputDir, "build-provenance.json"); const vectorPath = join(outputDir, "query-vectors.json"); const snapshot = join(outputDir, "snapshot.db");
  // Set before loading any module that captures embedding/profile configuration.
  const environment = { MUNIN_MEMORY_DB_PATH: dbPath, MUNIN_EMBEDDINGS_ENABLED: "true", MUNIN_EMBEDDINGS_MODEL: BGE_MODEL, MUNIN_EMBEDDINGS_REVISION: BGE_REVISION, MUNIN_EMBEDDINGS_DTYPE: "fp32", MUNIN_EMBEDDINGS_LOCAL_ONLY: options.allowModelDownload ? "false" : "true", MUNIN_SEMANTIC_ENABLED: "true", MUNIN_HYBRID_ENABLED: "true" };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const runtime = await dependencies.loadRuntime();
    const converted = await withFrozenClock(asOf, () => Promise.resolve(runtime.build({ split: "s", granularity: "session", searchMode: "hybrid", inputPath: input, dbPath, queryPath, provenancePath })));
    const expected = dependencies.expectedCounts;
    if (converted.stats.item_count !== expected.questions || converted.stats.query_count !== expected.questions || converted.stats.entry_count !== expected.entries || converted.stats.skipped_queries_missing_answer_sessions !== 0) throw new Error("LongMemEval full dataset count mismatch");
    const queryDigest = digest(queryPath, outputDir);
    const queries = validateQueries(readFileSync(queryPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown));
    if (queries.length !== expected.questions || queries.some((q) => !q.scope_namespace?.startsWith("benchmarks/longmemeval/s/q/")) || new Set(queries.map((q) => q.scope_namespace)).size !== expected.questions) throw new Error("Invalid question count or per-question namespace isolation");
    if (!await runtime.initialize()) throw new Error("Pinned embedding initialization failed; a cold cache requires explicit --allow-model-download");
    const identity = validateIdentity(runtime.identity()); checkBinding(runtime, identity);
    const artifacts = modelArtifacts(outputDir);
    const summary = await runtime.populate(dbPath);
    if (summary.total !== expected.entries || summary.generated !== expected.entries || summary.failed !== 0 || summary.skipped !== 0 || summary.vector_rows !== expected.entries) throw new Error("Fresh corpus embedding count mismatch or failed generation");
    checkBinding(runtime, identity);
    const byText = new Map<string, number[]>(); const vectors: Record<string, number[]> = {};
    for (const query of queries) {
      let vector = byText.get(query.query);
      if (!vector) {
        const generated = await runtime.generate(query.query);
        checkBinding(runtime, identity);
        if (!(generated instanceof Float32Array) || generated.length !== 384 || !generated.every(Number.isFinite)) throw new Error(`Invalid query embedding: ${query.id}`);
        vector = Array.from(generated); byText.set(query.query, vector);
      }
      vectors[query.id] = vector;
    }
    const frozen: FrozenVectors = { schema_version: 1, query_set_sha256: queryDigest.sha256, model: BGE_MODEL, identity, dimensions: 384, vectors };
    validateVectors(frozen, queries, queryDigest.sha256);
    writeFileSync(vectorPath, JSON.stringify(frozen, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const vectorDigest = digest(vectorPath, outputDir);
    const provenanceDigest = digest(provenancePath, outputDir);
    if (canonical(modelArtifacts(outputDir)) !== canonical(artifacts)) throw new Error("Pinned model artifacts changed during generation");
    if (hashFile(input) !== inputDigest.sha256) throw new Error("Raw input changed during preparation");
    if (hashFile(queryPath) !== queryDigest.sha256) throw new Error("Queries changed during preparation");
    checkBinding(runtime, identity);
    await detachSnapshot(dbPath, snapshot, identity, expected.entries);
    if (hashFile(input) !== inputDigest.sha256) throw new Error("Raw input changed during preparation");
    for (const file of [queryDigest, vectorDigest, provenanceDigest]) {
      if (hashFile(join(outputDir, file.path)) !== file.sha256) throw new Error("Generated input changed during preparation");
    }
    if (canonical(modelArtifacts(outputDir)) !== canonical(artifacts)) throw new Error("Pinned model artifacts changed during snapshot preparation");
    checkBinding(runtime, identity);
    if (canonical(sourceIdentity()) !== canonical(source)) throw new Error("Preparation source changed during generation");
    const manifest: PreparationManifest = {
      schema_version: 1, status: "prepared", measurement: "new_reproduction_not_historical_provenance", as_of: asOf, started_at: startedAt, completed_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started), input: inputDigest,
      dataset: { adapter: "longmemeval", split: "s", granularity: "session", search_mode: "hybrid", haystack_policy: "per_question_namespace", source_url: DATASET_URL, expected_input_sha256: dependencies.expectedInputSha256 },
      embedding: { model: BGE_MODEL, identity, dimensions: 384, local_files_only: !options.allowModelDownload },
      runtime: { node: process.version, versions: { ...process.versions }, platform: process.platform, arch: process.arch }, source, model_artifacts: artifacts,
      counts: { questions: queries.length, entries: summary.total, generated: summary.generated, failed: summary.failed, skipped: summary.skipped, vector_rows: summary.vector_rows, unique_query_texts: byText.size },
      files: { snapshot: digest(snapshot, outputDir), queries: queryDigest, vectors: vectorDigest, build_provenance: provenanceDigest },
    };
    writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown preparation failure";
    writeFileSync(join(outputDir, "failure.json"), JSON.stringify({ schema_version: 1, status: "failed", error: message, started_at: startedAt, failed_at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const USAGE = "Usage: npm run benchmark:evidence:prepare -- --input ABSOLUTE_PATH --output-dir ABSOLUTE_NEW_BENCHMARK_GENERATED_DIR --as-of ISO_TIMESTAMP [--allow-model-download]";
export async function main(args: string[]): Promise<0 | 2> {
  try {
    const values: Record<string, string> = {}; let allowModelDownload = false;
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (key === "--allow-model-download" && !allowModelDownload) { allowModelDownload = true; continue; }
      const value = args[++index];
      if (!["--input", "--output-dir", "--as-of"].includes(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new Error(USAGE);
      values[key] = value;
    }
    if (!values["--input"] || !values["--output-dir"] || !values["--as-of"]) throw new Error(USAGE);
    const manifest = await prepare({ input: values["--input"], outputDir: values["--output-dir"], asOf: values["--as-of"], allowModelDownload });
    process.stdout.write(`Prepared ${manifest.counts.questions} questions and ${manifest.counts.entries} entries. Manifest: ${join(values["--output-dir"], "manifest.json")}\n`);
    return 0;
  } catch (error) { process.stderr.write(`Evidence preparation failed: ${error instanceof Error ? error.message : "Unknown error"}\n`); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
