/**
 * PR 2b parity test — the benchmark runner's `production_ranker` mode
 * must produce the same top-k result IDs as `memory_query` for the same
 * snapshot DB + query.
 *
 * If this test ever fails, it means the runner's pipeline composition
 * has drifted from `src/tools.ts:5924-5936`. Re-sync the runner before
 * publishing benchmark numbers — a divergent runner reports retrieval
 * quality that real users will never see.
 *
 * The test deliberately uses a small handcrafted corpus (no LongMemEval
 * data) so failures are debuggable without external downloads.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase, writeState, appendLog } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";
import { runBenchmark } from "../benchmark/runner.js";
import type { BenchmarkQuery } from "../benchmark/types.js";

interface MemoryQueryResultEntry {
  id: string;
  namespace: string;
  key?: string | null;
}

interface MemoryQueryResponse {
  results: MemoryQueryResultEntry[];
  total: number;
  search_mode: string;
  search_mode_actual?: string;
}

async function callTool(
  server: Server,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => unknown>;
  })._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("tools/call handler not registered");
  return handler({ method: "tools/call", params: { name, arguments: args } });
}

function parseMemoryQuery(response: unknown): MemoryQueryResponse {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text) as MemoryQueryResponse;
}

/**
 * Seed the DB with a small mixed corpus: tracked-project statuses, a
 * canonical reference-index entry, some chronological logs, and a few
 * noise entries. The mix matters — too uniform and the rerank pipeline
 * has nothing to reorder, so the parity assertion becomes trivial.
 */
function seedCorpus(db: Database.Database): void {
  // Tracked-status entries (drive attention/canonical injection)
  writeState(db, "projects/alpha", "status", "Active project alpha. Blockers: dependency on bravo.", ["active"]);
  writeState(db, "projects/bravo", "status", "Blocked on review for bravo retrieval changes.", ["blocked"]);
  writeState(db, "projects/charlie", "status", "Completed feature charlie.", ["completed"]);
  writeState(db, "clients/delta", "status", "Delta engagement renewed; quarterly check-in scheduled.", ["active"]);

  // Canonical entries
  writeState(db, "meta", "reference-index", "Catalog of important Munin namespaces and conventions.", ["canonical"]);
  writeState(db, "people/magnus", "profile", "Owner of the Munin Memory project. Prefers terse outputs.", ["canonical"]);

  // Plain notes
  writeState(db, "decisions/ranker", "v1", "Decided to apply heuristic rerank + freshness over raw FTS5 scores.", ["decision"]);
  writeState(db, "decisions/embedding", "v1", "Decided to ship local Transformers.js embeddings before any remote API option.", ["decision"]);

  // Logs (no key — append_log)
  appendLog(db, "projects/alpha", "Made progress on alpha retrieval changes today.", ["progress"]);
  appendLog(db, "projects/bravo", "Discovered new edge case in bravo lexical fallback.", ["bug"]);
  appendLog(db, "projects/alpha", "Pair-debugged with reviewer; landed reranker fix in alpha branch.", ["progress"]);

  // Noise entries unrelated to typical queries
  writeState(db, "meta/test", "demo-noise-1", "Zucchini risotto recipe with parmesan and lemon zest.", []);
  writeState(db, "meta/test", "demo-noise-2", "Notes on the migratory pattern of arctic terns.", []);
}

describe("benchmark runner — production_ranker parity with memory_query", () => {
  let tmp: string;
  let dbPath: string;
  let db: Database.Database;
  let server: Server;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-parity-"));
    dbPath = join(tmp, "snap.db");
    db = initDatabase(dbPath);
    seedCorpus(db);
    server = new Server(
      { name: "munin-parity-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, db, "parity-session", ownerContext());
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Run the same query through both surfaces and assert top-k ID equality.
   *
   * `memory_query` already runs the rerank pipeline; the runner's
   * production_ranker mode must match it byte-for-byte on the result-ID
   * sequence. Latency and explain payloads are not part of parity — only
   * the ordered IDs are.
   */
  async function assertParity(query: string, searchMode: "lexical" | "semantic" | "hybrid" = "lexical") {
    // 1. Production: hit memory_query through the registered MCP handler.
    const prodRaw = await callTool(server, "memory_query", {
      query,
      search_mode: searchMode,
      limit: 10,
      include_expired: true,
    });
    const prod = parseMemoryQuery(prodRaw);
    const prodMode = prod.search_mode_actual ?? prod.search_mode;
    const prodIds = prod.results.map((r) => r.id);

    // 2. Runner: same DB, same query, production_ranker mode.
    const benchQuery: BenchmarkQuery = {
      id: "parity-1",
      query,
      source: "manual",
      category: "broad-orientation",
      search_mode: searchMode,
      // expected_ids is required by the runner ground-truth gate; we don't
      // care what scores it computes — only that it returns the entries.
      expected_ids: prodIds.length > 0 ? [prodIds[0]] : ["__never__"],
    };
    const report = await runBenchmark(dbPath, [benchQuery], {
      runnerMode: "production_ranker",
      querySetSources: [], // suppress lineage-untracked warning
      manifestPath: null,
    });
    // Only the lineage warning is allowed to slip through here. Anything
    // else (especially "downgraded to raw mode") would invalidate parity.
    const realWarnings = (report.warnings ?? []).filter(
      (w) => !w.includes("query_set_sources not tracked"),
    );
    expect(realWarnings).toEqual([]);
    expect(report.runner_mode).toBe("production_ranker");
    expect(report.runner_mode_requested).toBe("production_ranker");
    expect(report.queries).toHaveLength(1);
    const runnerIds = report.queries[0].result_ids;

    // 3. Parity: both surfaces must agree on the ordered top-k IDs.
    // We compare the prefix up to min(len) so that limit cutoffs match
    // exactly — they should already be the same since both apply
    // requestedLimit=10, but if memory_query returns fewer due to a
    // post-rerank filter (e.g. ACL), allow the runner to return the
    // same prefix.
    expect(runnerIds.slice(0, prodIds.length)).toEqual(prodIds);
    // Sanity: the runner must record the actual mode the same way.
    if (prodMode !== searchMode) {
      expect(report.queries[0].actual_mode).toBe(prodMode);
    }
  }

  it("matches memory_query for a tracked-status query (lexical)", async () => {
    await assertParity("blocked review");
  });

  it("matches memory_query for a broad-orientation query that triggers canonical injection", async () => {
    await assertParity("how should I orient on munin reference");
  });

  it("matches memory_query for a decision-lookup query", async () => {
    await assertParity("reranker decision");
  });

  it("matches memory_query for a noisy query that misses everything (relaxed lexical fallback)", async () => {
    // Multiword query with no exact match → exercises the relaxed-OR
    // fallback both surfaces share.
    await assertParity("arctic terns migratory snippet");
  });
});

describe("benchmark runner — production_ranker prereq handling", () => {
  let tmp: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-prereq-"));
    dbPath = join(tmp, "snap.db");
    db = initDatabase(dbPath);
    writeState(db, "projects/x", "status", "Active.", ["active"]);
    db.close();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const benchQuery: BenchmarkQuery = {
    id: "prereq-1",
    query: "active",
    source: "manual",
    category: "broad-orientation",
    search_mode: "lexical",
    expected_ids: ["__never__"],
  };

  it("emits both runner_mode and runner_mode_requested on a successful production_ranker run", async () => {
    const report = await runBenchmark(dbPath, [benchQuery], {
      runnerMode: "production_ranker",
      manifestPath: null,
    });
    expect(report.runner_mode).toBe("production_ranker");
    expect(report.runner_mode_requested).toBe("production_ranker");
    expect(report.search_recency_weight).toBe(0.2);
    expect(report.principal_id).toBe("owner");
  });

  it("reports search_recency_weight: null for raw mode (no rerank ran)", async () => {
    const report = await runBenchmark(dbPath, [benchQuery], {
      runnerMode: "raw",
      manifestPath: null,
    });
    expect(report.runner_mode).toBe("raw");
    expect(report.runner_mode_requested).toBe("raw");
    expect(report.search_recency_weight).toBeNull();
  });

  it("downgrades to raw with a warning when fallbackRunnerMode is opt-in", async () => {
    // Build a snapshot whose schema_version row reads as 0 — too old for
    // production_ranker prereq. Easiest way is to manipulate the
    // schema_version table directly on a fresh DB.
    const oldDb = new Database(dbPath);
    oldDb.prepare("DELETE FROM schema_version").run();
    oldDb.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
    oldDb.close();

    const report = await runBenchmark(dbPath, [benchQuery], {
      runnerMode: "production_ranker",
      fallbackRunnerMode: "raw",
      manifestPath: null,
    });
    expect(report.runner_mode).toBe("raw");
    expect(report.runner_mode_requested).toBe("production_ranker");
    expect(report.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining("downgraded to raw mode")]),
    );
  });

  it("throws when production_ranker prereqs fail and no fallback is opted in", async () => {
    const oldDb = new Database(dbPath);
    oldDb.prepare("DELETE FROM schema_version").run();
    oldDb.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
    oldDb.close();

    await expect(
      runBenchmark(dbPath, [benchQuery], {
        runnerMode: "production_ranker",
        manifestPath: null,
      }),
    ).rejects.toThrow(/production_ranker prerequisites not met/);
  });
});
