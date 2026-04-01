import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";

// Mock @huggingface/transformers before any imports that use it
const mockPipeline = vi.fn().mockResolvedValue(vi.fn());
const mockEnv: Record<string, unknown> = {};

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
  };
});

import { initEmbeddings } from "../src/embeddings.js";

describe("initEmbeddings cache directory integration", () => {
  const originalDbPath = process.env.MUNIN_MEMORY_DB_PATH;

  beforeEach(() => {
    mockPipeline.mockClear();
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

    // transformers.env.cacheDir was set to absolute path
    expect(mockEnv.cacheDir).toBe(expectedCacheDir);

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

    expect(mockEnv.cacheDir).toBe(expectedCacheDir);
    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ cache_dir: expectedCacheDir }),
    );
  });

  it("never passes a raw tilde path to transformers", async () => {
    delete process.env.MUNIN_MEMORY_DB_PATH;

    await initEmbeddings();

    const cacheDir = mockEnv.cacheDir as string;
    expect(cacheDir).toBeDefined();
    expect(cacheDir).not.toContain("~");
    expect(cacheDir.startsWith("/")).toBe(true);
  });
});
