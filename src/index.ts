import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer, IncomingMessage } from "node:http";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { initDatabase, nowUTC, pruneRedactionLog, pruneRetrievalAnalytics } from "./db.js";
import { registerTools } from "./tools.js";
import { initEmbeddings, startEmbeddingWorker, stopEmbeddingWorker } from "./embeddings.js";
import { initConsolidation, startConsolidationWorker, stopConsolidationWorker } from "./consolidation.js";
import { getConfiguredLegacyBearerTransportType, resolveAccessContext } from "./access.js";
import type { AccessContext } from "./access.js";
import { getLibrarianConfigWarnings, type LibrarianRuntimeConfig } from "./librarian.js";
import { MuninOAuthProvider, type ExtendedAuthInfo } from "./oauth.js";

// Analytics retention (default 90 days)
function getAnalyticsRetentionDays(): number {
  const val = parseInt(process.env.MUNIN_ANALYTICS_RETENTION_DAYS ?? "90", 10);
  return Number.isFinite(val) && val > 0 ? val : 90;
}

function getRedactionLogRetentionDays(): number {
  const val = parseInt(process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS ?? "90", 10);
  return Number.isFinite(val) && val > 0 ? val : 90;
}

export function runMaintenancePrune(database: Database.Database): void {
  pruneRetrievalAnalytics(database, getAnalyticsRetentionDays());
  pruneRedactionLog(database, getRedactionLogRetentionDays());
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
const OAUTH_CLEANUP_INTERVAL_MS = 60 * 1000;

export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// --- Types ---

export type BodyParseResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "timeout" | "invalid_json" | "error" };

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  rpcMethod?: string;
  toolName?: string;
  authType: "bearer" | "oauth" | "none";
  clientId?: string;
  sessionId?: string;
  status: number;
  durationMs: number;
  diagnostics?: {
    headers: Record<string, string | string[]>;
    bodySnippet?: string;
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

// --- MCP server factory ---

function createMcpServer(
  database: Database.Database,
  sessionId?: string,
  accessContext?: AccessContext,
  runtimeConfig?: LibrarianRuntimeConfig,
): Server {
  const server = new Server(
    { name: "munin-memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, database, sessionId, accessContext, runtimeConfig);
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

export function isTrustedConsentRequest(req: Request, config: ConsentAuthConfig): boolean {
  if (
    config.trustedHeaderName &&
    config.trustedHeaderValue &&
    safeStringEqual(req.get(config.trustedHeaderName) ?? "", config.trustedHeaderValue)
  ) {
    return true;
  }

  // If identity header is configured, check if the email matches any active principal
  if (config.identityHeaderName) {
    const email = req.get(config.identityHeaderName);
    if (email) return true; // Gate passes — identity will be resolved in the handler
  }

  if (!config.allowLocalhost) {
    return false;
  }

  return isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Resolve the identity of the user making a consent request.
 * Returns null if identity cannot be determined (fail-closed).
 *
 * Resolution order:
 * 1. Owner env var fallback (MUNIN_OAUTH_TRUSTED_USER_VALUE match)
 * 2. Identity header → DB lookup by email
 * 3. Localhost → owner
 */
export function resolveConsentIdentity(
  req: Request,
  config: ConsentAuthConfig,
  db: Database.Database,
): ConsentIdentity | null {
  // 1. Check owner env var (gate header match = owner)
  if (
    config.trustedHeaderName &&
    config.trustedHeaderValue
  ) {
    const headerValue = req.get(config.trustedHeaderName) ?? "";
    if (safeStringEqual(headerValue, config.trustedHeaderValue)) {
      return { email: config.trustedHeaderValue, principalId: "owner", isOwner: true };
    }
  }

  // 2. Identity header → DB lookup
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
      // No match — fall through (may still match localhost)
    }
  }

  // 3. Localhost fallback → owner
  if (config.allowLocalhost && isLoopbackAddress(req.socket.remoteAddress)) {
    return { email: "localhost", principalId: "owner", isOwner: true };
  }

  return null;
}

export function createRateLimiter(): RateLimiterState {
  return { tokens: RATE_LIMIT_MAX, lastRefill: Date.now() };
}

export function checkRateLimit(state: RateLimiterState, now = Date.now()): boolean {
  const elapsed = now - state.lastRefill;
  const refill = (elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_MAX;
  state.tokens = Math.min(RATE_LIMIT_MAX, state.tokens + refill);
  state.lastRefill = now;

  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
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

/**
 * Derive a stable session ID from the caller's identity and a time bucket.
 * When the client doesn't send mcp-session-id, this ensures all requests from
 * the same caller within a 30-minute window share a session ID, so retrieval
 * analytics can correlate queries with outcomes.
 */
function deriveSessionId(clientId: string): string {
  const bucketMs = 30 * 60 * 1000;
  const bucket = Math.floor(Date.now() / bucketMs);
  return createHash("sha256").update(`${clientId}:${bucket}`).digest("hex").slice(0, 32);
}

const REDACTED_HEADER_KEYS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "cf-access-client-secret",
  "x-api-key",
]);

const DIAGNOSTIC_BODY_SNIPPET_LIMIT = 500;

function redactHeaders(headers: Request["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = REDACTED_HEADER_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

function buildBodySnippet(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  try {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    if (!serialized) return undefined;
    return serialized.length > DIAGNOSTIC_BODY_SNIPPET_LIMIT
      ? serialized.slice(0, DIAGNOSTIC_BODY_SNIPPET_LIMIT) + "...[truncated]"
      : serialized;
  } catch {
    return undefined;
  }
}

function attachRequestLogger(
  req: Request,
  res: Response,
  requestLogger: (entry: RequestLogEntry) => void,
): { setBody: (body: unknown) => void } {
  const startTime = Date.now();
  const sessionId = getSessionHeader(req);
  const authContext = getRequestAuthLogContext(req.auth);
  let rpcMethod: string | undefined;
  let toolName: string | undefined;
  let body: unknown;

  res.on("finish", () => {
    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      rpcMethod,
      toolName,
      ...authContext,
      sessionId,
      status: res.statusCode,
      durationMs: Date.now() - startTime,
    };
    if (res.statusCode >= 400 && req.path === "/mcp") {
      entry.diagnostics = {
        headers: redactHeaders(req.headers),
        bodySnippet: buildBodySnippet(body),
      };
    }
    requestLogger(entry);
  });

  return {
    setBody(nextBody: unknown) {
      body = nextBody;
      rpcMethod = extractMethod(nextBody);
      toolName = extractToolName(nextBody);
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
  } = options;
  const allowedHosts = buildAllowedHosts(httpHost, httpPort);
  const runtimeConfig = buildLibrarianRuntimeConfig("http", { apiKey, apiKeyDpa, apiKeyConsumer });
  const rateLimiter = createRateLimiter();
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

  // OAuth consent must be protected by a trusted user signal.
  // For GET /authorize, also resolve identity and pass to OAuth provider.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path !== "/authorize" && req.path !== "/authorize/approve") {
      next();
      return;
    }

    if (!isTrustedConsentRequest(req, consentAuth)) {
      res.status(403).json({
        error: "Forbidden: OAuth consent requires trusted user authentication",
      });
      return;
    }

    // Resolve identity for GET /authorize — pass to OAuth provider so
    // authorize() can bind it to the pending auth
    if (req.method === "GET" && req.path === "/authorize") {
      const identity = resolveConsentIdentity(req, consentAuth, database);
      if (identity) {
        oauthProvider.setLastResolvedIdentity({
          email: identity.email,
          principalId: identity.principalId,
        });
      } else {
        // Identity resolution failed but gate passed — proceed as owner fallback
        oauthProvider.setLastResolvedIdentity(undefined);
      }
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

      // TOCTOU protection: re-resolve identity on POST and verify it matches GET
      const identity = resolveConsentIdentity(req, consentAuth, database);
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

    // Rate limiting (after auth)
    if (!checkRateLimit(rateLimiter)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many requests" });
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

    requestLog.setBody(body);

    // Stateless mode requires a fresh transport per request to avoid message ID collisions.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    // Use mcp-session-id header for correlation, fall back to caller-derived stable ID
    const mcpSessionId = getSessionHeader(req) ?? deriveSessionId(req.auth?.clientId ?? "anonymous");
    const authInfo = req.auth as ExtendedAuthInfo | undefined;
    const accessContext = resolveAccessContext(
      database,
      authInfo?.clientId ?? "",
      authInfo?.token,
      authInfo?.principalId,
      authInfo?.authMethod ?? "oauth",
      authInfo?.transportTypeHint,
    );
    const mcpServer = createMcpServer(database, mcpSessionId, accessContext, runtimeConfig);

    try {
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

  const httpServer = createServer(app);

  // Server timeouts
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;

  cleanupTimerId = setInterval(() => {
    oauthProvider.cleanupExpired();
    runMaintenancePrune(database);
  }, OAUTH_CLEANUP_INTERVAL_MS);

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

// Graceful shutdown
async function shutdown() {
  if (cleanupTimerId) {
    clearInterval(cleanupTimerId);
    cleanupTimerId = undefined;
  }
  await stopEmbeddingWorker();
  await stopConsolidationWorker();
  activeDb?.close();
  activeDb = undefined;
  process.exit(0);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });

  main().catch(async (err) => {
    console.error("Fatal error:", err);
    if (cleanupTimerId) {
      clearInterval(cleanupTimerId);
      cleanupTimerId = undefined;
    }
    await stopEmbeddingWorker();
    await stopConsolidationWorker();
    activeDb?.close();
    activeDb = undefined;
    process.exit(1);
  });
}
