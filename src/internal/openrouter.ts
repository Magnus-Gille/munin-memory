/**
 * Shared OpenAI-compatible chat-completion client.
 *
 * Used by both the answer-quality eval harness and the consolidation worker
 * (unified in #123). The base URL is configurable via MUNIN_LLM_BASE_URL
 * (default: https://openrouter.ai/api/v1) so either consumer can target a
 * local llama.cpp / Ollama / vLLM server without changing calling code. When a
 * non-default base URL is set, the API key becomes optional (local servers
 * typically need no auth).
 *
 * The default path (no MUNIN_LLM_BASE_URL) is byte-for-byte unchanged from the
 * previous OpenRouter-only implementation.
 */

// --- Types ---

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface OpenRouterCallOptions {
  model: string;
  messages: ChatMessage[];
  /** Bearer token. Pass null or "" to omit the Authorization header (local servers). */
  apiKey?: string | null;
  /** Maximum tokens to generate. Defaults to 4096. */
  maxTokens?: number;
  /** Sampling temperature. Defaults to undefined (model default). Judge passes 0. */
  temperature?: number;
  /** X-Title header value. Defaults to "Munin Memory". */
  title?: string;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// --- Constants ---

const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TITLE = "Munin Memory";
const DEFAULT_HTTP_REFERER = "https://github.com/Magnus-Gille/munin-memory";

export function getLlmHttpReferer(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MUNIN_LLM_HTTP_REFERER?.trim();
  return configured || DEFAULT_HTTP_REFERER;
}

function getHeader(response: Response, name: string): string | null {
  return response.headers?.get(name) ?? null;
}

function summarizeErrorBody(response: Response, text: string): string {
  const contentType = getHeader(response, "content-type") ?? "";
  const trimmed = text.trim();
  const looksHtml =
    contentType.toLowerCase().includes("text/html") ||
    /^<!doctype\s+html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed);

  if (!looksHtml) {
    return trimmed.slice(0, 200);
  }

  const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim();
  return title ? `HTML error page: ${title}` : "HTML error page";
}

// --- Base-URL resolution ---

/**
 * Normalize a raw base-URL value: strip trailing slashes and a trailing
 * `/chat/completions` suffix (so a full-endpoint URL does not double-append).
 * Applied to both the override and the comparison target so the default
 * full-endpoint URL also normalizes to DEFAULT_LLM_BASE_URL.
 */
function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
}

/**
 * Resolve the OpenAI-compatible chat-completions base URL.
 * MUNIN_LLM_BASE_URL overrides the default; trailing slashes and a trailing
 * `/chat/completions` suffix are stripped so the endpoint can be appended
 * uniformly. Accepts an optional env map for testability.
 */
export function getLlmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MUNIN_LLM_BASE_URL;
  const base = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_LLM_BASE_URL;
  return normalizeBaseUrl(base);
}

/**
 * True when a non-default (local) base URL is configured — used to make the
 * API key optional so local inference servers (llama.cpp, Ollama, vLLM) that
 * need no auth can be targeted without supplying a dummy key. Accepts an
 * optional env map for testability.
 */
export function isCustomLlmBaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MUNIN_LLM_BASE_URL;
  if (!raw || raw.trim().length === 0) return false;
  return normalizeBaseUrl(raw.trim()) !== DEFAULT_LLM_BASE_URL;
}

// --- Client ---

/**
 * Call an OpenAI-compatible chat-completion endpoint.
 *
 * Preserves the ZDR (`provider.zdr: true`), HTTP-Referer, and X-Title headers
 * from the consolidation worker's original implementation. Authorization is
 * included only when apiKey is a non-empty string — omitted for local servers.
 */
export async function callOpenRouter(opts: OpenRouterCallOptions): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: opts.messages,
    provider: { zdr: true },
  };
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  // Build headers with Authorization first (when present) to preserve the
  // original request shape: Authorization, Content-Type, HTTP-Referer, X-Title.
  const headers: Record<string, string> = {};
  if (opts.apiKey && opts.apiKey.length > 0) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }
  headers["Content-Type"] = "application/json";
  headers["HTTP-Referer"] = getLlmHttpReferer();
  headers["X-Title"] = opts.title ?? DEFAULT_TITLE;

  const endpoint = `${getLlmBaseUrl()}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const detail = summarizeErrorBody(response, text);
    throw new Error(`LLM API error ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}

/**
 * Read OPENROUTER_API_KEY from the environment.
 * Returns null when the variable is absent or empty.
 */
export function getOpenRouterApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.length > 0 ? key : null;
}

// --- Key health check (#168) ---

export interface KeyHealthResult {
  ok: boolean;
  /** HTTP status of the /auth/key probe, when a response was received. */
  status?: number;
  /** Truncated, secret-free error detail (response body or fetch error). */
  error?: string;
}

/**
 * Verify an OpenRouter API key against the authenticated `/auth/key` endpoint.
 *
 * `/models` returns 200 *unauthenticated*, so a stale/invalid key is masked
 * until the first real completion call fails with `401 {"User not found."}` —
 * silently blocking consolidation (and the eval). `/auth/key` requires a valid
 * bearer token, so a 401 here surfaces the failure loudly and early (#168).
 *
 * Only meaningful against the default OpenRouter host — a custom/local
 * `MUNIN_LLM_BASE_URL` (llama.cpp/Ollama/vLLM) has no such endpoint and no
 * bearer auth, so callers should skip the probe in that case. Never throws:
 * a network error is returned as `{ ok: false, error }`. The returned `error`
 * carries only the response body / fetch message (never the key itself).
 */
export async function checkOpenRouterKey(
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KeyHealthResult> {
  // Defense-in-depth: never let the key surface in the returned detail, even if
  // a proxy reflects the Authorization header into an error body or a low-level
  // fetch error message embeds it. Strip the exact key and `Bearer <key>`.
  const redact = (s: string): string => {
    if (!apiKey) return s;
    return s.split(`Bearer ${apiKey}`).join("Bearer [REDACTED]").split(apiKey).join("[REDACTED]");
  };
  const endpoint = `${getLlmBaseUrl(env)}/auth/key`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": getLlmHttpReferer(env),
        "X-Title": DEFAULT_TITLE,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: redact(text).slice(0, 200) };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, error: redact(err instanceof Error ? err.message : String(err)) };
  }
}
