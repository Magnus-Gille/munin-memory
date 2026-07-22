/**
 * munin-bridge: MCP stdio-to-HTTP bridge with session auto-reconnect
 *
 * Transparently proxies JSON-RPC messages between a local stdio client
 * (Claude Code / Desktop) and a remote MCP Streamable HTTP server.
 *
 * When the server evicts a session (idle timeout), the bridge automatically
 * reconnects: creates a new transport, performs the MCP initialize handshake,
 * and retries the failed message. Claude Code sees no interruption.
 *
 * Environment variables:
 *   MUNIN_REMOTE_URL          — Required. Remote MCP endpoint URL.
 *   MUNIN_AUTH_TOKEN           — Bearer token for Authorization header.
 *   MUNIN_CF_CLIENT_ID         — Cloudflare Access client ID.
 *   MUNIN_CF_CLIENT_SECRET     — Cloudflare Access client secret.
 *   MUNIN_CREDENTIALS_FILE     — Optional path to a 0600 JSON file holding
 *                                 auth_token / cf_client_id / cf_client_secret.
 *                                 When set, these values are read from the
 *                                 file instead of env vars, keeping secrets
 *                                 out of MCP client config files.
 *   MUNIN_REQUEST_TIMEOUT_MS   — Per-request timeout in ms (default: 60000).
 *   MUNIN_BRIDGE_CLIENT_ID     — Optional non-secret caller label used for
 *                                 per-client server admission isolation.
 *   MUNIN_BRIDGE_RATE_LIMIT_RETRIES — 429 retries (default: 2).
 *   MUNIN_BRIDGE_RATE_LIMIT_MAX_WAIT_MS — Total 429 wait budget (default: 10000).
 *   MUNIN_BRIDGE_RATE_LIMIT_JITTER_MS — Additive jitter ceiling (default: 250).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_VERSION } from "./version.js";

// --- Credential loading ---

export interface BridgeCredentials {
  authToken?: string;
  cfClientId?: string;
  cfClientSecret?: string;
}

interface CredentialsFileShape {
  auth_token?: unknown;
  cf_client_id?: unknown;
  cf_client_secret?: unknown;
}

export interface CredentialsLoaderOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  stat?: (filePath: string) => { mode: number };
  log?: (msg: string) => void;
  platform?: NodeJS.Platform;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readStringField(
  source: CredentialsFileShape,
  field: keyof CredentialsFileShape,
  filePath: string,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `MUNIN_CREDENTIALS_FILE at ${filePath}: field "${field}" must be a string.`,
    );
  }
  return value;
}

function checkFilePermissions(
  filePath: string,
  platform: NodeJS.Platform,
  stat: (p: string) => { mode: number },
): void {
  let stats: { mode: number };
  try {
    stats = stat(filePath);
  } catch (err) {
    throw new Error(
      `MUNIN_CREDENTIALS_FILE set but file is not readable at ${filePath}: ${
        (err as Error).message
      }`,
    );
  }
  if (platform !== "win32") {
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `MUNIN_CREDENTIALS_FILE at ${filePath} has mode 0${mode
          .toString(8)
          .padStart(3, "0")}; refusing to read a group/world-accessible credentials file (use \`chmod 600\`).`,
      );
    }
  }
}

function parseCredentialsFile(
  filePath: string,
  readFile: (p: string) => string,
): CredentialsFileShape {
  let raw: string;
  try {
    raw = readFile(filePath);
  } catch (err) {
    throw new Error(
      `Failed to read MUNIN_CREDENTIALS_FILE at ${filePath}: ${
        (err as Error).message
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `MUNIN_CREDENTIALS_FILE at ${filePath} is not valid JSON: ${
        (err as Error).message
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `MUNIN_CREDENTIALS_FILE at ${filePath} must contain a JSON object at the top level.`,
    );
  }
  return parsed as CredentialsFileShape;
}

function warnOverriddenEnvVars(env: NodeJS.ProcessEnv, log: (msg: string) => void): void {
  const overriddenEnv: string[] = [];
  if (env.MUNIN_AUTH_TOKEN) overriddenEnv.push("MUNIN_AUTH_TOKEN");
  if (env.MUNIN_CF_CLIENT_ID) overriddenEnv.push("MUNIN_CF_CLIENT_ID");
  if (env.MUNIN_CF_CLIENT_SECRET) overriddenEnv.push("MUNIN_CF_CLIENT_SECRET");
  if (overriddenEnv.length > 0) {
    log(
      `MUNIN_CREDENTIALS_FILE is set; ignoring inline env vars: ${overriddenEnv.join(", ")}`,
    );
  }
}

export function loadBridgeCredentials(
  options: CredentialsLoaderOptions = {},
): BridgeCredentials {
  const env = options.env ?? process.env;
  const readFile =
    options.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const stat = options.stat ?? ((p: string) => fs.statSync(p));
  const log =
    options.log ??
    ((msg: string) => process.stderr.write(`[munin-bridge] ${msg}\n`));
  const platform = options.platform ?? process.platform;

  const rawPath = env.MUNIN_CREDENTIALS_FILE;
  if (!rawPath || rawPath.length === 0) {
    return {
      authToken: env.MUNIN_AUTH_TOKEN,
      cfClientId: env.MUNIN_CF_CLIENT_ID,
      cfClientSecret: env.MUNIN_CF_CLIENT_SECRET,
    };
  }

  const filePath = expandHome(rawPath);

  checkFilePermissions(filePath, platform, stat);

  const obj = parseCredentialsFile(filePath, readFile);
  const authToken = readStringField(obj, "auth_token", filePath);
  const cfClientId = readStringField(obj, "cf_client_id", filePath);
  const cfClientSecret = readStringField(obj, "cf_client_secret", filePath);

  warnOverriddenEnvVars(env, log);
  log(`Credentials loaded from file: ${filePath}`);

  return { authToken, cfClientId, cfClientSecret };
}

// --- Exported helpers (for testing) ---

export function isSessionExpiredError(err: unknown): boolean {
  if (!(err instanceof StreamableHTTPError)) return false;
  if (err.code === 404) return true;
  if (err.code === 400) {
    const msg = err.message.toLowerCase();
    return msg.includes("not initialized") || msg.includes("no valid session");
  }
  return false;
}

export function isRequest(
  msg: JSONRPCMessage,
): msg is JSONRPCMessage & { id: string | number } {
  return "id" in msg && "method" in msg && msg.id !== undefined;
}

export const DEFAULT_BRIDGE_RATE_LIMIT_RETRIES = 2;
export const DEFAULT_BRIDGE_RATE_LIMIT_MAX_WAIT_MS = 10_000;
export const DEFAULT_BRIDGE_RATE_LIMIT_JITTER_MS = 250;
const DEFAULT_BRIDGE_RATE_LIMIT_FALLBACK_MS = 1_000;

export interface BridgeRateLimitRetryConfig {
  maxRetries: number;
  maxWaitMs: number;
  jitterMs: number;
}

export interface FetchWithTimeoutOptions {
  fetchFn?: typeof fetch;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (message: string) => void;
  retry?: BridgeRateLimitRetryConfig;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = nonNegativeInteger(value, fallback, maximum);
  return parsed > 0 ? parsed : fallback;
}

export function getBridgeRateLimitRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeRateLimitRetryConfig {
  return {
    maxRetries: nonNegativeInteger(
      env.MUNIN_BRIDGE_RATE_LIMIT_RETRIES,
      DEFAULT_BRIDGE_RATE_LIMIT_RETRIES,
      10,
    ),
    maxWaitMs: positiveInteger(
      env.MUNIN_BRIDGE_RATE_LIMIT_MAX_WAIT_MS,
      DEFAULT_BRIDGE_RATE_LIMIT_MAX_WAIT_MS,
      60_000,
    ),
    jitterMs: nonNegativeInteger(
      env.MUNIN_BRIDGE_RATE_LIMIT_JITTER_MS,
      DEFAULT_BRIDGE_RATE_LIMIT_JITTER_MS,
      5000,
    ),
  };
}

export function resolveBridgeClientId(
  env: NodeJS.ProcessEnv = process.env,
  uuid: () => string = randomUUID,
): string {
  const configured = env.MUNIN_BRIDGE_CLIENT_ID?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configured)) {
      throw new Error(
        "MUNIN_BRIDGE_CLIENT_ID must be 1-128 characters using only letters, digits, '.', '_', ':', or '-'.",
      );
    }
    return configured;
  }
  return `bridge-${uuid()}`;
}

export function parseRetryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

export class BridgeRateLimitRetryExhaustedError extends Error {
  constructor(
    attempts: number,
    elapsedMs: number,
    maxWaitMs: number,
    nextDelayMs: number,
  ) {
    super(
      `Bridge rate-limit retry exhausted after ${attempts} attempt(s); ` +
        `elapsed ${elapsedMs}ms of ${maxWaitMs}ms budget and next admission ` +
        `requires ${nextDelayMs}ms.`,
    );
    this.name = "BridgeRateLimitRetryExhaustedError";
  }
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createFetchWithTimeout(
  timeoutMs: number,
  options: FetchWithTimeoutOptions = {},
): typeof fetch {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const retry = options.retry ?? getBridgeRateLimitRetryConfig();
  const retryLog = options.log ?? (() => {});

  return async (input, init) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    let removeOuterAbort: (() => void) | undefined;
    if (init?.signal) {
      if (init.signal.aborted) {
        controller.abort(init.signal.reason);
      } else {
        const onOuterAbort = () => controller.abort(init.signal!.reason);
        init.signal.addEventListener("abort", onOuterAbort, { once: true });
        removeOuterAbort = () =>
          init.signal?.removeEventListener("abort", onOuterAbort);
      }
    }

    try {
      const startedAt = now();
      let retriesUsed = 0;
      let waitedMs = 0;

      while (true) {
        const response = await fetchFn(input, {
          ...init,
          signal: controller.signal,
        });
        if (response.status !== 429) return response;

        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("Retry-After"), now()) ??
          DEFAULT_BRIDGE_RATE_LIMIT_FALLBACK_MS;
        const jitterMs = Math.floor(Math.max(0, random()) * retry.jitterMs);
        const delayMs = retryAfterMs + jitterMs;
        await response.body?.cancel().catch(() => {});

        const elapsedMs = Math.max(waitedMs, now() - startedAt);
        if (
          retriesUsed >= retry.maxRetries ||
          elapsedMs + delayMs > retry.maxWaitMs
        ) {
          throw new BridgeRateLimitRetryExhaustedError(
            retriesUsed + 1,
            elapsedMs,
            retry.maxWaitMs,
            delayMs,
          );
        }

        retriesUsed += 1;
        retryLog(
          `HTTP 429; retry ${retriesUsed}/${retry.maxRetries} in ${delayMs}ms`,
        );
        await sleep(delayMs, controller.signal);
        waitedMs += delayMs;
      }
    } finally {
      clearTimeout(timeoutId);
      removeOuterAbort?.();
    }
  };
}

// --- Transport interface for dependency injection ---

export interface TransportLike {
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
  terminateSession?(): Promise<void>;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

// --- Bridge factory (exported for testing) ---

export interface BridgeConfig {
  createHttpTransport: () => TransportLike;
  stdio: TransportLike;
  log?: (msg: string) => void;
  onExit?: (code: number) => void;
}

export function createBridge(config: BridgeConfig) {
  const {
    stdio,
    createHttpTransport,
    log = (msg: string) =>
      process.stderr.write(`[munin-bridge] ${msg}\n`),
    onExit = (code: number) => process.exit(code),
  } = config;

  let httpClient = createHttpTransport();
  let stdinClosed = false;
  let cleaningUp = false;
  let reconnecting = false;

  const sendQueue: JSONRPCMessage[] = [];
  let sending = false;

  // Forward server responses to Claude Code via stdio
  function forwardToStdio(message: JSONRPCMessage): void {
    stdio.send(message).catch((err) => log(`Failed to forward to stdio: ${err}`));
  }

  async function cleanup(): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;

    try {
      await httpClient.terminateSession?.();
    } catch {
      // Best-effort session cleanup
    }
    try {
      await httpClient.close();
    } catch {
      // Already closed or errored
    }
    try {
      await stdio.close();
    } catch {
      // Already closed or errored
    }

    onExit(0);
  }

  function wireHttpHandlers(client: TransportLike): void {
    client.onmessage = forwardToStdio;
    client.onerror = (err) => log(`Remote: ${err.message}`);
    // Transport-identity-scoped onclose: only cleanup if this is still the active transport.
    // During reconnect, the old transport is replaced — its onclose must NOT trigger cleanup.
    client.onclose = () => {
      if (client === httpClient) {
        void cleanup();
      }
    };
  }

  async function reconnect(): Promise<void> {
    if (reconnecting) throw new Error("Reconnect already in progress");
    reconnecting = true;

    const oldClient = httpClient;

    try {
      // 1. Detach old transport handlers to prevent spurious cleanup
      oldClient.onclose = undefined;
      oldClient.onmessage = undefined;
      oldClient.onerror = undefined;

      // 2. Close old transport (best-effort)
      try {
        await oldClient.close();
      } catch {
        // Already closed or errored
      }

      // 3. Create new transport via factory
      const newClient = createHttpTransport();
      httpClient = newClient;

      // 4. Start new transport
      await newClient.start();

      // 5. MCP initialize handshake (bridge-internal, not forwarded to Claude Code)
      const initId = `bridge-init-${Date.now()}`;

      const initResponse = await new Promise<JSONRPCMessage>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Initialize handshake timed out (15s)"));
          }, 15_000);

          newClient.onmessage = (msg: JSONRPCMessage) => {
            if ("id" in msg && msg.id === initId) {
              clearTimeout(timeout);
              resolve(msg);
            }
          };

          newClient
            .send({
              jsonrpc: "2.0",
              id: initId,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: {
                  name: "munin-bridge",
                  version: SERVER_VERSION,
                },
              },
            })
            .catch((err) => {
              clearTimeout(timeout);
              reject(err);
            });
        },
      );

      // Check for error response
      if ("error" in initResponse) {
        throw new Error(
          `Initialize failed: ${JSON.stringify((initResponse as Record<string, unknown>).error)}`,
        );
      }

      // 6. Send initialized notification
      await newClient.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      log("Session reconnected successfully");
    } finally {
      // Always restore handlers on current httpClient (even on failure)
      wireHttpHandlers(httpClient);
      reconnecting = false;
    }
  }

  async function processSendQueue(): Promise<void> {
    if (sending) return;
    sending = true;

    while (sendQueue.length > 0) {
      const message = sendQueue.shift()!;
      try {
        await httpClient.send(message);
      } catch (err) {
        // Session expired? Reconnect and retry once (max 1 reconnect per message)
        if (isSessionExpiredError(err)) {
          log("Session expired, attempting reconnect...");
          try {
            await reconnect();
            // Retry the message once after successful reconnect
            await httpClient.send(message);
            continue;
          } catch (reconnectErr) {
            const error =
              reconnectErr instanceof Error
                ? reconnectErr
                : new Error(String(reconnectErr));
            log(`Reconnect failed: ${error.message}`);
            if (isRequest(message)) {
              try {
                await stdio.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32000,
                    message: `Bridge reconnect failed: ${error.message}`,
                  },
                });
              } catch {
                log("Failed to send error response to client");
              }
            }
            continue;
          }
        }

        // Non-session error: forward to Claude Code as-is
        const error =
          err instanceof Error ? err : new Error(String(err));
        if (isRequest(message)) {
          try {
            await stdio.send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message: `Bridge error: ${error.message}`,
              },
            });
          } catch {
            log("Failed to send error response to client");
          }
        }
      }
    }

    sending = false;

    if (stdinClosed) {
      void cleanup();
    }
  }

  // Wire stdio → httpClient forwarding
  stdio.onmessage = (message: JSONRPCMessage) => {
    sendQueue.push(message);
    void processSendQueue();
  };
  stdio.onerror = (err) => log(`Stdio: ${err.message}`);
  stdio.onclose = () => {
    stdinClosed = true;
    // If no sends are in-flight, exit now. Otherwise processSendQueue handles it.
    if (!sending && sendQueue.length === 0) {
      void cleanup();
    }
  };

  // Wire initial HTTP handlers
  wireHttpHandlers(httpClient);

  return {
    async start() {
      await httpClient.start();
      await stdio.start();
    },
    cleanup,
    reconnect,
    getHttpClient: () => httpClient,
  };
}

// --- Entry point ---

function log(msg: string): void {
  process.stderr.write(`[munin-bridge] ${msg}\n`);
}

async function main(): Promise<void> {
  const REMOTE_URL = process.env.MUNIN_REMOTE_URL;
  if (!REMOTE_URL) {
    process.stderr.write("Fatal: MUNIN_REMOTE_URL is required\n");
    process.exit(1);
  }

  const requestTimeoutMs = parseInt(
    process.env.MUNIN_REQUEST_TIMEOUT_MS ?? "60000",
    10,
  );

  const creds = loadBridgeCredentials({ log });
  const authHeaders: Record<string, string> = {};
  if (creds.authToken) {
    authHeaders["Authorization"] = `Bearer ${creds.authToken}`;
  }
  if (creds.cfClientId) {
    authHeaders["CF-Access-Client-Id"] = creds.cfClientId;
  }
  if (creds.cfClientSecret) {
    authHeaders["CF-Access-Client-Secret"] = creds.cfClientSecret;
  }
  authHeaders["X-Munin-Client-Id"] = resolveBridgeClientId();

  const fetchWithTimeout = createFetchWithTimeout(requestTimeoutMs, { log });

  const bridge = createBridge({
    stdio: new StdioServerTransport() as TransportLike,
    createHttpTransport: () =>
      new StreamableHTTPClientTransport(new URL(REMOTE_URL), {
        requestInit: { headers: authHeaders },
        fetch: fetchWithTimeout,
      }) as TransportLike,
    log,
    onExit: (code) => process.exit(code),
  });

  process.on("SIGINT", () => {
    void bridge.cleanup();
  });
  process.on("SIGTERM", () => {
    void bridge.cleanup();
  });

  await bridge.start();
  log(`Bridge started → ${REMOTE_URL} (timeout: ${requestTimeoutMs}ms)`);
}

// Guard: don't auto-start when imported for testing
if (!process.env.VITEST) {
  main().catch((err) => {
    process.stderr.write(`[munin-bridge] Fatal: ${err}\n`);
    process.exit(1);
  });
}
