import { createHash } from "node:crypto";
import type { RequestLogEntry } from "./index.js";

// Request access logging for the HTTP transport (MUNIN-426).
//
// `verbose` writes one JSON line per request, as the service always did.
// `summary` (default) aggregates successful and rate-limited requests into one
// `access_summary` line per interval, and writes individual lines only for
// errors (status >= 400 other than 429) and slow requests, within bounded
// per-interval budgets. Budgets are kept per source (client id, or the shared
// unauthenticated source) and per class (5xx versus everything else), so a
// flood from one source or of one kind cannot hide another client's errors;
// a global ceiling bounds the total. Summaries carry no session or request ids
// and no headers or bodies.

export type AccessLogMode = "summary" | "verbose";

export interface AccessLogOptions {
  write: (line: string) => void;
  mode: AccessLogMode;
  intervalMs: number;
  /** Requests at or above this duration get an individual line. 0 disables. */
  slowMs: number;
  /**
   * Individual lines allowed per interval for each source and class (5xx or
   * other). A global ceiling of GLOBAL_INDIVIDUAL_CEILING_FACTOR times this
   * value bounds the total. Overflow is counted in the summary.
   */
  maxIndividualPerInterval: number;
  /** Maximum clients listed by name in each summary (default 20). */
  maxClients?: number;
  now?: () => number;
}

export interface AccessLogger {
  log(entry: RequestLogEntry): void;
  flush(): void;
  stop(): void;
}

export interface AccessLogConfig {
  mode: AccessLogMode;
  intervalMs: number;
  slowMs: number;
  maxIndividualPerInterval: number;
}

const DEFAULT_CONFIG: AccessLogConfig = {
  mode: "summary",
  intervalMs: 60_000,
  slowMs: 5_000,
  maxIndividualPerInterval: 20,
};

const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 3_600_000;
const MIN_INDIVIDUAL = 1;
const DEFAULT_MAX_CLIENTS = 20;
const MAX_TOOLS_PER_CLIENT = 10;
const RATE_LIMITED_STATUS = 429;
/** Total individual lines per interval = this factor x the per-source budget. */
const GLOBAL_INDIVIDUAL_CEILING_FACTOR = 5;
/** Distinct sources tracked per interval; further sources share one overflow bucket. */
const MAX_TRACKED_SOURCES = 1_000;
/**
 * Internal key of the shared overflow bucket. A symbol cannot collide with any
 * caller-controlled client label, and the bucket is reported as `otherClients`.
 */
const OVERFLOW_SOURCE: unique symbol = Symbol("access-log-overflow");
type SourceKey = string | typeof OVERFLOW_SOURCE;
/** Longest client or tool label kept; longer ones are shortened so retained memory stays bounded. */
const MAX_LABEL_LENGTH = 128;
const LABEL_PREFIX_LENGTH = 100;
const LABEL_DIGEST_LENGTH = 16;

function parseNonNegativeInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse MUNIN_ACCESS_LOG_* settings. Never throws: unparseable values fall back
 * to defaults, and numeric values outside their documented range are clamped.
 */
export function getAccessLogConfig(env: Record<string, string | undefined> = process.env): AccessLogConfig {
  const rawMode = env.MUNIN_ACCESS_LOG_MODE?.trim().toLowerCase();
  const mode: AccessLogMode = rawMode === "verbose" || rawMode === "summary" ? rawMode : DEFAULT_CONFIG.mode;

  const interval = parseNonNegativeInteger(env.MUNIN_ACCESS_LOG_INTERVAL_MS);
  const slow = parseNonNegativeInteger(env.MUNIN_ACCESS_LOG_SLOW_MS);
  const maxIndividual = parseNonNegativeInteger(env.MUNIN_ACCESS_LOG_MAX_INDIVIDUAL);

  return {
    mode,
    intervalMs: interval === undefined
      ? DEFAULT_CONFIG.intervalMs
      : clamp(interval, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    slowMs: slow ?? DEFAULT_CONFIG.slowMs,
    maxIndividualPerInterval: maxIndividual === undefined
      ? DEFAULT_CONFIG.maxIndividualPerInterval
      : Math.max(MIN_INDIVIDUAL, maxIndividual),
  };
}

interface ClientCounters {
  requests: number;
  rateLimited: number;
  errors: number;
  maxDurationMs: number;
  tools: Map<string, number>;
  toolsOther: number;
}

interface ClientSummary {
  requests: number;
  rateLimited: number;
  errors: number;
  maxDurationMs: number;
  tools: Record<string, number>;
  /** Requests for tool names beyond the per-client name cap; omitted when zero. */
  toolsOther?: number;
}

function newCounters(): ClientCounters {
  return { requests: 0, rateLimited: 0, errors: 0, maxDurationMs: 0, tools: new Map(), toolsOther: 0 };
}

/** Shape of every label this module produces by shortening: `<prefix>~<16 hex digits>`. */
const SHORTENED_LABEL = /~[0-9a-f]{16}$/;

/**
 * Bound a caller-controlled label (client id, tool name). A label is kept as is
 * only when it is at most 128 characters and does not already look like a
 * shortened label; everything else becomes `<100-char prefix>~<16 hex digits of
 * SHA-256 over the full label>`. That makes the shortened form
 *   - bounded in size (at most 117 characters),
 *   - distinct for distinct inputs (the digest covers the exact UTF-16 code
 *     units, so lone surrogates and U+FFFD do not merge), and
 *   - disjoint from kept labels, since a label that already ends in `~<16 hex>`
 *     is itself shortened and so cannot be mistaken for another label's form.
 * The prefix is copied through a Buffer so the retained string owns its storage;
 * a plain `slice` of a long string can keep the original (possibly multi-megabyte)
 * string alive as its backing store.
 */
function boundLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH && !SHORTENED_LABEL.test(label)) return label;
  const prefix = Buffer.from(label.slice(0, LABEL_PREFIX_LENGTH), "utf8").toString("utf8");
  const digest = createHash("sha256").update(Buffer.from(label, "utf16le")).digest("hex").slice(0, LABEL_DIGEST_LENGTH);
  return `${prefix}~${digest}`;
}

function clientKey(entry: RequestLogEntry): string {
  return boundLabel(entry.clientId ?? entry.authType ?? "anonymous");
}

function isIndividualStatus(status: number): boolean {
  return status >= 400 && status !== RATE_LIMITED_STATUS;
}

export function createAccessLogger(options: AccessLogOptions): AccessLogger {
  const {
    write,
    mode,
    intervalMs,
    slowMs,
    maxIndividualPerInterval,
    maxClients = DEFAULT_MAX_CLIENTS,
    now = Date.now,
  } = options;

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let windowStart: number | undefined;
  let total = 0;
  let byStatus = new Map<number, number>();
  let clients = new Map<SourceKey, ClientCounters>();
  let individualBySourceClass = new Map<string, number>();
  let individualThisInterval = 0;
  let suppressedIndividual = 0;
  const globalIndividualCeiling = maxIndividualPerInterval * GLOBAL_INDIVIDUAL_CEILING_FACTOR;

  function resetWindow(): void {
    windowStart = undefined;
    total = 0;
    byStatus = new Map();
    clients = new Map();
    individualBySourceClass = new Map();
    individualThisInterval = 0;
    suppressedIndividual = 0;
  }

  /** Source key used for both counters and budgets; bounded against key floods. */
  function sourceKey(entry: RequestLogEntry): SourceKey {
    const key = clientKey(entry);
    if (clients.has(key)) return key;
    // The overflow bucket does not count toward the tracking cap.
    const tracked = clients.has(OVERFLOW_SOURCE) ? clients.size - 1 : clients.size;
    return tracked < MAX_TRACKED_SOURCES ? key : OVERFLOW_SOURCE;
  }

  function armTimer(): void {
    if (timer !== undefined || stopped) return;
    timer = setInterval(() => flush(), intervalMs);
    // The access log must never keep the process alive on its own.
    timer.unref();
  }

  function writeIndividual(entry: RequestLogEntry, source: SourceKey): void {
    // Label-derived keys carry an "s:" prefix, so they cannot equal the overflow key.
    const budgetKey = `${source === OVERFLOW_SOURCE ? "overflow" : `s:${source}`}|${entry.status >= 500 ? "5xx" : "other"}`;
    const used = individualBySourceClass.get(budgetKey) ?? 0;
    if (used < maxIndividualPerInterval && individualThisInterval < globalIndividualCeiling) {
      individualBySourceClass.set(budgetKey, used + 1);
      individualThisInterval += 1;
      write(JSON.stringify(entry));
    } else {
      suppressedIndividual += 1;
    }
  }

  function record(entry: RequestLogEntry, source: SourceKey): void {
    if (windowStart === undefined) windowStart = now();
    total += 1;
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);

    let counters = clients.get(source);
    if (!counters) {
      counters = newCounters();
      clients.set(source, counters);
    }
    counters.requests += 1;
    if (entry.status === RATE_LIMITED_STATUS) counters.rateLimited += 1;
    else if (isIndividualStatus(entry.status)) counters.errors += 1;
    counters.maxDurationMs = Math.max(counters.maxDurationMs, entry.durationMs);
    if (entry.toolName !== undefined) {
      const toolName = boundLabel(entry.toolName);
      const current = counters.tools.get(toolName);
      if (current !== undefined) {
        counters.tools.set(toolName, current + 1);
      } else if (counters.tools.size < MAX_TOOLS_PER_CLIENT) {
        counters.tools.set(toolName, 1);
      } else {
        counters.toolsOther += 1;
      }
    }
  }

  function summarize(end: number): Record<string, unknown> {
    const overflow = clients.get(OVERFLOW_SOURCE);
    const ranked = [...clients.entries()]
      .filter((pair): pair is [string, ClientCounters] => pair[0] !== OVERFLOW_SOURCE)
      .sort((a, b) => b[1].requests - a[1].requests);
    const listed = ranked.slice(0, maxClients);
    const folded = overflow ? [...ranked.slice(maxClients), [OVERFLOW_SOURCE, overflow] as const] : ranked.slice(maxClients);

    const toSummary = (counters: ClientCounters): ClientSummary => {
      const summary: ClientSummary = {
        requests: counters.requests,
        rateLimited: counters.rateLimited,
        errors: counters.errors,
        maxDurationMs: counters.maxDurationMs,
        tools: Object.fromEntries(counters.tools),
      };
      if (counters.toolsOther > 0) summary.toolsOther = counters.toolsOther;
      return summary;
    };

    const other = newCounters();
    for (const [, counters] of folded) {
      other.requests += counters.requests;
      other.rateLimited += counters.rateLimited;
      other.errors += counters.errors;
      other.maxDurationMs = Math.max(other.maxDurationMs, counters.maxDurationMs);
    }

    // fromEntries defines own properties, so a client id such as "__proto__"
    // is kept instead of invoking the prototype setter.
    const clientsOut: Record<string, ClientSummary> = Object.fromEntries(
      listed.map(([key, counters]) => [key, toSummary(counters)]),
    );

    return {
      timestamp: new Date(end).toISOString(),
      event: "access_summary",
      windowStart: new Date(windowStart ?? end).toISOString(),
      windowEnd: new Date(end).toISOString(),
      intervalMs,
      total,
      byStatus: Object.fromEntries([...byStatus.entries()].map(([status, count]) => [String(status), count])),
      clients: clientsOut,
      otherClients: {
        requests: other.requests,
        rateLimited: other.rateLimited,
        errors: other.errors,
        maxDurationMs: other.maxDurationMs,
      },
      suppressedIndividual,
    };
  }

  function flush(): void {
    // Idle intervals write nothing.
    if (total === 0) return;
    const summary = summarize(now());
    resetWindow();
    write(JSON.stringify(summary));
  }

  function log(entry: RequestLogEntry): void {
    if (mode === "verbose") {
      write(JSON.stringify(entry));
      return;
    }

    const source = sourceKey(entry);
    const slow = slowMs > 0 && entry.durationMs >= slowMs;
    if (isIndividualStatus(entry.status) || slow) {
      writeIndividual(entry, source);
    }
    record(entry, source);
    armTimer();
  }

  function stop(): void {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (mode === "summary") flush();
  }

  return { log, flush, stop };
}
