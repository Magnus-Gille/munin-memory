/**
 * CLAUDE.md tool-table inventory contract (issue #54).
 *
 * The "MCP tools exposed" table in CLAUDE.md is the single human-readable
 * inventory of the MCP tool surface. This test makes that inventory
 * machine-checked: every tool registered in `TOOL_DEFINITIONS`
 * (exported as `REGISTERED_TOOL_NAMES`) must appear in the table exactly
 * once, and the table must not list any name that isn't registered.
 *
 * When you add, rename, or remove a tool, update the CLAUDE.md table row
 * in the same change — this test will fail until you do.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REGISTERED_TOOL_NAMES } from "../src/tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_MD = join(__dirname, "..", "CLAUDE.md");

/**
 * Extract the tool names from the "MCP tools exposed" table in CLAUDE.md.
 * Scoped to that section only (from the heading to the next "## " heading)
 * so unrelated `| \`memory_*\` |`-shaped rows elsewhere can't leak in.
 */
function extractTableToolNames(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### MCP tools exposed");
  if (start === -1) {
    throw new Error('Could not find "### MCP tools exposed" heading in CLAUDE.md');
  }
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at the next section heading.
    if (/^##\s/.test(line)) break;
    // Table rows look like:  | `memory_orient` | ... |
    const match = line.match(/^\|\s*`([a-z_]+)`\s*\|/);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("CLAUDE.md tool-table inventory contract", () => {
  const markdown = readFileSync(CLAUDE_MD, "utf8");
  const tableNames = extractTableToolNames(markdown);

  it("registers a non-trivial number of tools", () => {
    // Guard against the regex silently matching zero rows.
    expect(REGISTERED_TOOL_NAMES.length).toBeGreaterThan(10);
    expect(tableNames.length).toBeGreaterThan(10);
  });

  it("lists every registered tool exactly once", () => {
    for (const name of REGISTERED_TOOL_NAMES) {
      const occurrences = tableNames.filter((n) => n === name).length;
      expect(
        occurrences,
        `Tool \`${name}\` should appear exactly once in the CLAUDE.md table, found ${occurrences}`,
      ).toBe(1);
    }
  });

  it("does not list any name that isn't a registered tool", () => {
    const registered = new Set(REGISTERED_TOOL_NAMES);
    const extras = tableNames.filter((n) => !registered.has(n));
    expect(
      extras,
      `CLAUDE.md table lists names not registered in TOOL_DEFINITIONS: ${extras.join(", ")}`,
    ).toEqual([]);
  });

  it("has no duplicate rows in the table", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of tableNames) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes, `Duplicate rows in CLAUDE.md table: ${dupes.join(", ")}`).toEqual([]);
  });
});
