import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import supertest from "supertest";
import { initDatabase } from "../src/db.js";
import {
  createHttpApp,
  getRequestAuthLogContext,
  type RequestLogEntry,
} from "../src/index.js";

const TEST_DB_PATH = "/tmp/munin-memory-http-transport-test.db";
const LEGACY_API_KEY = "http-transport-test-api-key";
const DPA_API_KEY = "http-transport-test-dpa-api-key";
const CONSUMER_API_KEY = "http-transport-test-consumer-api-key";
const ISSUER_URL = "https://test.example.com";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

function jsonRpcHeaders(token = LEGACY_API_KEY) {
  return {
    Authorization: `Bearer ${token}`,
    Host: "127.0.0.1:3030",
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
}

async function initializeClient(appInstance: ReturnType<typeof createHttpApp>["app"], token = LEGACY_API_KEY) {
  await supertest(appInstance)
    .post("/mcp")
    .set(jsonRpcHeaders(token))
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "http-transport-test",
          version: "1.0.0",
        },
      },
    })
    .expect(200);
}

function parseJsonRpcResponse(body: string): Record<string, unknown> {
  const sseMatch = body.match(/^data: (.+)$/m);
  if (sseMatch) {
    return JSON.parse(sseMatch[1]) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function parseToolContent<T>(body: string): T {
  const payload = parseJsonRpcResponse(body);
  const result = payload.result as Record<string, unknown>;
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text) as T;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let db: Database.Database;
let app: ReturnType<typeof createHttpApp>["app"];
let requestLogs: RequestLogEntry[];

beforeEach(() => {
  process.env.MUNIN_OAUTH_TRUSTED_USER_HEADER = "x-auth-user";
  process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE = "owner@example.com";
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  requestLogs = [];
  ({ app } = createHttpApp({
    database: db,
    apiKey: LEGACY_API_KEY,
    apiKeyDpa: DPA_API_KEY,
    apiKeyConsumer: CONSUMER_API_KEY,
    issuerUrl: ISSUER_URL,
    httpHost: "127.0.0.1",
    httpPort: 3030,
    requestLogger: (entry) => {
      requestLogs.push(entry);
    },
  }));
});

afterEach(() => {
  delete process.env.MUNIN_OAUTH_TRUSTED_USER_HEADER;
  delete process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE;
  db.close();
  cleanupTestDb();
});

describe("stateless HTTP transport", () => {
  it("handles tools/call without an MCP session header", async () => {
    const initializeResponse = await supertest(app)
      .post("/mcp")
      .set(jsonRpcHeaders())
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "http-transport-test",
            version: "1.0.0",
          },
        },
      })
      .expect(200);

    expect(initializeResponse.headers["mcp-session-id"]).toBeUndefined();

    const packageVersion = (await import("../package.json", { with: { type: "json" } })).default.version;
    const initPayload = parseJsonRpcResponse(initializeResponse.text);
    expect((initPayload.result as Record<string, unknown>).serverInfo).toMatchObject({
      name: "munin-memory",
      version: packageVersion,
    });

    const toolResponse = await supertest(app)
      .post("/mcp")
      .set({
        ...jsonRpcHeaders(),
        "mcp-protocol-version": "2025-03-26",
      })
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_list",
          arguments: {},
        },
      })
      .expect(200);

    expect(toolResponse.headers["mcp-session-id"]).toBeUndefined();

    const toolPayload = parseJsonRpcResponse(toolResponse.text);
    const result = toolPayload.result as Record<string, unknown>;
    const content = result.content as Array<{ text: string }>;
    const parsedContent = JSON.parse(content[0].text) as { namespaces: unknown[] };

    expect(Array.isArray(parsedContent.namespaces)).toBe(true);
    expect(requestLogs.at(-1)).toMatchObject({
      method: "POST",
      rpcMethod: "tools/call",
      toolName: "memory_list",
      authType: "bearer",
      clientId: "legacy",
      status: 200,
    });
  });

  it("keeps unauthenticated requests rejected", async () => {
    await supertest(app)
      .post("/mcp")
      .set({
        Host: "127.0.0.1:3030",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      })
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "http-transport-test",
            version: "1.0.0",
          },
        },
      })
      .expect(401);
  });

  it("returns 405 for GET and DELETE on /mcp", async () => {
    const headers = {
      Authorization: `Bearer ${LEGACY_API_KEY}`,
      Host: "127.0.0.1:3030",
    };

    const getResponse = await supertest(app)
      .get("/mcp")
      .set(headers)
      .expect(405);

    expect(getResponse.headers.allow).toBe("POST");
    expect(getResponse.body).toEqual({ error: "Method not allowed" });

    const deleteResponse = await supertest(app)
      .delete("/mcp")
      .set(headers)
      .expect(405);

    expect(deleteResponse.headers.allow).toBe("POST");
    expect(deleteResponse.body).toEqual({ error: "Method not allowed" });
    expect(requestLogs).toEqual([
      expect.objectContaining({
        method: "GET",
        authType: "bearer",
        clientId: "legacy",
        status: 405,
      }),
      expect.objectContaining({
        method: "DELETE",
        authType: "bearer",
        clientId: "legacy",
        status: 405,
      }),
    ]);
  });

  it("attaches diagnostics (redacted headers + body snippet) to 4xx /mcp logs", async () => {
    const response = await supertest(app)
      .post("/mcp")
      .set({
        Authorization: `Bearer ${LEGACY_API_KEY}`,
        Host: "127.0.0.1:3030",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "mcp-protocol-version": "2099-01-01",
        Cookie: "session=supersecret",
      })
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_list", arguments: {} },
      });

    expect(response.status).toBe(400);

    const entry = requestLogs.at(-1);
    expect(entry?.status).toBe(400);
    expect(entry?.path).toBe("/mcp");
    expect(entry?.diagnostics).toBeDefined();
    expect(entry?.diagnostics?.headers.authorization).toBe("[REDACTED]");
    expect(entry?.diagnostics?.headers.cookie).toBe("[REDACTED]");
    expect(entry?.diagnostics?.headers["mcp-protocol-version"]).toBe("2099-01-01");
    expect(entry?.diagnostics?.bodySnippet).toContain("tools/call");
  });

  it("omits diagnostics on 2xx /mcp logs", async () => {
    await supertest(app)
      .post("/mcp")
      .set(jsonRpcHeaders())
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_list", arguments: {} },
      })
      .expect(200);

    expect(requestLogs.at(-1)?.diagnostics).toBeUndefined();
  });
});

describe("request log attribution", () => {
  it("maps OAuth and legacy bearer auth to log fields", () => {
    expect(getRequestAuthLogContext(undefined)).toEqual({
      authType: "none",
    });

    expect(getRequestAuthLogContext({
      token: "legacy-token",
      clientId: "legacy-bearer",
      scopes: [],
      expiresAt: 1,
    })).toEqual({
      authType: "bearer",
      clientId: "legacy",
    });

    expect(getRequestAuthLogContext({
      token: "oauth-token",
      clientId: "oauth-client-id",
      scopes: ["mcp:tools"],
      expiresAt: 1,
    })).toEqual({
      authType: "oauth",
      clientId: "oauth-client-id",
    });
  });
});

describe("transport-aware HTTP access context", () => {
  it("maps DPA bearer credentials into status metadata", async () => {
    await initializeClient(app, DPA_API_KEY);

    const toolResponse = await supertest(app)
      .post("/mcp")
      .set({
        ...jsonRpcHeaders(DPA_API_KEY),
        "mcp-protocol-version": "2025-03-26",
      })
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_status",
          arguments: {},
        },
      })
      .expect(200);

    const toolPayload = parseJsonRpcResponse(toolResponse.text);
    const result = toolPayload.result as Record<string, unknown>;
    const content = result.content as Array<{ text: string }>;
    const parsedContent = JSON.parse(content[0].text) as {
      librarian: { transport_type: string; max_classification: string };
    };

    expect(parsedContent.librarian.transport_type).toBe("dpa_covered");
    expect(parsedContent.librarian.max_classification).toBe("client-confidential");
  });

  it("maps consumer bearer credentials into status metadata", async () => {
    await initializeClient(app, CONSUMER_API_KEY);

    const toolResponse = await supertest(app)
      .post("/mcp")
      .set({
        ...jsonRpcHeaders(CONSUMER_API_KEY),
        "mcp-protocol-version": "2025-03-26",
      })
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_status",
          arguments: {},
        },
      })
      .expect(200);

    const toolPayload = parseJsonRpcResponse(toolResponse.text);
    const result = toolPayload.result as Record<string, unknown>;
    const content = result.content as Array<{ text: string }>;
    const parsedContent = JSON.parse(content[0].text) as {
      librarian: { transport_type: string; max_classification: string };
    };

    expect(parsedContent.librarian.transport_type).toBe("consumer");
    expect(parsedContent.librarian.max_classification).toBe("internal");
  });

  it("uses createHttpApp credential options instead of ambient env when computing owner warnings", async () => {
    const originalEnabled = process.env.MUNIN_LIBRARIAN_ENABLED;
    const originalLegacy = process.env.MUNIN_API_KEY;
    const originalDpa = process.env.MUNIN_API_KEY_DPA;
    const originalConsumer = process.env.MUNIN_API_KEY_CONSUMER;

    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    delete process.env.MUNIN_API_KEY;
    delete process.env.MUNIN_API_KEY_DPA;
    delete process.env.MUNIN_API_KEY_CONSUMER;

    try {
      const freshLogs: RequestLogEntry[] = [];
      const { app: optionBackedApp } = createHttpApp({
        database: db,
        apiKey: LEGACY_API_KEY,
        apiKeyDpa: DPA_API_KEY,
        apiKeyConsumer: CONSUMER_API_KEY,
        issuerUrl: ISSUER_URL,
        httpHost: "127.0.0.1",
        httpPort: 3030,
        requestLogger: (entry) => {
          freshLogs.push(entry);
        },
      });

      await initializeClient(optionBackedApp, LEGACY_API_KEY);

      const toolResponse = await supertest(optionBackedApp)
        .post("/mcp")
        .set({
          ...jsonRpcHeaders(LEGACY_API_KEY),
          "mcp-protocol-version": "2025-03-26",
        })
        .send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "memory_status",
            arguments: {},
          },
        })
        .expect(200);

      const toolPayload = parseJsonRpcResponse(toolResponse.text);
      const result = toolPayload.result as Record<string, unknown>;
      const content = result.content as Array<{ text: string }>;
      const parsedContent = JSON.parse(content[0].text) as {
        librarian: { config_warnings?: string[] };
      };

      expect(parsedContent.librarian.config_warnings).toBeUndefined();
      expect(freshLogs.at(-1)?.toolName).toBe("memory_status");
    } finally {
      if (originalEnabled === undefined) {
        delete process.env.MUNIN_LIBRARIAN_ENABLED;
      } else {
        process.env.MUNIN_LIBRARIAN_ENABLED = originalEnabled;
      }
      if (originalLegacy === undefined) {
        delete process.env.MUNIN_API_KEY;
      } else {
        process.env.MUNIN_API_KEY = originalLegacy;
      }
      if (originalDpa === undefined) {
        delete process.env.MUNIN_API_KEY_DPA;
      } else {
        process.env.MUNIN_API_KEY_DPA = originalDpa;
      }
      if (originalConsumer === undefined) {
        delete process.env.MUNIN_API_KEY_CONSUMER;
      } else {
        process.env.MUNIN_API_KEY_CONSUMER = originalConsumer;
      }
    }
  });
});

describe("HTTP tenant service-token attribution", () => {
  it("attributes bearer-token writes and history rows to the resolved principal", async () => {
    const tenantToken = "codex-cli-test-service-token";
    // DPA-covered transport gives this remote agent the same classification
    // ceiling a dedicated DPA bearer would have; attribution still comes from
    // the token_hash -> principal_id mapping.
    db.prepare(
      `INSERT INTO principals
       (id, principal_id, principal_type, token_hash, namespace_rules, transport_type, created_at)
       VALUES (?, ?, 'agent', ?, ?, 'dpa_covered', ?)`,
    ).run(
      randomUUID(),
      "codex-cli",
      hashToken(tenantToken),
      JSON.stringify([
        { pattern: "traces/codex-tenant", permissions: "rw" },
        { pattern: "traces/codex-tenant/*", permissions: "rw" },
      ]),
      new Date().toISOString(),
    );

    await initializeClient(app, tenantToken);

    const writeResponse = await supertest(app)
      .post("/mcp")
      .set({
        ...jsonRpcHeaders(tenantToken),
        "mcp-protocol-version": "2025-03-26",
      })
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_write",
          arguments: {
            namespace: "traces/codex-tenant",
            key: "run-2026-07-04",
            content: "tenant write attribution regression",
            tags: ["tenant-validation"],
          },
        },
      })
      .expect(200);

    const writePayload = parseToolContent<{
      ok: boolean;
      status: string;
      provenance: { principal_id: string; owner_principal_id: string };
    }>(writeResponse.text);
    expect(writePayload.ok).toBe(true);
    expect(writePayload.status).toBe("created");
    expect(writePayload.provenance).toEqual({
      principal_id: "codex-cli",
      owner_principal_id: "codex-cli",
    });

    const stored = db
      .prepare("SELECT agent_id, owner_principal_id FROM entries WHERE namespace = ? AND key = ?")
      .get("traces/codex-tenant", "run-2026-07-04") as
      | { agent_id: string; owner_principal_id: string | null }
      | undefined;
    expect(stored).toEqual({
      agent_id: "codex-cli",
      owner_principal_id: "codex-cli",
    });

    const historyResponse = await supertest(app)
      .post("/mcp")
      .set({
        ...jsonRpcHeaders(tenantToken),
        "mcp-protocol-version": "2025-03-26",
      })
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_history",
          arguments: {
            namespace: "traces/codex-tenant",
            limit: 5,
          },
        },
      })
      .expect(200);

    const historyPayload = parseToolContent<{
      ok: boolean;
      count: number;
      entries: Array<{
        agent_id: string;
        provenance: { principal_id: string };
      }>;
    }>(historyResponse.text);
    expect(historyPayload.ok).toBe(true);
    expect(historyPayload.count).toBeGreaterThan(0);
    expect(historyPayload.entries[0]).toMatchObject({
      agent_id: "codex-cli",
      provenance: { principal_id: "codex-cli" },
    });
    expect(requestLogs.at(-1)).toMatchObject({
      authType: "bearer",
      clientId: "principal:codex-cli",
      toolName: "memory_history",
      status: 200,
    });
  });
});
