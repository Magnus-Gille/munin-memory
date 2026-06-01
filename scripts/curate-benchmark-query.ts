/**
 * Curate derived benchmark-query candidates into a real query set (Phase 3, #70).
 *
 * `scripts/derive-benchmark-queries.ts` emits machine-derived candidates with
 * implicit ground truth and a provenance tail (`support`, `signals`). Those are
 * proposals, not facts — a human blesses them before they gate anything. This
 * tool walks each candidate interactively (accept / edit / skip / quit) and
 * appends the accepted ones to a target query set, stripping the provenance
 * fields so the result is a clean `BenchmarkQuery` JSONL.
 *
 * CLI:
 *   tsx scripts/curate-benchmark-query.ts <candidates.jsonl> [--out <target.jsonl>]
 *   tsx scripts/curate-benchmark-query.ts <candidates.jsonl> --accept-all   # non-interactive
 *
 * Default target: benchmark/queries/derived.jsonl
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { BenchmarkQuery } from "../benchmark/types.js";
import type { DerivedCandidate } from "./derive-benchmark-queries.js";

export interface CandidateEdits {
  query?: string;
  category?: BenchmarkQuery["category"];
  search_mode?: BenchmarkQuery["search_mode"];
}

/**
 * Convert a derived candidate into a clean BenchmarkQuery, dropping the
 * provenance tail and applying any human edits.
 */
export function blessCandidate(candidate: DerivedCandidate, edits: CandidateEdits = {}): BenchmarkQuery {
  // Pull provenance fields off; keep the rest as the canonical query shape.
  const { support: _support, signals: _signals, ...rest } = candidate;
  void _support;
  void _signals;
  const blessed: BenchmarkQuery = { ...rest };
  if (edits.query !== undefined) blessed.query = edits.query;
  if (edits.category !== undefined) blessed.category = edits.category;
  if (edits.search_mode !== undefined) blessed.search_mode = edits.search_mode;
  return blessed;
}

export interface MergeResult {
  merged: BenchmarkQuery[];
  added: number;
  skipped: number;
}

/**
 * Append blessed queries to an existing set, skipping any whose id is already
 * present so re-running curation is idempotent.
 */
export function mergeIntoQuerySet(
  existing: BenchmarkQuery[],
  blessed: BenchmarkQuery[],
): MergeResult {
  const seen = new Set(existing.map((q) => q.id));
  const merged = [...existing];
  let added = 0;
  let skipped = 0;
  for (const q of blessed) {
    if (seen.has(q.id)) {
      skipped += 1;
      continue;
    }
    seen.add(q.id);
    merged.push(q);
    added += 1;
  }
  return { merged, added, skipped };
}

/** Human-readable rendering of a candidate for the review prompt. */
export function formatCandidateForReview(c: DerivedCandidate, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`[${index}/${total}] ${c.query}`);
  lines.push(`  category: ${c.category}   search_mode: ${c.search_mode}`);
  if (c.expected_ids?.length) lines.push(`  expected_ids: ${c.expected_ids.join(", ")}`);
  if (c.expected_namespaces?.length) lines.push(`  expected_namespaces: ${c.expected_namespaces.join(", ")}`);
  if (c.negatives?.length) lines.push(`  negatives: ${c.negatives.join(", ")}`);
  lines.push(`  ${c.notes ?? `support ${c.support}`}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

export function loadCandidates(path: string): DerivedCandidate[] {
  const text = readFileSync(path, "utf-8");
  const out: DerivedCandidate[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || line.trim().startsWith("//")) continue;
    out.push(JSON.parse(line) as DerivedCandidate);
  }
  return out;
}

export function loadQuerySet(path: string): BenchmarkQuery[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const out: BenchmarkQuery[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || line.trim().startsWith("//")) continue;
    out.push(JSON.parse(line) as BenchmarkQuery);
  }
  return out;
}

export function writeQuerySet(path: string, queries: BenchmarkQuery[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = queries.map((q) => JSON.stringify(q)).join("\n");
  writeFileSync(path, body + (body ? "\n" : ""));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a)));
}

async function interactiveCurate(
  candidates: DerivedCandidate[],
  existing: BenchmarkQuery[],
): Promise<BenchmarkQuery[]> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const accepted: BenchmarkQuery[] = [];
  try {
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      process.stderr.write("\n" + formatCandidateForReview(c, i + 1, candidates.length) + "\n");
      const action = (await ask(rl, "  [a]ccept / [e]dit / [s]kip / [q]uit > ")).trim().toLowerCase();
      if (action === "q") break;
      if (action === "s" || action === "") continue;
      if (action === "e") {
        const query = (await ask(rl, `  query [${c.query}]: `)).trim();
        const category = (await ask(rl, `  category [${c.category}]: `)).trim();
        const searchMode = (await ask(rl, `  search_mode [${c.search_mode}]: `)).trim();
        accepted.push(
          blessCandidate(c, {
            query: query || undefined,
            category: category || undefined,
            search_mode: (searchMode || undefined) as BenchmarkQuery["search_mode"] | undefined,
          }),
        );
        continue;
      }
      // default: accept
      accepted.push(blessCandidate(c));
    }
  } finally {
    rl.close();
  }
  return mergeIntoQuerySet(existing, accepted).merged;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const candidatesPath = argv.find((a) => !a.startsWith("--"));
  if (!candidatesPath) {
    console.error("Usage: tsx scripts/curate-benchmark-query.ts <candidates.jsonl> [--out <target>] [--accept-all]");
    process.exit(2);
  }
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : join("benchmark", "queries", "derived.jsonl");
  const acceptAll = argv.includes("--accept-all");

  const candidates = loadCandidates(candidatesPath);
  const existing = loadQuerySet(outPath);

  let result: BenchmarkQuery[];
  if (acceptAll) {
    const blessed = candidates.map((c) => blessCandidate(c));
    const merge = mergeIntoQuerySet(existing, blessed);
    result = merge.merged;
    console.error(`Accepted all: +${merge.added}, skipped ${merge.skipped} (already present).`);
  } else {
    result = await interactiveCurate(candidates, existing);
  }

  writeQuerySet(outPath, result);
  console.error(`Wrote ${result.length} quer${result.length === 1 ? "y" : "ies"} → ${outPath}`);
}

const invokedPath = process.argv[1] ?? "";
if (/curate-benchmark-query\.(ts|js|mjs)$/.test(invokedPath)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
