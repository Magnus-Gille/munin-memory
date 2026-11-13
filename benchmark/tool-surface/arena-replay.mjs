#!/usr/bin/env node
/**
 * Replay the read-only Munin tool calls recorded in Memory Arena traces against copies of
 * the arena stores, and measure the full (untruncated) response sizes field by field.
 *
 * The arena traces truncate tool outputs at 4000 chars, so field-level shares of
 * `memory_orient` and `memory_query` cannot be read from them directly. This script
 * starts the selected Munin build over stdio exactly like the arena Munin arm (local
 * embeddings, consolidation off), against a scratch COPY of each cell's store, and
 * re-issues every recorded read call with its recorded arguments. Write calls are skipped.
 * No model/API calls are made.
 *
 * Usage:
 *   node benchmark/tool-surface/arena-replay.mjs --runs <arena results-v071/runs> \
 *     --stores <memory-arena-stores/main-v071> [--repo <munin build>] [--arm munin] \
 *     [--env MUNIN_X=y,MUNIN_Z=w] [--label name] [--out file.json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const RUNS = opt("runs");
const STORES = opt("stores");
const REPO = path.resolve(opt("repo", path.resolve(here, "../..")));
const ARM = opt("arm", "munin");
const LABEL = opt("label", "replay");
const OUT = opt("out");
const EXTRA_ENV = Object.fromEntries(
  (opt("env", "") || "")
    .split(",")
    .filter(Boolean)
    .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
);
if (!RUNS || !STORES) {
  console.error("need --runs and --stores");
  process.exit(2);
}

const WRITE_TOOLS = new Set([
  "memory_write", "memory_log", "memory_update_status", "memory_delete", "memory_extract",
  "memory_review", "memory_consolidate", "memory_retrieval_feedback", "memory_code_health",
]);
const readJsonl = (p) =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const len = (v) => (v === undefined ? 0 : JSON.stringify(v).length);

function childEnv(extra) {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

async function startServer(storeDir, scratch) {
  fs.mkdirSync(scratch, { recursive: true });
  for (const f of ["memory.db", "memory.db-wal", "memory.db-shm"]) {
    const src = path.join(storeDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(scratch, f));
  }
  const hf = path.join(storeDir, "hf-cache");
  if (fs.existsSync(hf)) fs.symlinkSync(fs.realpathSync(hf), path.join(scratch, "hf-cache"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, "dist/index.js")],
    cwd: REPO,
    env: childEnv({
      MUNIN_MEMORY_DB_PATH: path.join(scratch, "memory.db"),
      MUNIN_TRANSPORT: "stdio",
      MUNIN_EMBEDDINGS_ENABLED: "true",
      MUNIN_SEMANTIC_ENABLED: "true",
      MUNIN_EMBEDDINGS_LOCAL_ONLY: "true",
      MUNIN_CONSOLIDATION_ENABLED: "false",
      ...EXTRA_ENV,
    }),
    stderr: fs.openSync(path.join(scratch, "server.stderr.log"), "a"),
  });
  const client = new Client({ name: "arena-replay", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const apiTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  return { client, toolsChars: JSON.stringify(apiTools).length, toolCount: tools.length, instructions: client.getInstructions() ?? "" };
}

// Field accounting: top-level keys, and for array-of-object fields (query `results`,
// orient dashboard groups) the per-item keys.
function addFields(acc, obj, prefix = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    acc[key] = (acc[key] ?? 0) + len(v) + k.length + 3;
    if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      for (const item of v) addFields(acc, item, `${key}[].`);
    } else if (v && typeof v === "object" && !Array.isArray(v) && prefix.split(".").length < 3) {
      addFields(acc, v, `${key}.`);
    }
  }
}

const result = { label: LABEL, repo: REPO, env: EXTRA_ENV, cells: {}, tools: {}, fields: {} };
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "munin-arena-replay-"));
try {
  for (const cell of fs.readdirSync(RUNS).filter((c) => c.split("__")[0] === ARM)) {
    for (const [phase, sub] of [["probe", "main"], ["scale", "scale"]]) {
      const storeDir = path.join(STORES, cell, sub);
      if (!fs.existsSync(path.join(storeDir, "memory.db"))) continue;
      const recs = readJsonl(path.join(RUNS, cell, `${phase}.jsonl`));
      const srv = await startServer(storeDir, path.join(scratchRoot, cell, sub));
      result.cells[`${cell}/${phase}`] = { tools_chars: srv.toolsChars, tool_count: srv.toolCount, instructions_chars: srv.instructions.length };
      try {
        for (const r of recs) {
          for (const c of r.trace.tool_calls ?? []) {
            if (WRITE_TOOLS.has(c.name)) continue;
            let text = "";
            let isError = false;
            try {
              const resp = await srv.client.callTool({ name: c.name, arguments: c.input ?? {} });
              text = (resp.content ?? []).map((x) => (x.type === "text" ? x.text : JSON.stringify(x))).join("\n");
              isError = !!resp.isError;
            } catch (e) {
              text = `Error: ${e.message}`;
              isError = true;
            }
            const t = (result.tools[c.name] ??= { calls: 0, chars: 0, errors: 0, results: 0 });
            t.calls += 1;
            t.chars += text.length;
            if (isError) t.errors += 1;
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* non-JSON response (e.g. error text) */
            }
            if (parsed && (c.name === "memory_query" || c.name === "memory_orient")) {
              const f = (result.fields[c.name] ??= { calls: 0, total: 0, keys: {} });
              f.calls += 1;
              f.total += text.length;
              addFields(f.keys, parsed);
              if (Array.isArray(parsed.results)) t.results += parsed.results.length;
            }
          }
        }
      } finally {
        await srv.client.close();
      }
    }
  }
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

const summary = {
  label: LABEL,
  tools_chars: Object.values(result.cells)[0]?.tools_chars,
  tool_count: Object.values(result.cells)[0]?.tool_count,
  per_call: Object.fromEntries(
    Object.entries(result.tools)
      .sort((a, b) => b[1].chars - a[1].chars)
      .map(([k, t]) => [k, { calls: t.calls, chars_per_call: Math.round(t.chars / t.calls), errors: t.errors, results_per_call: t.results ? +(t.results / t.calls).toFixed(1) : undefined }]),
  ),
  fields: Object.fromEntries(
    Object.entries(result.fields).map(([tool, f]) => [
      tool,
      Object.fromEntries(
        Object.entries(f.keys)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, { chars_per_call: Math.round(v / f.calls), share: +(v / f.total).toFixed(3) }]),
      ),
    ]),
  ),
};
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ...result, summary }, null, 2));
console.log(JSON.stringify(summary, null, 2));
