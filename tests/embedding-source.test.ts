import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoConfig, env } from "@huggingface/transformers";
import { withPinnedEmbeddingSource } from "../src/internal/embedding-source.js";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OTHER_REVISION = "abcdef0123456789abcdef0123456789abcdef01";
const MODEL_ID = "owner/repo";
function sourceState() {
  return {
  localModelPath: env.localModelPath,
  allowLocalModels: env.allowLocalModels,
  allowRemoteModels: env.allowRemoteModels,
  cacheDir: env.cacheDir,
  useFSCache: env.useFSCache,
  useBrowserCache: env.useBrowserCache,
  useCustomCache: env.useCustomCache,
  remoteHost: env.remoteHost,
  remotePathTemplate: env.remotePathTemplate,
  };
}
const originalSourceState = sourceState();
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(env, originalSourceState);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "munin-pinned-source-"));
  directories.push(directory);
  return directory;
}

function writeConfig(path: string, marker: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "config.json"), JSON.stringify({
    model_type: "bert",
    hidden_size: marker === "old-local" ? 17 : 23,
    num_hidden_layers: marker === "old-local" ? 91 : marker === "pinned" ? 3 : 7,
    marker,
  }));
}

describe("withPinnedEmbeddingSource", () => {
  it("uses the cached pinned revision instead of unversioned local config and never fetches", async () => {
    const root = fixtureDirectory();
    const cacheDir = join(root, "cache");
    const localRoot = join(root, "models");
    writeConfig(join(localRoot, MODEL_ID), "old-local");
    writeConfig(join(cacheDir, MODEL_ID, REVISION), "pinned");
    env.localModelPath = localRoot;
    const fetch = vi.spyOn(env, "fetch").mockRejectedValue(new Error("network must not be used"));

    const config = await withPinnedEmbeddingSource(env, cacheDir, () => AutoConfig.from_pretrained(MODEL_ID, {
      local_files_only: true,
      revision: REVISION,
    }));

    expect(config.num_hidden_layers).toBe(3);
    expect(config.hidden_size).toBe(23);
    expect(fetch).not.toHaveBeenCalled();
    expect(env.localModelPath).toBe(localRoot);
    expect(readdirSync(cacheDir).sort()).toEqual(["owner"]);
    writeConfig(join(localRoot, MODEL_ID), "mutated-old-local");
    const again = await withPinnedEmbeddingSource(env, cacheDir, () => AutoConfig.from_pretrained(MODEL_ID, {
      local_files_only: true,
      revision: REVISION,
    }));
    expect(again.num_hidden_layers).toBe(3);
    expect(readFileSync(join(localRoot, MODEL_ID, "config.json"), "utf8")).toContain("mutated-old-local");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing revision cache entry instead of falling back to local config", async () => {
    const root = fixtureDirectory();
    const cacheDir = join(root, "cache");
    const localRoot = join(root, "models");
    writeConfig(join(localRoot, MODEL_ID), "old-local");
    writeConfig(join(cacheDir, MODEL_ID, REVISION), "pinned");
    env.localModelPath = localRoot;
    const fetch = vi.spyOn(env, "fetch").mockRejectedValue(new Error("network must not be used"));

    await expect(withPinnedEmbeddingSource(env, cacheDir, () => AutoConfig.from_pretrained(MODEL_ID, {
      local_files_only: true,
      revision: OTHER_REVISION,
    }))).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(cacheDir).sort()).toEqual(["owner"]);
  });

  it("preserves an offline caller policy on a revision cache miss", async () => {
    const root = fixtureDirectory();
    const cacheDir = join(root, "cache");
    const localRoot = join(root, "models");
    writeConfig(join(localRoot, MODEL_ID), "old-local");
    env.localModelPath = localRoot;
    env.allowRemoteModels = false;
    const fetch = vi.spyOn(env, "fetch").mockRejectedValue(new Error("network must not be used"));

    await expect(withPinnedEmbeddingSource(env, cacheDir, () => AutoConfig.from_pretrained(MODEL_ID, {
      revision: OTHER_REVISION,
    }))).rejects.toThrow();

    expect(fetch).not.toHaveBeenCalled();
    expect(env.allowRemoteModels).toBe(false);
    expect(env.localModelPath).toBe(localRoot);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("restores the Transformers environment and removes its scratch root when loading fails", async () => {
    const root = fixtureDirectory();
    const cacheDir = join(root, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const beforeEntries = readdirSync(cacheDir);
    const before = { ...originalSourceState };

    await expect(withPinnedEmbeddingSource(env, cacheDir, async () => {
      expect(env.localModelPath).not.toBe(before.localModelPath);
      expect(readdirSync(env.localModelPath)).toEqual([]);
      throw new Error("synthetic loader failure");
    })).rejects.toThrow("synthetic loader failure");

    expect(sourceState()).toEqual(before);
    expect(env.localModelPath).toBe(before.localModelPath);
    expect(readdirSync(cacheDir)).toEqual(beforeEntries);
  });

  it("serializes overlapping loads so each sees its own empty local root", async () => {
    const root = fixtureDirectory();
    const firstCache = join(root, "first-cache");
    const secondCache = join(root, "second-cache");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const roots: string[] = [];
    const first = withPinnedEmbeddingSource(env, firstCache, async () => {
      roots.push(env.localModelPath);
      expect(readdirSync(env.localModelPath)).toEqual([]);
      await firstGate;
      return env.cacheDir;
    });
    const second = withPinnedEmbeddingSource(env, secondCache, async () => {
      roots.push(env.localModelPath);
      expect(readdirSync(env.localModelPath)).toEqual([]);
      return env.cacheDir;
    });

    await Promise.resolve();
    expect(roots).toHaveLength(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([firstCache, secondCache]);
    expect(roots).toHaveLength(2);
    expect(new Set(roots).size).toBe(2);
    expect(env.localModelPath).toBe(originalSourceState.localModelPath);
    expect(readdirSync(firstCache)).toEqual([]);
    expect(readdirSync(secondCache)).toEqual([]);
  });
});
