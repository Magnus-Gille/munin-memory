import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createAccessLogger, getAccessLogConfig, type AccessLogOptions } from "../src/access-log.js";
import type { RequestLogEntry } from "../src/index.js";

const INTERVAL_MS = 60_000;

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    timestamp: "2026-11-14T00:00:00.000Z",
    method: "POST",
    path: "/mcp",
    rpcMethod: "tools/call",
    toolName: "memory_read",
    authType: "bearer",
    clientId: "client-a",
    sessionId: "session-secret-1",
    requestId: "request-secret-1",
    status: 200,
    durationMs: 12,
    ...overrides,
  };
}

interface Harness {
  lines: string[];
  write: (line: string) => void;
}

function harness(): Harness {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function options(h: Harness, overrides: Partial<AccessLogOptions> = {}): AccessLogOptions {
  return {
    write: h.write,
    mode: "summary",
    intervalMs: INTERVAL_MS,
    slowMs: 5000,
    maxIndividualPerInterval: 20,
    ...overrides,
  };
}

function parse(line: string): Record<string, any> {
  return JSON.parse(line) as Record<string, any>;
}

describe("access logger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates successful requests into one summary line per interval", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));

    logger.log(entry({ toolName: "memory_read", clientId: "client-a" }));
    logger.log(entry({ toolName: "memory_read", clientId: "client-a" }));
    logger.log(entry({ toolName: "memory_query", clientId: "client-b", status: 201 }));
    expect(h.lines).toHaveLength(0);

    vi.advanceTimersByTime(INTERVAL_MS);

    expect(h.lines).toHaveLength(1);
    const summary = parse(h.lines[0]!);
    expect(summary.event).toBe("access_summary");
    expect(summary.intervalMs).toBe(INTERVAL_MS);
    expect(summary.total).toBe(3);
    expect(summary.byStatus).toEqual({ "200": 2, "201": 1 });
    expect(summary.clients["client-a"]).toMatchObject({ requests: 2, rateLimited: 0, errors: 0, tools: { memory_read: 2 } });
    expect(summary.clients["client-b"]).toMatchObject({ requests: 1, tools: { memory_query: 1 } });
    expect(summary.suppressedIndividual).toBe(0);
    expect(typeof summary.windowStart).toBe("string");
    expect(typeof summary.windowEnd).toBe("string");
    expect(summary.otherClients).toEqual({ requests: 0, rateLimited: 0, errors: 0, maxDurationMs: 0 });
  });

  it("never includes session or request ids in the summary", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.log(entry());
    logger.flush();
    expect(h.lines[0]).not.toContain("session-secret-1");
    expect(h.lines[0]).not.toContain("request-secret-1");
  });

  it("counts 429 rejections per client instead of logging each one", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    for (let i = 0; i < 5; i += 1) {
      logger.log(entry({ status: 429, clientId: "client-a", durationMs: 1, rateLimit: undefined }));
    }
    logger.log(entry({ status: 200, clientId: "client-a" }));

    expect(h.lines).toHaveLength(0);
    logger.flush();

    expect(h.lines).toHaveLength(1);
    const summary = parse(h.lines[0]!);
    expect(summary.byStatus).toEqual({ "429": 5, "200": 1 });
    expect(summary.clients["client-a"]).toMatchObject({ requests: 6, rateLimited: 5, errors: 0 });
    expect(summary.suppressedIndividual).toBe(0);
  });

  it("logs a 500 and a 401 individually in the exact entry shape", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    const serverError = entry({ status: 500, toolName: "memory_write" });
    const unauthorized = entry({ status: 401, authType: "none", clientId: undefined, toolName: undefined });

    logger.log(serverError);
    logger.log(unauthorized);

    expect(h.lines).toEqual([JSON.stringify(serverError), JSON.stringify(unauthorized)]);
  });

  it("counts errors in the summary as well as logging them", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.log(entry({ status: 500 }));
    logger.flush();
    const summary = parse(h.lines[1]!);
    expect(summary.clients["client-a"]).toMatchObject({ requests: 1, errors: 1, rateLimited: 0 });
  });

  it("logs slow requests individually and can disable slow logging with slowMs 0", () => {
    const slowH = harness();
    const slowLogger = createAccessLogger(options(slowH, { slowMs: 5000 }));
    const slow = entry({ status: 200, durationMs: 6000 });
    slowLogger.log(entry({ status: 200, durationMs: 4999 }));
    slowLogger.log(slow);
    expect(slowH.lines).toEqual([JSON.stringify(slow)]);

    // "At or above" the threshold: a request of exactly slowMs is logged too.
    const boundary = entry({ status: 200, durationMs: 5000 });
    slowLogger.log(boundary);
    expect(slowH.lines).toEqual([JSON.stringify(slow), JSON.stringify(boundary)]);

    const disabledH = harness();
    const disabledLogger = createAccessLogger(options(disabledH, { slowMs: 0 }));
    disabledLogger.log(entry({ status: 200, durationMs: 60_000 }));
    expect(disabledH.lines).toHaveLength(0);
  });

  it("caps individual lines per interval and reports the overflow as suppressedIndividual", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 2 }));

    for (let i = 0; i < 5; i += 1) {
      logger.log(entry({ status: 500 }));
    }
    expect(h.lines).toHaveLength(2);

    logger.flush();
    expect(h.lines).toHaveLength(3);
    const summary = parse(h.lines[2]!);
    expect(summary.event).toBe("access_summary");
    expect(summary.suppressedIndividual).toBe(3);
    expect(summary.clients["client-a"]).toMatchObject({ requests: 5, errors: 5 });

    // The individual budget resets for the next interval.
    logger.log(entry({ status: 500 }));
    expect(h.lines).toHaveLength(4);
    logger.flush();
    expect(parse(h.lines.at(-1)!).suppressedIndividual).toBe(0);
  });

  it("keeps an authenticated client's 500 visible during an anonymous 401 flood (individual budgets are per source)", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 2 }));
    const anonymous = (): RequestLogEntry =>
      entry({ status: 401, authType: "none", clientId: undefined, toolName: undefined });

    for (let i = 0; i < 6; i += 1) logger.log(anonymous());
    expect(h.lines).toHaveLength(2);

    const serverError = entry({ status: 500, clientId: "client-a" });
    logger.log(serverError);
    expect(h.lines.at(-1)).toBe(JSON.stringify(serverError));
    expect(h.lines).toHaveLength(3);

    logger.flush();
    const summary = parse(h.lines.at(-1)!);
    expect(summary.suppressedIndividual).toBe(4);
  });

  it("keeps a client's 5xx visible during a flood of its own 4xx errors", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 2 }));

    for (let i = 0; i < 6; i += 1) logger.log(entry({ status: 403, clientId: "client-a" }));
    expect(h.lines).toHaveLength(2);

    const serverError = entry({ status: 502, clientId: "client-a" });
    logger.log(serverError);
    expect(h.lines.at(-1)).toBe(JSON.stringify(serverError));
  });

  it("does not let one authenticated client's errors use up another client's budget", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 2 }));

    for (let i = 0; i < 6; i += 1) logger.log(entry({ status: 400, clientId: "client-a" }));
    const other = entry({ status: 400, clientId: "client-b" });
    logger.log(other);

    expect(h.lines).toHaveLength(3);
    expect(h.lines.at(-1)).toBe(JSON.stringify(other));
  });

  it("bounds the total individual lines per interval across all sources", () => {
    const h = harness();
    // Ceiling is 5 x the per-source budget: 5 x 2 = 10.
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 2 }));

    for (let i = 0; i < 30; i += 1) logger.log(entry({ status: 500, clientId: `client-${i}` }));
    expect(h.lines).toHaveLength(10);

    logger.flush();
    const summary = parse(h.lines.at(-1)!);
    expect(summary.suppressedIndividual).toBe(20);
    expect(summary.total).toBe(30);
  });

  it("bounds tracked clients and keeps counting the rest in otherClients", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxClients: 3 }));

    for (let i = 0; i < 2_500; i += 1) logger.log(entry({ clientId: `client-${i}` }));
    logger.flush();

    const summary = parse(h.lines.at(-1)!);
    expect(summary.total).toBe(2_500);
    expect(Object.keys(summary.clients)).toHaveLength(3);
    const listed = Object.values(summary.clients as Record<string, { requests: number }>)
      .reduce((sum, client) => sum + client.requests, 0);
    expect(listed + summary.otherClients.requests).toBe(2_500);
  });

  it("observably stops tracking sources beyond the cap and folds them into otherClients", () => {
    const h = harness();
    // maxClients far above the tracking cap, so only the tracking cap limits the named clients.
    const logger = createAccessLogger(options(h, { maxClients: 5_000 }));

    for (let i = 0; i < 2_500; i += 1) logger.log(entry({ clientId: `client-${i}` }));
    logger.flush();

    const summary = parse(h.lines.at(-1)!);
    expect(summary.total).toBe(2_500);
    expect(Object.keys(summary.clients)).toHaveLength(1_000);
    expect(summary.otherClients.requests).toBe(1_500);
  });

  it("keeps a real client named _overflow separate from overflow traffic", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxClients: 5_000, maxIndividualPerInterval: 2 }));

    // Track the real "_overflow" client and 999 others: the tracking cap (1,000) is reached.
    logger.log(entry({ clientId: "_overflow" }));
    for (let i = 0; i < 999; i += 1) logger.log(entry({ clientId: `c-${i}` }));
    // Two untracked clients exhaust the shared overflow budget for 5xx lines.
    logger.log(entry({ clientId: "new-1", status: 500 }));
    logger.log(entry({ clientId: "new-2", status: 500 }));
    // The real "_overflow" client's own first 500 must still get its individual line.
    const own = entry({ clientId: "_overflow", status: 500 });
    logger.log(own);
    expect(h.lines).toContain(JSON.stringify(own));

    logger.flush();
    const summary = parse(h.lines.at(-1)!);
    expect(summary.suppressedIndividual).toBe(0);
    expect(summary.clients["_overflow"]).toMatchObject({ requests: 2, errors: 1 });
    expect(summary.otherClients).toMatchObject({ requests: 2, errors: 2 });
  });

  it("keeps clients that share a 128-character prefix distinct", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 2 }));
    const prefix = "a".repeat(128);
    const first = prefix + "first";
    const second = prefix + "second";

    logger.log(entry({ clientId: first, status: 500 }));
    logger.log(entry({ clientId: first, status: 500 }));
    const secondEntry = entry({ clientId: second, status: 500 });
    logger.log(secondEntry);
    // The second client has its own budget, so its first 500 is not suppressed by the first's.
    expect(h.lines).toContain(JSON.stringify(secondEntry));

    logger.flush();
    const summary = parse(h.lines.at(-1)!);
    expect(summary.suppressedIndividual).toBe(0);
    const keys = Object.keys(summary.clients);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(128);
    expect(Object.values(summary.clients as Record<string, { requests: number }>).map((c) => c.requests).sort())
      .toEqual([1, 2]);
  });

  it("does not let a short id impersonate the shortened form of a long id", () => {
    const longId = "a".repeat(129);
    // Learn how the logger displays the long id, then use exactly that string as a short id.
    const probe = harness();
    const probeLogger = createAccessLogger(options(probe));
    probeLogger.log(entry({ clientId: longId }));
    probeLogger.flush();
    const shortenedForm = Object.keys(parse(probe.lines[0]!).clients)[0]!;
    expect(shortenedForm).not.toBe(longId);
    expect(shortenedForm.length).toBeLessThanOrEqual(128);

    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 1 }));
    logger.log(entry({ clientId: longId, status: 500 }));
    const impostor = entry({ clientId: shortenedForm, status: 500 });
    logger.log(impostor);
    // Separate sources: the impostor's first 500 keeps its own budget.
    expect(h.lines).toContain(JSON.stringify(impostor));
    logger.flush();
    const summary = parse(h.lines.at(-1)!);
    expect(summary.suppressedIndividual).toBe(0);
    expect(Object.keys(summary.clients)).toHaveLength(2);
  });

  it("hashes exact UTF-16 code units so lone surrogates and U+FFFD stay distinct", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    const base = "a".repeat(129);
    for (const tail of ["\uD800", "\uD801", "\uFFFD"]) logger.log(entry({ clientId: base + tail }));
    // Valid surrogate pairs that straddle the 100-character prefix boundary.
    const pairA = "a".repeat(99) + "\u{1F600}" + "x".repeat(40);
    const pairB = "a".repeat(99) + "\u{1F601}" + "x".repeat(40);
    logger.log(entry({ clientId: pairA }));
    logger.log(entry({ clientId: pairB }));
    logger.flush();

    const keys = Object.keys(parse(h.lines.at(-1)!).clients);
    expect(keys).toHaveLength(5);
  });

  it("bounds oversized tool names and keeps distinct oversized names distinct", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    const huge = "x".repeat(10_000_000);
    logger.log(entry({ toolName: huge }));
    logger.log(entry({ toolName: huge }));
    logger.log(entry({ toolName: "x".repeat(10_000_001) }));
    logger.flush();

    const line = h.lines.at(-1)!;
    expect(line.length).toBeLessThan(4_096);
    const tools = parse(line).clients["client-a"].tools as Record<string, number>;
    const names = Object.keys(tools);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(128);
    expect(Object.values(tools).sort()).toEqual([1, 2]);
  });

  it("caps the clients map and folds the remainder into otherClients", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxClients: 2 }));

    logger.log(entry({ clientId: "client-a" }));
    logger.log(entry({ clientId: "client-a" }));
    logger.log(entry({ clientId: "client-a" }));
    logger.log(entry({ clientId: "client-b" }));
    logger.log(entry({ clientId: "client-b" }));
    logger.log(entry({ clientId: "client-c", status: 429 }));
    logger.log(entry({ clientId: "client-d", status: 500 }));
    logger.flush();

    const summary = parse(h.lines.at(-1)!);
    expect(Object.keys(summary.clients).sort()).toEqual(["client-a", "client-b"]);
    expect(summary.clients["client-a"].requests).toBe(3);
    expect(summary.clients["client-b"].requests).toBe(2);
    expect(summary.otherClients).toMatchObject({ requests: 2, rateLimited: 1, errors: 1 });
    expect(summary.total).toBe(7);
  });

  it("caps each client's tools map to 10 names plus _other", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    for (let i = 0; i < 12; i += 1) {
      logger.log(entry({ toolName: `tool_${i}` }));
    }
    logger.flush();

    const client = parse(h.lines[0]!).clients["client-a"];
    expect(Object.keys(client.tools)).toHaveLength(10);
    expect(client.toolsOther).toBe(2);
  });

  it("keeps a tool literally named _other distinct from the tools overflow count", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    for (let i = 0; i < 5; i += 1) logger.log(entry({ toolName: "_other" }));
    for (let i = 0; i < 10; i += 1) logger.log(entry({ toolName: `tool_${i}` }));
    logger.flush();

    const client = parse(h.lines[0]!).clients["client-a"];
    expect(client.tools._other).toBe(5);
    expect(client.toolsOther).toBe(1);
  });

  it("does not lose a client literally named __proto__ from the summary", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.log(entry({ clientId: "__proto__", status: 429 }));
    logger.flush();

    const summary = parse(h.lines[0]!);
    expect(Object.keys(summary.clients)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(summary.clients, "__proto__")?.value).toMatchObject({
      requests: 1,
      rateLimited: 1,
    });
  });

  it("truncates very long client labels so retained memory per client is bounded", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    const longId = "c".repeat(100_000);
    logger.log(entry({ clientId: longId }));
    logger.log(entry({ clientId: longId }));
    logger.flush();

    const summary = parse(h.lines[0]!);
    const keys = Object.keys(summary.clients);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.length).toBeLessThanOrEqual(128);
    expect(summary.clients[keys[0]!].requests).toBe(2);
  });

  it("does not let the interval timer keep the process alive (unref)", () => {
    const h = harness();
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const logger = createAccessLogger(options(h));
      logger.log(entry());
      const timer = spy.mock.results.at(-1)?.value as { hasRef?: () => boolean } | undefined;
      expect(typeof timer?.hasRef).toBe("function");
      expect(timer!.hasRef!()).toBe(false);
      logger.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it("writes one individual line per request in verbose mode and no summaries", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { mode: "verbose" }));
    const first = entry();
    const second = entry({ status: 429 });
    logger.log(first);
    logger.log(second);
    expect(h.lines).toEqual([JSON.stringify(first), JSON.stringify(second)]);

    vi.advanceTimersByTime(INTERVAL_MS * 3);
    logger.flush();
    logger.stop();
    expect(h.lines).toHaveLength(2);
  });

  it("stop() writes a final summary and clears the timer", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.log(entry());
    logger.stop();

    expect(h.lines).toHaveLength(1);
    expect(parse(h.lines[0]!).total).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(h.lines).toHaveLength(1);
  });

  it("stop() writes nothing when there are no counters", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.stop();
    expect(h.lines).toHaveLength(0);
  });

  it("writes nothing while idle", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.log(entry());
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(h.lines).toHaveLength(1);

    vi.advanceTimersByTime(INTERVAL_MS * 10);
    expect(h.lines).toHaveLength(1);
    logger.stop();
    expect(h.lines).toHaveLength(1);
  });

  it("does not keep the process alive with its timer", () => {
    const h = harness();
    const logger = createAccessLogger(options(h));
    logger.log(entry());
    const timers = vi.getTimerCount();
    expect(timers).toBe(1);
    logger.stop();
  });
});

describe("getAccessLogConfig", () => {
  it("returns defaults when no variables are set", () => {
    expect(getAccessLogConfig({})).toEqual({
      mode: "summary",
      intervalMs: 60_000,
      slowMs: 5000,
      maxIndividualPerInterval: 20,
    });
  });

  it("parses valid overrides", () => {
    expect(
      getAccessLogConfig({
        MUNIN_ACCESS_LOG_MODE: "verbose",
        MUNIN_ACCESS_LOG_INTERVAL_MS: "30000",
        MUNIN_ACCESS_LOG_SLOW_MS: "0",
        MUNIN_ACCESS_LOG_MAX_INDIVIDUAL: "7",
      }),
    ).toEqual({ mode: "verbose", intervalMs: 30_000, slowMs: 0, maxIndividualPerInterval: 7 });
  });

  it("falls back to defaults for invalid values without throwing", () => {
    expect(
      getAccessLogConfig({
        MUNIN_ACCESS_LOG_MODE: "loud",
        MUNIN_ACCESS_LOG_INTERVAL_MS: "soon",
        MUNIN_ACCESS_LOG_SLOW_MS: "-1",
        MUNIN_ACCESS_LOG_MAX_INDIVIDUAL: "1.5",
      }),
    ).toEqual({ mode: "summary", intervalMs: 60_000, slowMs: 5000, maxIndividualPerInterval: 20 });
    expect(getAccessLogConfig({ MUNIN_ACCESS_LOG_INTERVAL_MS: "", MUNIN_ACCESS_LOG_MAX_INDIVIDUAL: "5ms" })).toMatchObject({
      intervalMs: 60_000,
      maxIndividualPerInterval: 20,
    });
  });

  it("clamps numeric values to their documented bounds", () => {
    expect(getAccessLogConfig({ MUNIN_ACCESS_LOG_INTERVAL_MS: "10" }).intervalMs).toBe(1000);
    expect(getAccessLogConfig({ MUNIN_ACCESS_LOG_INTERVAL_MS: "99999999" }).intervalMs).toBe(3_600_000);
    expect(getAccessLogConfig({ MUNIN_ACCESS_LOG_MAX_INDIVIDUAL: "0" }).maxIndividualPerInterval).toBe(1);
  });
});

describe("access logger volume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps 24 hours of rate-limited and successful traffic within a few MiB", () => {
    const h = harness();
    const logger = createAccessLogger(options(h, { maxIndividualPerInterval: 20 }));
    const clients = ["client-a", "client-b", "client-c"];
    const tools = ["memory_read", "memory_query", "memory_write"];
    const minutes = 24 * 60;
    const successPerMinute = 62_000 / minutes;
    const rejectedPerMinute = 40_000 / minutes;
    let successCount = 0;
    let rejectedCount = 0;

    for (let minute = 0; minute < minutes; minute += 1) {
      const successesNow = Math.round((minute + 1) * successPerMinute) - Math.round(minute * successPerMinute);
      for (let i = 0; i < successesNow; i += 1) {
        const n = successCount;
        successCount += 1;
        logger.log(entry({ clientId: clients[n % clients.length], toolName: tools[n % tools.length] }));
      }
      const rejectedNow = Math.round((minute + 1) * rejectedPerMinute) - Math.round(minute * rejectedPerMinute);
      for (let i = 0; i < rejectedNow; i += 1) {
        rejectedCount += 1;
        logger.log(entry({ clientId: "client-flood", status: 429, toolName: undefined, durationMs: 1 }));
      }
      vi.advanceTimersByTime(INTERVAL_MS);
    }
    logger.stop();

    expect(successCount).toBe(62_000);
    expect(rejectedCount).toBe(40_000);

    const totalBytes = h.lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
    const maxLines = minutes + 20;
    console.info(`access-log volume: ${h.lines.length} lines, ${totalBytes} bytes over 24h`);
    expect(totalBytes).toBeLessThan(2 * 1024 * 1024);
    expect(h.lines.length).toBeLessThanOrEqual(maxLines);
    // Individual lines are not emitted for 429s or successes.
    expect(h.lines.filter((line) => !line.includes('"access_summary"'))).toHaveLength(0);
  });
});
