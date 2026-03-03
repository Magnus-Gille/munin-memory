import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import supertest from "supertest";
import Database from "better-sqlite3";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { initDatabase } from "../src/db.js";
import { MuninOAuthProvider } from "../src/oauth.js";

const TEST_DB_PATH = "/tmp/munin-memory-oauth-integ-test.db";
const LEGACY_API_KEY = "integration-test-api-key";
const ISSUER_URL = "https://test.example.com";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

/**
 * Generate a proper S256 PKCE pair.
 * code_verifier is a random string, code_challenge is BASE64URL(SHA256(code_verifier)).
 */
function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Extract the nonce from a consent page HTML response.
 */
function extractNonce(html: string): string {
  const match = html.match(/name="nonce" value="([^"]+)"/);
  if (!match) throw new Error("Nonce not found in consent page HTML");
  return match[1];
}

let db: Database.Database;
let app: express.Express;
let provider: MuninOAuthProvider;

function createApp() {
  provider = new MuninOAuthProvider(db, LEGACY_API_KEY);
  app = express();

  // Mount OAuth router (rateLimit: false for tests to avoid flaky failures)
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(ISSUER_URL),
      scopesSupported: ["mcp:tools"],
      resourceName: "Test Munin",
      clientRegistrationOptions: { rateLimit: false },
    }),
  );

  // Consent approval handler — matches production (nonce-based)
  app.post(
    "/authorize/approve",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const { action, nonce } = req.body as Record<string, string>;

      if (!nonce) {
        res.status(400).json({ error: "Missing authorization nonce" });
        return;
      }

      const pending = provider.consumePendingAuth(nonce);
      if (!pending) {
        res.status(400).json({ error: "Invalid or expired authorization request" });
        return;
      }

      if (action !== "approve") {
        provider.denyAuthorization(pending, res);
        return;
      }

      provider.completeAuthorization(pending, res);
    },
  );

  // Protected endpoint (simulates /mcp)
  app.get(
    "/mcp",
    requireBearerAuth({ verifier: provider }),
    (_req: Request, res: Response) => {
      res.json({ status: "authenticated" });
    },
  );

  return app;
}

/**
 * Helper: perform the authorization flow (GET /authorize → extract nonce → POST /authorize/approve).
 * Returns the approval response (302 redirect with code).
 */
async function authorizeViaConsent(
  clientId: string,
  codeChallenge: string,
  opts: { scopes?: string; state?: string; action?: string } = {},
) {
  const action = opts.action ?? "approve";
  const query: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:3000/callback",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (opts.scopes !== undefined) query.scope = opts.scopes;
  if (opts.state) query.state = opts.state;

  // Step 1: GET /authorize — SDK validates params, calls provider.authorize() → consent HTML
  const authorizeRes = await supertest(app)
    .get("/authorize")
    .query(query)
    .expect(200);

  const nonce = extractNonce(authorizeRes.text);

  // Step 2: POST /authorize/approve with nonce + action
  const approveRes = await supertest(app)
    .post("/authorize/approve")
    .type("form")
    .send({ action, nonce });

  return approveRes;
}

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  createApp();
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

describe("OAuth metadata endpoints", () => {
  it("serves OAuth authorization server metadata", async () => {
    const res = await supertest(app)
      .get("/.well-known/oauth-authorization-server")
      .expect(200);

    // URL constructor adds trailing slash to bare origins
    expect(res.body.issuer).toBe(ISSUER_URL + "/");
    expect(res.body.authorization_endpoint).toContain("/authorize");
    expect(res.body.token_endpoint).toContain("/token");
    expect(res.body.registration_endpoint).toContain("/register");
    expect(res.body.scopes_supported).toContain("mcp:tools");
    expect(res.body.response_types_supported).toContain("code");
  });

  it("serves protected resource metadata", async () => {
    const res = await supertest(app)
      .get("/.well-known/oauth-protected-resource")
      .expect(200);

    expect(res.body.resource).toBeDefined();
    expect(res.body.resource_name).toBe("Test Munin");
  });
});

describe("Dynamic client registration", () => {
  it("registers a new client", async () => {
    const res = await supertest(app)
      .post("/register")
      .send({
        redirect_uris: ["http://localhost:3000/callback"],
        client_name: "Integration Test Client",
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      })
      .expect(201);

    expect(res.body.client_id).toBeDefined();
    expect(res.body.client_secret).toBeDefined();
    expect(res.body.client_name).toBe("Integration Test Client");
  });

  it("rejects registration with invalid metadata", async () => {
    await supertest(app)
      .post("/register")
      .send({
        // Missing required redirect_uris
        client_name: "Bad Client",
      })
      .expect(400);
  });
});

describe("Full OAuth flow", () => {
  let clientId: string;
  let clientSecret: string;

  beforeEach(async () => {
    // Register a client
    const res = await supertest(app)
      .post("/register")
      .send({
        redirect_uris: ["http://localhost:3000/callback"],
        client_name: "Flow Test Client",
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      })
      .expect(201);

    clientId = res.body.client_id;
    clientSecret = res.body.client_secret;
  });

  it("completes authorization code flow", async () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();

    // Step 1+2: GET /authorize → consent page → POST /authorize/approve
    const approveRes = await authorizeViaConsent(clientId, codeChallenge, {
      scopes: "mcp:tools",
      state: "random-state",
    });
    expect(approveRes.status).toBe(302);

    const redirectUrl = new URL(approveRes.headers.location);
    expect(redirectUrl.origin).toBe("http://localhost:3000");
    expect(redirectUrl.pathname).toBe("/callback");
    expect(redirectUrl.searchParams.get("state")).toBe("random-state");
    const code = redirectUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Step 3: Exchange code for tokens (PKCE verified by SDK)
    const tokenRes = await supertest(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: codeVerifier,
      })
      .expect(200);

    expect(tokenRes.body.access_token).toBeDefined();
    expect(tokenRes.body.refresh_token).toBeDefined();
    expect(tokenRes.body.token_type).toBe("bearer");

    // Step 4: Access protected endpoint with token
    const mcpRes = await supertest(app)
      .get("/mcp")
      .set("Authorization", `Bearer ${tokenRes.body.access_token}`)
      .expect(200);

    expect(mcpRes.body.status).toBe("authenticated");

    // Step 5: Refresh token
    const refreshRes = await supertest(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "refresh_token",
        refresh_token: tokenRes.body.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      })
      .expect(200);

    expect(refreshRes.body.access_token).toBeDefined();
    expect(refreshRes.body.access_token).not.toBe(tokenRes.body.access_token);
  });

  it("handles denied authorization", async () => {
    const { codeChallenge } = generatePkcePair();

    const denyRes = await authorizeViaConsent(clientId, codeChallenge, {
      state: "random-state",
      action: "deny",
    });
    expect(denyRes.status).toBe(302);

    const redirectUrl = new URL(denyRes.headers.location);
    expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    expect(redirectUrl.searchParams.get("state")).toBe("random-state");
  });

  it("rejects approve with invalid nonce", async () => {
    const res = await supertest(app)
      .post("/authorize/approve")
      .type("form")
      .send({ action: "approve", nonce: "nonexistent-nonce" })
      .expect(400);

    expect(res.body.error).toContain("Invalid or expired");
  });

  it("rejects approve without nonce", async () => {
    const res = await supertest(app)
      .post("/authorize/approve")
      .type("form")
      .send({ action: "approve" })
      .expect(400);

    expect(res.body.error).toContain("Missing authorization nonce");
  });

  it("nonce is single-use", async () => {
    const { codeChallenge } = generatePkcePair();

    // GET /authorize to create pending auth
    const authorizeRes = await supertest(app)
      .get("/authorize")
      .query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      })
      .expect(200);

    const nonce = extractNonce(authorizeRes.text);

    // First use succeeds
    const first = await supertest(app)
      .post("/authorize/approve")
      .type("form")
      .send({ action: "approve", nonce })
      .expect(302);
    expect(first.headers.location).toContain("code=");

    // Second use fails (nonce consumed)
    const second = await supertest(app)
      .post("/authorize/approve")
      .type("form")
      .send({ action: "approve", nonce })
      .expect(400);
    expect(second.body.error).toContain("Invalid or expired");
  });

  it("consent page has CSP header", async () => {
    const { codeChallenge } = generatePkcePair();

    const res = await supertest(app)
      .get("/authorize")
      .query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:3000/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      })
      .expect(200);

    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });
});

describe("Legacy Bearer token on /mcp", () => {
  it("accepts legacy API key", async () => {
    await supertest(app)
      .get("/mcp")
      .set("Authorization", `Bearer ${LEGACY_API_KEY}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe("authenticated");
      });
  });

  it("rejects invalid token", async () => {
    await supertest(app)
      .get("/mcp")
      .set("Authorization", "Bearer invalid-token")
      .expect(401);
  });

  it("rejects missing auth", async () => {
    await supertest(app)
      .get("/mcp")
      .expect(401);
  });
});

describe("Token revocation", () => {
  it("revokes token via /revoke endpoint", async () => {
    // Register client
    const regRes = await supertest(app)
      .post("/register")
      .send({
        redirect_uris: ["http://localhost:3000/callback"],
        client_name: "Revoke Test",
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      })
      .expect(201);

    const clientId = regRes.body.client_id;
    const clientSecret = regRes.body.client_secret;
    const { codeVerifier, codeChallenge } = generatePkcePair();

    // Get a token via the full authorization flow
    const approveRes = await authorizeViaConsent(clientId, codeChallenge);
    expect(approveRes.status).toBe(302);

    const code = new URL(approveRes.headers.location).searchParams.get("code")!;

    const tokenRes = await supertest(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: "http://localhost:3000/callback",
        code_verifier: codeVerifier,
      })
      .expect(200);

    const accessToken = tokenRes.body.access_token;

    // Token works
    await supertest(app)
      .get("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    // Revoke it
    await supertest(app)
      .post("/revoke")
      .type("form")
      .send({
        token: accessToken,
        client_id: clientId,
        client_secret: clientSecret,
      })
      .expect(200);

    // Token no longer works
    await supertest(app)
      .get("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(401);
  });
});
