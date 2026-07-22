export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_CREDENTIAL_MAX = 180;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_GLOBAL_MAX = 300;
export const RATE_LIMIT_MAX_CALLERS = 1000;

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  perCallerMax: number;
  perCredentialMax: number;
  globalMax: number;
  windowMs: number;
  maxCallers: number;
}

export type RateLimitScope = "caller" | "credential" | "global";
export type RateLimitBucketKind = "caller" | "credential" | "overflow" | "global";

export interface RateLimitDecision {
  allowed: boolean;
  scope?: RateLimitScope;
  bucketKind?: RateLimitBucketKind;
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
    perCredentialMax: positiveInteger(
      env.MUNIN_RATE_LIMIT_PER_CREDENTIAL_MAX,
      RATE_LIMIT_CREDENTIAL_MAX,
      1,
      100_000,
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
 * Hierarchical MCP admission control. Each cooperative caller identity has its
 * own bucket, each authenticated credential has an aggregate bucket, and a
 * larger process-wide bucket remains as a hard abuse backstop. Rejections at a
 * narrower scope never consume tokens from wider scopes.
 */
export class McpRateLimiter {
  private readonly callers = new Map<string, CallerBucket>();
  private readonly credentials = new Map<string, CallerBucket>();
  private readonly callerOverflow: CallerBucket;
  private readonly credentialOverflow: CallerBucket;
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
    this.callerOverflow = {
      ...createBucket(config.perCallerMax, now),
      lastSeen: now,
    };
    this.credentialOverflow = {
      ...createBucket(config.perCredentialMax, now),
      lastSeen: now,
    };
  }

  private getBoundedBucket(
    buckets: Map<string, CallerBucket>,
    overflow: CallerBucket,
    max: number,
    key: string,
    now: number,
  ): { bucket: CallerBucket; overflow: boolean } {
    const existing = buckets.get(key);
    if (existing) {
      existing.lastSeen = now;
      return { bucket: existing, overflow: false };
    }

    const expiryMs = this.config.windowMs * 2;
    for (const [candidateKey, candidate] of buckets) {
      if (now - candidate.lastSeen >= expiryMs) {
        buckets.delete(candidateKey);
      }
    }

    if (buckets.size >= this.config.maxCallers) {
      overflow.lastSeen = now;
      return { bucket: overflow, overflow: true };
    }

    const created: CallerBucket = {
      ...createBucket(max, now),
      lastSeen: now,
    };
    buckets.set(key, created);
    return { bucket: created, overflow: false };
  }

  admit(callerKey: string, credentialKey: string, now = Date.now()): RateLimitDecision {
    const callerResult = this.getBoundedBucket(
      this.callers,
      this.callerOverflow,
      this.config.perCallerMax,
      callerKey,
      now,
    );
    const credentialResult = this.getBoundedBucket(
      this.credentials,
      this.credentialOverflow,
      this.config.perCredentialMax,
      credentialKey,
      now,
    );
    const caller = callerResult.bucket;
    const credential = credentialResult.bucket;
    refillRateLimit(
      caller.state,
      this.config.perCallerMax,
      this.config.windowMs,
      now,
    );
    refillRateLimit(
      credential.state,
      this.config.perCredentialMax,
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
        bucketKind: callerResult.overflow ? "overflow" : "caller",
        retryAfterMs: callerWait,
        remaining: Math.floor(caller.state.tokens),
        admittedCount: caller.admitted,
        throttleCount: caller.throttled,
        totalThrottleCount: this.totalThrottled,
      };
    }

    const credentialWait = getRateLimitRetryAfterMs(
      credential.state,
      this.config.perCredentialMax,
      this.config.windowMs,
    );
    if (credentialWait > 0) {
      credential.throttled += 1;
      this.totalThrottled += 1;
      return {
        allowed: false,
        scope: "credential",
        bucketKind: credentialResult.overflow ? "overflow" : "credential",
        retryAfterMs: credentialWait,
        remaining: Math.floor(credential.state.tokens),
        admittedCount: credential.admitted,
        throttleCount: credential.throttled,
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
        bucketKind: "global",
        retryAfterMs: globalWait,
        remaining: Math.floor(this.global.state.tokens),
        admittedCount: this.global.admitted,
        throttleCount: this.global.throttled,
        totalThrottleCount: this.totalThrottled,
      };
    }

    caller.state.tokens -= 1;
    caller.admitted += 1;
    credential.state.tokens -= 1;
    credential.admitted += 1;
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
