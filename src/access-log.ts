import type { RequestLogEntry } from "./index.js";

// Request access logging for the HTTP transport (MUNIN-426).
//
// `verbose` writes one JSON line per request, as the service always did.
// `summary` (default) aggregates successful and rate-limited requests into one
// `access_summary` line per interval, and writes individual lines only for
// errors (status >= 400 other than 429), slow requests, and within a bounded
// per-interval budget. Summaries carry no session or request ids and no
// headers or bodies.

export type AccessLogMode = "summary" | "verbose";

export interface AccessLogOptions {
  write: (line: string) => void;
  mode: AccessLogMode;
  intervalMs: number;
  /** Requests at or above this duration get an individual line. 0 disables. */
  slowMs: number;
  /** Individual lines allowed per interval; overflow is counted in the summary. */
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
}

function newCounters(): ClientCounters {
  return { requests: 0, rateLimited: 0, errors: 0, maxDurationMs: 0, tools: new Map(), toolsOther: 0 };
}

function clientKey(entry: RequestLogEntry): string {
  return entry.clientId ?? entry.authType ?? "anonymous";
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
  let clients = new Map<string, ClientCounters>();
  let individualThisInterval = 0;
  let suppressedIndividual = 0;

  function resetWindow(): void {
    windowStart = undefined;
    total = 0;
    byStatus = new Map();
    clients = new Map();
    individualThisInterval = 0;
    suppressedIndividual = 0;
  }

  function armTimer(): void {
    if (timer !== undefined || stopped) return;
    timer = setInterval(() => flush(), intervalMs);
    // The access log must never keep the process alive on its own.
    timer.unref();
  }

  function writeIndividual(entry: RequestLogEntry): void {
    if (individualThisInterval < maxIndividualPerInterval) {
      individualThisInterval += 1;
      write(JSON.stringify(entry));
    } else {
      suppressedIndividual += 1;
    }
  }

  function record(entry: RequestLogEntry): void {
    if (windowStart === undefined) windowStart = now();
    total += 1;
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);

    const key = clientKey(entry);
    let counters = clients.get(key);
    if (!counters) {
      counters = newCounters();
      clients.set(key, counters);
    }
    counters.requests += 1;
    if (entry.status === RATE_LIMITED_STATUS) counters.rateLimited += 1;
    else if (isIndividualStatus(entry.status)) counters.errors += 1;
    counters.maxDurationMs = Math.max(counters.maxDurationMs, entry.durationMs);
    if (entry.toolName !== undefined) {
      const current = counters.tools.get(entry.toolName);
      if (current !== undefined) {
        counters.tools.set(entry.toolName, current + 1);
      } else if (counters.tools.size < MAX_TOOLS_PER_CLIENT) {
        counters.tools.set(entry.toolName, 1);
      } else {
        counters.toolsOther += 1;
      }
    }
  }

  function summarize(end: number): Record<string, unknown> {
    const ranked = [...clients.entries()].sort((a, b) => b[1].requests - a[1].requests);
    const listed = ranked.slice(0, maxClients);
    const folded = ranked.slice(maxClients);

    const toSummary = (counters: ClientCounters): ClientSummary => {
      const tools: Record<string, number> = Object.fromEntries(counters.tools);
      if (counters.toolsOther > 0) tools._other = counters.toolsOther;
      return {
        requests: counters.requests,
        rateLimited: counters.rateLimited,
        errors: counters.errors,
        maxDurationMs: counters.maxDurationMs,
        tools,
      };
    };

    const other = newCounters();
    for (const [, counters] of folded) {
      other.requests += counters.requests;
      other.rateLimited += counters.rateLimited;
      other.errors += counters.errors;
      other.maxDurationMs = Math.max(other.maxDurationMs, counters.maxDurationMs);
    }

    const clientsOut: Record<string, ClientSummary> = {};
    for (const [key, counters] of listed) clientsOut[key] = toSummary(counters);

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

    const slow = slowMs > 0 && entry.durationMs > slowMs;
    if (isIndividualStatus(entry.status) || slow) {
      writeIndividual(entry);
    }
    record(entry);
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
