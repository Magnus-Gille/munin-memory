/**
 * #406 (TOCTOU): the existing-entry ceiling check must hold in the same
 * transaction as the write. A second connection to the same SQLite file (the
 * admin CLI, another process) can raise an entry's classification after the
 * early check but before the write; the write must then be denied and leave
 * the row untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";
import type { AccessContext } from "../src/access.js";

const NS = "projects/race";
const ORIGINAL = "FIXTURE_RACE_ORIGINAL_CONTENT";

let dir: string;
let db: Database.Database;
let other: Database.Database;

function makeCallTool(ctx: AccessContext) {
  const server = new Server(
    { name: "test-munin-ceiling-race", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ctx);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    const response = (await handler({ method: "tools/call", params: { name, arguments: args } })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
  };
}

/**
 * An agent whose ceiling covers the entry while it is `internal`. On the
 * second ceiling read (after the early check, before the write) a second
 * connection raises the entry's classification to client-restricted.
 */
function racingAgent(key: string): AccessContext {
  let reads = 0;
  return {
    principalId: "agent-race",
    principalType: "agent",
    accessibleNamespaces: [{ pattern: "projects/*", permissions: "rw" }],
    transportType: "consumer",
    get maxClassification() {
      reads += 1;
      if (reads === 2) {
        other.prepare(
          "UPDATE entries SET classification = 'client-restricted' WHERE namespace = ? AND key = ?",
        ).run(NS, key);
      }
      return "internal" as const;
    },
  };
}

const row = (key: string) =>
  JSON.stringify(db.prepare("SELECT * FROM entries WHERE namespace = ? AND key = ?").get(NS, key));

describe("existing-entry ceiling check is atomic with the write (#406)", () => {
  beforeEach(async () => {
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    dir = mkdtempSync(join(tmpdir(), "munin-ceiling-race-"));
    const file = join(dir, "munin.db");
    db = initDatabase(file);
    // A second connection to the same file, as the admin CLI or another
    // process would hold. initDatabase also registers the custom SQL functions
    // the entries triggers need.
    other = initDatabase(file);
    const owner = makeCallTool(ownerContext());
    expect((await owner("memory_write", {
      namespace: NS, key: "note", content: ORIGINAL, classification: "internal",
    })).status).toBe("created");
    expect((await owner("memory_write", {
      namespace: NS, key: "status", content: `## Phase\nPlanning\n\n## Notes\n${ORIGINAL}`,
      tags: ["active"], classification: "internal",
    })).status).toBe("created");
  });

  afterEach(() => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    other.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, string, Record<string, unknown>, (() => Promise<Record<string, unknown>>) | null]> = [
    ["tag-only patch", "note", { name: "memory_write", args: { patch: { tags_add: ["x"] }, classification: "internal" } }, null],
    ["full overwrite", "note", { name: "memory_write", args: { content: "replacement", classification: "internal" } }, null],
    ["status update", "status", { name: "memory_update_status", args: { phase: "Reviewed", classification: "internal" } }, null],
  ];

  for (const [label, key, call] of cases) {
    it(`denies a ${label} when the entry is raised between the check and the write`, async () => {
      const spec = call as { name: string; args: Record<string, unknown> };
      const caller = makeCallTool(racingAgent(key));
      const result = await caller(spec.name, { namespace: NS, ...(key === "note" ? { key } : {}), ...spec.args });

      // The raise itself is the only change; the write must not have gone through.
      expect(result.ok).toBe(false);
      expect(result.error).toBe("access_denied");
      const stored = db.prepare("SELECT classification, content FROM entries WHERE namespace = ? AND key = ?").get(NS, key) as { classification: string; content: string };
      expect(stored.classification).toBe("client-restricted");
      expect(stored.content).toContain(ORIGINAL);
      expect(row(key)).toContain(ORIGINAL);
    });
  }
});
