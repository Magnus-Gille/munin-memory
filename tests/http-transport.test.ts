import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
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
const ISSUER_URL = "https://test.example.com";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

function jsonRpcHeaders() {
  return {
    Authorization: `Bearer ${LEGACY_API_KEY}`,
    Host: "127.0.0.1:3030",
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
}

function parseJsonRpcResponse(body: string): Record<string, unknown> {
  const sseMatch = body.match(/^data: (.+)$/m);
  if (sseMatch) {
    return JSON.parse(sseMatch[1]) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

let db: Database.Database;
let app: ReturnType<typeof createHttpApp>["app"];
let requestLogs: RequestLogEntry[];

beforeEach(() => {
  process.env.MUNIN_OAUTH_TRUSTED_USER_HEADER = "x-auth-user";
  process.env.MUNIN_OAUTH_TRUSTED_USER_VALUE = "magnus@example.com";
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  requestLogs = [];
  ({ app } = createHttpApp({
    database: db,
    apiKey: LEGACY_API_KEY,
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

    const initPayload = parseJsonRpcResponse(initializeResponse.text);
    expect((initPayload.result as Record<string, unknown>).serverInfo).toMatchObject({
      name: "munin-memory",
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
