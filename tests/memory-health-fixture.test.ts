/**
 * Drift-guard test for docs/examples/memory-health.json.
 *
 * Generates a fresh memory_health payload (same seeded DB) and asserts
 * it has the identical nested key structure as the committed fixture.
 * Catches any schema drift — added/removed fields — before Heimdall
 * (or any other consumer) would see it in production.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  initDatabase,
  writeState,
  appendLog,
  upsertConsolidationMetadata,
} from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, "..", "docs", "examples", "memory-health.json");

// ---------------------------------------------------------------------------
// The 7 contract section names — canonical as of schema_version 2
// ---------------------------------------------------------------------------
const CONTRACT_SECTIONS = [
  "embedding",
  "size",
  "retrieval",
  "classification",
  "maintenance",
  "consolidation",
  "security_events",
];

// ---------------------------------------------------------------------------
// Shared seed — must match gen-health-example.ts exactly
// ---------------------------------------------------------------------------
function seed(db: Database.Database): void {
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

  writeState(db, "meta/telos", "telos", "Magnus wants resilient AI memory.", ["meta"]);

  for (let i = 0; i < 5; i++) {
    appendLog(db, "projects/demo", `Decision log entry ${i + 1}: chose approach A over B`, ["decision"]);
  }

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
}

// ---------------------------------------------------------------------------
// Tool invocation helper
// ---------------------------------------------------------------------------
async function callHealth(db: Database.Database): Promise<Record<string, unknown>> {
  const server = new Server(
    { name: "test-health-fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ownerContext());

  const handler = (
    server as unknown as { _requestHandlers: Map<string, (...a: unknown[]) => unknown> }
  )._requestHandlers?.get("tools/call");
  if (!handler) throw new Error("tools/call handler not found");

  const raw = await handler({ method: "tools/call", params: { name: "memory_health", arguments: {} } });
  const resp = raw as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Key-path collector: collects every "a.b.c" path to a non-object leaf
// across the full JSON tree (excluding array indices — we treat arrays
// as value leaves). Returns a sorted array.
// ---------------------------------------------------------------------------
function collectKeyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") {
    return prefix ? [prefix] : [];
  }
  if (Array.isArray(obj)) {
    // Recurse into array ITEMS with a "[]" wildcard so item-internal key
    // renames (e.g. backlog[].unincorporated -> ...unincorporated_log_count)
    // are pinned too. Empty arrays record the array path itself as a leaf.
    if (obj.length === 0) return prefix ? [prefix] : [];
    const paths: string[] = [];
    for (const item of obj) paths.push(...collectKeyPaths(item, `${prefix}[]`));
    return [...new Set(paths)].sort();
  }
  const paths: string[] = [];
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const child = (obj as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(...collectKeyPaths(child, path));
  }
  return [...new Set(paths)].sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_health fixture drift-guard", () => {
  it("committed fixture has schema_version 2 and exactly 7 contract sections", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Record<string, unknown>;
    expect(fixture["schema_version"]).toBe(2);
    const sections = Object.keys(
      (fixture["sections"] as Record<string, unknown>) ?? {},
    ).sort();
    expect(sections).toEqual([...CONTRACT_SECTIONS].sort());
  });

  it("fresh payload has the same nested key structure as the committed fixture", async () => {
    const db: Database.Database = initDatabase(":memory:");
    seed(db);

    let fresh: Record<string, unknown>;
    try {
      fresh = await callHealth(db);
    } finally {
      db.close();
    }

    // Normalise generated_at in both (value-only change; doesn't affect structure)
    fresh["generated_at"] = "NORMALISED";
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Record<string, unknown>;
    (fixture as Record<string, unknown>)["generated_at"] = "NORMALISED";

    const freshPaths = collectKeyPaths(fresh);
    const fixturePaths = collectKeyPaths(fixture);

    expect(freshPaths, "Key paths in fresh payload must match committed fixture").toEqual(fixturePaths);
  });
});
