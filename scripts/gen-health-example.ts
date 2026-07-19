/**
 * Generator: docs/examples/memory-health.json
 *
 * Creates an in-memory DB, seeds it with representative data, calls
 * memory_health via the real MCP tool handler, normalises generated_at
 * to a fixed sentinel, and writes the pretty-printed result to
 * docs/examples/memory-health.json.
 *
 * Usage:
 *   npx tsx scripts/gen-health-example.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  initDatabase,
  writeState,
  appendLog,
  upsertConsolidationMetadata,
  logRetrievalEvent,
  recordAccessDenied,
} from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seed(db: Database.Database): void {
  // Three state entries
  writeState(db, "projects/demo", "status", JSON.stringify({
    phase: "M2",
    current_work: "Heimdall integration",
    blockers: "",
    next_steps: "- Wire up health endpoint\n- Ship fixture",
    notes: "Seeded by gen-health-example",
  }), ["active"]);

  writeState(db, "projects/scion", "status", JSON.stringify({
    phase: "planning",
    current_work: "Architecture design",
    blockers: "",
    next_steps: "- Finalize schema",
    notes: "",
  }), ["active"]);

  writeState(db, "meta/telos", "telos", "The owner wants resilient AI memory.", ["meta"]);

  // Several log entries under projects/demo (exercises consolidation backlog)
  for (let i = 0; i < 5; i++) {
    appendLog(db, "projects/demo", `Decision log entry ${i + 1}: chose approach A over B`, ["decision"]);
  }

  // ONE consolidation_metadata row with non-null last_consolidated_at + run_duration_ms
  upsertConsolidationMetadata(db, {
    namespace: "projects/demo",
    last_consolidated_at: "2026-06-28T12:00:00.000Z",
    last_log_id: null,
    last_log_created_at: null,
    synthesis_model: "anthropic/claude-haiku-4-5-20251001",
    synthesis_token_count: 412,
    run_duration_ms: 1843,
    drain_in_progress: 0,
  });

  // A timed memory_query retrieval event so retrieval.latency_p50_ms/p95_ms are non-null.
  logRetrievalEvent(db, {
    sessionId: "seed-session",
    toolName: "memory_query",
    queryText: "demo",
    requestedMode: "lexical",
    actualMode: "lexical",
    resultIds: [],
    resultNamespaces: [],
    resultRanks: [],
    durationMs: 12,
  });

  // An access-denied security event so classification.access_denied_7d is non-zero.
  recordAccessDenied(db, "agent:demo", "memory_read");
}

// ---------------------------------------------------------------------------
// Invoke tool
// ---------------------------------------------------------------------------

async function callTool(
  db: Database.Database,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const server = new Server(
    { name: "gen-health-example", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ownerContext());

  const handler = (
    server as unknown as { _requestHandlers: Map<string, (...a: unknown[]) => unknown> }
  )._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("tools/call handler not found");

  return handler({ method: "tools/call", params: { name, arguments: args } });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const db = initDatabase(":memory:");
seed(db);

const raw = await callTool(db, "memory_health");
const resp = raw as { content: Array<{ text: string }> };
const payload = JSON.parse(resp.content[0].text) as Record<string, unknown>;

// Normalise generated_at so the fixture is stable across runs
payload["generated_at"] = "2026-06-29T00:00:00.000Z";

const outDir = join(REPO_ROOT, "docs", "examples");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "memory-health.json");
writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");

db.close();

process.stdout.write(`Written: ${outPath}\n`);
process.stdout.write(`schema_version: ${(payload as Record<string, unknown>)["schema_version"]}\n`);
process.stdout.write(`ok: ${(payload as Record<string, unknown>)["ok"]}\n`);
const sections = (payload as Record<string, unknown>)["sections"] as Record<string, unknown>;
process.stdout.write(`sections: ${Object.keys(sections).join(", ")}\n`);
const consolidation = sections["consolidation"] as Record<string, unknown>;
process.stdout.write(`last_synthesis_at: ${consolidation["last_synthesis_at"]}\n`);
process.stdout.write(`avg_latency_ms: ${consolidation["avg_latency_ms"]}\n`);
