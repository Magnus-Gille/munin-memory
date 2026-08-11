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
import { MCP_SERVER_INSTRUCTIONS } from "../src/tools.js";

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
  return supertest(appInstance)
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

async function callHttpTool(
  token: string,
  id: number,
  name: string,
  arguments_: Record<string, unknown>,
  runHandle?: string,
) {
  const headers: Record<string, string> = {
    ...jsonRpcHeaders(token),
    "mcp-protocol-version": "2025-03-26",
  };
  if (runHandle !== undefined) headers["mcp-session-id"] = runHandle;
  return supertest(app)
    .post("/mcp")
    .set(headers)
    .send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    })
    .expect(200);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function insertOAuthRunToken(token: string, clientId: string, principalId = "owner"): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO oauth_clients (client_id, created_at, updated_at)
     VALUES (?, ?, ?)`,
  ).run(clientId, now, now);
  db.prepare(
    `INSERT INTO oauth_tokens
     (token, token_type, client_id, scopes, expires_at, created_at, principal_id)
     VALUES (?, 'access', ?, '[]', ?, ?, ?)`,
  ).run(hashToken(token), clientId, Math.floor(Date.now() / 1000) + 3600, now, principalId);
}

function insertOAuthPrincipal(principalId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO principals
     (id, principal_id, principal_type, namespace_rules, created_at)
     VALUES (?, ?, 'family', ?, ?)`,
  ).run(
    randomUUID(),
    principalId,
    JSON.stringify([{ pattern: "*", permissions: "rw" }]),
    now,
  );
}

function flipHexCharacter(value: string): string {
  const last = value.at(-1);
  if (!last) throw new Error("Cannot tamper with an empty hexadecimal value");
  return `${value.slice(0, -1)}${last === "0" ? "1" : "0"}`;
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
    expect((initPayload.result as Record<string, unknown>).instructions).toBe(MCP_SERVER_INSTRUCTIONS);

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

    const durableResponse = await supertest(app)
      .post("/mcp")
      .set({
        ...jsonRpcHeaders(),
        "mcp-protocol-version": "2025-03-26",
      })
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_extract",
          arguments: {
            conversation_text: "We decided this stateless request must not capture durable memory.",
            namespace_hint: "projects/http-stateless",
            persist: true,
          },
        },
      })
      .expect(200);
    expect(parseToolContent<Record<string, unknown>>(durableResponse.text)).toMatchObject({
      error: "session_required",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_proposals").get())
      .toEqual({ count: 0 });

    expect(requestLogs.at(-1)).toMatchObject({
      method: "POST",
      rpcMethod: "tools/call",
      toolName: "memory_extract",
      authType: "bearer",
      clientId: "legacy",
      status: 200,
    });
  });

  it("isolates same-credential review runs with server-issued MCP handles", async () => {
    const token = "oauth-run-token-shared";
    insertOAuthRunToken(token, "http-review-client-shared");

    const extract = async (id: number, namespace: string, runHandle?: string) =>
      callHttpTool(token, id, "memory_extract", {
        conversation_text: `We decided to preserve durable HTTP review isolation for ${namespace}.`,
        namespace_hint: namespace,
        persist: true,
      }, runHandle);

    const initializeResponseA = await initializeClient(app, token);
    const initializeResponseB = await initializeClient(app, token);
    const handleA = initializeResponseA.headers["mcp-session-id"];
    const handleB = initializeResponseB.headers["mcp-session-id"];
    expect(handleA).toMatch(/^munin-run-v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(handleB).toMatch(/^munin-run-v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(handleB).not.toBe(handleA);

    const responseA = await extract(3, "projects/http-review-a", handleA);
    const responseB = await extract(4, "projects/http-review-b", handleB);
    const proposalA = parseToolContent<{ proposals: Array<{ id: string }> }>(responseA.text).proposals[0].id;
    const proposalB = parseToolContent<{ proposals: Array<{ id: string }> }>(responseB.text).proposals[0].id;
    const list = async (id: number, runHandle: string) => parseToolContent<{
      proposals: Array<{ id: string }>;
    }>((await callHttpTool(token, id, "memory_review", { action: "list" }, runHandle)).text);

    expect((await list(5, handleA)).proposals.map((proposal) => proposal.id)).toEqual([proposalA]);
    expect((await list(6, handleB)).proposals.map((proposal) => proposal.id)).toEqual([proposalB]);

    const invalidHandleResponse = await extract(7, "projects/http-review-invalid", "caller-chosen-shared-session");
    expect(parseToolContent<Record<string, unknown>>(invalidHandleResponse.text)).toMatchObject({
      error: "session_required",
    });
    expect(invalidHandleResponse.headers["mcp-session-id"]).toBeUndefined();
  });

  it("rejects a review handle replayed with a different credential for the same principal", async () => {
    const tokenA = "oauth-run-token-owner-a";
    const tokenB = "oauth-run-token-owner-b";
    insertOAuthRunToken(tokenA, "http-review-client-owner-a");
    insertOAuthRunToken(tokenB, "http-review-client-owner-b");

    const initializeResponse = await initializeClient(app, tokenA);
    const handle = initializeResponse.headers["mcp-session-id"];
    expect(handle).toMatch(/^munin-run-v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/);

    const replayResponse = await callHttpTool(tokenB, 2, "memory_extract", {
      conversation_text: "This replay must not create a proposal under the other owner credential.",
      namespace_hint: "projects/http-review-replay",
      persist: true,
    }, handle);

    expect(parseToolContent<Record<string, unknown>>(replayResponse.text)).toMatchObject({
      error: "session_required",
    });
    expect(replayResponse.headers["mcp-session-id"]).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_proposals").get())
      .toEqual({ count: 0 });
  });

  it("rejects a review handle replayed by a different principal", async () => {
    const ownerToken = "oauth-run-token-owner-principal";
    const otherPrincipal = "http-review-peer";
    const otherToken = "oauth-run-token-other-principal";
    insertOAuthRunToken(ownerToken, "http-review-client-owner-principal");
    insertOAuthPrincipal(otherPrincipal);
    insertOAuthRunToken(otherToken, "http-review-client-other-principal", otherPrincipal);

    const initializeResponse = await initializeClient(app, ownerToken);
    const handle = initializeResponse.headers["mcp-session-id"];
    expect(handle).toBeDefined();

    const replayResponse = await callHttpTool(otherToken, 2, "memory_extract", {
      conversation_text: "This replay must not create a proposal for a different principal.",
      namespace_hint: "projects/http-review-principal-replay",
      persist: true,
    }, handle);

    expect(parseToolContent<Record<string, unknown>>(replayResponse.text)).toMatchObject({
      error: "session_required",
    });
    expect(replayResponse.headers["mcp-session-id"]).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_proposals").get())
      .toEqual({ count: 0 });
  });

  it.each([
    ["run ID", (prefix: string, runId: string, signature: string) =>
      `${prefix}.${flipHexCharacter(runId)}.${signature}`],
    ["signature", (prefix: string, runId: string, signature: string) =>
      `${prefix}.${runId}.${flipHexCharacter(signature)}`],
  ] as const)("rejects a handle with a tampered %s", async (_label, tamper) => {
    const token = "oauth-run-token-tampered-handle";
    insertOAuthRunToken(token, "http-review-client-tampered-handle");

    const initializeResponse = await initializeClient(app, token);
    const handle = initializeResponse.headers["mcp-session-id"] as string;
    const [prefix, runId, signature] = handle.split(".");
    const tamperedHandle = tamper(prefix, runId, signature);

    const replayResponse = await callHttpTool(token, 2, "memory_extract", {
      conversation_text: "This tampered handle must not create a proposal.",
      namespace_hint: "projects/http-review-tampered",
      persist: true,
    }, tamperedHandle);

    expect(parseToolContent<Record<string, unknown>>(replayResponse.text)).toMatchObject({
      error: "session_required",
    });
    expect(replayResponse.headers["mcp-session-id"]).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_proposals").get())
      .toEqual({ count: 0 });
  });

  it("keeps cross-run undo authorization same-principal and explicit", async () => {
    const token = "oauth-undo-run-token";
    insertOAuthRunToken(token, "http-undo-client");

    const sourceResponse = await callHttpTool(token, 1, "memory_extract", {
      conversation_text: "We decided to preserve the HTTP cross-run undo boundary.",
      namespace_hint: "projects/http-undo",
      persist: true,
    });
    const sourceHandle = sourceResponse.headers["mcp-session-id"];
    expect(sourceHandle).toBeDefined();
    const sourceId = parseToolContent<{ proposals: Array<{ id: string }> }>(sourceResponse.text).proposals[0].id;
    expect(parseToolContent<Record<string, unknown>>(
      (await callHttpTool(token, 2, "memory_review", {
        action: "approve",
        proposal_id: sourceId,
      }, sourceHandle)).text,
    )).toMatchObject({ status: "approved" });

    const runBResponse = await callHttpTool(token, 3, "memory_review", { action: "list" });
    const runBHandle = runBResponse.headers["mcp-session-id"];
    expect(runBHandle).toBeDefined();
    const undo = parseToolContent<{ undo_proposal_id: string; status: string }>(
      (await callHttpTool(token, 4, "memory_review", {
        action: "prepare_undo",
        scope: "principal",
        proposal_id: sourceId,
        reason: "explicit cross-run undo preparation",
      }, runBHandle)).text,
    );
    expect(undo.status).toBe("pending");

    expect(parseToolContent<Record<string, unknown>>(
      (await callHttpTool(token, 5, "memory_review", {
        action: "get",
        proposal_id: undo.undo_proposal_id,
      }, sourceHandle)).text,
    )).toMatchObject({ error: "not_found", code: "not_found" });
    expect(parseToolContent<Record<string, unknown>>(
      (await callHttpTool(token, 6, "memory_review", {
        action: "approve",
        proposal_id: undo.undo_proposal_id,
      }, runBHandle)).text,
    )).toMatchObject({ status: "approved" });
    expect(db.prepare("SELECT status FROM review_proposals WHERE id = ?").get(sourceId))
      .toEqual({ status: "superseded" });
  });

  it("persists retrieval analytics without a caller MCP session header", async () => {
    await supertest(app)
      .post("/mcp")
      .set({ ...jsonRpcHeaders(), "mcp-protocol-version": "2025-03-26" })
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_write",
          arguments: {
            namespace: "projects/http-analytics",
            key: "retrieval-event",
            content: "analytics persistence regression",
          },
        },
      })
      .expect(200);

    await supertest(app)
      .post("/mcp")
      .set({ ...jsonRpcHeaders(), "mcp-protocol-version": "2025-03-26" })
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_query",
          arguments: {
            query: "analytics persistence regression",
            namespace: "projects/http-analytics",
            search_mode: "lexical",
          },
        },
      })
      .expect(200);

    const event = db.prepare(
      `SELECT session_id, tool_name
       FROM retrieval_events
       ORDER BY timestamp DESC
       LIMIT 1`,
    ).get() as { session_id: string; tool_name: string } | undefined;
    expect(event?.tool_name).toBe("memory_query");
    expect(event?.session_id).toMatch(/^[0-9a-f]{32}$/);
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
