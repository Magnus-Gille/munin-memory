// Minimal Messages API client for the memory arena.
// Raw HTTPS (no new npm dependency; owner policy on dependency installs), key read from the
// owner's dedicated Keychain item at run time and kept only in process memory.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';

// USD per million tokens (list prices, skill cache 2026-10-06). cw = 5-minute cache write (1.25x).
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01 },
};

export class BudgetExceeded extends Error {}

let apiKey = null;
async function getKey() {
  if (apiKey) return apiKey;
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password', '-s', 'claude-feedback-api', '-a', 'claude-feedback', '-w',
  ], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1 << 16 });
  apiKey = stdout.replace(/\r?\n$/, '');
  if (!apiKey.startsWith('sk-ant-')) throw new Error('Keychain item does not look like an Anthropic API key');
  return apiKey;
}

export function costOf(model, u) {
  const p = PRICES[model];
  if (!p || !u) return 0;
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out
    + (u.cache_creation_input_tokens ?? 0) * p.cw + (u.cache_read_input_tokens ?? 0) * p.cr) / 1e6;
}

// One ledger file per process (`ledger-<name>.json` in `dir`); the cap is checked against the SUM
// of all ledger files in the directory, so parallel processes share one budget.
export class Ledger {
  constructor(dir, capUsd, name) {
    this.dir = dir;
    this.file = path.join(dir, `ledger-${name}.json`);
    this.cap = capUsd;
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { total_usd: 0, calls: 0, by_model: {} };
  }
  globalTotal() {
    if (!fs.existsSync(this.dir)) return 0;
    let t = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^ledger-.*\.json$/.test(f)) continue;
      const p = path.join(this.dir, f);
      t += p === this.file ? this.state.total_usd : JSON.parse(fs.readFileSync(p, 'utf8')).total_usd;
    }
    return t;
  }
  check() {
    const t = this.globalTotal();
    if (t >= this.cap) throw new BudgetExceeded(`API budget cap $${this.cap} reached ($${t.toFixed(2)})`);
  }
  add(model, usage, tag) {
    const c = costOf(model, usage);
    this.state.total_usd += c;
    this.state.calls += 1;
    const m = (this.state.by_model[model] ??= { usd: 0, calls: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 });
    m.usd += c; m.calls += 1;
    m.input += usage.input_tokens ?? 0; m.output += usage.output_tokens ?? 0;
    m.cache_write += usage.cache_creation_input_tokens ?? 0; m.cache_read += usage.cache_read_input_tokens ?? 0;
    const t = (this.state.by_tag ??= {});
    t[tag] = (t[tag] ?? 0) + c;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    return c;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One Messages API call with bounded retries on 429/5xx/529/network errors.
export async function createMessage(body, { ledger, tag }) {
  ledger.check();
  const key = await getKey();
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (e) {
      lastErr = e; await sleep(2000 * 2 ** attempt); continue;
    }
    let text;
    try { text = await res.text(); } catch (e) { lastErr = e; await sleep(2000 * 2 ** attempt); continue; }
    if (res.ok) {
      let msg;
      // A truncated body under parallel load surfaced as "Unexpected end of JSON input" in the
      // first main run; treat it as transient. (Such a call may still have been billed.)
      try { msg = JSON.parse(text); } catch (e) { lastErr = new Error(`truncated response body (${text.length} bytes): ${e.message}`); ledger.state.truncated_bodies = (ledger.state.truncated_bodies ?? 0) + 1; await sleep(2000 * 2 ** attempt); continue; }
      msg._cost_usd = ledger.add(body.model, msg.usage, tag);
      return msg;
    }
    lastErr = new Error(`API ${res.status}: ${text.slice(0, 600)}`);
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * 2 ** attempt);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}
