import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  createFetchWithTimeout,
  createBridge,
  type TransportLike,
} from "../src/bridge.js";
import { createHttpApp } from "../src/index.js";
import { initDatabase } from "../src/db.js";
import { createTestStorage } from "./helpers/test-storage.js";

const API_KEY = "write-recovery-http-api-key";
const WRITE_REPLAY_HEADER = "X-Munin-Write-Replay";
const WRITE_TOOLS = new Set(["memory_write", "memory_update_status", "memory_log"]);

type WriteTool = "memory_write" | "memory_update_status" | "memory_log";
type FailureMode = "before-delivery" | "after-commit";

interface FakeStdio {
  transport: TransportLike;
  sent: JSONRPCMessage[];
}

interface RunningHttp {
  db: Database.Database;
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function fakeStdio(): FakeStdio {
  const sent: JSONRPCMessage[] = [];
  return {
    sent,
    transport: {
      start: async () => {},
      send: async (message) => {
        sent.push(message);
      },
      close: async () => {},
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
    },
  };
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startHttp(): Promise<RunningHttp> {
  const port = await reservePort();
  const storage = createTestStorage("write-recovery-http-case");
  const db = initDatabase(storage.path);
  const { app } = createHttpApp({
    database: db,
    apiKey: API_KEY,
    issuerUrl: `http://127.0.0.1:${port}`,
    httpHost: "127.0.0.1",
    httpPort: port,
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  return {
    db,
    server,
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
      storage.cleanup();
    },
  };
}

async function waitForRpcResponse(sent: JSONRPCMessage[], id: number): Promise<JSONRPCMessage> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = sent.find((message) => "id" in message && message.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${id}`);
}

function toolResponse(message: JSONRPCMessage): Record<string, unknown> {
  if (!("result" in message)) throw new Error(`Expected result response: ${JSON.stringify(message)}`);
  const result = message.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function errorResponse(message: JSONRPCMessage): { code: number; message: string } {
  if (!("error" in message)) throw new Error(`Expected error response: ${JSON.stringify(message)}`);
  return message.error as { code: number; message: string };
}

function argsFor(tool: WriteTool): Record<string, unknown> {
  switch (tool) {
    case "memory_write":
      return {
        namespace: "projects/write-recovery-http",
        key: "state",
        content: "A write whose response was lost.",
        tags: ["active"],
      };
    case "memory_update_status":
      return {
        namespace: "projects/write-recovery-http",
        phase: "Implementation",
        current_work: "Recovering a lost write response.",
        blockers: "None.",
        next_steps: ["Verify the recovered metadata."],
        lifecycle: "active",
      };
    case "memory_log":
      return {
        namespace: "projects/write-recovery-http",
        content: "A decision whose response was lost.",
        tags: ["decision"],
      };
  }
}

function rpcCall(id: number, tool: WriteTool, args: Record<string, unknown>): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args },
  } as JSONRPCMessage;
}

async function runRecoveryScenario(tool: WriteTool, mode: FailureMode, omitReplayHeader = false): Promise<void> {
  const http = await startHttp();
  const stdio = fakeStdio();
  let supportsReplay = false;
  let firstWriteUuid: string | undefined;
  let writeAttempts = 0;
  let initializeContentType: string | null = null;
  let initializeReplayHeader: string | null = null;
  let committedResponse: Record<string, unknown> | undefined;
  const writeRequestArguments: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  const fetchFn: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const method = body?.method;
    const toolName = method === "tools/call"
      ? ((body?.params as { name?: unknown } | undefined)?.name)
      : undefined;
    const isWrite = Boolean(toolName && WRITE_TOOLS.has(String(toolName)));
    const isFirstWrite = isWrite && writeAttempts === 0;
    if (isWrite) {
      writeAttempts += 1;
      if (isFirstWrite) {
        const arguments_ = (body?.params as { arguments?: Record<string, unknown> } | undefined)?.arguments;
        writeRequestArguments.push({ ...(arguments_ ?? {}) });
        firstWriteUuid = arguments_?.idempotency_key as string | undefined;
        if (mode === "before-delivery") {
          throw new TypeError("simulated connection failure before delivery");
        }
      }
      if (!isFirstWrite) {
        const arguments_ = (body?.params as { arguments?: Record<string, unknown> } | undefined)?.arguments;
        writeRequestArguments.push({ ...(arguments_ ?? {}) });
      }
    }
    const response = await realFetch(input, init);

    if (method === "initialize") {
      initializeContentType = response.headers.get("content-type");
      initializeReplayHeader = response.headers.get(WRITE_REPLAY_HEADER);
    }
    if (isFirstWrite && mode === "after-commit") {
      const text = await response.text();
      const payload = JSON.parse(text) as { result: { content: Array<{ text: string }> } };
      committedResponse = JSON.parse(payload.result.content[0].text) as Record<string, unknown>;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("simulated response stream failure after commit"));
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(omitReplayHeader ? {} : { [WRITE_REPLAY_HEADER]: "v1" }),
          },
        },
      );
    }
    return response;
  };

  const fetchWithTimeout = createFetchWithTimeout(5_000, {
    fetchFn,
    onWriteReplaySupport: (supported: boolean) => {
      supportsReplay = supported;
    },
  });
  const bridge = createBridge({
    stdio: stdio.transport,
    supportsWriteReplay: () => supportsReplay,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    createHttpTransport: () => new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
      fetch: fetchWithTimeout,
    }) as TransportLike,
    log: () => {},
    onExit: () => {},
  });

  try {
    await bridge.start();
    stdio.transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "write-recovery-http-test", version: "1.0.0" },
      },
    });
    const initializeResponse = await waitForRpcResponse(stdio.sent, 1);
    expect("result" in initializeResponse).toBe(true);
    expect(initializeContentType).toContain("application/json");
    expect(initializeReplayHeader).toBe("v1");
    expect(supportsReplay).toBe(true);

    const originalArgs = argsFor(tool);
    stdio.transport.onmessage?.(rpcCall(2, tool, originalArgs));
    const firstResponse = await waitForRpcResponse(stdio.sent, 2);
    const firstError = errorResponse(firstResponse);
    expect(firstError.code).toBe(-32000);
    expect(firstWriteUuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(firstError.message).toContain(firstWriteUuid);
    if (omitReplayHeader) expect(firstError.message).toContain("support was not confirmed");
    expect(writeAttempts).toBe(1);

    if (mode === "before-delivery") {
      expect(http.db.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
    } else {
      expect(committedResponse).toBeDefined();
      expect(http.db.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 1 });
    }

    stdio.transport.onmessage?.(rpcCall(3, tool, {
      ...originalArgs,
      idempotency_key: firstWriteUuid,
    }));
    const replayResponse = await waitForRpcResponse(stdio.sent, 3);
    const replay = toolResponse(replayResponse);
    expect(replay.ok).toBe(true);
    expect(replay.idempotency_replayed).toBe(mode === "after-commit");
    expect(replay.status).toBeDefined();
    expect(replay.id ?? replay.timestamp).toBeDefined();
    if (committedResponse) {
      expect(replay).toMatchObject({
        id: committedResponse.id,
        status: committedResponse.status,
        ...(committedResponse.timestamp ? { timestamp: committedResponse.timestamp } : { updated_at: committedResponse.updated_at }),
      });
    }
    expect(writeAttempts).toBe(2);
    expect(writeRequestArguments).toHaveLength(2);
    expect(writeRequestArguments.map((arguments_) => arguments_.idempotency_key)).toEqual([
      firstWriteUuid,
      firstWriteUuid,
    ]);
    expect(http.db.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 1 });
    expect(http.db.prepare("SELECT COUNT(*) AS count FROM audit_log").get()).toEqual({ count: 1 });
  } finally {
    await bridge.cleanup();
    await http.close();
  }
}

describe("HTTP write recovery", () => {
  beforeEach(() => {
    vi.stubEnv("MUNIN_OAUTH_TRUSTED_USER_HEADER", "x-auth-user");
    vi.stubEnv("MUNIN_OAUTH_TRUSTED_USER_VALUE", "owner@example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not replay memory_write after a before-delivery failure", async () => {
    await runRecoveryScenario("memory_write", "before-delivery");
  });

  it("retains an injected key when capability disappears on an unreadable response", async () => {
    await runRecoveryScenario("memory_log", "after-commit", true);
  });

  it("does not advertise write recovery to an unauthenticated caller", async () => {
    const http = await startHttp();
    try {
      const response = await fetch(http.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer definitely-not-valid",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "write-recovery-http-test", version: "1.0.0" },
          },
        }),
      });
      await response.text();
      expect(response.status).toBe(401);
      expect(response.headers.get(WRITE_REPLAY_HEADER)).toBeNull();
    } finally {
      await http.close();
    }
  });

  it.each(["memory_write", "memory_update_status", "memory_log"] as WriteTool[])(
    "%s returns the committed metadata after a response-stream failure",
    async (tool) => {
      await runRecoveryScenario(tool, "after-commit");
    },
  );
});
