import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { createTestStorage } from "./helpers/test-storage.js";

/**
 * Token-overhead ratchet for the MCP tool surface (MUNIN tool-surface trim).
 *
 * Every client request carries the full `tools/list` payload, so its size is a
 * fixed per-request cost. The Memory Arena benchmark measured ~55k characters
 * (~15k tokens) before the trim. These ceilings are ratchets: lower them when
 * the surface shrinks; never raise them to admit verbose regressions without a
 * deliberate decision. Measure with `npx tsx benchmark/tool-surface/measure.ts`.
 */
// Raised 31_000 -> 31_200 deliberately (MUNIN-434) to restore the memory_log
// dated-record guidance and the memory_update_status "only what the user stated"
// rule that the MUNIN-431 trim dropped; other prose was trimmed to offset most of it.
const MAX_TOOLS_LIST_CHARS = 31_200;
const MAX_SINGLE_TOOL_CHARS = 4_000;
// MUNIN_TOOL_PROFILE=core (MUNIN-434): the eight everyday tools.
const MAX_CORE_TOOLS_LIST_CHARS = 16_100;

type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

const storage = createTestStorage("tool-surface-budget");
let db: Database.Database;
let tools: ToolDefinition[];

beforeAll(async () => {
  db = initDatabase(storage.path);
  const server = new Server({ name: "budget", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, db, "budget-session");
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/list");
  tools = ((await handler!({ method: "tools/list", params: {} })) as { tools: ToolDefinition[] }).tools;
});

afterAll(() => {
  db.close();
  storage.cleanup();
});

describe("MCP tool surface token budget", () => {
  it("keeps the full tools/list payload within the ratcheted character budget", () => {
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(MAX_TOOLS_LIST_CHARS);
  });

  it("keeps the core tool profile within its own ratcheted budget", async () => {
    const saved = process.env.MUNIN_TOOL_PROFILE;
    process.env.MUNIN_TOOL_PROFILE = "core";
    try {
      const server = new Server({ name: "budget-core", version: "0.0.0" }, { capabilities: { tools: {} } });
      registerTools(server, db, "budget-core-session");
      const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/list");
      const core = ((await handler!({ method: "tools/list", params: {} })) as { tools: ToolDefinition[] }).tools;
      expect(core).toHaveLength(8);
      expect(JSON.stringify(core).length).toBeLessThanOrEqual(MAX_CORE_TOOLS_LIST_CHARS);
    } finally {
      if (saved === undefined) delete process.env.MUNIN_TOOL_PROFILE;
      else process.env.MUNIN_TOOL_PROFILE = saved;
    }
  });

  it("keeps every single tool definition within the per-tool budget", () => {
    for (const tool of tools) {
      expect(JSON.stringify(tool).length, `${tool.name} definition size`).toBeLessThanOrEqual(MAX_SINGLE_TOOL_CHARS);
    }
  });

  it("does not spend tokens on schema titles that only restate property names", () => {
    const titles: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${path}[${index}]`));
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "title" && typeof value === "string") titles.push(path);
        walk(value, `${path}.${key}`);
      }
    };
    for (const tool of tools) walk(tool.inputSchema, tool.name);
    expect(titles).toEqual([]);
  });

  it("keeps the essential behavioural guidance after trimming", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const description = (name: string) => byName.get(name)?.description ?? "";

    // Routing between status and free-form writes.
    expect(description("memory_write")).toContain("memory_update_status");
    expect(description("memory_update_status")).toContain("not after every `memory_log`");
    expect(description("memory_log")).toContain("supersedes");
    // Write guidance restored after the MUNIN-431 trim (MUNIN-434): the arena
    // showed fewer dated facts logged without it.
    expect(description("memory_log")).toContain("Append-only chronological record");
    expect(description("memory_log")).toContain("with its date");
    for (const tag of ["decision", "milestone", "blocker", "discovery", "correction"]) {
      expect(description("memory_log")).toContain(`\`${tag}\``);
    }
    // Destructive and owner-only flows stay explicit.
    expect(description("memory_delete")).toContain("delete_token");
    expect(description("memory_consolidate")).toContain("confirm_token");
    for (const name of ["memory_consolidate", "memory_retrieval_feedback", "memory_health"]) {
      expect(description(name), `${name} should stay labelled owner-only`).toContain("Owner-only");
    }
    // Review: only approve mutates, and principal scope never crosses principals.
    expect(description("memory_review")).toContain("Only `approve` changes memory");
    expect(description("memory_review")).toContain("never another principal");
    // Pagination and expiry rules the model must follow.
    expect(description("memory_query")).toContain("next_cursor");
    expect(description("memory_query")).toContain("include_expired");
    expect(description("memory_history")).toContain("mutually exclusive");
  });

  it("keeps response-contract guidance flagged by cross-model review (PR #432)", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const property = (name: string, prop: string) =>
      ((byName.get(name)?.inputSchema.properties as Record<string, { description?: string }> | undefined)?.[prop]
        ?.description) ?? "";

    // memory_review preview: read-only effect fields, optional fields, and error omission.
    const review = byName.get("memory_review")?.description ?? "";
    for (const fragment of [
      "preview_wrote_memory:false",
      "approval_would_write_memory",
      "`approval_error` and `persisted_status` are optional",
      "`exact_operation` may be omitted",
      "`payload_expired`",
      "omit effect fields",
    ]) {
      expect(review, `memory_review should mention ${fragment}`).toContain(fragment);
    }

    // memory_code_health: CAS source and export continuation.
    expect(property("memory_code_health", "expected_updated_at")).toContain("exact current `updated_at`");
    expect(property("memory_code_health", "cursor")).toContain("next_cursor");

    // memory_list rejects only non-default paging with a namespace.
    expect(byName.get("memory_list")?.description).toContain("non-default paging is rejected");

    // Status sections record what the user stated, not the model's own plans (MUNIN-434).
    expect(property("memory_update_status", "next_steps")).toContain("Only steps the user stated");
    expect(property("memory_update_status", "current_work")).toContain("Only what the user stated");

    // Expired statuses surface in attention only when include_expiring is enabled.
    expect(property("memory_update_status", "valid_until")).toContain("include_expiring");
  });
});
