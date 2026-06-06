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

export function isTrackedNamespace(namespace: string): boolean {
  return namespace.startsWith("projects/") || namespace.startsWith("clients/");
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
