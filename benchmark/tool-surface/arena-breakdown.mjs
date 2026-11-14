#!/usr/bin/env node
/**
 * Break Memory Arena per-question input tokens into their parts.
 *
 * Each API iteration re-sends (tool definitions + system + user question) plus every
 * earlier assistant turn and tool result. From the per-call `usage` in the traces:
 *
 *   in_i   = input + cache_write + cache_read of call i (the full prompt of call i)
 *   P      = in_0 (the prefix: tool definitions + system + user question)
 *   R_j    = in_{j+1} - in_j - out_j  (tokens added by the tool results of iteration j)
 *
 *   Σ in_i = N·P + Σ_j (N-1-j)·(out_j + R_j)
 *
 * Tool definitions are split from P with a baseline arm (same system prompt and question,
 * a tiny tool list): T_tools ≈ P(munin) - P(baseline). R_j is attributed to tools by the
 * result character share within an iteration; iterations with several parallel tool calls
 * are grouped by a contiguous DP partition of the flat tool-call list.
 *
 * Traces are the `slimTrace` form (tool outputs over 4000 chars truncated with a
 * `…[N chars]` suffix), so the original output length is recoverable.
 *
 * Usage:
 *   node benchmark/tool-surface/arena-breakdown.mjs --runs <runs-dir> --arm munin \
 *     [--baseline-runs <runs-dir> --baseline-arm memtool] [--phases probe,scale] [--json]
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const RUNS = opt("runs");
const ARM = opt("arm", "munin");
const BASE_RUNS = opt("baseline-runs", RUNS);
const BASE_ARM = opt("baseline-arm", "memtool");
const PHASES = opt("phases", "probe,scale").split(",");
const AS_JSON = argv.includes("--json");
if (!RUNS) {
  console.error("need --runs <dir>");
  process.exit(2);
}

const readJsonl = (p) =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const totalIn = (u) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
const outLen = (o) => {
  if (typeof o !== "string") return 0;
  const m = /…\[(\d+) chars\]$/.exec(o);
  return m ? Number(m[1]) : o.length;
};

function cells(dir, arm) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((c) => c.split("__")[0] === arm)
    .map((c) => ({ cell: c, model: c.split("__")[1], dir: path.join(dir, c) }));
}

function records(cell) {
  const out = [];
  for (const ph of PHASES) for (const r of readJsonl(path.join(cell.dir, `${ph}.jsonl`))) out.push({ phase: ph, ...r });
  return out;
}

// Partition tool calls (in order) into `k` contiguous non-empty groups that best match the
// per-iteration result tokens R (minimise squared error of chars·ratio − R).
function partition(calls, R, ratio) {
  const n = calls.length;
  const k = R.length;
  if (k === 0) return [];
  if (n === k) return calls.map((c) => [c]);
  if (n < k) return null;
  const pre = [0];
  for (const c of calls) pre.push(pre.at(-1) + outLen(c.output));
  const INF = Number.POSITIVE_INFINITY;
  const cost = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(INF));
  const back = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let g = 1; g <= k; g++) {
    for (let e = g; e <= n - (k - g); e++) {
      for (let s = g - 1; s < e; s++) {
        if (cost[g - 1][s] === INF) continue;
        const err = (pre[e] - pre[s]) / ratio - R[g - 1];
        const c = cost[g - 1][s] + err * err;
        if (c < cost[g][e]) {
          cost[g][e] = c;
          back[g][e] = s;
        }
      }
    }
  }
  const groups = [];
  let e = n;
  for (let g = k; g >= 1; g--) {
    const s = back[g][e];
    groups.unshift(calls.slice(s, e));
    e = s;
  }
  return groups;
}

function analyse(cell, prefixBaseline, ratioHint) {
  const qs = [];
  for (const r of records(cell)) {
    const calls = r.trace.calls ?? [];
    if (!calls.length) continue;
    const N = calls.length;
    const ins = calls.map((c) => totalIn(c.usage));
    const outs = calls.map((c) => c.usage.output_tokens ?? 0);
    const P = ins[0];
    const R = [];
    for (let j = 0; j < N - 1; j++) R.push(Math.max(0, ins[j + 1] - ins[j] - outs[j]));
    const groups = partition(r.trace.tool_calls ?? [], R, ratioHint) ?? [];
    const byTool = {};
    groups.forEach((g, j) => {
      const resend = N - 1 - j;
      const chars = g.reduce((s, c) => s + outLen(c.output), 0) || 1;
      for (const c of g) {
        const share = outLen(c.output) / chars;
        const t = (byTool[c.name] ??= { calls: 0, chars: 0, result_tokens: 0, billed_tokens: 0 });
        t.calls += 1;
        t.chars += outLen(c.output);
        t.result_tokens += share * R[j];
        t.billed_tokens += share * R[j] * resend;
      }
    });
    const toolDefs = Math.max(0, P - prefixBaseline);
    const total = ins.reduce((s, x) => s + x, 0);
    const resultsBilled = R.reduce((s, x, j) => s + x * (N - 1 - j), 0);
    const assistantBilled = outs.slice(0, N - 1).reduce((s, x, j) => s + x * (N - 1 - j), 0);
    qs.push({
      id: r.id,
      phase: r.phase,
      api_calls: N,
      total,
      tool_defs: N * toolDefs,
      system_and_question: N * (P - toolDefs),
      tool_results: resultsBilled,
      assistant_turns: assistantBilled,
      prefix: P,
      byTool,
      result_chars: (r.trace.tool_calls ?? []).reduce((s, c) => s + outLen(c.output), 0),
      result_tokens_once: R.reduce((s, x) => s + x, 0),
    });
  }
  return qs;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const models = [...new Set(cells(RUNS, ARM).map((c) => c.model))].sort();
const report = { runs: RUNS, arm: ARM, baseline: `${BASE_ARM} in ${BASE_RUNS}`, phases: PHASES, models: {} };

for (const model of models) {
  // Baseline prefix: median first-call prompt of the baseline arm for the same model.
  const basePrefixes = [];
  for (const c of cells(BASE_RUNS, BASE_ARM).filter((x) => x.model === model))
    for (const r of records(c)) if (r.trace.calls?.[0]) basePrefixes.push(totalIn(r.trace.calls[0].usage));
  const prefixBaseline = median(basePrefixes);

  // Calibrate chars/token of tool results from single-call iterations (first pass with 3.0).
  const first = cells(RUNS, ARM)
    .filter((c) => c.model === model)
    .flatMap((c) => analyse(c, prefixBaseline, 3.0));
  const ratio =
    first.reduce((s, q) => s + q.result_chars, 0) / Math.max(1, first.reduce((s, q) => s + q.result_tokens_once, 0));
  const qs = cells(RUNS, ARM)
    .filter((c) => c.model === model)
    .flatMap((c) => analyse(c, prefixBaseline, ratio));

  const tools = {};
  for (const q of qs)
    for (const [name, t] of Object.entries(q.byTool)) {
      const a = (tools[name] ??= { calls: 0, chars: 0, result_tokens: 0, billed_tokens: 0 });
      for (const k of Object.keys(a)) a[k] += t[k];
    }
  const n = qs.length;
  report.models[model] = {
    questions: n,
    baseline_prefix_tokens: prefixBaseline,
    result_chars_per_token: Number(ratio.toFixed(2)),
    per_question: {
      total: mean(qs.map((q) => q.total)),
      api_calls: mean(qs.map((q) => q.api_calls)),
      prefix: mean(qs.map((q) => q.prefix)),
      tool_defs: mean(qs.map((q) => q.tool_defs)),
      system_and_question: mean(qs.map((q) => q.system_and_question)),
      tool_results: mean(qs.map((q) => q.tool_results)),
      assistant_turns: mean(qs.map((q) => q.assistant_turns)),
    },
    tools: Object.fromEntries(
      Object.entries(tools)
        .sort((a, b) => b[1].billed_tokens - a[1].billed_tokens)
        .map(([k, t]) => [
          k,
          {
            calls_per_q: t.calls / n,
            chars_per_call: t.chars / t.calls,
            tokens_per_call: t.result_tokens / t.calls,
            billed_tokens_per_q: t.billed_tokens / n,
          },
        ]),
    ),
  };
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const r0 = (x) => Math.round(x).toLocaleString("en-US");
  console.log(`# ${ARM} input-token breakdown (${PHASES.join("+")}) — ${RUNS}\n`);
  console.log("| Model | Q | Input/q | API calls/q | Prefix | Tool defs | System+question | Tool results | Assistant turns |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const [m, x] of Object.entries(report.models)) {
    const p = x.per_question;
    const pc = (v) => `${r0(v)} (${Math.round((100 * v) / p.total)}%)`;
    console.log(
      `| ${m} | ${x.questions} | ${r0(p.total)} | ${p.api_calls.toFixed(2)} | ${r0(p.prefix)} | ${pc(p.tool_defs)} | ${pc(p.system_and_question)} | ${pc(p.tool_results)} | ${pc(p.assistant_turns)} |`,
    );
  }
  for (const [m, x] of Object.entries(report.models)) {
    console.log(`\n## ${m} tool results (chars/token ≈ ${x.result_chars_per_token})\n`);
    console.log("| Tool | Calls/q | Chars/call | Tokens/call | Billed tokens/q |");
    console.log("|---|---|---|---|---|");
    for (const [t, v] of Object.entries(x.tools))
      console.log(`| ${t} | ${v.calls_per_q.toFixed(2)} | ${r0(v.chars_per_call)} | ${r0(v.tokens_per_call)} | ${r0(v.billed_tokens_per_q)} |`);
  }
}
