import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  appendLog,
  getById,
  storeEmbedding,
  vecLoaded,
  writeState,
} from "../src/db.js";
import {
  _embeddingConfig,
  embeddingToBuffer,
  getActiveEmbeddingModel,
} from "../src/embeddings.js";
import * as embeddings from "../src/embeddings.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";
import { applyProductionReranker, executeQuery, runBenchmark } from "../benchmark/runner.js";
import type { BenchmarkQuery } from "../benchmark/types.js";
import type { Entry, QueryParams } from "../src/types.js";

type ExecuteQueryResult = Awaited<ReturnType<typeof executeQuery>>;

/** Select the raw or production retrieval contract explicitly. */
function executeWithRunnerMode(
  db: Database.Database,
  query: string,
  mode: "lexical" | "semantic" | "hybrid",
  limit: number,
  runnerMode: "raw" | "production_ranker",
): Promise<ExecuteQueryResult> {
  return executeQuery(db, query, mode, limit, undefined, undefined, undefined, runnerMode);
}

const EMBEDDING_DIM = 384;

function makeEmbedding(seed: number): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  for (let index = 0; index < EMBEDDING_DIM; index += 1) {
    vector[index] = Math.sin(seed * (index + 1) * 0.1) * 0.1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  for (let index = 0; index < EMBEDDING_DIM; index += 1) vector[index] /= norm;
  return vector;
}

function seedEmbedded(
  db: Database.Database,
  namespace: string,
  key: string,
  content: string,
  seed: number,
  validUntil?: string | null,
): string {
  const id = writeState(db, namespace, key, content, [], "test", undefined, validUntil).id;
  storeEmbedding(db, id, embeddingToBuffer(makeEmbedding(seed)), getActiveEmbeddingModel());
  return id;
}

describe("benchmark runner production retrieval parity", () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "runner-production-parity-"));
    db = initDatabase(join(tempDir, "snapshot.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it("production mode excludes expired lexical candidates while raw mode preserves legacy inclusion", async () => {
    const expiredId = writeState(
      db,
      "projects/expired",
      "status",
      "expired parity probe",
      [],
      "test",
      undefined,
      "2000-01-01T00:00:00.000Z",
    ).id;

    const raw = await executeWithRunnerMode(db, "expired parity probe", "lexical", 10, "raw");
    expect(raw.entries.map((entry) => entry.id)).toContain(expiredId);

    const production = await executeWithRunnerMode(
      db,
      "expired parity probe",
      "lexical",
      10,
      "production_ranker",
    );
    expect(production.entries.map((entry) => entry.id)).not.toContain(expiredId);

    const liveId = writeState(db, "projects/live", "status", "expired parity probe", []).id;
    const query: BenchmarkQuery = {
      id: "expired-report",
      query: "expired parity probe",
      source: "manual",
      category: "temporal",
      search_mode: "lexical",
      expected_ids: [liveId],
    };
    const report = await runBenchmark(join(tempDir, "snapshot.db"), [query], {
      runnerMode: "production_ranker",
      querySetSources: [],
      manifestPath: null,
    });
    expect(report.queries[0]?.result_ids).toEqual([liveId]);
  });

  it("production mode fetches beyond the public ten-result limit for lexical and hybrid legs", async () => {
    const lexicalIds: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      lexicalIds.push(writeState(db, `bulk/${index}`, "status", "overfetch parity token", []).id);
    }

    const raw = await executeWithRunnerMode(db, "overfetch parity token", "lexical", 10, "raw");
    const production = await executeWithRunnerMode(
      db,
      "overfetch parity token",
      "lexical",
      10,
      "production_ranker",
    );
    expect(raw.entries).toHaveLength(10);
    expect(production.entries.map((entry) => entry.id)).toEqual(lexicalIds);

    expect(vecLoaded()).toBe(true);
    const hybridIds: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = writeState(db, `hybrid/${index}`, "status", "hybrid overfetch parity token", []).id;
      storeEmbedding(db, id, embeddingToBuffer(makeEmbedding(1)), getActiveEmbeddingModel());
      hybridIds.push(id);
    }
    const provider = () => makeEmbedding(1);
    const hybrid = executeQuery(
      db,
      "hybrid overfetch parity token",
      "hybrid",
      10,
      provider,
      undefined,
      undefined,
      "production_ranker",
    );
    const hybridResult = await hybrid;
    expect(hybridResult.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(hybridIds),
    );
    expect(hybridResult.entries).toHaveLength(60);
  });

  it("production mode caps an oversized lexical probe at the 500-candidate contract", async () => {
    for (let index = 0; index < 550; index += 1) {
      writeState(db, `bulk-cap/${index}`, "status", "oversized probe parity token", []);
    }

    const production = await executeWithRunnerMode(
      db,
      "oversized probe parity token",
      "lexical",
      10,
      "production_ranker",
    );
    expect(production.entries).toHaveLength(500);
  });

  it("production mode applies the configured semantic distance cutoff to semantic and hybrid legs", async () => {
    expect(vecLoaded()).toBe(true);
    const previousMaxDistance = _embeddingConfig.semanticMaxDistance;
    _embeddingConfig.semanticMaxDistance = 0.01;
    try {
      const closeId = seedEmbedded(db, "distance/close", "status", "semantic cutoff close", 1);
      const farId = seedEmbedded(db, "distance/far", "status", "semantic cutoff far", 3);
      const provider = () => makeEmbedding(1);

      const semantic = executeQuery(
        db,
        "semantic cutoff",
        "semantic",
        10,
        provider,
        undefined,
        undefined,
        "production_ranker",
      );
      expect((await semantic).entries.map((entry) => entry.id)).toEqual([closeId]);
      expect((await semantic).entries.map((entry) => entry.id)).not.toContain(farId);
      const rawSemantic = await executeQuery(db, "semantic cutoff", "semantic", 10, provider);
      expect(rawSemantic.entries.map((entry) => entry.id)).toContain(farId);

      const hybrid = executeQuery(
        db,
        "semantic cutoff close",
        "hybrid",
        10,
        provider,
        undefined,
        undefined,
        "production_ranker",
      );
      expect((await hybrid).entries.map((entry) => entry.id)).toEqual([closeId]);
    } finally {
      _embeddingConfig.semanticMaxDistance = previousMaxDistance;
    }
  });

  it("production mode excludes expired candidates from relaxed lexical, semantic, and hybrid retrieval", async () => {
    expect(vecLoaded()).toBe(true);
    const expiredId = seedEmbedded(
      db,
      "expired/vector",
      "status",
      "expired vector sentinel",
      1,
      "2000-01-01T00:00:00.000Z",
    );
    const liveId = seedEmbedded(db, "live/vector", "status", "live vector sentinel", 1);
    const provider = () => makeEmbedding(1);

    const relaxed = await executeWithRunnerMode(
      db,
      "expired vector sentinel missing-term",
      "lexical",
      10,
      "production_ranker",
    );
    expect(relaxed.relaxed).toBe(true);
    expect(relaxed.entries.map((entry) => entry.id)).toEqual([liveId]);
    expect(relaxed.entries.map((entry) => entry.id)).not.toContain(expiredId);
    for (const mode of ["semantic", "hybrid"] as const) {
      const fallback = await executeQuery(db, "expired vector sentinel missing-term", mode, 10, () => null, undefined, undefined, "production_ranker");
      expect(fallback.effectiveMode).toBe("lexical");
      expect(fallback.relaxed).toBe(true);
      expect(fallback.entries.map((entry) => entry.id)).toEqual([liveId]);
    }

    const semantic = executeQuery(
      db,
      "vector sentinel",
      "semantic",
      10,
      provider,
      undefined,
      undefined,
      "production_ranker",
    );
    expect((await semantic).entries.map((entry) => entry.id)).toEqual([liveId]);

    const hybrid = executeQuery(
      db,
      "live vector sentinel",
      "hybrid",
      10,
      provider,
      undefined,
      undefined,
      "production_ranker",
    );
    expect((await hybrid).entries.map((entry) => entry.id)).toContain(liveId);
    expect((await hybrid).entries.map((entry) => entry.id)).not.toContain(expiredId);
  });

  it("keeps the production rerank window at 50 and leaves the tail in retrieval order", () => {
    const plainIds: string[] = [];
    const plainEntries: Entry[] = [];
    for (let index = 0; index < 50; index += 1) {
      const id = writeState(
        db,
        `notes/plain-${index}`,
        "note",
        "plain retrieval candidate",
        [],
      ).id;
      plainIds.push(id);
      plainEntries.push(db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Entry);
    }

    const tailIds: string[] = [];
    const tailEntries: Entry[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = writeState(
        db,
        `projects/tail-${index}`,
        "status",
        "tracked retrieval candidate",
        ["active"],
      ).id;
      tailIds.push(id);
      tailEntries.push(db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Entry);
    }

    const queryParams: QueryParams = {
      query: "needle unique",
      limit: 60,
      search_mode: "lexical",
      search_recency_weight: 0,
      include_expired: false,
    };
    const reranked = applyProductionReranker(
      db,
      [...plainEntries, ...tailEntries],
      queryParams,
      60,
    );

    // The head is structurally reranked; the tail stays in retrieval order.
    // A whole-array rerank incorrectly lifts tracked statuses from positions
    // 51–60 into the first 50.
    expect(reranked.map((entry) => entry.id)).toEqual([...plainIds, ...tailIds]);
  });

  it("counts eligible tail matches before promoting a supposedly unique exact anchor", () => {
    const anchorId = appendLog(db, "notes/anchor", "zarquon-flimflam-42", []).id;
    const anchor = getById(db, anchorId)!;
    const head = [anchor];
    for (let index = 1; index < 50; index += 1) {
      const id = writeState(db, `projects/noise-${index}`, "status", "unrelated active project", ["active"]).id;
      head.push(getById(db, id)!);
    }
    const tailId = appendLog(db, "notes/tail", "also zarquon-flimflam-42", []).id;
    const tail = getById(db, tailId)!;
    const params: QueryParams = { query: "zarquon-flimflam-42", search_recency_weight: 0 };
    expect(applyProductionReranker(db, head, params, 10)[0].id).toBe(anchorId);
    const withTail = applyProductionReranker(db, [...head, tail], params, 10);
    expect(withTail[0].id).not.toBe(anchorId);
    expect(withTail[0].id).toBe(head[1].id);

    // A suppressed tail match must not block uniqueness.
    const demoId = appendLog(db, "demo/anchor", "zarquon-flimflam-42", []).id;
    expect(applyProductionReranker(db, [...head, getById(db, demoId)!], params, 10)[0].id).toBe(anchorId);
  });

  it.each([
    ["lexical", undefined], ["semantic", undefined], ["hybrid", undefined],
    ["lexical", "notes"], ["semantic", "notes"], ["hybrid", "notes"],
  ] as const)(
    "matches default memory_query IDs for %s (namespace %s) on an oversized corpus with expiry, cutoff and suppression",
    async (mode, namespace) => {
      expect(vecLoaded()).toBe(true);
      const previousMaxDistance = _embeddingConfig.semanticMaxDistance;
      _embeddingConfig.semanticMaxDistance = 0.01;
      vi.spyOn(embeddings, "isSemanticEnabled").mockReturnValue(true);
      vi.spyOn(embeddings, "isHybridEnabled").mockReturnValue(true);
      vi.spyOn(embeddings, "generateEmbedding").mockResolvedValue(makeEmbedding(1));
      try {
        for (let index = 0; index < 55; index += 1) {
          seedEmbedded(db, `demo/${index}`, "note", "rankcanary", 1);
        }
        const liveIds = new Set<string>();
        for (let index = 0; index < 10; index += 1) {
          liveIds.add(seedEmbedded(db, `notes/live-${index}`, "note", "rankcanary", 1));
        }
        const expiredId = seedEmbedded(db, "notes/expired", "note", "rankcanary", 1, "2000-01-01T00:00:00.000Z");
        const farId = seedEmbedded(db, "notes/far", "note", "unrelatedcandidate", 3);
        const server = new Server({ name: "runner-vector-parity", version: "0.0.1" }, { capabilities: { tools: {} } });
        registerTools(server, db, "runner-vector-parity", ownerContext());
        const handler = (server as unknown as {
          _requestHandlers: Map<string, (request: unknown) => Promise<{ content: Array<{ text: string }> }>>;
        })._requestHandlers.get("tools/call")!;
        const response = await handler({ method: "tools/call", params: {
          name: "memory_query", arguments: { query: "rankcanary", search_mode: mode, namespace, limit: 10 },
        } });
        const production = JSON.parse(response.content[0].text) as {
          results: Array<{ id: string }>;
          search_mode: string;
          search_mode_actual?: string;
        };
        expect(production.search_mode_actual ?? production.search_mode).toBe(mode);
        const productionIds = production.results.map((entry) => entry.id);
        expect(productionIds).toHaveLength(10);
        expect(productionIds.every((id) => liveIds.has(id))).toBe(true);
        expect(productionIds).not.toContain(expiredId);
        expect(productionIds).not.toContain(farId);
        const query: BenchmarkQuery = {
          id: `e2e-${mode}`, query: "rankcanary", source: "manual",
          category: "exact-identifier", search_mode: mode, scope_namespace: namespace, expected_ids: [...liveIds],
        };
        const report = await runBenchmark(join(tempDir, "snapshot.db"), [query], {
          runnerMode: "production_ranker", queryEmbeddingProvider: () => makeEmbedding(1),
          queryEmbeddingModel: getActiveEmbeddingModel(), querySetSources: [], manifestPath: null,
        });
        expect(report.queries[0].actual_mode ?? report.queries[0].search_mode).toBe(mode);
        expect(report.queries[0].result_ids).toEqual(productionIds);
      } finally {
        _embeddingConfig.semanticMaxDistance = previousMaxDistance;
      }
    },
  );

});
