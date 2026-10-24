/**
 * Regression test for #411: concurrent POST /authorize requests must each bind
 * their own resolved identity to their own pending authorization.
 *
 * The SDK's /authorize handler parses the body asynchronously, so identity must
 * travel with the request (res.locals), never through shared provider state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { runMigrations } from "../src/migrations.js";
import { createHttpApp } from "../src/index.js";
import type { MuninOAuthProvider } from "../src/oauth.js";

const API_KEY = "consent-concurrency-test-api-key";
const ISSUER_URL = "https://munin.example.com";
const HTTP_PORT = 3031;
const CLIENT_ID = "client-1";
const REDIRECT_URI = "http://localhost:3000/cb";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertFamilyPrincipal(db: Database.Database, principalId: string): void {
  const email = `${principalId}@example.com`;
  db.prepare(
    `INSERT INTO principals
       (id, principal_id, principal_type, namespace_rules, created_at, email, email_lower)
     VALUES (?, ?, 'family', '[]', datetime('now'), ?, ?)`,
  ).run(randomUUID(), principalId, email, email);
}

function authorizeBody(): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "mcp:tools",
  }).toString();
}

interface HeldRequest {
  response: Promise<{ status: number; body: string }>;
  /** Flush the first `bytes` of the body and keep the request open. */
  start(bytes: number): Promise<void>;
  /** Send the remainder of the body and finish the request. */
  finish(): void;
}

function heldPost(port: number, email: string, body: string): HeldRequest {
  const payload = Buffer.from(body);
  let sent = 0;
  let resolveResponse!: (value: { status: number; body: string }) => void;
  let rejectResponse!: (reason: unknown) => void;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/authorize",
      headers: {
        Host: `127.0.0.1:${HTTP_PORT}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(payload.length),
        "x-auth-user": "proxy-secret",
        "x-user-email": email,
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolveResponse({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    },
  );
  req.on("error", rejectResponse);
  return {
    response,
    start(bytes: number) {
      sent = bytes;
      return new Promise<void>((resolve, reject) => {
        req.write(payload.subarray(0, bytes), (err) => (err ? reject(err) : resolve()));
      });
    },
    finish() {
      req.end(payload.subarray(sent));
    },
  };
}

describe("POST /authorize identity binding under concurrency (#411)", () => {
  let db: Database.Database;
  let server: http.Server;
  let provider: MuninOAuthProvider;
  let port: number;

  beforeEach(async () => {
    vi.stubEnv("MUNIN_OAUTH_TRUSTED_USER_HEADER", "x-auth-user");
    vi.stubEnv("MUNIN_OAUTH_TRUSTED_USER_VALUE", "proxy-secret");
    vi.stubEnv("MUNIN_OAUTH_IDENTITY_HEADER", "x-user-email");

    db = makeDb();
    insertFamilyPrincipal(db, "alice");
    insertFamilyPrincipal(db, "mallory");

    const created = createHttpApp({
      database: db,
      apiKey: API_KEY,
      issuerUrl: ISSUER_URL,
      httpHost: "127.0.0.1",
      httpPort: HTTP_PORT,
    });
    provider = created.oauthProvider;
    await provider.clientsStore.registerClient!({
      client_id: CLIENT_ID,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:tools",
    });

    server = http.createServer(created.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
    db.close();
    vi.unstubAllEnvs();
  });

  it("binds each concurrent request to its own principal", async () => {
    const body = authorizeBody();

    // A (alice) passes the consent middleware but stalls mid-body, so the
    // SDK handler has not yet reached provider.authorize() for it.
    const a = heldPost(port, "alice@example.com", body);
    await a.start(10);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // B (mallory) completes entirely while A is still held.
    const b = heldPost(port, "mallory@example.com", body);
    await b.start(0);
    b.finish();
    const bResult = await b.response;
    expect(bResult.status).toBe(200);

    a.finish();
    const aResult = await a.response;
    expect(aResult.status).toBe(200);

    const pendings = [
      ...(provider as unknown as {
        pendingAuths: Map<string, { resolvedPrincipalId?: string; resolvedEmail?: string }>;
      }).pendingAuths.values(),
    ];
    expect(pendings).toHaveLength(2);
    expect(pendings.map((p) => p.resolvedPrincipalId).sort()).toEqual(["alice", "mallory"]);
    expect(pendings.map((p) => p.resolvedEmail).sort()).toEqual([
      "alice@example.com",
      "mallory@example.com",
    ]);
  });

  it("binds GET /authorize to the requesting principal", async () => {
    const res = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: `/authorize?${authorizeBody()}`,
            headers: {
              Host: `127.0.0.1:${HTTP_PORT}`,
              "x-auth-user": "proxy-secret",
              "x-user-email": "mallory@example.com",
            },
          },
          (r) => {
            r.resume();
            r.on("end", () => resolve({ statusCode: r.statusCode }));
          },
        )
        .on("error", reject);
    });
    expect(res.statusCode).toBe(200);

    const pendings = [
      ...(provider as unknown as {
        pendingAuths: Map<string, { resolvedPrincipalId?: string }>;
      }).pendingAuths.values(),
    ];
    expect(pendings.map((p) => p.resolvedPrincipalId)).toEqual(["mallory"]);
  });
});
