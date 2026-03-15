import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  parseJsonBody,
  buildAllowedHosts,
  validateHost,
  getConsentAuthConfig,
  validateConsentAuthConfig,
  isTrustedConsentRequest,
  createRateLimiter,
  checkRateLimit,
  extractMethod,
  extractToolName,
  MAX_BODY_SIZE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  type BodyParseResult,
  type RateLimiterState,
} from "../src/index.js";

// Helper to create a fake IncomingMessage from a string or buffer
function fakeRequest(body: string | Buffer): IncomingMessage {
  const stream = new Readable({
    read() {
      this.push(typeof body === "string" ? Buffer.from(body) : body);
      this.push(null);
    },
  });
  return stream as unknown as IncomingMessage;
}

function fakeRequestChunked(chunks: Buffer[], delayMs = 0): IncomingMessage {
  const stream = new Readable({
    read() {},
  });
  // Push chunks asynchronously
  let i = 0;
  const pushNext = () => {
    if (i < chunks.length) {
      stream.push(chunks[i]);
      i++;
      if (delayMs > 0) {
        setTimeout(pushNext, delayMs);
      } else {
        pushNext();
      }
    } else {
      stream.push(null);
    }
  };
  // Start pushing on next tick so listeners are attached
  process.nextTick(pushNext);
  return stream as unknown as IncomingMessage;
}

// --- parseJsonBody ---

describe("parseJsonBody", () => {
  it("parses valid JSON", async () => {
    const req = fakeRequest(JSON.stringify({ method: "initialize" }));
    const result = await parseJsonBody(req);
    expect(result).toEqual({ ok: true, body: { method: "initialize" } });
  });

  it("rejects invalid JSON", async () => {
    const req = fakeRequest("not json{{{");
    const result = await parseJsonBody(req);
    expect(result).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("rejects oversized body", async () => {
    // Create a body larger than 1KB (using small maxSize for testing)
    const maxSize = 1024;
    const bigBody = Buffer.alloc(maxSize + 100, "x");
    const req = fakeRequest(bigBody);
    const result = await parseJsonBody(req, maxSize);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects oversized body sent in chunks", async () => {
    const maxSize = 1024;
    const chunk = Buffer.alloc(600, "x");
    // Two chunks of 600 bytes each = 1200 > 1024
    const req = fakeRequestChunked([chunk, chunk]);
    const result = await parseJsonBody(req, maxSize);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("handles stream errors", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });
    const req = stream as unknown as IncomingMessage;
    const result = await parseJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["error", "timeout"]).toContain(result.reason);
    }
  });

  it("accepts body exactly at size limit", async () => {
    const maxSize = 1024;
    const obj = { data: "x".repeat(maxSize - 20) };
    const json = JSON.stringify(obj);
    // Ensure it's under the limit
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(maxSize);
    const req = fakeRequest(json);
    const result = await parseJsonBody(req, maxSize);
    expect(result.ok).toBe(true);
  });

  it("times out on slow body", async () => {
    vi.useFakeTimers();
    const stream = new Readable({
      read() {
        // Never push data — simulates a stalled connection
      },
    });
    const req = stream as unknown as IncomingMessage;
    const promise = parseJsonBody(req);

    // Advance past the 10s timeout
    await vi.advanceTimersByTimeAsync(11_000);

    const result = await promise;
    expect(result).toEqual({ ok: false, reason: "timeout" });
    vi.useRealTimers();
  });
});

// --- validateHost ---

describe("validateHost", () => {
  const hosts = new Set(["localhost:3030", "127.0.0.1:3030", "myserver.local:3030"]);

  it("accepts known host", () => {
    expect(validateHost("localhost:3030", hosts)).toBe(true);
    expect(validateHost("myserver.local:3030", hosts)).toBe(true);
  });

  it("rejects unknown host", () => {
    expect(validateHost("evil.com:3030", hosts)).toBe(false);
  });

  it("rejects missing host header", () => {
    expect(validateHost(undefined, hosts)).toBe(false);
  });

  it("rejects empty host header", () => {
    expect(validateHost("", hosts)).toBe(false);
  });
});

// --- buildAllowedHosts ---

describe("buildAllowedHosts", () => {
  it("includes bind host, localhost, and 127.0.0.1", () => {
    const hosts = buildAllowedHosts("0.0.0.0", 3030);
    expect(hosts.has("0.0.0.0:3030")).toBe(true);
    expect(hosts.has("localhost:3030")).toBe(true);
    expect(hosts.has("127.0.0.1:3030")).toBe(true);
  });

  it("includes MUNIN_ALLOWED_HOSTS entries", () => {
    process.env.MUNIN_ALLOWED_HOSTS = "munin.example.com, myserver.local:3030";
    try {
      const hosts = buildAllowedHosts("127.0.0.1", 3030);
      expect(hosts.has("munin.example.com")).toBe(true);
      expect(hosts.has("myserver.local:3030")).toBe(true);
    } finally {
      delete process.env.MUNIN_ALLOWED_HOSTS;
    }
  });

  it("ignores empty entries in MUNIN_ALLOWED_HOSTS", () => {
    process.env.MUNIN_ALLOWED_HOSTS = "a.com,,b.com,";
    try {
      const hosts = buildAllowedHosts("127.0.0.1", 3030);
      expect(hosts.has("a.com")).toBe(true);
      expect(hosts.has("b.com")).toBe(true);
      expect(hosts.has("")).toBe(false);
    } finally {
      delete process.env.MUNIN_ALLOWED_HOSTS;
    }
  });
});

// --- OAuth consent gating ---

describe("validateConsentAuthConfig", () => {
  it("allows localhost issuers without extra config", () => {
    const error = validateConsentAuthConfig(
      { allowLocalhost: true },
      new URL("http://localhost:3030"),
    );
    expect(error).toBeNull();
  });

  it("rejects partial trusted-header config", () => {
    const error = validateConsentAuthConfig(
      {
        trustedHeaderName: "x-auth-user",
        allowLocalhost: false,
      },
      new URL("https://munin.example.com"),
    );
    expect(error).toContain("must be set together");
  });

  it("rejects public issuers without trusted-header config", () => {
    const error = validateConsentAuthConfig(
      { allowLocalhost: true },
      new URL("https://munin.example.com"),
    );
    expect(error).toContain("Public OAuth consent requires trusted-user header configuration");
  });
});

describe("getConsentAuthConfig", () => {
  it("reads consent config from environment", () => {
    process.env.MUNIN_OAUTH_TRUSTED_USER_HEADER = "x-auth-user";
    process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE = "magnus@example.com";
    process.env.MUNIN_OAUTH_ALLOW_LOCALHOST_CONSENT = "false";

    try {
      expect(getConsentAuthConfig()).toEqual({
        trustedHeaderName: "x-auth-user",
        trustedHeaderValue: "magnus@example.com",
        allowLocalhost: false,
      });
    } finally {
      delete process.env.MUNIN_OAUTH_TRUSTED_USER_HEADER;
      delete process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE;
      delete process.env.MUNIN_OAUTH_ALLOW_LOCALHOST_CONSENT;
    }
  });
});

describe("isTrustedConsentRequest", () => {
  it("accepts matching trusted-user header", () => {
    const req = {
      get: (name: string) => (name === "x-auth-user" ? "magnus@example.com" : undefined),
      socket: { remoteAddress: "203.0.113.10" },
    };

    expect(isTrustedConsentRequest(req as any, {
      trustedHeaderName: "x-auth-user",
      trustedHeaderValue: "magnus@example.com",
      allowLocalhost: false,
    })).toBe(true);
  });

  it("accepts loopback requests when localhost consent is enabled", () => {
    const req = {
      get: () => undefined,
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };

    expect(isTrustedConsentRequest(req as any, {
      allowLocalhost: true,
    })).toBe(true);
  });

  it("rejects untrusted requests", () => {
    const req = {
      get: () => undefined,
      socket: { remoteAddress: "203.0.113.10" },
    };

    expect(isTrustedConsentRequest(req as any, {
      trustedHeaderName: "x-auth-user",
      trustedHeaderValue: "magnus@example.com",
      allowLocalhost: false,
    })).toBe(false);
  });
});

// --- checkRateLimit ---

describe("checkRateLimit", () => {
  let state: RateLimiterState;
  const baseTime = 1_000_000;

  beforeEach(() => {
    state = { tokens: RATE_LIMIT_MAX, lastRefill: baseTime };
  });

  it("allows up to RATE_LIMIT_MAX requests", () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(checkRateLimit(state, baseTime)).toBe(true);
    }
  });

  it("rejects after exhausting tokens", () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      checkRateLimit(state, baseTime);
    }
    expect(checkRateLimit(state, baseTime)).toBe(false);
  });

  it("refills tokens over time", () => {
    // Exhaust all tokens
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      checkRateLimit(state, baseTime);
    }
    expect(checkRateLimit(state, baseTime)).toBe(false);

    // Advance one full window — should refill to max
    const fullRefillTime = baseTime + RATE_LIMIT_WINDOW_MS;
    expect(checkRateLimit(state, fullRefillTime)).toBe(true);
  });

  it("refills proportionally", () => {
    // Exhaust all tokens
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      checkRateLimit(state, baseTime);
    }

    // Advance half window — should get ~30 tokens back
    const halfTime = baseTime + RATE_LIMIT_WINDOW_MS / 2;
    const allowed: boolean[] = [];
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      allowed.push(checkRateLimit(state, halfTime));
    }

    const passCount = allowed.filter(Boolean).length;
    // Should be approximately half (allow some float rounding)
    expect(passCount).toBeGreaterThanOrEqual(RATE_LIMIT_MAX / 2 - 1);
    expect(passCount).toBeLessThanOrEqual(RATE_LIMIT_MAX / 2 + 1);
  });

  it("never exceeds max tokens", () => {
    // Wait a very long time — tokens should cap at max
    const farFuture = baseTime + RATE_LIMIT_WINDOW_MS * 100;
    expect(checkRateLimit(state, farFuture)).toBe(true);
    // state.tokens should be at most RATE_LIMIT_MAX - 1 (just consumed one)
    expect(state.tokens).toBeLessThanOrEqual(RATE_LIMIT_MAX);
  });
});

// --- extractMethod ---

describe("extractMethod", () => {
  it("extracts method from single message", () => {
    expect(extractMethod({ jsonrpc: "2.0", method: "initialize", id: 1 })).toBe("initialize");
  });

  it("extracts method from batch (first message)", () => {
    expect(extractMethod([
      { jsonrpc: "2.0", method: "tools/call", id: 1 },
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
    ])).toBe("tools/call");
  });

  it("returns undefined for empty array", () => {
    expect(extractMethod([])).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(extractMethod("hello")).toBeUndefined();
    expect(extractMethod(42)).toBeUndefined();
    expect(extractMethod(null)).toBeUndefined();
    expect(extractMethod(undefined)).toBeUndefined();
  });

  it("returns undefined for object without method", () => {
    expect(extractMethod({ jsonrpc: "2.0", id: 1 })).toBeUndefined();
  });
});

// --- extractToolName ---

describe("extractToolName", () => {
  it("extracts tool name from tools/call message", () => {
    expect(extractToolName({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "memory_write", arguments: {} },
      id: 1,
    })).toBe("memory_write");
  });

  it("extracts tool name from batch", () => {
    expect(extractToolName([
      { jsonrpc: "2.0", method: "tools/call", params: { name: "memory_read" }, id: 1 },
    ])).toBe("memory_read");
  });

  it("returns undefined for initialize message", () => {
    expect(extractToolName({
      jsonrpc: "2.0",
      method: "initialize",
      params: {},
      id: 1,
    })).toBeUndefined();
  });

  it("returns undefined for tools/list message", () => {
    expect(extractToolName({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    })).toBeUndefined();
  });

  it("returns undefined for non-object body", () => {
    expect(extractToolName(null)).toBeUndefined();
    expect(extractToolName("string")).toBeUndefined();
    expect(extractToolName(42)).toBeUndefined();
  });

  it("returns undefined for empty batch", () => {
    expect(extractToolName([])).toBeUndefined();
  });

  it("finds tool name in mixed batch", () => {
    expect(extractToolName([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "memory_query" }, id: 2 },
    ])).toBe("memory_query");
  });
});
