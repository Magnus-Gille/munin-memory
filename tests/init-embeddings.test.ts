import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";

// Mock @huggingface/transformers before any imports that use it
const mockPipelineEnvSnapshots: Array<Record<string, unknown>> = [];
let mockScratchSequence = 0;
const mockPipeline = vi.fn().mockImplementation(async () => {
  mockPipelineEnvSnapshots.push({
    localModelPath: mockEnv.localModelPath,
    allowLocalModels: mockEnv.allowLocalModels,
    allowRemoteModels: mockEnv.allowRemoteModels,
    cacheDir: mockEnv.cacheDir,
    useFSCache: mockEnv.useFSCache,
    useBrowserCache: mockEnv.useBrowserCache,
    useCustomCache: mockEnv.useCustomCache,
    remoteHost: mockEnv.remoteHost,
    remotePathTemplate: mockEnv.remotePathTemplate,
  });
  return vi.fn();
});
const mockEnv: Record<string, unknown> = { allowRemoteModels: true };

vi.mock("@huggingface/transformers", () => ({
  env: mockEnv,
  pipeline: mockPipeline,
}));

// Mock vecLoaded to return true (so initEmbeddings doesn't bail early)
vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return {
    ...actual,
    vecLoaded: () => true,
  };
});

// Mock fs so mkdirSync doesn't fail on non-writable paths
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) =>
      typeof p === "string" && p.endsWith("/hf-cache") ? true : actual.existsSync(p),
    mkdirSync: (p: string, opts?: unknown) => {
      if (typeof p === "string" && p.endsWith("/hf-cache")) return undefined;
      return actual.mkdirSync(p, opts as Parameters<typeof actual.mkdirSync>[1]);
    },
    mkdtempSync: (p: string) => `${p}${++mockScratchSequence}`,
    rmdirSync: () => undefined,
  };
});

import { _setExtractorForTesting, initEmbeddings } from "../src/embeddings.js";

describe("initEmbeddings cache directory integration", () => {
  const originalDbPath = process.env.MUNIN_MEMORY_DB_PATH;

  beforeEach(() => {
    mockPipeline.mockClear();
    mockPipelineEnvSnapshots.length = 0;
    _setExtractorForTesting(null);
    delete mockEnv.cacheDir;
  });

  afterEach(() => {
    if (originalDbPath !== undefined) {
      process.env.MUNIN_MEMORY_DB_PATH = originalDbPath;
    } else {
      delete process.env.MUNIN_MEMORY_DB_PATH;
    }
  });

  it("sets transformers cacheDir to resolved absolute path (default DB path)", async () => {
    delete process.env.MUNIN_MEMORY_DB_PATH;

    const result = await initEmbeddings();
    expect(result).toBe(true);

    const expectedCacheDir = `${homedir()}/.munin-memory/hf-cache`;

    // The scoped source environment is visible during pipeline construction, then restored.
    expect(mockPipelineEnvSnapshots).toHaveLength(1);
    expect(mockPipelineEnvSnapshots[0]).toMatchObject({
      cacheDir: expectedCacheDir,
      localModelPath: expect.stringContaining(".munin-empty-model-source-"),
      allowLocalModels: true,
      allowRemoteModels: true,
      useFSCache: true,
      useBrowserCache: false,
      useCustomCache: false,
    });
    expect(mockEnv).toMatchObject({
      localModelPath: undefined,
      allowLocalModels: undefined,
      allowRemoteModels: true,
      cacheDir: undefined,
      useFSCache: undefined,
      useBrowserCache: undefined,
      useCustomCache: undefined,
      remoteHost: undefined,
      remotePathTemplate: undefined,
    });

    // pipeline() was called with cache_dir set to the same absolute path
    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ cache_dir: expectedCacheDir }),
    );
  });

  it("sets transformers cacheDir to resolved absolute path (custom DB path)", async () => {
    process.env.MUNIN_MEMORY_DB_PATH = "/var/lib/munin-memory/memory.db";

    const result = await initEmbeddings();
    expect(result).toBe(true);

    const expectedCacheDir = "/var/lib/munin-memory/hf-cache";

    expect(mockPipelineEnvSnapshots).toHaveLength(1);
    expect(mockPipelineEnvSnapshots[0]).toMatchObject({
      cacheDir: expectedCacheDir,
      localModelPath: expect.stringContaining(".munin-empty-model-source-"),
    });
    expect(mockEnv).toMatchObject({
      localModelPath: undefined,
      allowLocalModels: undefined,
      allowRemoteModels: true,
      cacheDir: undefined,
      useFSCache: undefined,
      useBrowserCache: undefined,
      useCustomCache: undefined,
      remoteHost: undefined,
      remotePathTemplate: undefined,
    });
    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ cache_dir: expectedCacheDir }),
    );
  });

  it("never passes a raw tilde path to transformers", async () => {
    process.env.MUNIN_MEMORY_DB_PATH = "~/munin-test/memory.db";

    await initEmbeddings();

    const cacheDir = mockPipelineEnvSnapshots[0]?.cacheDir as string;
    expect(cacheDir).toBeDefined();
    expect(cacheDir).toBe(`${homedir()}/munin-test/hf-cache`);
    expect(cacheDir).not.toContain("~");
    expect(cacheDir.startsWith("/")).toBe(true);
    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ cache_dir: cacheDir }),
    );
    expect(mockEnv).toMatchObject({
      localModelPath: undefined,
      allowLocalModels: undefined,
      allowRemoteModels: true,
      cacheDir: undefined,
      useFSCache: undefined,
      useBrowserCache: undefined,
      useCustomCache: undefined,
      remoteHost: undefined,
      remotePathTemplate: undefined,
    });
  });
});
