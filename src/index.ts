import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { initDatabase } from "./db.js";
import { registerTools } from "./tools.js";
import { initEmbeddings, startEmbeddingWorker, stopEmbeddingWorker } from "./embeddings.js";
import { MuninOAuthProvider } from "./oauth.js";

// --- Configuration ---

const transportMode = process.env.MUNIN_TRANSPORT ?? "stdio";
const httpPort = parseInt(process.env.MUNIN_HTTP_PORT ?? "3030", 10);
const httpHost = process.env.MUNIN_HTTP_HOST ?? "127.0.0.1";
const apiKey = process.env.MUNIN_API_KEY;
const issuerUrl = process.env.MUNIN_OAUTH_ISSUER_URL ?? "http://localhost:3030";

if (transportMode === "http" && !apiKey) {
  console.error(
    "Fatal: MUNIN_API_KEY is required when MUNIN_TRANSPORT=http. Generate one with: openssl rand -hex 32",
  );
  process.exit(1);
}

// --- Hardening constants ---

export const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB
const BODY_PARSE_TIMEOUT_MS = 10_000;

export const MAX_SESSIONS = 10;
const SESSION_IDLE_TTL_MS = parseInt(process.env.MUNIN_SESSION_IDLE_TTL_MS ?? String(30 * 60 * 1000), 10);
const SESSION_ABSOLUTE_TTL_MS = 4 * 60 * 60 * 1000; // 4hr
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;      // 1min

export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// --- Types ---

interface SessionMeta {
  createdAt: number;
  lastActivityAt: number;
  transport: StreamableHTTPServerTransport;
  server: Server;
}

export type BodyParseResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "timeout" | "invalid_json" | "error" };

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  rpcMethod?: string;
  toolName?: string;
  sessionId?: string;
  status: number;
  durationMs: number;
}

// --- Database ---

const dbPath = process.env.MUNIN_MEMORY_DB_PATH;
const db = initDatabase(dbPath);

// --- MCP server factory ---

function createMcpServer(): Server {
  const server = new Server(
    { name: "munin-memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db);
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

// --- Session management ---

let sweepTimerId: ReturnType<typeof setInterval> | undefined;

function evictSession(sessionId: string, sessions: Map<string, SessionMeta>): void {
  const meta = sessions.get(sessionId);
  if (!meta) return;
  sessions.delete(sessionId);
  meta.server.close().catch(() => {});
}

function sweepSessions(sessions: Map<string, SessionMeta>): void {
  const now = Date.now();
  const toEvict: string[] = [];

  for (const [id, meta] of sessions) {
    if (
      now - meta.lastActivityAt > SESSION_IDLE_TTL_MS ||
      now - meta.createdAt > SESSION_ABSOLUTE_TTL_MS
    ) {
      toEvict.push(id);
    }
  }

  for (const id of toEvict) {
    evictSession(id, sessions);
  }
}

function evictOldestIdle(sessions: Map<string, SessionMeta>): boolean {
  let oldestId: string | undefined;
  let oldestActivity = Infinity;

  for (const [id, meta] of sessions) {
    if (meta.lastActivityAt < oldestActivity) {
      oldestActivity = meta.lastActivityAt;
      oldestId = id;
    }
  }

  if (oldestId) {
    evictSession(oldestId, sessions);
    return true;
  }
  return false;
}

// --- HTTP transport (Express) ---

async function startHttp() {
  const sessions = new Map<string, SessionMeta>();
  const allowedHosts = buildAllowedHosts(httpHost, httpPort);
  const rateLimiter = createRateLimiter();

  // OAuth provider with dual auth (legacy Bearer + OAuth tokens)
  const oauthProvider = new MuninOAuthProvider(db, apiKey);

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

  // --- OAuth endpoints (mounted at root) ---
  // mcpAuthRouter handles: /.well-known/oauth-authorization-server,
  // /.well-known/oauth-protected-resource/mcp, /authorize, /token, /register, /revoke
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(issuerUrl),
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

  // MCP endpoint — all methods (POST, GET, DELETE)
  app.all("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const startTime = Date.now();
    const method = req.method;

    // Rate limiting (after auth)
    if (!checkRateLimit(rateLimiter)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    // Parse body for POST — StreamableHTTPServerTransport needs raw body
    let body: unknown;
    if (method === "POST") {
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
      body = result.body;
    }

    const rpcMethod = extractMethod(body);
    const toolName = extractToolName(body);

    // Route to existing session if present
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existingMeta = sessionId ? sessions.get(sessionId) : undefined;

    if (existingMeta) {
      existingMeta.lastActivityAt = Date.now();
      await existingMeta.transport.handleRequest(req, res, body);
      logRequest({
        timestamp: new Date().toISOString(),
        method,
        path: "/mcp",
        rpcMethod,
        toolName,
        sessionId,
        status: res.statusCode,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // New session — create transport + server pair
    if (method === "POST") {
      // Enforce session cap
      if (sessions.size >= MAX_SESSIONS) {
        sweepSessions(sessions);
      }
      if (sessions.size >= MAX_SESSIONS) {
        evictOldestIdle(sessions);
      }
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({ error: "Too many active sessions" });
        return;
      }

      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          const now = Date.now();
          const server = mcpServer;
          sessions.set(id, {
            createdAt: now,
            lastActivityAt: now,
            transport,
            server,
          });
        },
        onsessionclosed: (id: string) => {
          sessions.delete(id);
        },
      });

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      logRequest({
        timestamp: new Date().toISOString(),
        method,
        path: "/mcp",
        rpcMethod,
        toolName,
        sessionId: undefined,
        status: res.statusCode,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // GET/DELETE without a valid session
    res.status(400).json({ error: "No valid session. Send an initialize request first." });
  });

  // --- Start server ---

  const httpServer = createServer(app);

  // Server timeouts
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;

  // Session + OAuth token sweep timer
  sweepTimerId = setInterval(() => {
    sweepSessions(sessions);
    oauthProvider.cleanupExpired();
  }, SESSION_SWEEP_INTERVAL_MS);

  httpServer.listen(httpPort, httpHost, () => {
    console.error(`Munin-memory HTTP server listening on ${httpHost}:${httpPort}`);
    console.error(`Allowed hosts: ${[...allowedHosts].join(", ")}`);
    console.error(`OAuth issuer: ${issuerUrl}`);
  });
}

// --- Stdio transport ---

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --- Entry point ---

async function main() {
  // Initialize embedding pipeline (soft dependency — server works without it)
  const embeddingsReady = await initEmbeddings();
  if (embeddingsReady) {
    startEmbeddingWorker(db);
    console.error("Embedding pipeline initialized, background worker started");
  } else {
    console.error("Embedding pipeline not available — semantic search will degrade to lexical");
  }

  if (transportMode === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

// Graceful shutdown
async function shutdown() {
  if (sweepTimerId) {
    clearInterval(sweepTimerId);
    sweepTimerId = undefined;
  }
  await stopEmbeddingWorker();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => { shutdown(); });
process.on("SIGTERM", () => { shutdown(); });

main().catch(async (err) => {
  console.error("Fatal error:", err);
  if (sweepTimerId) {
    clearInterval(sweepTimerId);
  }
  await stopEmbeddingWorker();
  db.close();
  process.exit(1);
});
