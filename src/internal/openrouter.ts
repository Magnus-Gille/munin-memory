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
const HTTP_REFERER = "https://munin-memory.gille.ai";

// --- Base-URL resolution ---

/**
 * Resolve the OpenAI-compatible chat-completions base URL.
 * MUNIN_LLM_BASE_URL overrides the default; trailing slashes are trimmed.
 */
export function getLlmBaseUrl(): string {
  const raw = process.env.MUNIN_LLM_BASE_URL;
  const base = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_LLM_BASE_URL;
  return base.replace(/\/+$/, "");
}

/**
 * True when a non-default (local) base URL is configured — used to make the
 * API key optional so local inference servers (llama.cpp, Ollama, vLLM) that
 * need no auth can be targeted without supplying a dummy key.
 */
export function isCustomLlmBaseUrl(): boolean {
  const raw = process.env.MUNIN_LLM_BASE_URL;
  return !!(raw && raw.trim().length > 0 && raw.trim().replace(/\/+$/, "") !== DEFAULT_LLM_BASE_URL);
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": HTTP_REFERER,
    "X-Title": opts.title ?? DEFAULT_TITLE,
  };
  if (opts.apiKey && opts.apiKey.length > 0) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const endpoint = `${getLlmBaseUrl()}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter API error ${response.status}: ${text.slice(0, 200)}`);
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
