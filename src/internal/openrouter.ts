/**
 * Shared OpenRouter client for Munin sub-systems that need to call the
 * OpenRouter chat-completion API (consolidation worker, answer-quality eval).
 *
 * The consolidation worker previously had an inline `callOpenRouter` that
 * was user-message-only.  This module lifts it to a two-role (system+user)
 * shape while preserving all the same defaults (ZDR, headers, model param).
 */

// --- Types ---

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface OpenRouterCallOptions {
  model: string;
  messages: ChatMessage[];
  apiKey: string;
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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TITLE = "Munin Memory";
const HTTP_REFERER = "https://munin-memory.gille.ai";

// --- Client ---

/**
 * Call the OpenRouter chat-completion API with a two-role message list.
 *
 * Preserves the ZDR (`provider.zdr: true`), HTTP-Referer, and X-Title headers
 * from the consolidation worker's original implementation.
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

  const response = await fetch(OPENROUTER_BASE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": HTTP_REFERER,
      "X-Title": opts.title ?? DEFAULT_TITLE,
    },
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
