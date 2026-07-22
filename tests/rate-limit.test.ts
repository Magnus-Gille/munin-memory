import { describe, expect, it } from "vitest";
import {
  McpRateLimiter,
  RATE_LIMIT_GLOBAL_MAX,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_CALLERS,
  RATE_LIMIT_WINDOW_MS,
  getRateLimitConfig,
} from "../src/rate-limit.js";

const testConfig = {
  perCallerMax: 2,
  globalMax: 10,
  windowMs: 10_000,
  maxCallers: 10,
};

describe("McpRateLimiter", () => {
  it("rejects unsafe programmatic configuration", () => {
    expect(
      () => new McpRateLimiter({ ...testConfig, windowMs: 0 }),
    ).toThrow("windowMs must be a positive integer");
  });

  it("isolates callers and reports the exact continuous-refill wait", () => {
    const limiter = new McpRateLimiter(testConfig, 0);

    expect(limiter.admit("caller-a", 0).allowed).toBe(true);
    expect(limiter.admit("caller-a", 0).allowed).toBe(true);
    expect(limiter.admit("caller-a", 0)).toMatchObject({
      allowed: false,
      scope: "caller",
      retryAfterMs: 5000,
      admittedCount: 2,
      throttleCount: 1,
    });
    expect(limiter.admit("caller-b", 0).allowed).toBe(true);

    expect(limiter.admit("caller-a", 4999)).toMatchObject({
      allowed: false,
      retryAfterMs: 1,
      throttleCount: 2,
    });
    expect(limiter.admit("caller-a", 5000).allowed).toBe(true);
  });

  it("does not charge the global backstop for caller-local rejections", () => {
    const limiter = new McpRateLimiter(
      { ...testConfig, perCallerMax: 1, globalMax: 2 },
      0,
    );

    expect(limiter.admit("caller-a", 0).allowed).toBe(true);
    for (let i = 0; i < 20; i++) {
      expect(limiter.admit("caller-a", 0).scope).toBe("caller");
    }
    expect(limiter.admit("caller-b", 0).allowed).toBe(true);
    expect(limiter.admit("caller-c", 0)).toMatchObject({
      allowed: false,
      scope: "global",
    });
  });

  it("collapses new identities into a capped overflow bucket at the map bound", () => {
    const limiter = new McpRateLimiter(
      { ...testConfig, perCallerMax: 1, maxCallers: 1 },
      0,
    );

    expect(limiter.admit("stored", 0).allowed).toBe(true);
    expect(limiter.admit("overflow-a", 0).allowed).toBe(true);
    expect(limiter.admit("overflow-b", 0)).toMatchObject({
      allowed: false,
      scope: "caller",
    });
    expect(limiter.callerCount).toBe(1);
  });

  it("prunes caller state only after two complete windows", () => {
    const limiter = new McpRateLimiter(
      { ...testConfig, perCallerMax: 1, maxCallers: 1 },
      0,
    );

    expect(limiter.admit("old", 0).allowed).toBe(true);
    expect(limiter.admit("new", 20_000).allowed).toBe(true);
    expect(limiter.callerCount).toBe(1);
  });

  it("does not create tokens when the clock moves backwards", () => {
    const limiter = new McpRateLimiter(
      { ...testConfig, perCallerMax: 1 },
      1000,
    );

    expect(limiter.admit("caller", 1000).allowed).toBe(true);
    expect(limiter.admit("caller", 500)).toMatchObject({
      allowed: false,
      retryAfterMs: 10_000,
    });
  });
});

describe("getRateLimitConfig", () => {
  it("uses documented defaults", () => {
    expect(getRateLimitConfig({})).toEqual({
      perCallerMax: RATE_LIMIT_MAX,
      globalMax: RATE_LIMIT_GLOBAL_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxCallers: RATE_LIMIT_MAX_CALLERS,
    });
  });

  it("accepts positive integer overrides and rejects malformed values", () => {
    expect(
      getRateLimitConfig({
        MUNIN_RATE_LIMIT_PER_CALLER_MAX: "12",
        MUNIN_RATE_LIMIT_GLOBAL_MAX: "120",
        MUNIN_RATE_LIMIT_WINDOW_MS: "30000",
        MUNIN_RATE_LIMIT_MAX_CALLERS: "50",
      }),
    ).toEqual({
      perCallerMax: 12,
      globalMax: 120,
      windowMs: 30_000,
      maxCallers: 50,
    });

    expect(
      getRateLimitConfig({
        MUNIN_RATE_LIMIT_PER_CALLER_MAX: "0",
        MUNIN_RATE_LIMIT_GLOBAL_MAX: "not-a-number",
        MUNIN_RATE_LIMIT_WINDOW_MS: "500",
        MUNIN_RATE_LIMIT_MAX_CALLERS: "1.5",
      }),
    ).toEqual(getRateLimitConfig({}));
  });
});
