import { WRITE_REPLAY_HEADER, WRITE_REPLAY_VERSION } from "./internal/write-replay.js";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer, IncomingMessage, type RequestListener, type Server as HttpServer } from "node:http";
import {
  timingSafeEqual,
  randomUUID,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  initDatabase,
  nowUTC,
  pruneExpiredQuerySnapshots,
  pruneCodeHealthRecords,
  pruneRedactionLog,
  pruneRetrievalAnalytics,
} from "./db.js";
import { MCP_SERVER_INSTRUCTIONS, registerTools } from "./tools.js";
import { initEmbeddings, startEmbeddingWorker, stopEmbeddingWorker } from "./embeddings.js";
import { initConsolidation, startConsolidationWorker, stopConsolidationWorker } from "./consolidation.js";
import { getConfiguredLegacyBearerTransportType, resolveAccessContext } from "./access.js";
import type { AccessContext } from "./access.js";
import { getLibrarianConfigWarnings, type LibrarianRuntimeConfig } from "./librarian.js";
import { MuninOAuthProvider, type ExtendedAuthInfo } from "./oauth.js";
import {
  McpRateLimiter,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  createRateLimiter,
  checkRateLimit,
  getRateLimitConfig,
  type RateLimitConfig,
  type RateLimiterState,
  type RateLimitScope,
} from "./rate-limit.js";
import { SERVER_VERSION } from "./version.js";
import { pruneReviewProposals } from "./review-inbox.js";

export {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  createRateLimiter,
  checkRateLimit,
  getRateLimitConfig,
};
export type { RateLimitConfig, RateLimiterState };

// Analytics retention (default 90 days)
function getAnalyticsRetentionDays(): number {
  const val = parseInt(process.env.MUNIN_ANALYTICS_RETENTION_DAYS ?? "90", 10);
  return Number.isFinite(val) && val > 0 ? val : 90;
}

const DEFAULT_REDACTION_LOG_RETENTION_DAYS = 365;

function getRedactionLogRetentionDays(): number {
  const configured = process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;
  if (configured === undefined) return DEFAULT_REDACTION_LOG_RETENTION_DAYS;

  const normalized = configured.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return DEFAULT_REDACTION_LOG_RETENTION_DAYS;

  const val = Number(normalized);
  return Number.isSafeInteger(val) ? val : DEFAULT_REDACTION_LOG_RETENTION_DAYS;
}

export function runMaintenancePrune(database: Database.Database): void {
  const maintenanceNow = nowUTC();
  pruneExpiredQuerySnapshots(database, maintenanceNow);
  pruneCodeHealthRecords(database, maintenanceNow);
  pruneRetrievalAnalytics(database, getAnalyticsRetentionDays());
  pruneRedactionLog(database, getRedactionLogRetentionDays());
  pruneReviewProposals(database, maintenanceNow);
}

// --- Configuration ---

const transportMode = process.env.MUNIN_TRANSPORT ?? "stdio";
const httpPort = parseInt(process.env.MUNIN_HTTP_PORT ?? "3030", 10);
const httpHost = process.env.MUNIN_HTTP_HOST ?? "127.0.0.1";
const apiKey = process.env.MUNIN_API_KEY;
const apiKeyDpa = process.env.MUNIN_API_KEY_DPA;
const apiKeyConsumer = process.env.MUNIN_API_KEY_CONSUMER;
const issuerUrl = process.env.MUNIN_OAUTH_ISSUER_URL ?? "http://localhost:3030";

// --- Hardening constants ---

export const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB
const BODY_PARSE_TIMEOUT_MS = 10_000;
const MAINTENANCE_PRUNE_INTERVAL_MS = 60 * 1000;

// --- Heimdall self-descriptor ---
// Served at GET /heimdall.json for Tier-1 discovery by the Heimdall dashboard.
// Shape must satisfy Heimdall's validateDescriptor (schema/service/v1).
export function getHeimdallDescriptor(env: NodeJS.ProcessEnv = process.env) {
  return {
  _schema: 'https://heimdall.gille.ai/schema/service/v1',
  service: {
    name: 'munin-memory',
    label: 'Munin Memory',
    namespace: env.MUNIN_HEIMDALL_NAMESPACE || 'standalone',
    instance_id: env.MUNIN_INSTANCE_ID || 'munin-local',
    criticality: 'normal',
  },
  kind: 'mcp',
  status: 'pass',
  version: SERVER_VERSION,
  deploy: {
    host: env.MUNIN_DEPLOY_HOST || 'localhost',
    systemd_unit: 'munin-memory',
    platform: 'bare-metal',
  },
  metrics: [],
  alerts: { rules: [], active_count: 0, firing: [] },
  panels: [],
  links: {
    self: '/heimdall.json',
    health: '/health',
    repo: 'https://github.com/Magnus-Gille/munin-memory',
  },
  ui: { icon: 'brain', category: 'infra' },
  } as const;
}

export const HEIMDALL_DESCRIPTOR = getHeimdallDescriptor();

// --- Types ---

export type BodyParseResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "timeout" | "invalid_json" | "error" };

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  rpcMethod?: string;
  toolName?: string;
  authType: "bearer" | "oauth" | "none";
  clientId?: string;
  sessionId?: string;
  /** Client-supplied correlation id (untrusted; logged only when well-formed). */
  requestId?: string;
  status: number;
  durationMs: number;
  rateLimit?: {
    keyHash: string;
    keySource: "client" | "session" | "credential";
    scope: RateLimitScope;
    retryAfterMs: number;
    admittedCount: number;
    throttleCount: number;
    totalThrottleCount: number;
  };
}

export interface HttpAppOptions {
  database: Database.Database;
  apiKey?: string;
  apiKeyDpa?: string;
  apiKeyConsumer?: string;
  issuerUrl: string;
  httpHost: string;
  httpPort: number;
  requestLogger?: (entry: RequestLogEntry) => void;
  rateLimitConfig?: RateLimitConfig;
}

export interface ConsentAuthConfig {
  trustedHeaderName?: string;
  trustedHeaderValue?: string;
  identityHeaderName?: string;
  allowLocalhost: boolean;
}

export interface ConsentIdentity {
  email: string;
  principalId: string | null; // null = owner via env var fallback or localhost
  isOwner: boolean;
}

let cleanupTimerId: ReturnType<typeof setInterval> | undefined;
let activeDb: Database.Database | undefined;
let activeHttpServer: HttpServer | undefined;

export interface MaintenancePruneTimerOptions {
  intervalMs?: number;
  additionalCleanup?: () => void;
}

export function startMaintenancePruneTimer(
  database: Database.Database,
  options: MaintenancePruneTimerOptions = {},
): ReturnType<typeof setInterval> {
  const intervalMs = options.intervalMs ?? MAINTENANCE_PRUNE_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Maintenance prune interval must be a positive finite number.");
  }

  const timer = setInterval(() => {
    options.additionalCleanup?.();
    runMaintenancePrune(database);
  }, intervalMs);
  timer.unref();
  return timer;
}

export function stopMaintenancePruneTimer(
  timer: ReturnType<typeof setInterval> | undefined,
): void {
  if (timer !== undefined) clearInterval(timer);
}

// --- MCP server factory ---

function createMcpServer(
  database: Database.Database,
  sessionId?: string,
  accessContext?: AccessContext,
  runtimeConfig?: LibrarianRuntimeConfig,
  reviewSessionIdOverride?: string | null,
): Server {
  const server = new Server(
    { name: "munin-memory", version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerTools(server, database, sessionId, accessContext, runtimeConfig, undefined, reviewSessionIdOverride);
  return server;
}

// --- Exported helper functions (for testing) ---

export function parseJsonBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<BodyParseResult> {
  return new Promise((resolve) => {
    let totalSize = 0;
    const chunks: Buffer[] = [];
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        req.destroy();
        resolve({ ok: false, reason: "timeout" });
      }
    }, BODY_PARSE_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      if (resolved) return;
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        resolved = true;
        clearTimeout(timer);
        req.destroy();
        resolve({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        resolve({ ok: true, body });
      } catch {
        resolve({ ok: false, reason: "invalid_json" });
      }
    });

    req.on("error", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: "error" });
    });
  });
}

export function buildAllowedHosts(host: string, port: number): Set<string> {
  const hosts = new Set<string>();
  hosts.add(`${host}:${port}`);
  hosts.add(`localhost:${port}`);
  hosts.add(`127.0.0.1:${port}`);

  const envHosts = process.env.MUNIN_ALLOWED_HOSTS;
  if (envHosts) {
    for (const h of envHosts.split(",")) {
      const trimmed = h.trim();
      if (trimmed) hosts.add(trimmed);
    }
  }

  return hosts;
}

export function validateHost(hostHeader: string | undefined, allowedHosts: Set<string>): boolean {
  if (!hostHeader) return false;
  return allowedHosts.has(hostHeader);
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1";
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

export function getConsentAuthConfig(): ConsentAuthConfig {
  return {
    trustedHeaderName: process.env.MUNIN_OAUTH_TRUSTED_USER_HEADER?.trim() || undefined,
    trustedHeaderValue: process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE?.trim() || undefined,
    identityHeaderName: process.env.MUNIN_OAUTH_IDENTITY_HEADER?.trim() || undefined,
    allowLocalhost: (process.env.MUNIN_OAUTH_ALLOW_LOCALHOST_CONSENT ?? "true") === "true",
  };
}

export function validateConsentAuthConfig(config: ConsentAuthConfig, issuer: URL): string | null {
  const hasHeaderName = Boolean(config.trustedHeaderName);
  const hasHeaderValue = Boolean(config.trustedHeaderValue);

  if (hasHeaderName !== hasHeaderValue) {
    return "MUNIN_OAUTH_TRUSTED_USER_HEADER and MUNIN_OAUTH_TRUSTED_USER_VALUE must be set together.";
  }

  if (isLocalHostname(issuer.hostname)) {
    return null;
  }

  if (!hasHeaderName || !hasHeaderValue) {
    return "Public OAuth consent requires trusted-user header configuration. Set MUNIN_OAUTH_TRUSTED_USER_HEADER and MUNIN_OAUTH_TRUSTED_USER_VALUE.";
  }

  return null;
}

export function isTrustedConsentRequest(req: Request, config: ConsentAuthConfig, issuer: URL): boolean {
  if (
    config.trustedHeaderName &&
    config.trustedHeaderValue &&
    safeStringEqual(req.get(config.trustedHeaderName) ?? "", config.trustedHeaderValue)
  ) {
    return true;
  }

  // A user identity claim never proves that the request passed through the trusted proxy.
  // Loopback is a development exception only for local issuers; a local reverse proxy
  // can make public requests appear loopback at the socket boundary.
  return isLocalHostname(issuer.hostname) &&
    config.allowLocalhost &&
    isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Resolve the identity of the user making a consent request.
 * Returns null if identity cannot be determined (fail-closed).
 *
 * A valid proxy gate is required first. With an identity header configured,
 * resolve exactly one active principal from its email; otherwise a matching
 * trusted-user value or explicit local-development request resolves to owner.
 */
export function resolveConsentIdentity(
  req: Request,
  config: ConsentAuthConfig,
  db: Database.Database,
  issuer: URL,
): ConsentIdentity | null {
  if (!isTrustedConsentRequest(req, config, issuer)) return null;

  // When an identity header is configured, it must resolve to exactly one active
  // principal. The trusted header is only a proxy gate and must not become an
  // owner fallback when the identity claim is absent or invalid.
  if (config.identityHeaderName) {
    const email = req.get(config.identityHeaderName)?.trim();
    if (email) {
      const emailLower = email.toLowerCase();
      const rows = db
        .prepare(
          `SELECT principal_id, principal_type FROM principals
           WHERE email_lower = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .all(emailLower, nowUTC()) as Array<{ principal_id: string; principal_type: string }>;

      if (rows.length === 1) {
        return {
          email,
          principalId: rows[0].principal_id,
          isOwner: rows[0].principal_type === "owner",
        };
      }
      if (rows.length > 1) {
        // Ambiguous — fail closed, log error
        console.error(`resolveConsentIdentity: multiple principals match email "${emailLower}" — failing closed`);
        return null;
      }
      // No match — fail closed; do not fall through to owner/localhost.
      return null;
    }
    return null;
  }

  // Without a separate identity header, the matching trusted-user value is the
  // configured owner identity. This preserves owner-only consent deployments.
  if (config.trustedHeaderName && config.trustedHeaderValue) {
    const headerValue = req.get(config.trustedHeaderName) ?? "";
    if (safeStringEqual(headerValue, config.trustedHeaderValue)) {
      return { email: config.trustedHeaderValue, principalId: "owner", isOwner: true };
    }
  }

  // Local development owner fallback is available only without identity mapping,
  // and only when the issuer itself is local and the direct peer is loopback.
  if (
    !config.identityHeaderName &&
    isLocalHostname(issuer.hostname) &&
    config.allowLocalhost &&
    isLoopbackAddress(req.socket.remoteAddress)
  ) {
    return { email: "localhost", principalId: "owner", isOwner: true };
  }

  return null;
}

export function extractMethod(body: unknown): string | undefined {
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0];
    if (first && typeof first === "object" && "method" in first) {
      return String((first as Record<string, unknown>).method);
    }
    return undefined;
  }
  if (body && typeof body === "object" && "method" in body) {
    return String((body as Record<string, unknown>).method);
  }
  return undefined;
}

export function extractToolName(body: unknown): string | undefined {
  const getToolFromMessage = (msg: unknown): string | undefined => {
    if (!msg || typeof msg !== "object") return undefined;
    const rec = msg as Record<string, unknown>;
    if (rec.method !== "tools/call") return undefined;
    const params = rec.params;
    if (params && typeof params === "object" && "name" in params) {
      return String((params as Record<string, unknown>).name);
    }
    return undefined;
  };

  if (Array.isArray(body)) {
    for (const item of body) {
      const name = getToolFromMessage(item);
      if (name) return name;
    }
    return undefined;
  }
  return getToolFromMessage(body);
}

function logRequest(entry: RequestLogEntry): void {
  console.error(JSON.stringify(entry));
}

export function getRequestAuthLogContext(auth: AuthInfo | undefined): Pick<RequestLogEntry, "authType" | "clientId"> {
  if (!auth) {
    return { authType: "none" };
  }

  const extended = auth as ExtendedAuthInfo;
  if (extended.authMethod && extended.authMethod !== "oauth") {
    return {
      authType: "bearer",
      clientId: auth.clientId === "legacy-bearer" ? "legacy" : auth.clientId,
    };
  }

  if (auth.clientId === "legacy-bearer") {
    return {
      authType: "bearer",
      clientId: "legacy",
    };
  }

  return {
    authType: "oauth",
    clientId: auth.clientId,
  };
}

function getSessionHeader(req: Request): string | undefined {
  const header = req.headers["mcp-session-id"];
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Return the X-Munin-Request-Id header only when it is a well-formed token. */
export function getRequestIdHeader(req: Request): string | undefined {
  const header = req.headers["x-munin-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function getClientRateLimitHeader(req: Request): string | undefined {
  const header = req.headers["x-munin-client-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : undefined;
}

function getRateLimitIdentity(
  req: Request,
  secret: Buffer,
): {
  callerKey: string;
  callerKeyHash: string;
  credentialKey: string;
  credentialKeyHash: string;
  keySource: "client" | "session" | "credential";
} {
  const auth = req.auth as ExtendedAuthInfo | undefined;
  const explicitClient = getClientRateLimitHeader(req);
  const session = getSessionHeader(req);
  const keySource = explicitClient
    ? "client"
    : session
      ? "session"
      : "credential";
  const caller = explicitClient ?? session ?? "shared";
  const authScope = `${auth?.principalId ?? ""}:${auth?.clientId ?? "unknown"}`;
  const credentialKey = createHmac("sha256", secret)
    .update(authScope)
    .digest("hex");
  const callerKey = createHmac("sha256", secret)
    .update(`${authScope}\0${caller}`)
    .digest("hex");
  return {
    callerKey,
    callerKeyHash: callerKey.slice(0, 16),
    credentialKey,
    credentialKeyHash: credentialKey.slice(0, 16),
    keySource,
  };
}

function deriveAnalyticsSessionId(clientId: string): string {
  const bucketMs = 30 * 60 * 1000;
  const bucket = Math.floor(Date.now() / bucketMs);
  return createHash("sha256")
    .update(`${clientId}:${bucket}`)
    .digest("hex")
    .slice(0, 32);
}

const MUNIN_RUN_SESSION_HEADER = "mcp-session-id";
const MUNIN_RUN_HANDLE_PREFIX = "munin-run-v1";

type AuthenticatedRunAuth = Pick<ExtendedAuthInfo, "authMethod" | "token">;

function canCreateReviewRun(
  principalId: string,
  authInfo: AuthenticatedRunAuth | undefined,
): authInfo is AuthenticatedRunAuth & { token: string } {
  return Boolean(
    principalId
    && authInfo?.token
    && (authInfo.authMethod === "oauth" || authInfo.authMethod === "agent_token"),
  );
}

function signReviewRunHandle(
  secret: Buffer,
  principalId: string,
  token: string,
  runId: string,
): string {
  // This HMAC authenticates a server-issued review-run handle. The credential
  // is one binding component alongside the principal and random run ID; it is
  // never stored or used as a password verifier.
  const signature = createHmac("sha256", secret)
    .update(`${principalId}\0${token}\0${runId}`)
    .digest("hex");
  return `${MUNIN_RUN_HANDLE_PREFIX}.${runId}.${signature}`;
}

/**
 * Resolve an authenticated server-issued run handle into the durable review
 * creator identity. Caller-chosen MCP session IDs are never accepted.
 */
function resolveReviewRun(
  secret: Buffer,
  principalId: string,
  authInfo: AuthenticatedRunAuth | undefined,
  presentedHandle: string | undefined,
): { handle: string; sessionId: string } | undefined {
  if (!canCreateReviewRun(principalId, authInfo)) return undefined;

  if (presentedHandle) {
    const match = new RegExp(`^${MUNIN_RUN_HANDLE_PREFIX}\\.([0-9a-f]{32})\\.([0-9a-f]{64})$`)
      .exec(presentedHandle);
    if (!match) return undefined;
    const [, runId, presentedSignature] = match;
    // This HMAC verifies the server-issued handle created above. The token is
    // an authenticated binding input, not a password being stored or derived.
    const expectedSignature = createHmac("sha256", secret)
      .update(`${principalId}\0${authInfo.token}\0${runId}`)
      .digest("hex");
    const valid = timingSafeEqual(
      Buffer.from(presentedSignature, "ascii"),
      Buffer.from(expectedSignature, "ascii"),
    );
    return valid ? { handle: presentedHandle, sessionId: runId } : undefined;
  }

  const sessionId = randomBytes(16).toString("hex");
  return {
    handle: signReviewRunHandle(secret, principalId, authInfo.token, sessionId),
    sessionId,
  };
}

function attachRequestLogger(
  req: Request,
  res: Response,
  requestLogger: (entry: RequestLogEntry) => void,
): {
  setRequestMetadata: (body: unknown) => void;
  setRateLimit: (rateLimit: NonNullable<RequestLogEntry["rateLimit"]>) => void;
} {
  const startTime = Date.now();
  const sessionId = getSessionHeader(req);
  const requestId = getRequestIdHeader(req);
  const authContext = getRequestAuthLogContext(req.auth);
  let rpcMethod: string | undefined;
  let toolName: string | undefined;
  let rateLimit: RequestLogEntry["rateLimit"];

  res.on("finish", () => {
    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      rpcMethod,
      toolName,
      ...authContext,
      sessionId,
      requestId,
      status: res.statusCode,
      durationMs: Date.now() - startTime,
      rateLimit,
    };
    requestLogger(entry);
  });

  return {
    setRequestMetadata(nextBody: unknown) {
      rpcMethod = extractMethod(nextBody);
      toolName = extractToolName(nextBody);
    },
    setRateLimit(nextRateLimit) {
      rateLimit = nextRateLimit;
    },
  };
}

function hasHttpBearerCredential(): boolean {
  return Boolean(apiKey || apiKeyDpa || apiKeyConsumer);
}

function getHttpCredentialErrorMessage(): string {
  return "Fatal: at least one bearer credential is required when MUNIN_TRANSPORT=http. Set MUNIN_API_KEY, MUNIN_API_KEY_DPA, or MUNIN_API_KEY_CONSUMER.";
}

function buildLibrarianRuntimeConfig(
  transportMode: "http" | "stdio",
  options: {
    apiKey?: string;
    apiKeyDpa?: string;
    apiKeyConsumer?: string;
  } = {},
): LibrarianRuntimeConfig {
  return {
    transportMode,
    librarianEnabled: (process.env.MUNIN_LIBRARIAN_ENABLED ?? "false") === "true",
    hasLegacyBearerCredential: Boolean(options.apiKey ?? process.env.MUNIN_API_KEY),
    hasDpaBearerCredential: Boolean(options.apiKeyDpa ?? process.env.MUNIN_API_KEY_DPA),
    legacyBearerTransportType: getConfiguredLegacyBearerTransportType(),
  };
}

function logHttpLibrarianConfigWarnings(runtimeConfig: LibrarianRuntimeConfig): void {
  for (const warning of getLibrarianConfigWarnings(runtimeConfig)) {
    console.error(`Librarian config warning: ${warning}`);
  }
}

// --- HTTP transport (Express) ---

export function createHttpApp(options: HttpAppOptions): { app: express.Express; oauthProvider: MuninOAuthProvider } {
  const {
    database,
    apiKey,
    apiKeyDpa,
    apiKeyConsumer,
    issuerUrl,
    httpHost,
    httpPort,
    requestLogger = logRequest,
    rateLimitConfig = getRateLimitConfig(),
  } = options;
  const allowedHosts = buildAllowedHosts(httpHost, httpPort);
  const runtimeConfig = buildLibrarianRuntimeConfig("http", { apiKey, apiKeyDpa, apiKeyConsumer });
  const rateLimiter = new McpRateLimiter(rateLimitConfig);
  const rateLimitSecret = randomBytes(32);
  const reviewSessionSecret = randomBytes(32);
  const consentAuth = getConsentAuthConfig();
  const issuer = new URL(issuerUrl);
  const consentConfigError = validateConsentAuthConfig(consentAuth, issuer);

  if (consentConfigError) {
    throw new Error(consentConfigError);
  }

  // OAuth provider with dual auth (legacy Bearer + OAuth tokens)
  const oauthProvider = new MuninOAuthProvider(database, {
    legacyApiKey: apiKey,
    dpaApiKey: apiKeyDpa,
    consumerApiKey: apiKeyConsumer,
  });

  const app = express();

  // Trust first proxy (Cloudflare Tunnel) — required for express-rate-limit
  // and correct client IP detection behind reverse proxies
  app.set("trust proxy", 1);

  // --- Global middleware ---

  // Security headers on all responses
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // DNS rebinding protection on all routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!validateHost(req.headers.host, allowedHosts)) {
      res.status(403).json({ error: "Forbidden: invalid Host header" });
      return;
    }
    next();
  });

  // --- Health check (no auth) ---
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // --- Heimdall self-descriptor (no auth) ---
  app.get("/heimdall.json", (_req: Request, res: Response) => {
    res.json(HEIMDALL_DESCRIPTOR);
  });

  // OAuth consent must pass the proxy gate and resolve one authorized identity.
  // For GET and POST /authorize, bind that identity to the pending authorization.
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Express route matching is case-insensitive and permits a trailing slash by
    // default, so normalize those forms before deciding whether consent auth applies.
    const consentPath = req.path.toLowerCase().replace(/\/+$/, "");
    if (consentPath !== "/authorize" && consentPath !== "/authorize/approve") {
      next();
      return;
    }

    if (!isTrustedConsentRequest(req, consentAuth, issuer)) {
      res.status(403).json({
        error: "Forbidden: OAuth consent requires trusted user authentication",
      });
      return;
    }

    const identity = resolveConsentIdentity(req, consentAuth, database, issuer);
    if (!identity) {
      res.status(403).json({
        error: "Forbidden: OAuth consent requires a valid user identity",
      });
      return;
    }

    res.locals.consentIdentity = identity;

    // Resolve identity for GET /authorize — pass to OAuth provider so
    // authorize() can bind it to the pending auth
    if ((req.method === "GET" || req.method === "POST") && consentPath === "/authorize") {
      oauthProvider.setLastResolvedIdentity({
        email: identity.email,
        principalId: identity.principalId,
      });
    }

    next();
  });

  // --- OAuth endpoints (mounted at root) ---
  // mcpAuthRouter handles: /.well-known/oauth-authorization-server,
  // /.well-known/oauth-protected-resource/mcp, /authorize, /token, /register, /revoke
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: issuer,
      scopesSupported: ["mcp:tools"],
      resourceName: "Munin Memory",
    }),
  );

  // --- Consent approval handler ---
  // The consent page POSTs here after user clicks Approve/Deny.
  // All security-critical params are loaded from server-side storage by nonce —
  // the form only contains the nonce and the user's action.
  app.post(
    "/authorize/approve",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const { action, nonce } = req.body as Record<string, string>;

      if (!nonce) {
        res.status(400).json({ error: "Missing authorization nonce" });
        return;
      }

      // Look up and consume the pending authorization (single-use)
      const pending = oauthProvider.consumePendingAuth(nonce);
      if (!pending) {
        res.status(400).json({ error: "Invalid or expired authorization request" });
        return;
      }

      // Fail-closed: only approve on explicit "approve" action
      if (action !== "approve") {
        oauthProvider.denyAuthorization(pending, res);
        return;
      }

      // TOCTOU protection: re-resolve after the approval body has been parsed,
      // so principal changes during body receipt cannot reuse middleware's snapshot.
      const identity = resolveConsentIdentity(req, consentAuth, database, issuer);
      if (!identity) {
        oauthProvider.denyAuthorization(pending, res);
        return;
      }

      // If the pending auth was bound to a specific principal at GET time,
      // verify the identity hasn't changed
      if (pending.resolvedPrincipalId && identity.principalId !== pending.resolvedPrincipalId) {
        oauthProvider.denyAuthorization(pending, res);
        return;
      }

      // Bind the resolved principal to the pending auth (for completeAuthorization)
      if (identity.principalId && !pending.resolvedPrincipalId) {
        pending.resolvedPrincipalId = identity.principalId;
      }

      oauthProvider.completeAuthorization(pending, res);
    },
  );

  // --- MCP endpoint with Bearer auth ---
  // requireBearerAuth uses oauthProvider.verifyAccessToken which checks
  // legacy Bearer (MUNIN_API_KEY) first, then OAuth tokens.
  // resourceMetadataUrl tells clients where to discover OAuth endpoints (RFC 9728).
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: new URL(issuerUrl).href.replace(/\/$/, "") + "/.well-known/oauth-protected-resource",
  });

  app.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const requestLog = attachRequestLogger(req, res, requestLogger);

    // Rate limiting (after auth). Every authenticated MCP POST costs one token,
    // including initialize, notifications, tools/list, and malformed bodies.
    const rateLimitIdentity = getRateLimitIdentity(req, rateLimitSecret);
    const admission = rateLimiter.admit(
      rateLimitIdentity.callerKey,
      rateLimitIdentity.credentialKey,
    );
    if (!admission.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(admission.retryAfterMs / 1000));
      const limiterKey =
        admission.bucketKind === "overflow"
          ? "overflow"
          : admission.scope === "credential"
            ? rateLimitIdentity.credentialKeyHash
            : admission.scope === "global"
              ? "global"
              : rateLimitIdentity.callerKeyHash;
      requestLog.setRateLimit({
        keyHash: limiterKey,
        keySource: rateLimitIdentity.keySource,
        scope: admission.scope!,
        retryAfterMs: admission.retryAfterMs,
        admittedCount: admission.admittedCount,
        throttleCount: admission.throttleCount,
        totalThrottleCount: admission.totalThrottleCount,
      });
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.setHeader("X-Munin-Rate-Limit", "admission-v1");
      res.setHeader("X-Munin-RateLimit-Key", limiterKey);
      res.status(429).json({
        error: "Too many requests",
        retry_after_seconds: retryAfterSeconds,
        limiter_scope: admission.scope,
        limiter_key: limiterKey,
      });
      return;
    }

    // Parse body for POST — StreamableHTTPServerTransport needs raw body
    const result = await parseJsonBody(req);
    if (!result.ok) {
      const statusMap = { too_large: 413, timeout: 408, invalid_json: 400, error: 400 } as const;
      const msgMap = {
        too_large: "Request body too large",
        timeout: "Request body read timed out",
        invalid_json: "Invalid JSON body",
        error: "Error reading request body",
      } as const;
      res.status(statusMap[result.reason]).json({ error: msgMap[result.reason] });
      return;
    }
    const body = result.body;

    requestLog.setRequestMetadata(body);

    // Stateless mode requires a fresh transport per request to avoid message ID collisions.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const authInfo = req.auth as ExtendedAuthInfo | undefined;
    const accessContext = resolveAccessContext(
      database,
      authInfo?.clientId ?? "",
      authInfo?.token,
      authInfo?.principalId,
      authInfo?.authMethod ?? "oauth",
      authInfo?.transportTypeHint,
    );
    // Analytics correlation may use the caller's transport header (or the
    // legacy time-bucket fallback), but review authorization must use only a
    // server-issued, authenticated run handle. Keep these identities
    // independent so a missing review identity fails closed without dropping
    // retrieval events.
    const analyticsSessionId = getSessionHeader(req)
      ?? deriveAnalyticsSessionId(authInfo?.clientId ?? "anonymous");
    const reviewRun = resolveReviewRun(
      reviewSessionSecret,
      accessContext.principalId,
      authInfo,
      getSessionHeader(req),
    );
    if (reviewRun) {
      // StreamableHTTPServerTransport is intentionally stateless here, but
      // MCP clients still understand Mcp-Session-Id as the server-issued
      // handle to echo on subsequent requests. We authenticate it above and
      // use only its random run component for review scope.
      res.setHeader(MUNIN_RUN_SESSION_HEADER, reviewRun.handle);
    }
    const mcpServer = createMcpServer(
      database,
      analyticsSessionId,
      accessContext,
      runtimeConfig,
      reviewRun?.sessionId ?? null,
    );

    try {
      res.setHeader(WRITE_REPLAY_HEADER, WRITE_REPLAY_VERSION);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    } finally {
      await mcpServer.close().catch(() => {});
    }
  });

  // Stateless HTTP does not support session-bound GET/DELETE routes.
  app.all("/mcp", bearerAuth, (req: Request, res: Response) => {
    attachRequestLogger(req, res, requestLogger);
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
  });

  return { app, oauthProvider };
}

// cloudflared keeps idle origin connections for 90 s by default. If Node closes
// them first (its default is 5 s), the proxy can reuse a socket the origin is
// tearing down and the request is reset; non-idempotent POSTs such as OAuth
// /register then fail outright (#404). Stay idle longer than the proxy.
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 95_000;

export function createHttpServer(listener: RequestListener): HttpServer {
  const httpServer = createServer(listener);

  // Server timeouts
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;
  httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;

  return httpServer;
}

async function startHttp(database: Database.Database) {
  if (!hasHttpBearerCredential()) {
    console.error(getHttpCredentialErrorMessage());
    process.exit(1);
  }

  const runtimeConfig = buildLibrarianRuntimeConfig("http", { apiKey, apiKeyDpa, apiKeyConsumer });
  const { app, oauthProvider } = createHttpApp({
    database,
    apiKey,
    apiKeyDpa,
    apiKeyConsumer,
    issuerUrl,
    httpHost,
    httpPort,
  });

  const httpServer = createHttpServer(app);
  activeHttpServer = httpServer;

  cleanupTimerId = startMaintenancePruneTimer(database, {
    additionalCleanup: () => oauthProvider.cleanupExpired(),
  });

  httpServer.listen(httpPort, httpHost, () => {
    console.error(`Munin-memory HTTP server listening on ${httpHost}:${httpPort}`);
    console.error(`Allowed hosts: ${[...buildAllowedHosts(httpHost, httpPort)].join(", ")}`);
    console.error(`OAuth issuer: ${issuerUrl}`);
    logHttpLibrarianConfigWarnings(runtimeConfig);
  });
}

// --- Stdio transport ---

async function startStdio(database: Database.Database) {
  // One session ID per stdio process — all tool calls in this process are correlated
  const stdioSessionId = randomUUID();
  const accessContext = resolveAccessContext(
    database,
    "principal:owner",
    undefined,
    undefined,
    "stdio",
    "local",
  );
  if (accessContext.principalType !== "owner") {
    throw new Error("Failed to resolve owner access context for stdio transport.");
  }
  const server = createMcpServer(
    database,
    stdioSessionId,
    accessContext,
    buildLibrarianRuntimeConfig("stdio"),
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  cleanupTimerId = startMaintenancePruneTimer(database);
}

// --- Entry point ---

async function main() {
  if (transportMode === "http" && !hasHttpBearerCredential()) {
    console.error(getHttpCredentialErrorMessage());
    process.exit(1);
  }

  const database = initDatabase(process.env.MUNIN_MEMORY_DB_PATH);
  activeDb = database;

  // Prune old analytics data at startup
  runMaintenancePrune(database);

  // Initialize embedding pipeline (soft dependency — server works without it)
  const embeddingsReady = await initEmbeddings();
  if (embeddingsReady) {
    startEmbeddingWorker(database);
    console.error("Embedding pipeline initialized, background worker started");
  } else {
    console.error("Embedding pipeline not available — semantic search will degrade to lexical");
  }

  // Initialize consolidation worker (soft dependency — server works without it)
  const consolidationReady = initConsolidation();
  if (consolidationReady) {
    startConsolidationWorker(database);
    console.error("Consolidation worker initialized and started");
  } else {
    console.error("Consolidation worker not available — disabled or missing API key");
  }

  if (transportMode === "http") {
    await startHttp(database);
  } else {
    await startStdio(database);
  }
}

// --- Graceful shutdown ---

// How long shutdown waits for in-flight HTTP requests to finish before it
// force-closes their sockets. Bounded so a stuck request cannot block a deploy
// restart indefinitely.
//
// Worst case total = SHUTDOWN_DRAIN_TIMEOUT_MS + SHUTDOWN_WORKER_STOP_TIMEOUT_MS
// = 30 s plus DB close, which stays well under systemd's default 90 s stop
// timeout (after which SIGKILL would cut shutdown short).
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

// How long shutdown waits, in total, for both worker stops. A stop awaits its
// in-flight batch, and a consolidation batch can sit in an LLM fetch that has no
// timeout of its own, so the wait must be bounded here. On expiry the still-pending
// stop(s) are logged, the exit code becomes 1, and shutdown proceeds to close
// the DB (the in-flight batch is then abandoned and dies with the process).
export const SHUTDOWN_WORKER_STOP_TIMEOUT_MS = 20_000;

export interface ShutdownDeps {
  /** HTTP transport only; undefined for stdio. */
  httpServer?: HttpServer;
  stopEmbeddingWorker: () => Promise<void>;
  stopConsolidationWorker: () => Promise<void>;
  closeDatabase: () => void;
  exit: (code: number) => void;
  log?: (message: string, err?: unknown) => void;
  /** Exit code to use when every step succeeds (1 on the fatal startup path). */
  exitCode?: number;
  drainTimeoutMs?: number;
  /** Combined bound for both worker stops. */
  workerStopTimeoutMs?: number;
}

/**
 * Stop accepting connections, drain in-flight HTTP requests (bounded), stop both
 * background workers independently, close the database, then exit. Order matters:
 * requests may still write to the DB, so it closes only after they have drained,
 * and a failing worker stop must not prevent the other stop or the DB close.
 */
export async function runGracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const log = deps.log ?? ((message: string, err?: unknown) => console.error(message, err ?? ""));
  let exitCode = deps.exitCode ?? 0;

  if (deps.httpServer) {
    try {
      await drainHttpServer(deps.httpServer, deps.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS, log);
    } catch (err) {
      log("Error closing HTTP server during shutdown:", err);
      exitCode = 1;
    }
  }

  const stopTimeoutMs = deps.workerStopTimeoutMs ?? SHUTDOWN_WORKER_STOP_TIMEOUT_MS;
  const stopNames = ["embedding", "consolidation"];
  const settled = [false, false];
  const stopResults = [deps.stopEmbeddingWorker, deps.stopConsolidationWorker].map((stop, i) =>
    // Run each stop in its own async wrapper so a synchronous throw is also
    // reported as a rejection of that worker only.
    (async () => stop())().then(
      () => { settled[i] = true; },
      (err: unknown) => {
        settled[i] = true;
        // A worker stop can reject (in-flight DB/write/embedding errors). Don't let
        // that skip the other worker or the DB close.
        log(`Error stopping ${stopNames[i]} worker during shutdown:`, err);
        exitCode = 1;
      },
    ),
  );
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.all(stopResults).then(() => false),
    new Promise<boolean>((resolve) => {
      stopTimer = setTimeout(() => resolve(true), stopTimeoutMs);
    }),
  ]);
  clearTimeout(stopTimer);
  if (timedOut) {
    const pending = stopNames.filter((_, i) => !settled[i]).join(", ");
    log(`Worker stop still pending after ${stopTimeoutMs} ms (${pending}); closing the database anyway`);
    exitCode = 1;
  }

  try {
    deps.closeDatabase();
  } catch (err) {
    log("Error closing database during shutdown:", err);
    exitCode = 1;
  }
  deps.exit(exitCode);
}

function drainHttpServer(
  httpServer: HttpServer,
  timeoutMs: number,
  log: (message: string, err?: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;
    const finish = (err?: Error | null) => {
      clearTimeout(timer);
      clearInterval(sweep);
      // Closing a server that never started listening is not a shutdown failure.
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(err);
      else resolve();
    };

    // Stop accepting new connections; the callback fires once every open
    // connection has ended.
    httpServer.close(finish);
    httpServer.closeIdleConnections();
    // Defensive: a keep-alive connection that goes idle when its last response
    // finishes must not hold close() open for the whole keep-alive window.
    sweep = setInterval(() => httpServer.closeIdleConnections(), 100);
    timer = setTimeout(() => {
      log(`HTTP requests still in flight after ${timeoutMs} ms; closing their connections`);
      httpServer.closeAllConnections();
    }, timeoutMs);
  });
}

let shutdownStarted = false;

function shutdown(exitCode = 0): Promise<void> {
  if (shutdownStarted) return Promise.resolve();
  shutdownStarted = true;
  stopMaintenancePruneTimer(cleanupTimerId);
  cleanupTimerId = undefined;
  return runGracefulShutdown({
    httpServer: activeHttpServer,
    stopEmbeddingWorker,
    stopConsolidationWorker,
    closeDatabase: () => {
      const database = activeDb;
      activeDb = undefined;
      database?.close();
    },
    exit: (code) => process.exit(code),
    exitCode,
  });
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  main().catch(async (err) => {
    console.error("Fatal error:", err);
    await shutdown(1);
  });
}
