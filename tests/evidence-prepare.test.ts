import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildLongMemEvalArtifacts } from "../benchmark/adapters/longmemeval/build.js";
import { initDatabase, storeEmbedding } from "../src/db.js";
import { evaluate } from "../benchmark/evidence-metric/evaluate.js";
import { BGE_MODEL, BGE_REVISION, hashFile, prepare, type PreparationRuntime } from "../benchmark/evidence-metric/prepare.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const asOf = "2026-10-01T00:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "munin-prepare-test-")); directories.push(dir);
  const generated = join(dir, "benchmark/generated"); mkdirSync(generated, { recursive: true });
  const input = join(dir, "raw.json");
  writeFileSync(input, readFileSync(new URL("../benchmark/adapters/longmemeval/fixtures/sample-longmemeval.json", import.meta.url)));
  return { dir, input, outputDir: join(generated, "fresh"), asOf, allowModelDownload: true };
}
function fake(options: ReturnType<typeof fixture>, change?: (runtime: PreparationRuntime) => void) {
  const identity = JSON.stringify({ version: 1, model: BGE_MODEL, revision: BGE_REVISION, dtype: "fp32", dimensions: 384, pooling: "mean", normalize: true, preprocessing: "raw-text-v1", transformers_version: "4.3.1", onnxruntime_node_version: "1.30.0", platform: process.platform, arch: process.arch, execution_provider: "cpu" });
  const calls: string[] = [];
  const vector = new Float32Array(384); vector[0] = Math.fround(0.123456789); vector[1] = 1;
  const runtime: PreparationRuntime = {
    build: buildLongMemEvalArtifacts,
    initialize: () => {
      const root = join(options.outputDir, "hf-cache", BGE_MODEL, BGE_REVISION);
      mkdirSync(join(root, "onnx"), { recursive: true });
      for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"]) writeFileSync(join(root, file), file);
      return Promise.resolve(true);
    },
    identity: () => identity,
    model: () => BGE_MODEL,
    generate: (text) => { calls.push(text); return Promise.resolve(vector); },
    populate: (path) => {
      const db = initDatabase(path);
      const rows = db.prepare("SELECT id FROM entries").all() as { id: string }[];
      for (const row of rows) storeEmbedding(db, row.id, Buffer.from(vector.buffer), BGE_MODEL, identity);
      db.close();
      return Promise.resolve({ total: rows.length, generated: rows.length, failed: 0, skipped: 0, vector_rows: rows.length });
    },
  };
  change?.(runtime);
  return { runtime, calls, vector, dependencies: { expectedCounts: { questions: 2, entries: 4 }, expectedInputSha256: hashFile(options.input), loadRuntime: () => Promise.resolve(runtime) } };
}
describe("fresh evidence preparation", () => {
  it("refuses preparation without explicit download before loading runtime or creating output", async () => {
    const options = fixture(); const f = fake(options);
    const loadRuntime = vi.fn(f.dependencies.loadRuntime);
    const build = vi.spyOn(f.runtime, "build");
    const initialize = vi.spyOn(f.runtime, "initialize");
    const before = hashFile(options.input);
    await expect(prepare({ ...options, allowModelDownload: undefined }, { ...f.dependencies, loadRuntime })).rejects.toThrow(/--allow-model-download/);
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(readdirSync(join(options.dir, "benchmark/generated"))).toEqual([]);
    expect(hashFile(options.input)).toBe(before);
  });
  it("freezes ingestion, records hashes and exact float32 vectors, and feeds the strict offline lane", async () => {
    const options = fixture(); const before = hashFile(options.input); const f = fake(options);
    const manifest = await prepare(options, f.dependencies);
    expect(hashFile(options.input)).toBe(before);
    expect(manifest.schema_version).toBe(1);
    expect(manifest.as_of).toBe(asOf);
    expect(manifest.counts).toMatchObject({ questions: 2, entries: 4, generated: 4, vector_rows: 4 });
    expect(manifest.model_artifacts.map((file) => file.path)).toEqual(["config.json", "onnx/model.onnx", "tokenizer.json", "tokenizer_config.json"]);
    const vectors = JSON.parse(readFileSync(join(options.outputDir, "query-vectors.json"), "utf8")) as { vectors: Record<string, number[]> };
    expect(Buffer.from(Float32Array.from(Object.values(vectors.vectors)[0]).buffer)).toEqual(Buffer.from(f.vector.buffer));
    const db = new Database(join(options.outputDir, "snapshot.db"), { readonly: true });
    expect(statSync(join(options.outputDir, "snapshot.db")).mode & 0o777).toBe(0o600);
    expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
    expect(db.prepare("SELECT DISTINCT valid_from FROM entries").all()).toEqual([{ valid_from: null }]); db.close();
    expect(JSON.parse(readFileSync(join(options.outputDir, "build-provenance.json"), "utf8"))).toMatchObject({ generated_at: asOf });
    expect(readdirSync(options.outputDir).some((file) => /-(wal|shm|journal)$/.test(file))).toBe(false);
    for (const file of Object.values(manifest.files)) expect(hashFile(join(options.outputDir, file.path))).toBe(file.sha256);
    const result = await evaluate({ snapshot: join(options.outputDir, "snapshot.db"), queries: join(options.outputDir, "queries.jsonl"), vectors: join(options.outputDir, "query-vectors.json"), asOf });
    expect(result.report.summary.query_count).toBe(2);
    expect(result.report.quality_state).toBe("not_measured");
    expect(f.calls).toHaveLength(2);
  });
  it("rejects existing paths, paths outside generated, and symlink parents without touching input", async () => {
    const options = fixture(); const before = hashFile(options.input); const f = fake(options);
    mkdirSync(options.outputDir);
    await expect(prepare(options, f.dependencies)).rejects.toThrow(/exist/);
    await expect(prepare({ ...options, outputDir: join(options.dir, "elsewhere") }, f.dependencies)).rejects.toThrow(/benchmark\/generated/);
    const alias = join(options.dir, "benchmark/generated/alias"); symlinkSync(options.dir, alias);
    await expect(prepare({ ...options, outputDir: join(alias, "fresh") }, f.dependencies)).rejects.toThrow(/symlink/);
    expect(hashFile(options.input)).toBe(before);
  });
  it("rejects a partial dataset before initializing a model and retains diagnostics", async () => {
    const options = fixture(); let initialized = false;
    const f = fake(options, (runtime) => { runtime.initialize = () => { initialized = true; return Promise.resolve(true); }; });
    await expect(prepare(options, { ...f.dependencies, expectedCounts: { questions: 500, entries: 23854 } })).rejects.toThrow(/count/);
    expect(initialized).toBe(false);
    expect(JSON.parse(readFileSync(join(options.outputDir, "failure.json"), "utf8"))).toMatchObject({ status: "failed" });
  });
  it("rejects an unpinned raw input before creating the output directory", async () => {
    const options = fixture(); const f = fake(options);
    await expect(prepare(options, { ...f.dependencies, expectedInputSha256: "0".repeat(64) })).rejects.toThrow(/input hash/);
    expect(readdirSync(join(options.dir, "benchmark/generated"))).toEqual([]);
  });
  it("rejects failed corpus generation and changed binding or model file bytes", async () => {
    for (const kind of ["failed", "identity", "cache"] as const) {
      const options = fixture(); const f = fake(options, (runtime) => {
        const populate = runtime.populate;
        runtime.populate = async (path) => {
          const result = await populate(path);
          if (kind === "failed") result.failed = 1;
          if (kind === "identity") runtime.identity = () => null;
          if (kind === "cache") writeFileSync(join(options.outputDir, "hf-cache", BGE_MODEL, BGE_REVISION, "onnx/model.onnx"), "changed");
          return result;
        };
      });
      await expect(prepare(options, f.dependencies)).rejects.toThrow(/corpus|binding|artifacts/);
      expect(readdirSync(options.outputDir)).not.toContain("manifest.json");
    }
  });
  it("deduplicates identical query text and rejects input changes during generation", async () => {
    const options = fixture();
    const items = JSON.parse(readFileSync(options.input, "utf8")) as { question: string }[];
    items[1].question = items[0].question; writeFileSync(options.input, JSON.stringify(items));
    const f = fake(options);
    await prepare(options, f.dependencies); expect(f.calls).toHaveLength(1);
    const changed = fixture(); const g = fake(changed, (runtime) => {
      const generate = runtime.generate;
      runtime.generate = (text) => { writeFileSync(changed.input, readFileSync(changed.input, "utf8") + "\n"); return generate(text); };
    });
    await expect(prepare(changed, g.dependencies)).rejects.toThrow(/input changed/);
  });
});
