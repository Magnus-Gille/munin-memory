import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  initDatabase,
  writeState,
  vecLoaded,
  storeEmbedding,
  queryEntriesSemanticScored,
  filterIdsMatchingFts,
} from "../src/db.js";
import {
  embeddingToBuffer,
  _setExtractorForTesting,
  resetCircuitBreaker,
  getActiveEmbeddingModel,
} from "../src/embeddings.js";
import { registerTools } from "../src/tools.js";

const TEST_DB_PATH = "/tmp/munin-memory-semantic-threshold-test.db";
const EMBEDDING_DIM = 384;

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

function makeEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] = Math.sin(seed * (i + 1) * 0.1) * 0.1;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] /= norm;
  return arr;
}

// Maps query/content keywords to embedding seeds so we can drive hybrid mode
// deterministically without a real model.
function mockExtractor(text: string) {
  const seeds: Record<string, number> = { cat: 1, dog: 2, fish: 3, zebraclock: 99 };
  const lower = text.toLowerCase();
  for (const [kw, seed] of Object.entries(seeds)) {
    if (lower.includes(kw)) return Promise.resolve({ data: makeEmbedding(seed) });
  }
  return Promise.resolve({ data: makeEmbedding(42) });
}

const probeDb = initDatabase("/tmp/munin-memory-semantic-threshold-probe.db");
const vecAvailable = vecLoaded();
probeDb.close();
cleanupTestDb();
for (const suffix of ["", "-wal", "-shm"]) {
  const p = "/tmp/munin-memory-semantic-threshold-probe.db" + suffix;
  if (existsSync(p)) unlinkSync(p);
}

let db: Database.Database;
let server: Server;

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("no handler");
  return await handler({ method: "tools/call", params: { name, arguments: args } });
}

function parse(response: unknown): Record<string, unknown> {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  resetCircuitBreaker();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setExtractorForTesting(mockExtractor as any);
  server = new Server({ name: "test-munin", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, db, "session-semantic-threshold");
});

afterEach(() => {
  _setExtractorForTesting(null);
  db.close();
  cleanupTestDb();
});

function seedEntry(namespace: string, key: string, content: string, seed: number, tags: string[] = []) {
  const { id } = writeState(db, namespace, key, content, tags);
  storeEmbedding(db, id, embeddingToBuffer(makeEmbedding(seed)), getActiveEmbeddingModel());
  db.prepare("UPDATE entries SET embedding_status = 'generated' WHERE id = ?").run(id);
  return id;
}

describe("queryEntriesSemanticScored maxDistance cutoff (#77)", () => {
  it.skipIf(!vecAvailable)("drops candidates beyond the max distance", () => {
    const close = seedEntry("animals/cat", "info", "all about cat", 1);
    seedEntry("animals/fish", "info", "all about fish", 3);

    const queryEmb = embeddingToBuffer(makeEmbedding(1)); // identical to the cat vector

    const unbounded = queryEntriesSemanticScored(db, { queryEmbedding: queryEmb });
    expect(unbounded.length).toBe(2);

    // A tight cutoff keeps only the (near-)exact match.
    const bounded = queryEntriesSemanticScored(db, { queryEmbedding: queryEmb, maxDistance: 0.01 });
    expect(bounded.length).toBe(1);
    expect(bounded[0].entry.id).toBe(close);
  });

  it.skipIf(!vecAvailable)("is unbounded by default (no regression)", () => {
    seedEntry("animals/cat", "info", "all about cat", 1);
    seedEntry("animals/fish", "info", "all about fish", 3);
    const results = queryEntriesSemanticScored(db, { queryEmbedding: embeddingToBuffer(makeEmbedding(50)) });
    expect(results.length).toBe(2);
  });
});

describe("filterIdsMatchingFts (#77 anchor existence check)", () => {
  it("returns the subset of ids that lexically match, regardless of lexical rank", () => {
    const { id: catId } = writeState(db, "animals/cat", "info", "all about the cat", []);
    const { id: dogId } = writeState(db, "animals/dog", "info", "all about the dog", []);

    const matches = filterIdsMatchingFts(db, "cat", [catId, dogId]);
    expect(matches.has(catId)).toBe(true);
    expect(matches.has(dogId)).toBe(false);
  });

  it("returns an empty set for an empty id list", () => {
    expect(filterIdsMatchingFts(db, "anything", []).size).toBe(0);
  });
});

describe("memory_query require_lexical_match + semantic-only warning (#77)", () => {
  it.skipIf(!vecAvailable)("warns when a hybrid query degrades to semantic-only (no FTS5 match)", async () => {
    // Entry has a 'cat' vector but the query token 'zebraclock' shares no
    // lexical term with it, so FTS5 finds nothing and recall is vector-only.
    seedEntry("animals/cat", "info", "all about the cat", 1);

    const raw = await callTool("memory_query", { query: "zebraclock", search_mode: "hybrid" });
    const result = parse(raw) as { results: unknown[]; warning?: string; search_mode_actual?: string };

    // Vector recall returned the (unrelated) entry, but with a warning.
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.warning).toBeTruthy();
    expect(String(result.warning)).toContain("lexical");
  });

  it.skipIf(!vecAvailable)("suppresses semantic-only results when require_lexical_match is true", async () => {
    seedEntry("animals/cat", "info", "all about the cat", 1);

    const withFlag = parse(await callTool("memory_query", {
      query: "zebraclock",
      search_mode: "hybrid",
      require_lexical_match: true,
    })) as { results: unknown[] };
    expect(withFlag.results.length).toBe(0);

    const withoutFlag = parse(await callTool("memory_query", {
      query: "zebraclock",
      search_mode: "hybrid",
    })) as { results: unknown[] };
    expect(withoutFlag.results.length).toBeGreaterThan(0);
  });

  it.skipIf(!vecAvailable)("keeps relaxed-fallback lexical anchors under require_lexical_match", async () => {
    // A natural-language query has no exact (AND-of-all-terms) FTS match, so the
    // hybrid leg falls back to the relaxed lexical query and anchors the entry
    // via the "cat" token. require_lexical_match must not drop it just because
    // the scoped *exact*-query existence check finds nothing.
    seedEntry("animals/cat", "info", "all about the cat", 1);

    const withFlag = parse(await callTool("memory_query", {
      query: "tell me about cat",
      search_mode: "hybrid",
      require_lexical_match: true,
    })) as { results: Array<{ namespace: string }> };

    const withoutFlag = parse(await callTool("memory_query", {
      query: "tell me about cat",
      search_mode: "hybrid",
    })) as { results: Array<{ namespace: string }> };

    // Whatever the relaxed leg returns without the flag must survive with it.
    expect(withoutFlag.results.some((r) => r.namespace === "animals/cat")).toBe(true);
    expect(withFlag.results.some((r) => r.namespace === "animals/cat")).toBe(true);
  });

  it.skipIf(!vecAvailable)("keeps lexically-anchored hybrid results under require_lexical_match", async () => {
    seedEntry("animals/cat", "info", "all about the cat", 1);

    const result = parse(await callTool("memory_query", {
      query: "cat",
      search_mode: "hybrid",
      require_lexical_match: true,
    })) as { results: Array<{ namespace: string }> };
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some((r) => r.namespace === "animals/cat")).toBe(true);
  });

  it.skipIf(!vecAvailable)("keeps a lexically-matching hybrid result whose FTS rank is below the over-fetch window", async () => {
    // The anchor check for require_lexical_match must rely on a scoped FTS
    // existence query (filterIdsMatchingFts) rather than the RRF result's
    // lexicalRank, which is only populated for entries inside the limit*5 FTS
    // over-fetch window. Seed many strong "cat" lexical matches so a sparse,
    // exact-vector-match entry ranks below that window, then assert it is not
    // dropped as anchorless.
    for (let i = 0; i < 14; i++) {
      writeState(db, `bulk/cat-${i}`, "info", `cat cat cat cats cats note ${i}`, []);
    }
    const targetId = seedEntry("animals/special", "info", "a special cat", 1);

    const result = parse(await callTool("memory_query", {
      query: "cat",
      search_mode: "hybrid",
      require_lexical_match: true,
      limit: 2,
    })) as { results: Array<{ id: string }> };

    expect(result.results.some((r) => r.id === targetId)).toBe(true);
  });

  it("computes the lexical anchor set via a scoped FTS existence check, not rank depth", () => {
    // Direct guard for the #77 fix: filterIdsMatchingFts must report a lexical
    // match for an entry regardless of how it would rank in a windowed FTS
    // query. Seed many higher-ranking matches, then confirm a low-ranked but
    // genuine match is still reported as anchored.
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { id } = writeState(db, `bulk/cat-${i}`, "info", `cat cat cat cats cats ${i}`, []);
      ids.push(id);
    }
    const { id: sparseId } = writeState(db, "animals/sparse", "info", "a special cat here", []);
    ids.push(sparseId);

    const anchored = filterIdsMatchingFts(db, "cat", ids);
    expect(anchored.has(sparseId)).toBe(true);
  });
});
