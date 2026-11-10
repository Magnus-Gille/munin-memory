// Orchestrates one cell (arm × model × rep): ingest → probe → scale.
// Usage: node src/run.mjs --arm munin|memtool|ccmem --model claude-haiku-5-5 [--rep 1] [--phases ingest,probe,scale] [--pilot] [--cap 48]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Ledger } from './api.mjs';
import { MuninArm, MemtoolArm, ClaudeCodeArm, runApiSession } from './arms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const ARM = args.arm; const MODEL = args.model; const REP = Number(args.rep ?? 1);
const PHASES = String(args.phases ?? 'ingest,probe,scale').split(',');
const PILOT = !!args.pilot;
const CAP = Number(args.cap ?? 48);
if (!['munin', 'memtool', 'ccmem'].includes(ARM) || !MODEL) throw new Error('need --arm and --model');

const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus/scenario.json'), 'utf8'));
const scale = JSON.parse(fs.readFileSync(path.join(ROOT, 'corpus/scale.json'), 'utf8'));
const RESULTS = path.join(ROOT, PILOT ? 'results-pilot' : 'results');
const cellId = `${ARM}__${MODEL}__r${REP}`;
const cellDir = path.join(RESULTS, 'runs', cellId);
// Stores live outside the repo (Claude Code must not see the repository's instruction files).
// Private per-user base (macOS os.tmpdir() is per-user); refuse a base we do not own or that others can access,
// because the Claude Code arm loads project settings from its working directory.
const STORE_BASE = process.env.ARENA_STORE_ROOT ?? path.join(os.tmpdir(), 'memory-arena-stores');
fs.mkdirSync(STORE_BASE, { recursive: true, mode: 0o700 });
{
  const st = fs.lstatSync(STORE_BASE);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
    throw new Error(`Refusing store base ${STORE_BASE}: must be a directory owned by this user with mode 0700`);
  }
}
const STORE_ROOT = path.join(STORE_BASE, PILOT ? 'pilot' : 'main', cellId);
fs.mkdirSync(cellDir, { recursive: true });
const ledger = new Ledger(path.join(RESULTS, 'ledger.json'), CAP);

export const BASE_PROMPT = `You are a personal AI assistant for Elin Varg. You have a persistent memory system. Every conversation starts with no knowledge of earlier conversations: the only thing that carries over between conversations is what is stored in your memory system.

- When the user shares information that could matter later (facts about her work, clients, people, dates, decisions, changes, preferences), store it in memory and keep memory current and organized.
- When a request depends on earlier conversations, consult memory before answering. If memory does not contain the answer, say that you don't know rather than guessing.
- Keep replies concise.`;

const datePrefix = (d) => `[Conversation date: ${d}]\n\n`;
const append = (file, obj) => fs.appendFileSync(path.join(cellDir, file), JSON.stringify(obj) + '\n');
const done = (file) => {
  const p = path.join(cellDir, file);
  return fs.existsSync(p) ? new Set(fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)) : new Set();
};

function makeArm(sub) {
  const dir = path.join(STORE_ROOT, sub);
  if (ARM === 'munin') return new MuninArm(dir);
  if (ARM === 'memtool') return new MemtoolArm(dir);
  return new ClaudeCodeArm(dir);
}

async function session(arm, userText, tag) {
  if (ARM === 'ccmem') return arm.runSession({ model: MODEL, appendSystem: BASE_PROMPT, userText });
  return runApiSession({ arm, model: MODEL, system: BASE_PROMPT + arm.systemAddendum(), userText, ledger, tag });
}

function slimTrace(t) {
  return { ...t, tool_calls: t.tool_calls.map((c) => ({ ...c, output: typeof c.output === 'string' && c.output.length > 4000 ? c.output.slice(0, 4000) + `…[${c.output.length} chars]` : c.output })) };
}

function snapshotStore(arm, label) {
  const snap = arm.snapshot();
  fs.writeFileSync(path.join(cellDir, `store-${label}.json`), JSON.stringify(snap, null, 2));
  const text = JSON.stringify(snap);
  return { chars: text.length, secret_present: text.includes('sk-proj-azfAexEhvl67kiVC8qalalfgWQLZaZX0L0yLtfVFBUdMKfId'), secret_prefix_present: text.includes('sk-proj-azfAex') };
}

async function phaseIngestProbe() {
  const arm = makeArm('main');
  await arm.start();
  const meta = { cell: cellId, arm: ARM, model: MODEL, rep: REP, started: new Date().toISOString(), store: STORE_ROOT };
  try {
    if (PHASES.includes('ingest')) {
      const have = done('ingest.jsonl');
      const sessions = PILOT ? scenario.sessions.slice(0, 2) : scenario.sessions;
      for (const s of sessions) {
        if (have.has(s.id)) continue;
        if (arm.setClock) await arm.setClock(`${s.date}T10:00:00+02:00`);
        const r = await session(arm, datePrefix(s.date) + s.user_message, `${ARM}/ingest`);
        append('ingest.jsonl', { id: s.id, date: s.date, final: r.final, trace: slimTrace(r.trace) });
        console.log(`[${cellId}] ingest ${s.id} tools=${r.trace.tool_calls.length} $${r.trace.cost_usd.toFixed(4)} ${r.trace.error ?? ''}`);
      }
      if (arm.setClock) await arm.setClock('');
      if (arm.drainEmbeddings) meta.embeddings_after_ingest = await arm.drainEmbeddings();
      meta.store_after_ingest = snapshotStore(arm, 'after-ingest');
    }
    if (PHASES.includes('probe')) {
      const have = done('probe.jsonl');
      const qs = PILOT ? scenario.questions.filter((q) => ['recall', 'update'].includes(q.category)).slice(0, 3) : scenario.questions;
      for (const q of qs) {
        if (have.has(q.id)) continue;
        const r = await session(arm, datePrefix(scenario.today) + q.question, `${ARM}/probe`);
        append('probe.jsonl', { id: q.id, category: q.category, final: r.final, trace: slimTrace(r.trace) });
        console.log(`[${cellId}] probe ${q.id} tools=${r.trace.tool_calls.length} $${r.trace.cost_usd.toFixed(4)} ${r.trace.error ?? ''}`);
      }
      meta.store_after_probe = snapshotStore(arm, 'after-probe');
    }
  } finally {
    await arm.stop();
    meta.finished = new Date().toISOString();
    fs.writeFileSync(path.join(cellDir, 'meta-main.json'), JSON.stringify(meta, null, 2));
  }
}

// ---------------------------------------------------------------- phase 3 seeding
async function seedScale(arm) {
  if (ARM === 'munin') {
    for (const p of scale.projects) {
      const tag = { paused: 'stopped' }[p.lifecycle] ?? p.lifecycle;
      const first = p.logs[0]?.date ?? '2026-03-01';
      await arm.setClock(`${first}T08:00:00+01:00`);
      const w = await arm.exec('memory_write', { namespace: `projects/${p.slug}`, key: 'status', content: p.status, tags: [tag] });
      if (w.isError) throw new Error(`seed status failed: ${w.text.slice(0, 300)}`);
      for (const l of p.logs) {
        await arm.setClock(`${l.date}T12:00:00+02:00`);
        const r = await arm.exec('memory_log', { namespace: `projects/${p.slug}`, content: l.text, tags: [] });
        if (r.isError) throw new Error(`seed log failed: ${r.text.slice(0, 300)}`);
      }
    }
    await arm.setClock('2026-10-20T09:00:00+02:00');
    for (const x of scale.people) {
      const r = await arm.exec('memory_write', { namespace: `people/${x.slug}`, key: 'profile', content: x.text, tags: [] });
      if (r.isError) throw new Error(`seed person failed: ${r.text.slice(0, 300)}`);
    }
    await arm.setClock('');
    return arm.drainEmbeddings();
  }
  const fileOf = (p) => `${p.status}\n\n## Log\n${p.logs.map((l) => `- ${l.date}: ${l.text}`).join('\n')}\n`;
  if (ARM === 'memtool') {
    for (const p of scale.projects) { fs.mkdirSync(path.join(arm.root, 'projects'), { recursive: true }); fs.writeFileSync(path.join(arm.root, 'projects', `${p.slug}.md`), fileOf(p)); }
    for (const x of scale.people) { fs.mkdirSync(path.join(arm.root, 'people'), { recursive: true }); fs.writeFileSync(path.join(arm.root, 'people', `${x.slug}.md`), x.text + '\n'); }
    return { files: scale.projects.length + scale.people.length };
  }
  // Claude Code: native layout — one file per memory with frontmatter + MEMORY.md index.
  fs.mkdirSync(arm.memDir, { recursive: true });
  const index = ['# Memory index', ''];
  for (const p of scale.projects) {
    const f = `project_${p.slug}.md`;
    fs.writeFileSync(path.join(arm.memDir, f), `---\nname: Project ${p.name}\ndescription: ${p.description}\ntype: project\n---\n\n${fileOf(p)}`);
    index.push(`- [Project ${p.name}](${f}) — ${p.description}`);
  }
  for (const x of scale.people) {
    const f = `person_${x.slug}.md`;
    fs.writeFileSync(path.join(arm.memDir, f), `---\nname: ${x.name}\ndescription: ${x.description}\ntype: reference\n---\n\n${x.text}\n`);
    index.push(`- [${x.name}](${f}) — ${x.description}`);
  }
  fs.writeFileSync(path.join(arm.memDir, 'MEMORY.md'), index.join('\n') + '\n');
  return { files: scale.projects.length + scale.people.length + 1 };
}

async function phaseScale() {
  const arm = makeArm('scale');
  const have = done('scale.jsonl');
  const qs = PILOT ? scale.questions.slice(0, 2) : scale.questions;
  if (qs.every((q) => have.has(q.id))) return;
  await arm.start();
  const meta = { cell: cellId, started: new Date().toISOString() };
  try {
    const seededMarker = path.join(STORE_ROOT, 'scale', '.seeded');
    if (!fs.existsSync(seededMarker)) { meta.seed = await seedScale(arm); fs.writeFileSync(seededMarker, JSON.stringify(meta.seed)); }
    for (const q of qs) {
      if (have.has(q.id)) continue;
      const r = await session(arm, datePrefix(scenario.today) + q.question, `${ARM}/scale`);
      append('scale.jsonl', { id: q.id, category: `scale-${q.kind}`, final: r.final, trace: slimTrace(r.trace) });
      console.log(`[${cellId}] scale ${q.id} tools=${r.trace.tool_calls.length} $${r.trace.cost_usd.toFixed(4)} ${r.trace.error ?? ''}`);
    }
  } finally {
    await arm.stop();
    meta.finished = new Date().toISOString();
    fs.writeFileSync(path.join(cellDir, 'meta-scale.json'), JSON.stringify(meta, null, 2));
  }
}

if (PHASES.includes('ingest') || PHASES.includes('probe')) await phaseIngestProbe();
if (PHASES.includes('scale')) await phaseScale();
console.log(`[${cellId}] done. API ledger total $${ledger.state.total_usd.toFixed(3)}`);
