/**
 * Generate synthetic edge-case benchmark queries from corpus structure (#70).
 *
 * Where `derive-benchmark-queries.ts` mines what *actually happened*, this
 * script probes what *could* go wrong: it reads the entry corpus and
 * constructs queries whose ground truth is structural, exercising the
 * retrieval failure modes the hand-curated CI corpus was built around —
 *
 *   - rare-term disambiguation: a query built from terms unique to one entry,
 *     where other namespaces share the entry's common words (the
 *     "many entries mention storage engine; sqlite/wal disambiguate" case);
 *   - tag search: a query built from a distinctive tag, expecting the entries
 *     that carry it;
 *   - namespace orientation: a "<project> status" style query expecting any
 *     entry in a tracked namespace.
 *
 * Output is `source: "synthetic"` JSONL, deterministic for a given corpus so
 * the set is stable run-to-run. Like derived output it can contain private
 * terms, so it writes under the gitignored `benchmark/queries/`.
 *
 * CLI:
 *   tsx scripts/generate-synthetic-queries.ts [--db <path>] [--out <path>] [--namespace <ns>]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { initDatabase, listEntriesForDerivation } from "../src/db.js";
import type { Entry } from "../src/types.js";
import type { BenchmarkQuery } from "../benchmark/types.js";
import { inferCategory } from "./derive-benchmark-queries.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "are", "was", "were", "has",
  "had", "have", "will", "would", "should", "could", "all", "any", "not", "but", "out", "via",
  "per", "still", "underway", "pending", "review", "now", "then", "over", "under", "about",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and tokens < 3 chars. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export interface SyntheticOptions {
  /** Max rare terms to combine into a disambiguation query. Default 2. */
  rareTermsPerQuery?: number;
  /** A term is "rare" if it appears in at most this many entries. Default 1. */
  rareDocFreqMax?: number;
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function synthId(kind: string, seed: string): string {
  return `synth-${kind}-${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
}

/** Strip a prefix like `topic:` / `client:` from a tag and split into words. */
function tagToQuery(tag: string): string {
  const bare = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
  return bare.replace(/[-_]+/g, " ").trim();
}

const LIFECYCLE_TAGS = new Set([
  "active", "blocked", "completed", "stopped", "maintenance", "archived",
  "classification:internal", "classification:public",
]);

/**
 * Pure generator: build synthetic queries from a list of entries. Exported for
 * tests; the CLI wraps this around `listEntriesForDerivation`.
 */
export function generateSyntheticQueries(entries: Entry[], opts: SyntheticOptions = {}): BenchmarkQuery[] {
  const rareTermsPerQuery = opts.rareTermsPerQuery ?? 2;
  const rareDocFreqMax = opts.rareDocFreqMax ?? 1;

  // Skip empty-content entries — nothing to build a content query from.
  const corpus = entries.filter((e) => e.content && e.content.trim().length > 0);

  // Document frequency of every token across the corpus.
  const docFreq = new Map<string, number>();
  const entryTokens = new Map<string, Set<string>>();
  for (const e of corpus) {
    const toks = new Set(tokenize(e.content));
    entryTokens.set(e.id, toks);
    for (const t of toks) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const out: BenchmarkQuery[] = [];
  const seenIds = new Set<string>();
  const push = (q: BenchmarkQuery): void => {
    if (seenIds.has(q.id)) return;
    seenIds.add(q.id);
    out.push(q);
  };

  // Strategy 1: rare-term disambiguation. Terms unique (df <= rareDocFreqMax)
  // to an entry make a query that only that entry should answer.
  for (const e of corpus) {
    const toks = [...(entryTokens.get(e.id) ?? [])];
    const rare = toks
      .filter((t) => (docFreq.get(t) ?? 0) <= rareDocFreqMax)
      .sort((a, b) => (docFreq.get(a)! - docFreq.get(b)!) || a.localeCompare(b))
      .slice(0, rareTermsPerQuery);
    if (rare.length === 0) continue;
    // Anchor with a shared term (df > 1) so the query also has a distractor pull.
    const shared = toks.find((t) => (docFreq.get(t) ?? 0) > 1);
    const terms = shared ? [shared, ...rare] : rare;
    const query = terms.join(" ");
    push({
      id: synthId("rare", e.id + "|" + query),
      query,
      source: "synthetic",
      category: shared ? "cross-project" : inferCategory(e.namespace),
      search_mode: "lexical",
      expected_ids: [e.id],
      notes: `synthetic rare-term disambiguation; unique terms: ${rare.join(", ")}`,
    });
  }

  // Strategy 2: tag search. A distinctive (non-lifecycle) tag → its entries.
  const tagToEntries = new Map<string, string[]>();
  for (const e of corpus) {
    for (const tag of parseTags(e.tags)) {
      if (LIFECYCLE_TAGS.has(tag)) continue;
      const list = tagToEntries.get(tag) ?? [];
      list.push(e.id);
      tagToEntries.set(tag, list);
    }
  }
  for (const [tag, ids] of [...tagToEntries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const query = tagToQuery(tag);
    if (query.length === 0) continue;
    push({
      id: synthId("tag", tag),
      query,
      source: "synthetic",
      category: "tag-search",
      search_mode: "hybrid",
      expected_ids: [...ids].sort(),
      notes: `synthetic tag search for "${tag}"`,
    });
  }

  // Strategy 3: namespace orientation for tracked namespaces.
  const trackedNs = new Map<string, string[]>();
  for (const e of corpus) {
    const top = e.namespace.split("/")[0];
    if (top !== "projects" && top !== "clients") continue;
    const list = trackedNs.get(e.namespace) ?? [];
    list.push(e.id);
    trackedNs.set(e.namespace, list);
  }
  for (const [ns] of [...trackedNs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const leaf = ns.split("/").slice(1).join(" ").replace(/[-_]+/g, " ").trim();
    if (leaf.length === 0) continue;
    push({
      id: synthId("ns", ns),
      query: `${leaf} status`,
      source: "synthetic",
      category: "project-status",
      search_mode: "hybrid",
      expected_namespaces: [ns],
      notes: `synthetic namespace orientation for ${ns}`,
    });
  }

  // Stable global ordering: by id.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultDbPath(): string {
  return process.env.MUNIN_MEMORY_DB_PATH ?? join(homedir(), ".munin-memory", "memory.db");
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbPath = get("--db") ?? defaultDbPath();
  const outPath = get("--out") ?? join("benchmark", "queries", "synthetic.candidates.jsonl");
  const namespace = get("--namespace");

  const db = initDatabase(dbPath);
  try {
    const entries = listEntriesForDerivation(db, namespace ? { namespace } : {});
    const queries = generateSyntheticQueries(entries);
    mkdirSync(dirname(outPath), { recursive: true });
    const body = queries.map((q) => JSON.stringify(q)).join("\n");
    writeFileSync(outPath, body + (body ? "\n" : ""));
    console.error(`Read ${entries.length} entries; generated ${queries.length} synthetic queries → ${outPath}`);
    console.error(`Review with: tsx scripts/curate-benchmark-query.ts ${outPath} --out benchmark/queries/synthetic.jsonl`);
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ?? "";
if (/generate-synthetic-queries\.(ts|js|mjs)$/.test(invokedPath)) {
  main();
}
