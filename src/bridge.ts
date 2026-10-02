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
 *
 * Thrown network failures report a sanitised cause summary and are retried only
 * for read-only requests, never writes. Server-marked admission-v1 429 responses
 * remain retryable because they reject before execution. Every request carries
 * X-Munin-Request-Id.
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
  networkRetry?: BridgeNetworkRetryConfig;
  uuid?: () => string;
  /** Called with the id of every forwarded request (the bridge reports the latest one). */
  onRequestId?: (requestId: string) => void;
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

// --- Network failure reporting and safe retry ---

/**
 * Tools that only read memory and are safe to repeat after a failure where the
 * server may already have processed the request. Anything not listed here is
 * treated as a write by the bridge.
 */
export const BRIDGE_RETRY_SAFE_TOOL_NAMES: readonly string[] = [
  "memory_orient",
  "memory_resume",
  "memory_read",
  "memory_read_batch",
  "memory_get",
  "memory_query",
  "memory_list",
  "memory_history",
  "memory_attention",
  "memory_status",
  "memory_health",
  "memory_narrative",
  "memory_commitments",
  "memory_patterns",
  "memory_handoff",
  "memory_insights",
];

/**
 * Registered tools that must never be repeated automatically after a
 * "possibly sent" failure:
 * - memory_write: upsert; a repeat can clobber a newer write or fail a CAS check
 *   that the first (applied) attempt already consumed.
 * - memory_log: appends a new entry on every call, so a repeat duplicates it.
 * - memory_update_status: mutating write with CAS semantics, like memory_write.
 * - memory_delete: confirm flow consumes a token; a repeat is not idempotent.
 * - memory_extract: may persist proposals to the review inbox (duplicates).
 * - memory_review: approve/decline/undo mutate memory truth or proposal state.
 * - memory_retrieval_feedback: records feedback rows on every call.
 * - memory_consolidate: runs LLM synthesis and writes entries; costly and mutating.
 */
export const BRIDGE_NEVER_RETRY_TOOL_NAMES: readonly string[] = [
  "memory_write",
  "memory_log",
  "memory_update_status",
  "memory_delete",
  "memory_extract",
  "memory_review",
  "memory_retrieval_feedback",
  "memory_consolidate",
];

/**
 * Fixed descriptions for network error codes. Cause reporting never passes free
 * text from an error through; only these constants are shown.
 * scripts/stdio-bridge.mjs carries an identical copy (tests assert equality);
 * keep the two tables in sync.
 */
export const FETCH_ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset by peer",
  EPIPE: "broken pipe",
  ETIMEDOUT: "connection timed out",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  ENOTFOUND: "host name could not be resolved",
  EAI_AGAIN: "temporary name resolution failure",
  UND_ERR_SOCKET: "connection closed unexpectedly",
  UND_ERR_CONNECT_TIMEOUT: "connect timeout",
  UND_ERR_HEADERS_TIMEOUT: "timed out waiting for response headers",
  UND_ERR_BODY_TIMEOUT: "timed out waiting for response body",
  UND_ERR_ABORTED: "request aborted",
  CERT_HAS_EXPIRED: "TLS certificate problem",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS certificate problem",
  SELF_SIGNED_CERT_IN_CHAIN: "TLS certificate problem",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate problem",
  ERR_TLS_CERT_ALTNAME_INVALID: "TLS certificate problem",
};

/** Syscalls that may be shown (also mirrored in scripts/stdio-bridge.mjs). */
export const FETCH_ERROR_SYSCALLS: readonly string[] = [
  "connect",
  "getaddrinfo",
  "read",
  "write",
];

/** Where a failed fetch stopped, as far as the error chain proves. */
export type FetchFailureKind = "connect-phase" | "unknown-phase";

const MAX_CAUSE_DEPTH = 5;
const MAX_AGGREGATE_MEMBERS = 5;
const MAX_CAUSE_NODES = 12;
const MAX_SUMMARY_LENGTH = 300;
const CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

function prop(node: unknown, key: string): unknown {
  return typeof node === "object" && node !== null
    ? (node as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The error objects to inspect: the cause chain (bounded depth) with
 * AggregateError members (bounded count) in place of the aggregate itself.
 * Without `skipRoot` the thrown error is included.
 */
function causeNodes(error: unknown, skipRoot: boolean): unknown[] {
  const nodes: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH || nodes.length >= MAX_CAUSE_NODES) return;
    if (typeof node !== "object" || node === null) return;
    const members = prop(node, "errors");
    if (Array.isArray(members) && members.length > 0) {
      for (const member of members.slice(0, MAX_AGGREGATE_MEMBERS)) {
        visit(member, depth + 1);
      }
    } else {
      nodes.push(node);
    }
    visit(prop(node, "cause"), depth + 1);
  };
  if (skipRoot && typeof error === "object" && error !== null && prop(error, "cause") !== undefined) {
    visit(prop(error, "cause"), 1);
  } else {
    visit(error, 0);
  }
  return nodes;
}

function describeNode(node: unknown): string | undefined {
  const code = prop(node, "code");
  if (typeof code === "string" && CODE_PATTERN.test(code)) {
    const description = Object.hasOwn(FETCH_ERROR_DESCRIPTIONS, code)
      ? FETCH_ERROR_DESCRIPTIONS[code]
      : "unrecognised network error";
    const syscall = prop(node, "syscall");
    const shown =
      typeof syscall === "string" && FETCH_ERROR_SYSCALLS.includes(syscall)
        ? ` ${syscall}`
        : "";
    return `${code}${shown}: ${description}`;
  }
  const name = prop(node, "name");
  const ctorName = prop(prop(node, "constructor"), "name");
  const label = typeof name === "string" ? name : ctorName;
  return typeof label === "string" && NAME_PATTERN.test(label) ? label : undefined;
}

/**
 * Describe the cause chain of a thrown fetch error as `<code> [<syscall>]:
 * <fixed description>` parts. No text from the error itself is ever included.
 */
export function sanitizeFetchCause(error: unknown): string {
  const parts: string[] = [];
  for (const node of causeNodes(error, true)) {
    const text = describeNode(node);
    if (text !== undefined && parts[parts.length - 1] !== text) parts.push(text);
  }
  const summary = parts.join(" <- ");
  if (summary === "") return "unknown error";
  return summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 3)}...`
    : summary;
}

function isConnectPhaseNode(code: string, syscall: unknown): boolean {
  if (code === "UND_ERR_CONNECT_TIMEOUT") return true;
  if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(code)) {
    return syscall === "connect";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return syscall === "getaddrinfo";
  return false;
}

/**
 * Used only to choose the wording of the error, never to decide on a retry.
 * "connect-phase" requires positive evidence on every error object in the chain
 * that carries a code (AggregateError: every member); anything else, including
 * no code at all, is "unknown-phase".
 */
export function classifyFetchFailure(error: unknown): FetchFailureKind {
  let sawCode = false;
  for (const node of causeNodes(error, false)) {
    const code = prop(node, "code");
    if (code === undefined) continue;
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) return "unknown-phase";
    sawCode = true;
    if (!isConnectPhaseNode(code, prop(node, "syscall"))) return "unknown-phase";
  }
  return sawCode ? "connect-phase" : "unknown-phase";
}

/** True only when repeating the JSON-RPC message cannot change memory. */
export function isReadOnlyJsonRpcMessage(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const rpc = parsed as { method?: unknown; params?: unknown };
  if (typeof rpc.method !== "string") return false;
  if (rpc.method !== "tools/call") return true;
  const name =
    typeof rpc.params === "object" && rpc.params !== null
      ? (rpc.params as { name?: unknown }).name
      : undefined;
  return typeof name === "string" && BRIDGE_RETRY_SAFE_TOOL_NAMES.includes(name);
}

/** True only when repeating the request cannot change memory. */
export function isReadOnlyBridgeRequest(init?: {
  method?: string;
  body?: unknown;
}): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  // The SDK transport sends GET only to open the server-to-client SSE stream
  // and DELETE only to terminate the session; neither carries a JSON-RPC body.
  if (method === "GET" || method === "DELETE") return init?.body == null;
  if (method !== "POST" || typeof init?.body !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return false;
  }
  return isReadOnlyJsonRpcMessage(parsed);
}

export const WRITE_OUTCOME_UNKNOWN_GUIDANCE =
  "the request may or may not have been applied; check the current state " +
  "(for example with memory_read or memory_history) before repeating it";

export interface BridgeNetworkRetryConfig {
  maxRetries: number;
  delaysMs: readonly number[];
  jitterMs: number;
}

export const DEFAULT_BRIDGE_NETWORK_RETRY: BridgeNetworkRetryConfig = {
  maxRetries: 2,
  delaysMs: [150, 500],
  jitterMs: 50,
};

export const BRIDGE_REQUEST_ID_HEADER = "X-Munin-Request-Id";

export class BridgeNetworkError extends Error {
  readonly kind: FetchFailureKind;
  readonly readOnly: boolean;
  readonly requestId: string;
  readonly attempts: number;
  readonly causeSummary: string;

  constructor(opts: {
    kind: FetchFailureKind;
    readOnly: boolean;
    requestId: string;
    attempts: number;
    causeSummary: string;
  }) {
    const attempts = `${opts.attempts} attempt${opts.attempts === 1 ? "" : "s"}`;
    let outcome: string;
    if (opts.readOnly) {
      outcome = `the read-only request was not confirmed after ${attempts}; it is safe to repeat`;
    } else if (opts.kind === "connect-phase") {
      outcome =
        "the connection could not be established, so the request was most likely not applied; " +
        "if in doubt, check the current state (for example with memory_read or memory_history) " +
        "before repeating it";
    } else {
      outcome = WRITE_OUTCOME_UNKNOWN_GUIDANCE;
    }
    super(
      `network error (${opts.causeSummary}); ${outcome} [request id ${opts.requestId}]`,
    );
    this.name = "BridgeNetworkError";
    this.kind = opts.kind;
    this.readOnly = opts.readOnly;
    this.requestId = opts.requestId;
    this.attempts = opts.attempts;
    this.causeSummary = opts.causeSummary;
  }
}

/**
 * Message text for errors reported to the MCP client. Other errors keep their
 * own message (as SDK and HTTP-status errors always did); a cause is appended
 * only as the controlled summary, never as free text.
 */
export function formatBridgeErrorMessage(error: Error): string {
  if (error instanceof BridgeNetworkError || error.cause === undefined) {
    return error.message;
  }
  return `${error.message} (${sanitizeFetchCause(error)})`;
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
  const networkRetry = options.networkRetry ?? DEFAULT_BRIDGE_NETWORK_RETRY;
  const uuid = options.uuid ?? randomUUID;

  return async (input, init) => {
    const requestId = uuid();
    options.onRequestId?.(requestId);
    const headers = new Headers(init?.headers);
    headers.set(BRIDGE_REQUEST_ID_HEADER, requestId);
    const readOnly = isReadOnlyBridgeRequest(init);
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
      let networkRetriesUsed = 0;

      while (true) {
        let response: Response;
        try {
          response = await fetchFn(input, {
            ...init,
            headers,
            signal: controller.signal,
          });
        } catch (err) {
          // Our own timeout (or the caller's abort) is never retried.
          if (controller.signal.aborted) throw err;
          const kind = classifyFetchFailure(err);
          const causeSummary = sanitizeFetchCause(err);
          // Writes are never retried: no network error proves the server did
          // not apply the request.
          const retryable = readOnly;
          const baseDelay =
            networkRetry.delaysMs[
              Math.min(networkRetriesUsed, networkRetry.delaysMs.length - 1)
            ] ?? 0;
          const delayMs =
            baseDelay + Math.floor(Math.max(0, random()) * networkRetry.jitterMs);
          if (
            retryable &&
            networkRetriesUsed < networkRetry.maxRetries &&
            now() - startedAt + delayMs < timeoutMs
          ) {
            networkRetriesUsed += 1;
            retryLog(
              `Network error (${causeSummary}); retry ${networkRetriesUsed}/${networkRetry.maxRetries} in ${delayMs}ms [request id ${requestId}]`,
            );
            await sleep(delayMs, controller.signal);
            continue;
          }
          const failure = new BridgeNetworkError({
            kind,
            readOnly,
            requestId,
            attempts: networkRetriesUsed + 1,
            causeSummary,
          });
          retryLog(`Request failed: ${failure.message}`);
          throw failure;
        }
        if (
          response.status !== 429 ||
          response.headers.get("X-Munin-Rate-Limit") !== "admission-v1"
        ) {
          return response;
        }

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
  /** Id of the most recent forwarded HTTP request (the send queue is sequential). */
  getLastRequestId?: () => string | undefined;
}

export function createBridge(config: BridgeConfig) {
  const {
    stdio,
    createHttpTransport,
    log = (msg: string) =>
      process.stderr.write(`[munin-bridge] ${msg}\n`),
    onExit = (code: number) => process.exit(code),
    getLastRequestId,
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
    // Asynchronous stream (SSE) errors arrive here without any request context:
    // they are only logged, with no outcome guidance or request id.
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

  /**
   * Error text for a failed forward. Failures after the wrapper returned (for
   * example while the response body is read) are not BridgeNetworkErrors, so
   * add the outcome guidance for writes and the request id here.
   */
  function describeSendFailure(error: Error, message: JSONRPCMessage): string {
    let text = `Bridge error: ${formatBridgeErrorMessage(error)}`;
    if (error instanceof BridgeNetworkError) return text;
    if (!isReadOnlyJsonRpcMessage(message)) {
      text += `; ${WRITE_OUTCOME_UNKNOWN_GUIDANCE}`;
    }
    const requestId = getLastRequestId?.();
    if (requestId) text += ` [request id ${requestId}]`;
    return text;
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
                message: describeSendFailure(error, message),
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

  let lastRequestId: string | undefined;
  const fetchWithTimeout = createFetchWithTimeout(requestTimeoutMs, {
    log,
    onRequestId: (id) => {
      lastRequestId = id;
    },
  });

  const bridge = createBridge({
    stdio: new StdioServerTransport() as TransportLike,
    createHttpTransport: () =>
      new StreamableHTTPClientTransport(new URL(REMOTE_URL), {
        requestInit: { headers: authHeaders },
        fetch: fetchWithTimeout,
      }) as TransportLike,
    log,
    onExit: (code) => process.exit(code),
    getLastRequestId: () => lastRequestId,
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
