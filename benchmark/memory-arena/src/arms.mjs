// The three systems under test plus the shared API tool loop.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { createMessage } from './api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// ARENA_MUNIN_REPO: run the Munin arm from another build (the v0.7.1 tool-surface check); default = this checkout.
export const REPO = process.env.ARENA_MUNIN_REPO ? path.resolve(process.env.ARENA_MUNIN_REPO) : path.resolve(here, '../../..');
const HF_CACHE_SRC = '/Users/magnus/repos/munin-memory/benchmark/generated/evidence-metric/longmemeval-s-20261018/hf-cache';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal env for child processes: never forwards API keys or tokens.
function childEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

export const MAX_ITER = 30;

// MUNIN-434 lean variant: pass ONLY the tool-surface switches through to the Munin server
// (never other env; childEnv stays an allowlist). Unset = server defaults (full surface).
const MUNIN_SURFACE_ENV = Object.fromEntries(
  ['MUNIN_TOOL_PROFILE', 'MUNIN_RESPONSE_MODE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);

// ---------------------------------------------------------------- shared API loop
export async function runApiSession({ arm, model, system, userText, ledger, tag, effort = 'medium' }) {
  const messages = [{ role: 'user', content: userText }];
  const trace = { calls: [], tool_calls: [], usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, cost_usd: 0, stop: null, error: null };
  const t0 = Date.now();
  let final = '';
  try {
    for (let i = 0; i < MAX_ITER; i++) {
      const body = {
        // Explicit breakpoint after tools+system so the shared prefix is reused across sessions.
        model, max_tokens: 16000, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages,
        tools: arm.apiTools(), output_config: { effort },
        cache_control: { type: 'ephemeral' },
      };
      const resp = await createMessage(body, { ledger, tag });
      const u = resp.usage ?? {};
      trace.usage.input += u.input_tokens ?? 0; trace.usage.output += u.output_tokens ?? 0;
      trace.usage.cache_write += u.cache_creation_input_tokens ?? 0; trace.usage.cache_read += u.cache_read_input_tokens ?? 0;
      trace.cost_usd += resp._cost_usd;
      trace.calls.push({ stop_reason: resp.stop_reason, usage: u });
      messages.push({ role: 'assistant', content: resp.content });
      const texts = resp.content.filter((b) => b.type === 'text').map((b) => b.text);
      if (texts.length) final = texts.join('\n');
      if (resp.stop_reason !== 'tool_use') { trace.stop = resp.stop_reason; break; }
      const results = [];
      for (const b of resp.content.filter((x) => x.type === 'tool_use')) {
        let out; let isError = false;
        try { ({ text: out, isError } = await arm.exec(b.name, b.input)); }
        catch (e) { out = `Error: ${e.message}`; isError = true; }
        trace.tool_calls.push({ name: b.name, input: b.input, output: out, is_error: isError });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: out, ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      if (i === MAX_ITER - 1) trace.stop = 'loop_cap';
    }
  } catch (e) {
    trace.error = e.message;
    if (e.name === 'BudgetExceeded' || e.constructor?.name === 'BudgetExceeded') throw e;
  }
  trace.wall_ms = Date.now() - t0;
  return { final, trace };
}

// ---------------------------------------------------------------- Munin
export class MuninArm {
  constructor(dir) {
    this.name = 'munin';
    this.dir = dir;
    this.db = path.join(dir, 'memory.db');
    this.clockFile = path.join(dir, 'clock');
  }
  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    const hf = path.join(this.dir, 'hf-cache');
    if (!fs.existsSync(hf)) fs.symlinkSync(HF_CACHE_SRC, hf);
    fs.writeFileSync(this.clockFile, '');
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', path.join(here, 'clock-shim.mjs'), path.join(REPO, 'dist/index.js')],
      cwd: REPO,
      env: childEnv({
        MUNIN_MEMORY_DB_PATH: this.db, MUNIN_TRANSPORT: 'stdio',
        MUNIN_EMBEDDINGS_ENABLED: 'true', MUNIN_SEMANTIC_ENABLED: 'true', MUNIN_EMBEDDINGS_LOCAL_ONLY: 'true',
        MUNIN_CONSOLIDATION_ENABLED: 'false', ARENA_CLOCK_FILE: this.clockFile,
        ...MUNIN_SURFACE_ENV,
      }),
      stderr: fs.openSync(path.join(this.dir, 'server.stderr.log'), 'a'),
    });
    this.client = new Client({ name: 'memory-arena', version: '1.0.0' });
    await this.client.connect(this.transport);
    const { tools } = await this.client.listTools();
    this.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    this.instructions = this.client.getInstructions() ?? '';
  }
  async stop() { await this.client?.close(); }
  apiTools() { return this.tools; }
  systemAddendum() { return this.instructions ? `\n\n# MCP Server Instructions\n\n## munin-memory\n${this.instructions}` : ''; }
  async setClock(iso) { fs.writeFileSync(this.clockFile, iso ?? ''); await sleep(250); }
  async exec(name, input) {
    const r = await this.client.callTool({ name, arguments: input ?? {} });
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    return { text, isError: !!r.isError };
  }
  // Wait until the background embedding worker has processed every entry.
  async drainEmbeddings(timeoutMs = 300_000) {
    const t0 = Date.now();
    for (;;) {
      const d = new Database(this.db, { readonly: true, fileMustExist: true });
      const row = d.prepare("SELECT SUM(embedding_status IN ('pending','processing')) AS p, SUM(embedding_status='failed') AS f, COUNT(*) AS n FROM entries").get();
      d.close();
      if (!row.p || Date.now() - t0 > timeoutMs) return row;
      await sleep(2000);
    }
  }
  snapshot() {
    const d = new Database(this.db, { readonly: true, fileMustExist: true });
    const rows = d.prepare('SELECT namespace, key, entry_type, tags, content, created_at, updated_at, embedding_status FROM entries ORDER BY created_at').all();
    d.close();
    return rows;
  }
}

// ---------------------------------------------------------------- Anthropic memory tool
function humanSize(n) {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
export class MemtoolArm {
  constructor(dir) {
    this.name = 'memtool';
    this.root = path.join(dir, 'memories');
  }
  async start() { fs.mkdirSync(this.root, { recursive: true }); }
  async stop() {}
  apiTools() { return [{ type: 'memory_20250818', name: 'memory' }]; }
  systemAddendum() { return ''; }
  resolve(p) {
    if (typeof p !== 'string' || !(p === '/memories' || p.startsWith('/memories/')) || /(^|\/)\.\.(\/|$)|%2e/i.test(p)) {
      throw new Error(`Invalid path ${p}: must be under /memories`);
    }
    const real = path.resolve(this.root, '.' + p.slice('/memories'.length));
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new Error(`Invalid path ${p}`);
    return real;
  }
  listing(p, real) {
    const lines = [];
    const walk = (dirReal, dirVirt, depth) => {
      let size = 0;
      const kids = [];
      for (const e of fs.readdirSync(dirReal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const r = path.join(dirReal, e.name); const v = `${dirVirt}/${e.name}`;
        if (e.isDirectory()) {
          const sub = depth < 2 ? walk(r, v, depth + 1) : { size: 0, lines: [] };
          kids.push([`${humanSize(Math.max(sub.size, 4096))}\t${v}`, ...sub.lines]);
          size += sub.size;
        } else {
          const s = fs.statSync(r).size; size += s;
          kids.push([`${humanSize(s)}\t${v}`]);
        }
      }
      return { size, lines: kids.flat() };
    };
    const res = walk(real, p.replace(/\/$/, ''), 1);
    lines.push(`${humanSize(Math.max(res.size, 4096))}\t${p}`, ...res.lines);
    return `Here're the files and directories up to 2 levels deep in ${p}, excluding hidden items and node_modules:\n${lines.join('\n')}`;
  }
  numbered(p, content, start = 1) {
    return `Here's the content of ${p} with line numbers:\n` + content.split('\n').map((l, i) => `${String(i + start).padStart(6)}\t${l}`).join('\n');
  }
  async exec(name, input) {
    if (name !== 'memory') return { text: `Error: unknown tool ${name}`, isError: true };
    const ok = (text) => ({ text, isError: false });
    const err = (text) => ({ text, isError: true });
    const { command } = input;
    try {
      switch (command) {
        case 'view': {
          const real = this.resolve(input.path);
          if (!fs.existsSync(real)) return err(`The path ${input.path} does not exist. Please provide a valid path.`);
          if (fs.statSync(real).isDirectory()) return ok(this.listing(input.path, real));
          let content = fs.readFileSync(real, 'utf8').replace(/\n$/, '');
          const lines = content.split('\n');
          if (Array.isArray(input.view_range)) {
            const [a, b] = input.view_range;
            const end = b === -1 ? lines.length : b;
            return ok(this.numbered(input.path, lines.slice(a - 1, end).join('\n'), a));
          }
          if (content.length > 16000) {
            content = content.slice(0, 16000);
            return ok(this.numbered(input.path, content) + '\n[... file truncated at 16000 characters; use view_range to see more]');
          }
          return ok(this.numbered(input.path, content));
        }
        case 'create': {
          const real = this.resolve(input.path);
          if (real === this.root) return err('Error: cannot create the /memories directory itself');
          fs.mkdirSync(path.dirname(real), { recursive: true });
          fs.writeFileSync(real, input.file_text ?? '');
          return ok(`File created successfully at: ${input.path}`);
        }
        case 'str_replace': {
          const real = this.resolve(input.path);
          if (!fs.existsSync(real) || fs.statSync(real).isDirectory()) return err(`Error: The path ${input.path} does not exist. Please provide a valid path.`);
          const c = fs.readFileSync(real, 'utf8');
          const old = input.old_str ?? '';
          const idx = []; let k = c.indexOf(old);
          while (old && k !== -1) { idx.push(k); k = c.indexOf(old, k + 1); }
          if (idx.length === 0) return err(`No replacement was performed, old_str \`${old}\` did not appear verbatim in ${input.path}.`);
          if (idx.length > 1) {
            const lines = idx.map((i) => c.slice(0, i).split('\n').length);
            return err(`No replacement was performed. Multiple occurrences of old_str \`${old}\` in lines: ${lines.join(', ')}. Please ensure it is unique`);
          }
          const updated = c.slice(0, idx[0]) + (input.new_str ?? '') + c.slice(idx[0] + old.length);
          fs.writeFileSync(real, updated);
          const line = updated.slice(0, idx[0]).split('\n').length;
          const all = updated.split('\n');
          const s = Math.max(1, line - 2); const e = Math.min(all.length, line + (input.new_str ?? '').split('\n').length + 2);
          return ok('The memory file has been edited.\n' + this.numbered(input.path, all.slice(s - 1, e).join('\n'), s).split('\n').slice(1).join('\n'));
        }
        case 'insert': {
          const real = this.resolve(input.path);
          if (!fs.existsSync(real) || fs.statSync(real).isDirectory()) return err(`Error: The path ${input.path} does not exist`);
          const lines = fs.readFileSync(real, 'utf8').split('\n');
          const n = input.insert_line;
          if (typeof n !== 'number' || n < 0 || n > lines.length) return err(`Error: Invalid \`insert_line\` parameter: ${n}. It should be within the range of lines of the file: [0, ${lines.length}]`);
          lines.splice(n, 0, String(input.insert_text ?? '').replace(/\n$/, ''));
          fs.writeFileSync(real, lines.join('\n'));
          return ok(`The file ${input.path} has been edited.`);
        }
        case 'delete': {
          const real = this.resolve(input.path);
          if (real === this.root) return err('Error: cannot delete the /memories directory itself');
          if (!fs.existsSync(real)) return err(`Error: The path ${input.path} does not exist`);
          fs.rmSync(real, { recursive: true });
          return ok(`Successfully deleted ${input.path}`);
        }
        case 'rename': {
          const from = this.resolve(input.old_path); const to = this.resolve(input.new_path);
          if (from === this.root) return err('Error: cannot rename the /memories directory itself');
          if (!fs.existsSync(from)) return err(`Error: The path ${input.old_path} does not exist`);
          if (fs.existsSync(to)) return err(`Error: The destination ${input.new_path} already exists`);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(from, to);
          return ok(`Successfully renamed ${input.old_path} to ${input.new_path}`);
        }
        default:
          return err(`Error: unknown command ${command}`);
      }
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  }
  snapshot() { return snapshotDir(this.root); }
}

export function snapshotDir(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------- Claude Code auto-memory
const CC_MODEL = { 'claude-opus-5-5': 'opus', 'claude-sonnet-5-5': 'sonnet', 'claude-haiku-5-5': 'haiku' };
export class ClaudeCodeArm {
  constructor(dir) {
    this.name = 'ccmem';
    fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
    this.work = fs.realpathSync(path.join(dir, 'work'));
    this.memDir = path.join(os.homedir(), '.claude', 'projects', this.work.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  }
  async start() {}
  async stop() {}
  async runSession({ model, appendSystem, userText, effort = 'medium' }) {
    const args = ['-p', userText, '--model', CC_MODEL[model], '--effort', effort,
      '--setting-sources', 'project', '--strict-mcp-config', '--tools', 'Read,Write,Edit,Glob,Grep',
      '--permission-mode', 'acceptEdits', '--add-dir', this.memDir,
      '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', appendSystem];
    fs.mkdirSync(this.memDir, { recursive: true });
    const t0 = Date.now();
    const { stdout, stderr, code } = await new Promise((resolve) => {
      const p = spawn('claude', args, { cwd: this.work, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let so = ''; let se = '';
      const timer = setTimeout(() => p.kill('SIGTERM'), 900_000);
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('close', (c) => { clearTimeout(timer); resolve({ stdout: so, stderr: se, code: c }); });
    });
    const trace = { tool_calls: [], usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, cost_usd: 0, stop: null, error: null, models: null };
    let final = '';
    const pending = new Map();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use') { const tc = { name: b.name, input: b.input, output: null, is_error: false }; trace.tool_calls.push(tc); pending.set(b.id, tc); }
        }
      } else if (ev.type === 'user') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
            const tc = pending.get(b.tool_use_id);
            tc.output = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            tc.is_error = !!b.is_error;
          }
        }
      } else if (ev.type === 'result') {
        final = ev.result ?? '';
        trace.stop = ev.subtype;
        trace.cost_usd = ev.total_cost_usd ?? 0;
        const u = ev.usage ?? {};
        trace.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 };
        trace.models = Object.keys(ev.modelUsage ?? {});
        trace.num_turns = ev.num_turns;
        if (ev.is_error) trace.error = ev.result ?? ev.subtype;
      }
    }
    if (code !== 0 && !trace.error) trace.error = `exit ${code}: ${stderr.slice(0, 400)}`;
    trace.wall_ms = Date.now() - t0;
    return { final, trace };
  }
  snapshot() { return { memory: snapshotDir(this.memDir), work: snapshotDir(this.work) }; }
}
