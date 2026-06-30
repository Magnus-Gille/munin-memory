/**
 * Shared retrieval primitives — staleness/freshness helpers, tag lifecycle
 * utilities, and the constants that multiple retrieval tools depend on.
 *
 * Extracted from src/tools.ts as part of issue #59 (reranker-module refactor).
 * These are pure-utility declarations with no dependency on tools.ts.
 */


// --- Staleness / recency thresholds ---

export const STALENESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const EVENT_STALENESS_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const EVENT_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SEARCH_RECENCY_HALF_LIFE_DAYS = 30;
export const EXPIRES_SOON_DAYS = 7;

// Date pattern: YYYY-MM-DD (standalone or in ISO timestamp)
export const DATE_PATTERN = /\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g;

// Forward-looking phrasing that, when appearing in the same sentence as a past date, signals a
// stale statement. "will" is intentionally excluded — it fires on retrospective uses like
// "shipped 2026-03-10, will continue" and on proper names like "follow-up with Will".
export const FORWARD_LOOKING_PATTERN = /\b(?:going\s+to|plan(?:n?ing)?(?:\s+to)?|scheduled\s+(?:for|to)|upcoming|attend(?:ing)?|presenting\s+at|speaking\s+at|travel(?:l?ing)?(?:\s+to)?|join(?:ing)?)\b/i;

// --- Lifecycle tag management ---

export const LIFECYCLE_TAGS = new Set(["active", "blocked", "completed", "stopped", "maintenance", "archived"]);

export const TAG_ALIASES: Record<string, string> = {
  "done": "completed",
  "paused": "stopped",
  "inactive": "archived",
};

export const RELAXED_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "for", "how", "i", "important", "is", "it",
  "my", "myself", "of", "or", "should", "the", "to", "what",
]);

// --- Functions ---

export function parseTags(tags: string): string[] {
  return JSON.parse(tags) as string[];
}

export function isStale(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALENESS_THRESHOLD_MS;
}

export function getFreshnessScore(updatedAt: string): number {
  const ageMs = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.exp((-Math.log(2) * ageDays) / SEARCH_RECENCY_HALF_LIFE_DAYS);
}

export function getDaysUntil(validUntil: string): number {
  return (new Date(validUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

export function isEntryExpiringSoon(entry: { entry_type: "state" | "log"; valid_until?: string | null }): boolean {
  if (entry.entry_type !== "state" || !entry.valid_until) return false;
  const daysUntil = getDaysUntil(entry.valid_until);
  return daysUntil > 0 && daysUntil <= EXPIRES_SOON_DAYS;
}

/**
 * Detect if content mentions a date within the next 7 days and the entry
 * hasn't been updated in 3+ days. Returns the soonest upcoming date or null.
 */
export function findUpcomingEventDate(content: string, updatedAt: string): string | null {
  const now = Date.now();
  const sinceUpdate = now - new Date(updatedAt).getTime();
  if (sinceUpdate < EVENT_STALENESS_THRESHOLD_MS) return null; // recently updated, no concern

  let soonest: string | null = null;
  let soonestMs = Infinity;
  for (const match of content.matchAll(DATE_PATTERN)) {
    const dateStr = match[1];
    const dateMs = new Date(dateStr + "T23:59:59Z").getTime();
    const untilEvent = dateMs - now;
    if (untilEvent > 0 && untilEvent <= EVENT_LOOKAHEAD_MS && untilEvent < soonestMs) {
      soonestMs = untilEvent;
      soonest = dateStr;
    }
  }
  return soonest;
}

/**
 * Detect a YYYY-MM-DD date that has already passed while forward-looking
 * phrasing appears in the SAME sentence/line as the date. Returns the first
 * such past date string, or null. Advisory signal for stale statements like
 * "planning to attend conference 2026-03-10" after that date elapsed.
 *
 * Precision choices:
 * - Sentence/line scoping (not a 200-char window) prevents adjacent clauses
 *   from triggering (e.g. "Conference was 2026-03-10. Next we are planning…").
 * - Round-trip date validation rejects calendar overflows like 2026-02-31.
 */
export function findPassedForwardDate(content: string): string | null {
  const now = Date.now();
  for (const match of content.matchAll(DATE_PATTERN)) {
    const dateStr = match[1];
    const parsed = new Date(dateStr + "T23:59:59Z");
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) continue;
    if (parsed.getTime() >= now) continue; // future/today — handled by findUpcomingEventDate

    // Scope to the sentence/line containing the date match.
    const idx = match.index ?? 0;
    const before = Math.max(
      content.lastIndexOf(".", idx - 1),
      content.lastIndexOf("!", idx - 1),
      content.lastIndexOf("?", idx - 1),
      content.lastIndexOf("\n", idx - 1),
    );
    let after = content.length;
    for (const ch of [".", "!", "?", "\n"]) {
      const p = content.indexOf(ch, idx + match[0].length);
      if (p !== -1 && p < after) after = p;
    }
    const sentence = content.slice(before + 1, after);
    if (FORWARD_LOOKING_PATTERN.test(sentence)) return dateStr;
  }
  return null;
}

// --- Tracked-namespace patterns (dashboard taxonomy) ---

/**
 * Default tracked-namespace patterns: the namespaces whose `status` entries
 * feed the computed dashboard. Historically hardcoded as projects/* | clients/*
 * (a billing-consultant taxonomy). Now the DEFAULT, overridable per principal
 * via a meta/config entry (see resolveTrackedPatterns in tools.ts). Keeping
 * this as the default means an instance with no config behaves exactly as
 * before.
 */
export const DEFAULT_TRACKED_PATTERNS: readonly string[] = ["projects/*", "clients/*"];

/**
 * Match a namespace against a set of glob patterns. Grammar mirrors
 * namespaceMatchesPattern in access.ts: "*" matches everything, "prefix/*"
 * matches by prefix, anything else is an exact match.
 */
export function namespaceMatchesAnyPattern(ns: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    if (p.endsWith("/*")) {
      if (ns.startsWith(p.slice(0, -1))) return true;
    } else if (ns === p) {
      return true;
    }
  }
  return false;
}

function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * Translate tracked-namespace glob patterns into a parameterized SQL boolean
 * clause over `column`:
 *   - empty patterns → "0" (matches nothing)
 *   - a "*" pattern  → "1" (matches everything)
 *   - "prefix/*"     → `column LIKE 'prefix/%' ESCAPE '\\'`
 *   - exact          → `column = ?`
 * Returns the clause text and ordered bind params. `column` MUST be a trusted
 * literal (caller-supplied, never user input); only the pattern VALUES are
 * parameterized.
 */
export function trackedPatternsToSqlLike(
  patterns: readonly string[],
  column: string,
): { clause: string; params: string[] } {
  if (patterns.length === 0) return { clause: "0", params: [] };
  const ors: string[] = [];
  const params: string[] = [];
  for (const p of patterns) {
    if (p === "*") return { clause: "1", params: [] };
    if (p.endsWith("/*")) {
      ors.push(`${column} LIKE ? ESCAPE '\\'`);
      params.push(escapeLikePattern(p.slice(0, -1)) + "%");
    } else {
      ors.push(`${column} = ?`);
      params.push(p);
    }
  }
  return { clause: `(${ors.join(" OR ")})`, params };
}

/**
 * Whether `namespace` is "tracked" (its status entries feed the dashboard).
 * Defaults to DEFAULT_TRACKED_PATTERNS so existing call sites are unchanged;
 * pass resolved per-principal patterns to make it principal-aware.
 */
export function isTrackedNamespace(
  namespace: string,
  patterns: readonly string[] = DEFAULT_TRACKED_PATTERNS,
): boolean {
  return namespaceMatchesAnyPattern(namespace, patterns);
}

// --- Convention-level proposals: untracked-namespace detection (ADR 0001 layer-2) ---

/**
 * Reference / per-principal-home namespace patterns that are conventionally NOT
 * project work and must never be proposed as "tracked" dashboard namespaces.
 * Mirrors the recognized-namespace table in CLAUDE.md (`meta/*`, `people/*`,
 * `decisions/*`, `documents/*`, `reading/*`, `signals/*`, `digests/*`) plus
 * demo/scratch (`demo/*`), the task surface (`tasks/*`), feedback (`feedback/*`),
 * and per-principal homes (`users/*`). Suppresses false positives so the
 * `untracked_namespace` proposal only fires on namespaces that genuinely look
 * like un-dashboarded project work.
 */
export const REFERENCE_NAMESPACE_PATTERNS: readonly string[] = [
  "meta/*",
  "people/*",
  "decisions/*",
  "documents/*",
  "reading/*",
  "signals/*",
  "digests/*",
  "demo/*",
  "tasks/*",
  "feedback/*",
  "users/*",
];

/** Minimum state+log entries under a top-level prefix before it is proposed as untracked. */
export const UNTRACKED_NAMESPACE_MIN_ENTRIES = 3;

/**
 * Top-level prefix to attribute a namespace to for untracked-cluster detection,
 * or null if the namespace is tracked or a reference namespace. Shared by the
 * entry-based proposal (memory_patterns) and the count-based orient nag so both
 * apply identical exclusions. The whole-prefix `pattern` checks cover a bare
 * top-level namespace (e.g. "tasks") whose `tasks/*` pattern is tracked/reference
 * but does not match the bare name.
 */
function untrackedPrefixOf(
  ns: string,
  trackedPatterns: readonly string[],
  referencePatterns: readonly string[],
): string | null {
  if (namespaceMatchesAnyPattern(ns, trackedPatterns)) return null;
  if (namespaceMatchesAnyPattern(ns, referencePatterns)) return null;
  const prefix = ns.split("/")[0];
  const pattern = `${prefix}/*`;
  if (trackedPatterns.includes(pattern)) return null;
  if (referencePatterns.includes(pattern)) return null;
  return prefix;
}

export interface UntrackedNamespaceCandidate {
  /** Top-level namespace segment, e.g. "recipes". */
  prefix: string;
  /** Glob pattern to add to tracked_patterns to crystallize, e.g. "recipes/*". */
  pattern: string;
  /** Total entries observed under this prefix (within the supplied input set). */
  entry_count: number;
  /** Distinct full namespaces seen under this prefix, sorted ascending. */
  namespaces: string[];
  /** Sample entry ids (up to maxSources) backing the proposal. */
  source_entry_ids: string[];
  /** Most recent updated_at across the prefix's entries. */
  last_activity_at: string;
}

/**
 * Detect namespaces the principal keeps writing to that are NOT in their resolved
 * tracked patterns and are NOT conventional reference namespaces — i.e. taxonomy
 * the dashboard is missing. Pure: groups the supplied entries by top-level
 * segment, drops anything tracked or reference-allowlisted, and returns clusters
 * at or above `minEntries`, sorted by entry_count desc then prefix asc.
 *
 * The output feeds an owner-only, propose-only `untracked_namespace` PatternItem
 * (observe → propose; never auto-writes). A cluster disappears once its `<prefix>/*`
 * pattern is crystallized into the principal's meta/config tracked_patterns.
 */
export function detectUntrackedNamespaces(
  entries: readonly { id: string; namespace: string; updated_at: string }[],
  trackedPatterns: readonly string[],
  options: {
    minEntries?: number;
    referencePatterns?: readonly string[];
    maxSources?: number;
  } = {},
): UntrackedNamespaceCandidate[] {
  const minEntries = options.minEntries ?? UNTRACKED_NAMESPACE_MIN_ENTRIES;
  const referencePatterns = options.referencePatterns ?? REFERENCE_NAMESPACE_PATTERNS;
  const maxSources = options.maxSources ?? 6;

  interface Group {
    prefix: string;
    entry_count: number;
    namespaces: Set<string>;
    sourceIds: string[];
    last_activity_at: string;
  }
  const groups = new Map<string, Group>();

  for (const e of entries) {
    const prefix = untrackedPrefixOf(e.namespace, trackedPatterns, referencePatterns);
    if (prefix === null) continue;
    const ns = e.namespace;

    let group = groups.get(prefix);
    if (!group) {
      group = { prefix, entry_count: 0, namespaces: new Set(), sourceIds: [], last_activity_at: e.updated_at };
      groups.set(prefix, group);
    }
    group.entry_count += 1;
    group.namespaces.add(ns);
    if (group.sourceIds.length < maxSources) group.sourceIds.push(e.id);
    if (e.updated_at > group.last_activity_at) group.last_activity_at = e.updated_at;
  }

  return [...groups.values()]
    .filter((g) => g.entry_count >= minEntries)
    .map((g) => ({
      prefix: g.prefix,
      pattern: `${g.prefix}/*`,
      entry_count: g.entry_count,
      namespaces: [...g.namespaces].sort(),
      source_entry_ids: g.sourceIds,
      last_activity_at: g.last_activity_at,
    }))
    .sort((a, b) => b.entry_count - a.entry_count || a.prefix.localeCompare(b.prefix));
}

export interface UntrackedNamespaceCluster {
  prefix: string;
  pattern: string;
  entry_count: number;
}

/**
 * Count-based variant of {@link detectUntrackedNamespaces} for the orient hot
 * path: derives the same untracked clusters from cheap per-namespace counts
 * (`listNamespaces`) without loading every entry. Returns clusters at or above
 * `minEntries`, sorted by entry_count desc then prefix asc. Used only to decide
 * whether to nag (count of clusters); the full proposal with sources is built by
 * memory_patterns.
 */
export function detectUntrackedNamespaceClusters(
  namespaceCounts: readonly { namespace: string; state_count: number; log_count: number }[],
  trackedPatterns: readonly string[],
  options: { minEntries?: number; referencePatterns?: readonly string[] } = {},
): UntrackedNamespaceCluster[] {
  const minEntries = options.minEntries ?? UNTRACKED_NAMESPACE_MIN_ENTRIES;
  const referencePatterns = options.referencePatterns ?? REFERENCE_NAMESPACE_PATTERNS;
  const counts = new Map<string, number>();

  for (const row of namespaceCounts) {
    const prefix = untrackedPrefixOf(row.namespace, trackedPatterns, referencePatterns);
    if (prefix === null) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + row.state_count + row.log_count);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minEntries)
    .map(([prefix, count]) => ({ prefix, pattern: `${prefix}/*`, entry_count: count }))
    .sort((a, b) => b.entry_count - a.entry_count || a.prefix.localeCompare(b.prefix));
}

export function canonicalizeTags(tags: string[]): { canonical: string[]; normalized: string[] } {
  const normalized: string[] = [];
  const canonical = tags.map(t => {
    const alias = TAG_ALIASES[t];
    if (alias) {
      normalized.push(`"${t}" → "${alias}"`);
      return alias;
    }
    return t;
  });
  return { canonical, normalized };
}

/**
 * Tags that are server-injected only and must never be accepted from client
 * input. The consolidation worker stamps `source:synthesis` (via writeState,
 * which bypasses the tool layer); stripping it from user-supplied tags keeps the
 * provenance signal unspoofable. Applied unconditionally on every write/log/patch
 * path (separate from alias canonicalization, which only runs for status writes).
 */
export const RESERVED_SERVER_TAGS = new Set<string>(["source:synthesis"]);

export function stripReservedTags(tags: string[]): { kept: string[]; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const t of tags) {
    if (RESERVED_SERVER_TAGS.has(t)) removed.push(t);
    else kept.push(t);
  }
  return { kept, removed };
}

export function getLifecycleTags(tags: string[]): string[] {
  return tags.filter(t => LIFECYCLE_TAGS.has(t));
}

// --- Boundary serialization ---

/**
 * Boundary-priority serialization: place the highest-ranked items at the
 * boundaries of the list (where LLM attention is strongest) rather than in
 * the middle (where it is weakest — "lost in the middle" problem).
 *
 * Given best-first input [r1, r2, r3, r4, r5] it returns [r1, r3, r5, r4, r2]:
 * rank 1 at the start, rank 2 at the end. Pure and order-only — the same items
 * come back, so callers must not derive ranks from the returned order. A no-op
 * for 0–2 items.
 *
 * Moved from src/tools.ts (where it was private) to this module so both the
 * MCP tool layer and the answer-quality eval harness share one implementation.
 */
export function boundarySerialize<T>(items: T[]): T[] {
  if (items.length <= 2) return items;
  const front: T[] = [];
  const back: T[] = [];
  items.forEach((item, i) => {
    if (i % 2 === 0) front.push(item);
    else back.push(item);
  });
  back.reverse();
  return [...front, ...back];
}

/** Serialization mode: "linear" preserves rank order, "boundary" reorders for LLM attention. */
export type SerializationMode = "linear" | "boundary";

/**
 * Apply a serialization mode to an ordered list of items.
 * "linear" = identity (preserves rank order).
 * "boundary" = boundarySerialize (reorders for LLM primacy/recency effect).
 */
export function serializeOrder<T>(items: T[], mode: SerializationMode): T[] {
  return mode === "boundary" ? boundarySerialize(items) : items;
}
