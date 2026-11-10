/**
 * Measure the per-request token overhead of the Munin MCP tool surface.
 *
 * Reports:
 *  - tools/list JSON size per tool (what every client pays on every request),
 *  - response sizes of the calls that dominate real sessions
 *    (memory_orient default/compact, memory_query, memory_read, memory_list)
 *    against a small deterministic seeded corpus.
 *
 * Token counts are estimates (characters / 3.6, calibrated on the Memory Arena
 * observation of ~55k chars ~= 15k tokens for the tool list). Use them for
 * before/after comparison, not as billing truth.
 *
 * Usage: npx tsx benchmark/tool-surface/measure.ts [--json]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase, writeState, appendLog } from "../../src/db.js";
import { registerTools } from "../../src/tools.js";

const CHARS_PER_TOKEN = 3.6;
const est = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

type Handler = (req: unknown) => Promise<unknown>;

async function main() {
  const asJson = process.argv.includes("--json");
  const dir = mkdtempSync(join(tmpdir(), "munin-tool-surface-"));
  const db = initDatabase(join(dir, "memory.db"));
  try {
    const server = new Server({ name: "measure", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerTools(server, db, "measure-session");
    const handlers = (server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
    const list = (await handlers.get("tools/list")!({ method: "tools/list", params: {} })) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };

    const perTool = list.tools
      .map((t) => ({
        name: t.name,
        total: JSON.stringify(t).length,
        description: t.description.length,
        schema: JSON.stringify(t.inputSchema).length,
      }))
      .sort((a, b) => b.total - a.total);
    const listChars = JSON.stringify(list.tools).length;

    // Deterministic corpus: 8 projects with status + 4 logs each, 2 people notes.
    for (let p = 0; p < 8; p++) {
      const ns = `projects/project-${p}`;
      writeState(
        db,
        ns,
        "status",
        `## Phase\nBuild ${p}\n\n## Current work\nWorking on milestone ${p} for client Acme ${p}. Fixed fee 45 000 SEK.\n\n## Blockers\nNone\n\n## Next steps\n- Ship draft\n- Review with client`,
        [p % 3 === 0 ? "blocked" : "active"],
      );
      for (let l = 0; l < 4; l++) {
        appendLog(db, ns, `Decision ${l} for project ${p}: chose option ${l} because the workshop date moved to week ${40 + l}.`, ["decision"]);
      }
    }
    writeState(db, "people/anna", "profile", "Anna Lindqvist, logistics lead at Lindqvist Logistik. Prefers email.", ["contact"]);
    writeState(db, "meta/conventions", "conventions", "Use projects/<name>/status for status. Log decisions.", []);

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await handlers.get("tools/call")!({ method: "tools/call", params: { name, arguments: args } })) as {
        content: Array<{ text: string }>;
      };
      return r.content.map((c) => c.text).join("").length;
    };
    const responses: Array<{ call: string; chars: number }> = [];
    const probes: Array<[string, string, Record<string, unknown>]> = [
      ["memory_orient {}", "memory_orient", {}],
      ['memory_orient {detail:"compact"}', "memory_orient", { detail: "compact" }],
      ['memory_query {query:"workshop fee"}', "memory_query", { query: "workshop fee" }],
      ['memory_query {query:"workshop fee", limit:5}', "memory_query", { query: "workshop fee", limit: 5 }],
      ["memory_read status", "memory_read", { namespace: "projects/project-1", key: "status" }],
      ["memory_list {namespace}", "memory_list", { namespace: "projects/project-1" }],
    ];
    for (const [label, name, args] of probes) responses.push({ call: label, chars: await call(name, args) });

    const report = {
      tools_list: { tools: list.tools.length, chars: listChars, est_tokens: est(listChars) },
      per_tool: perTool.map((t) => ({ ...t, est_tokens: est(t.total) })),
      responses: responses.map((r) => ({ ...r, est_tokens: est(r.chars) })),
    };
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`tools/list: ${report.tools_list.tools} tools, ${listChars} chars, ~${est(listChars)} tokens\n`);
    console.log("tool                          total   desc  schema  ~tok");
    for (const t of report.per_tool) {
      console.log(
        `${t.name.padEnd(28)} ${String(t.total).padStart(6)} ${String(t.description).padStart(6)} ${String(t.schema).padStart(7)} ${String(t.est_tokens).padStart(5)}`,
      );
    }
    console.log("\nresponse                                       chars  ~tok");
    for (const r of report.responses) console.log(`${r.call.padEnd(46)} ${String(r.chars).padStart(6)} ${String(r.est_tokens).padStart(5)}`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
