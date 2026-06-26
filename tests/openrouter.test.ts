/**
 * Unit tests for src/internal/openrouter.ts — base-URL resolution, apiKey
 * optionality, header construction, and body shape.
 *
 * These tests exist to prove the #123 changes (MUNIN_LLM_BASE_URL + optional
 * auth) while keeping the default path byte-for-byte unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callOpenRouter, getLlmBaseUrl, isCustomLlmBaseUrl } from "../src/internal/openrouter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_COMPLETIONS_URL = `${DEFAULT_BASE_URL}/chat/completions`;

/** Build a minimal ok fetch response whose JSON resolves to a valid ChatCompletionResponse. */
function makeOkResponse() {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

let savedBaseUrl: string | undefined;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedBaseUrl = process.env.MUNIN_LLM_BASE_URL;
  savedFetch = globalThis.fetch;
  delete process.env.MUNIN_LLM_BASE_URL;
});

afterEach(() => {
  if (savedBaseUrl === undefined) {
    delete process.env.MUNIN_LLM_BASE_URL;
  } else {
    process.env.MUNIN_LLM_BASE_URL = savedBaseUrl;
  }
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// getLlmBaseUrl — env injection
// ---------------------------------------------------------------------------

describe("getLlmBaseUrl (env injection)", () => {
  it("returns default when env has no MUNIN_LLM_BASE_URL", () => {
    expect(getLlmBaseUrl({})).toBe(DEFAULT_BASE_URL);
  });

  it("returns default when env MUNIN_LLM_BASE_URL is empty string", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "" })).toBe(DEFAULT_BASE_URL);
  });

  it("returns default when env MUNIN_LLM_BASE_URL is whitespace only", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "   " })).toBe(DEFAULT_BASE_URL);
  });

  it("returns custom URL, trimming trailing slashes", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1" })).toBe("http://localhost:1234/v1");
  });

  it("trims trailing slash from custom URL", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1/" })).toBe("http://localhost:1234/v1");
  });

  it("trims multiple trailing slashes from custom URL", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1///" })).toBe("http://localhost:1234/v1");
  });

  // FIX 4: full-endpoint URL normalization
  it("(FIX 4) strips /chat/completions suffix from a full-endpoint custom URL", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1/chat/completions" })).toBe(
      "http://localhost:1234/v1",
    );
  });

  it("(FIX 4) strips /chat/completions suffix + trailing slash", () => {
    expect(getLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1/chat/completions/" })).toBe(
      "http://localhost:1234/v1",
    );
  });
});

// ---------------------------------------------------------------------------
// getLlmBaseUrl — process.env fallback (smoke)
// ---------------------------------------------------------------------------

describe("getLlmBaseUrl (process.env fallback)", () => {
  it("returns default when MUNIN_LLM_BASE_URL is unset in process.env", () => {
    delete process.env.MUNIN_LLM_BASE_URL;
    expect(getLlmBaseUrl()).toBe(DEFAULT_BASE_URL);
  });
});

// ---------------------------------------------------------------------------
// isCustomLlmBaseUrl — env injection
// ---------------------------------------------------------------------------

describe("isCustomLlmBaseUrl (env injection)", () => {
  it("returns false when env has no MUNIN_LLM_BASE_URL", () => {
    expect(isCustomLlmBaseUrl({})).toBe(false);
  });

  it("returns false when env MUNIN_LLM_BASE_URL is empty", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: "" })).toBe(false);
  });

  it("returns false when MUNIN_LLM_BASE_URL equals the default URL", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: DEFAULT_BASE_URL })).toBe(false);
  });

  it("returns false when MUNIN_LLM_BASE_URL equals default with trailing slash", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: `${DEFAULT_BASE_URL}/` })).toBe(false);
  });

  it("returns true when MUNIN_LLM_BASE_URL is a non-default URL", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1" })).toBe(true);
  });

  it("returns true when MUNIN_LLM_BASE_URL is a non-default URL with trailing slash", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1/" })).toBe(true);
  });

  // FIX 4: default full-endpoint URL must NOT be treated as custom
  it("(FIX 4) returns false when MUNIN_LLM_BASE_URL is the default full-endpoint URL", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: `${DEFAULT_BASE_URL}/chat/completions` })).toBe(false);
  });

  // FIX 4: non-default full-endpoint URL IS treated as custom
  it("(FIX 4) returns true when MUNIN_LLM_BASE_URL is a non-default full-endpoint URL", () => {
    expect(isCustomLlmBaseUrl({ MUNIN_LLM_BASE_URL: "http://localhost:1234/v1/chat/completions" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCustomLlmBaseUrl — process.env fallback (smoke)
// ---------------------------------------------------------------------------

describe("isCustomLlmBaseUrl (process.env fallback)", () => {
  it("returns false when MUNIN_LLM_BASE_URL is unset in process.env", () => {
    delete process.env.MUNIN_LLM_BASE_URL;
    expect(isCustomLlmBaseUrl()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — URL routing
// ---------------------------------------------------------------------------

describe("callOpenRouter — URL routing", () => {
  it("uses default completions URL when MUNIN_LLM_BASE_URL is unset", async () => {
    delete process.env.MUNIN_LLM_BASE_URL;
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(DEFAULT_COMPLETIONS_URL);
  });

  it("uses custom URL + /chat/completions when MUNIN_LLM_BASE_URL is set", async () => {
    process.env.MUNIN_LLM_BASE_URL = "http://localhost:1234/v1";
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("trims trailing slash before appending /chat/completions", async () => {
    process.env.MUNIN_LLM_BASE_URL = "http://localhost:1234/v1/";
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/chat/completions");
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — Authorization header
// ---------------------------------------------------------------------------

describe("callOpenRouter — Authorization header", () => {
  it("includes Authorization header when apiKey is a non-empty string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-xxx",
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-xxx");
  });

  it("omits Authorization header when apiKey is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: null,
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(headers, "Authorization")).toBe(false);
  });

  it("omits Authorization header when apiKey is empty string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "",
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(headers, "Authorization")).toBe(false);
  });

  it("always includes Content-Type regardless of apiKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: null,
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("always includes HTTP-Referer regardless of apiKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: null,
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://munin-memory.gille.ai");
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — body shape
// ---------------------------------------------------------------------------

describe("callOpenRouter — body shape", () => {
  it("includes provider:{zdr:true} in body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.provider).toEqual({ zdr: true });
  });

  it("defaults max_tokens to 4096", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(4096);
  });

  it("passes through messages unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const messages = [
      { role: "system" as const, content: "you are helpful" },
      { role: "user" as const, content: "tell me something" },
    ];

    await callOpenRouter({
      model: "test-model",
      messages,
      apiKey: "sk-test",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toEqual(messages);
  });

  it("includes temperature only when opts.temperature is set", async () => {
    const fetchMockNoTemp = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMockNoTemp as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    const bodyNoTemp = JSON.parse(fetchMockNoTemp.mock.calls[0][1].body as string);
    expect(Object.prototype.hasOwnProperty.call(bodyNoTemp, "temperature")).toBe(false);

    // Now with temperature set
    const fetchMockWithTemp = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMockWithTemp as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
      temperature: 0,
    });

    const bodyWithTemp = JSON.parse(fetchMockWithTemp.mock.calls[0][1].body as string);
    expect(bodyWithTemp.temperature).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — header order (FIX 2)
// ---------------------------------------------------------------------------

describe("callOpenRouter — header order (FIX 2)", () => {
  it("Authorization is FIRST key when apiKey is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-xxx",
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const keys = Object.keys(headers);
    expect(keys[0]).toBe("Authorization");
    expect(keys).toEqual(["Authorization", "Content-Type", "HTTP-Referer", "X-Title"]);
  });

  it("Content-Type is FIRST key when no apiKey", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: null,
    });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const keys = Object.keys(headers);
    expect(keys[0]).toBe("Content-Type");
    expect(keys).toEqual(["Content-Type", "HTTP-Referer", "X-Title"]);
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — FIX 4: full-endpoint URL normalization
// ---------------------------------------------------------------------------

describe("callOpenRouter — full-endpoint URL normalization (FIX 4)", () => {
  it("does not double-append /chat/completions when MUNIN_LLM_BASE_URL is already a full endpoint", async () => {
    process.env.MUNIN_LLM_BASE_URL = "http://localhost:1234/v1/chat/completions";
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callOpenRouter({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    // Must end with exactly one /chat/completions, not two
    expect(url.match(/\/chat\/completions/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — error handling
// ---------------------------------------------------------------------------

describe("callOpenRouter — error handling", () => {
  it("throws with 'OpenRouter API error <status>:' message on non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      callOpenRouter({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "sk-test",
      }),
    ).rejects.toThrow("OpenRouter API error 401:");
  });
});
