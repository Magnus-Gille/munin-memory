export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_GLOBAL_MAX = 300;
export const RATE_LIMIT_MAX_CALLERS = 1000;

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  perCallerMax: number;
  globalMax: number;
  windowMs: number;
  maxCallers: number;
}

export type RateLimitScope = "caller" | "global";

export interface RateLimitDecision {
  allowed: boolean;
  scope?: RateLimitScope;
  retryAfterMs: number;
  remaining: number;
  admittedCount: number;
  throttleCount: number;
  totalThrottleCount: number;
}

interface BucketWithCounters {
  state: RateLimiterState;
  admitted: number;
  throttled: number;
}

interface CallerBucket extends BucketWithCounters {
  lastSeen: number;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function getRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  return {
    perCallerMax: positiveInteger(
      env.MUNIN_RATE_LIMIT_PER_CALLER_MAX,
      RATE_LIMIT_MAX,
      1,
      10_000,
    ),
    globalMax: positiveInteger(
      env.MUNIN_RATE_LIMIT_GLOBAL_MAX,
      RATE_LIMIT_GLOBAL_MAX,
      1,
      100_000,
    ),
    windowMs: positiveInteger(
      env.MUNIN_RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_WINDOW_MS,
      1000,
      3_600_000,
    ),
    maxCallers: positiveInteger(
      env.MUNIN_RATE_LIMIT_MAX_CALLERS,
      RATE_LIMIT_MAX_CALLERS,
      1,
      10_000,
    ),
  };
}

export function createRateLimiter(now = Date.now()): RateLimiterState {
  return { tokens: RATE_LIMIT_MAX, lastRefill: now };
}

function refillRateLimit(
  state: RateLimiterState,
  max: number,
  windowMs: number,
  now: number,
): void {
  const elapsed = Math.max(0, now - state.lastRefill);
  if (elapsed > 0) {
    state.tokens = Math.min(max, state.tokens + (elapsed / windowMs) * max);
    state.lastRefill = now;
  }
}

export function getRateLimitRetryAfterMs(
  state: RateLimiterState,
  max: number,
  windowMs: number,
): number {
  if (state.tokens >= 1) return 0;
  return Math.max(1, Math.ceil(((1 - state.tokens) * windowMs) / max));
}

export function checkRateLimit(state: RateLimiterState, now = Date.now()): boolean {
  refillRateLimit(state, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, now);
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

function createBucket(max: number, now: number): BucketWithCounters {
  return {
    state: { tokens: max, lastRefill: now },
    admitted: 0,
    throttled: 0,
  };
}

/**
 * Hierarchical MCP admission control. Each authenticated caller has its own
 * bucket, while a larger process-wide bucket remains as a hard abuse backstop.
 * A caller-local rejection never consumes a global token.
 */
export class McpRateLimiter {
  private readonly callers = new Map<string, CallerBucket>();
  private readonly overflow: CallerBucket;
  private readonly global: BucketWithCounters;
  private totalThrottled = 0;

  constructor(
    readonly config: RateLimitConfig,
    now = Date.now(),
  ) {
    for (const [name, value] of Object.entries(config)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid rate-limit config: ${name} must be a positive integer.`);
      }
    }
    this.global = createBucket(config.globalMax, now);
    this.overflow = {
      ...createBucket(config.perCallerMax, now),
      lastSeen: now,
    };
  }

  private getCaller(key: string, now: number): CallerBucket {
    const existing = this.callers.get(key);
    if (existing) {
      existing.lastSeen = now;
      return existing;
    }

    const expiryMs = this.config.windowMs * 2;
    for (const [candidateKey, candidate] of this.callers) {
      if (now - candidate.lastSeen >= expiryMs) {
        this.callers.delete(candidateKey);
      }
    }

    if (this.callers.size >= this.config.maxCallers) {
      this.overflow.lastSeen = now;
      return this.overflow;
    }

    const created: CallerBucket = {
      ...createBucket(this.config.perCallerMax, now),
      lastSeen: now,
    };
    this.callers.set(key, created);
    return created;
  }

  admit(key: string, now = Date.now()): RateLimitDecision {
    const caller = this.getCaller(key, now);
    refillRateLimit(
      caller.state,
      this.config.perCallerMax,
      this.config.windowMs,
      now,
    );
    refillRateLimit(
      this.global.state,
      this.config.globalMax,
      this.config.windowMs,
      now,
    );

    const callerWait = getRateLimitRetryAfterMs(
      caller.state,
      this.config.perCallerMax,
      this.config.windowMs,
    );
    if (callerWait > 0) {
      caller.throttled += 1;
      this.totalThrottled += 1;
      return {
        allowed: false,
        scope: "caller",
        retryAfterMs: callerWait,
        remaining: Math.floor(caller.state.tokens),
        admittedCount: caller.admitted,
        throttleCount: caller.throttled,
        totalThrottleCount: this.totalThrottled,
      };
    }

    const globalWait = getRateLimitRetryAfterMs(
      this.global.state,
      this.config.globalMax,
      this.config.windowMs,
    );
    if (globalWait > 0) {
      this.global.throttled += 1;
      this.totalThrottled += 1;
      return {
        allowed: false,
        scope: "global",
        retryAfterMs: globalWait,
        remaining: Math.floor(this.global.state.tokens),
        admittedCount: caller.admitted,
        throttleCount: this.global.throttled,
        totalThrottleCount: this.totalThrottled,
      };
    }

    caller.state.tokens -= 1;
    caller.admitted += 1;
    this.global.state.tokens -= 1;
    this.global.admitted += 1;
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.floor(caller.state.tokens),
      admittedCount: caller.admitted,
      throttleCount: caller.throttled,
      totalThrottleCount: this.totalThrottled,
    };
  }

  get callerCount(): number {
    return this.callers.size;
  }
}
