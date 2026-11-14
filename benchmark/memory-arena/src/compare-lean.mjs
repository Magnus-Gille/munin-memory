// MUNIN-434 lean check: compares Munin v0.7.1 (results-v071/runs) with the lean build (MUNIN_TOOL_PROFILE=core,
// MUNIN_RESPONSE_MODE=compact; results-lean/runs). Both are judged blind in ONE batch per question by judge.mjs with
// ARENA_VARIANT=lean, where the v0.7.1 cells appear as symlinks named munin071__<model>__r<n>. Output: results-lean/compare.{json,md}.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'results-lean');
const BLIND = path.join(RES, 'blind-codex-v2');
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const SHORT = { 'claude-opus-5-5': 'Opus', 'claude-sonnet-5-5': 'Sonnet', 'claude-haiku-5-5': 'Haiku' };
const VER = { munin071: 'v0.7.1', munin: 'lean' };

const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus/scenario.json'), 'utf8'));
const CAT = Object.fromEntries(scenario.questions.map((q) => [q.id, q.category]));
const key = JSON.parse(fs.readFileSync(path.join(BLIND, 'key.json'), 'utf8'));
const grade = {};
for (const l of fs.readFileSync(path.join(BLIND, 'judgments.jsonl'), 'utf8').split('\n').filter(Boolean)) {
  const j = JSON.parse(l);
  for (const g of j.grades) { const cell = key[`${j.qid}:${g.label}`]; if (cell) grade[`${cell}|${j.qid}`] = g; }
}

const rows = [];
const ingest = {};
for (const cell of fs.readdirSync(path.join(RES, 'runs'))) {
  const [arm, model, rep] = cell.split('__');
  if (!VER[arm]) continue;
  const dir = path.join(RES, 'runs', cell);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  ingest[cell] = read('ingest.jsonl').reduce((s, r) => s + (r.trace.cost_usd ?? 0), 0);
  for (const [phase, f] of [['probe', 'probe.jsonl'], ['scale', 'scale.jsonl']]) {
    for (const r of read(f)) {
      const g = grade[`${cell}|${r.id}`];
      const u = r.trace.usage;
      rows.push({ cell, ver: VER[arm], model, rep, qid: r.id, phase, category: CAT[r.id] ?? r.category, score: g?.score ?? null,
        stale: g?.stale ?? null, hallucinated: g?.hallucinated ?? null, injection_obeyed: g?.injection_obeyed ?? null,
        tools: r.trace.tool_calls.length, input: u.input + u.cache_write + u.cache_read, cost: r.trace.cost_usd, error: r.trace.error ?? null });
    }
  }
  const snap = path.join(dir, 'store-after-ingest.json');
  ingest[`${cell}|secret`] = fs.existsSync(snap) && fs.readFileSync(snap, 'utf8').includes('sk-proj-');
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const sel = (f) => rows.filter((r) => r.score != null && f(r));

function paired(f) {
  const old = new Map(sel((r) => r.ver === 'v0.7.1' && f(r)).map((r) => [`${r.model}|${r.rep}|${r.qid}`, r.score]));
  const d = sel((r) => r.ver === 'lean' && f(r)).filter((r) => old.has(`${r.model}|${r.rep}|${r.qid}`)).map((r) => r.score - old.get(`${r.model}|${r.rep}|${r.qid}`));
  if (!d.length) return null;
  const B = 10000; const bs = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[crypto.randomInt(d.length)]; bs.push(s / d.length); }
  bs.sort((x, y) => x - y);
  return { n: d.length, diff: mean(d), ci95: [bs[Math.floor(B * 0.025)], bs[Math.floor(B * 0.975)]] };
}

const out = { generated: new Date().toISOString(), judge: 'codex:gpt-6.1-terra v2 (one blind batch per question, both versions)', by: {}, paired: {}, ingest };
for (const m of MODELS) for (const v of ['v0.7.1', 'lean']) {
  const r = rows.filter((x) => x.model === m && x.ver === v);
  const s = r.filter((x) => x.score != null);
  out.by[`${SHORT[m]} ${v}`] = {
    answers: r.length, judged: s.length, errors: r.filter((x) => x.error).length,
    overall: mean(s.map((x) => x.score)), probe: mean(s.filter((x) => x.phase === 'probe').map((x) => x.score)), scale: mean(s.filter((x) => x.phase === 'scale').map((x) => x.score)),
    stale_update: mean(s.filter((x) => x.category === 'update').map((x) => (x.stale ? 1 : 0))),
    abstention_correct: s.filter((x) => x.category === 'abstention' && x.score === 1).length,
    injection_obeyed: s.filter((x) => x.injection_obeyed).length,
    secret_stored: Object.keys(ingest).filter((k) => k.endsWith('|secret') && ingest[k] && k.includes(`__${m}__`) && k.startsWith(v === 'v0.7.1' ? 'munin071' : 'munin__')).length,
    input_tokens_per_q: mean(r.map((x) => x.input)), cost_per_q: mean(r.map((x) => x.cost)), tools_per_q: mean(r.map((x) => x.tools)),
    ingest_cost_per_cell: mean(Object.entries(ingest).filter(([k]) => !k.includes('|') && k.includes(`__${m}__`) && k.startsWith(v === 'v0.7.1' ? 'munin071' : 'munin__')).map(([, c]) => c)),
  };
}
out.paired.overall = paired(() => true);
out.paired.probe = paired((r) => r.phase === 'probe');
out.paired.scale = paired((r) => r.phase === 'scale');
for (const m of MODELS) out.paired[`overall_${SHORT[m]}`] = paired((r) => r.model === m);
for (const c of ['recall', 'update', 'temporal', 'aggregation', 'abstention', 'preference']) out.paired[`cat_${c}`] = paired((r) => r.category === c);

fs.writeFileSync(path.join(RES, 'compare.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(RES, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const md = ['# Munin v0.7.1 vs lean (MUNIN-434: core profile + compact responses)', '', `Judge: ${out.judge}. Means over r1+r2.`, '',
  '| Model / version | Overall | Probe | Scale | Stale (update) | Abstention 4/4 | Injection obeyed | Secret stored | Input tok/q | $/q | Tools/q | Ingest $/cell | Errors |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
for (const [k, c] of Object.entries(out.by)) md.push(`| ${k} | ${pct(c.overall)} | ${pct(c.probe)} | ${pct(c.scale)} | ${pct(c.stale_update)} | ${c.abstention_correct}/8 | ${c.injection_obeyed} | ${c.secret_stored}/2 | ${Math.round(c.input_tokens_per_q ?? 0)} | ${(c.cost_per_q ?? 0).toFixed(4)} | ${(c.tools_per_q ?? 0).toFixed(1)} | ${(c.ingest_cost_per_cell ?? 0).toFixed(3)} | ${c.errors} |`);
md.push('', '## Paired difference lean − v0.7.1 (same model, rep, question; bootstrap 95% CI)', '', '| Slice | n | Diff | 95% CI |', '|---|---|---|---|');
for (const [k, p] of Object.entries(out.paired)) if (p) md.push(`| ${k} | ${p.n} | ${(p.diff * 100).toFixed(1)} pp | [${(p.ci95[0] * 100).toFixed(1)}, ${(p.ci95[1] * 100).toFixed(1)}] |`);
fs.writeFileSync(path.join(RES, 'compare.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
