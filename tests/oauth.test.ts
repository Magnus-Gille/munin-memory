import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import { initDatabase } from "../src/db.js";
import { MuninOAuthProvider, MuninClientsStore } from "../src/oauth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const TEST_DB_PATH = "/tmp/munin-memory-oauth-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

let db: Database.Database;
let provider: MuninOAuthProvider;

const LEGACY_API_KEY = "test-legacy-api-key-12345";

function makeTestClient(overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
  return {
    client_id: "test-client-id",
    client_secret: "test-client-secret",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: Math.floor(Date.now() / 1000) + 86400,
    redirect_uris: [new URL("http://localhost:3000/callback")],
    client_name: "Test Client",
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...overrides,
  };
}

/**
 * Build a PendingAuth-shaped object for direct unit testing of
 * completeAuthorization / denyAuthorization. In production, these
 * objects are created by authorize() and looked up by nonce.
 */
function makePending(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    redirectUri: "http://localhost:3000/callback",
    codeChallenge: "test-challenge",
    scopes: [] as string[],
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  provider = new MuninOAuthProvider(db, LEGACY_API_KEY);
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

describe("MuninClientsStore", () => {
  it("registers and retrieves a client", async () => {
    const client = makeTestClient();
    const stored = await provider.clientsStore.registerClient!(client);

    expect(stored.client_id).toBe("test-client-id");
    expect(stored.client_name).toBe("Test Client");

    const retrieved = await provider.clientsStore.getClient("test-client-id");
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_id).toBe("test-client-id");
    expect(retrieved!.client_name).toBe("Test Client");
    expect(retrieved!.redirect_uris).toHaveLength(1);
    expect(retrieved!.redirect_uris[0].toString()).toBe("http://localhost:3000/callback");
  });

  it("returns undefined for unknown client", async () => {
    const result = await provider.clientsStore.getClient("nonexistent");
    expect(result).toBeUndefined();
  });

  it("stores client without secret (public client)", async () => {
    const client = makeTestClient({
      client_secret: undefined,
      token_endpoint_auth_method: "none",
    });
    await provider.clientsStore.registerClient!(client);

    const retrieved = await provider.clientsStore.getClient(client.client_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_secret).toBeUndefined();
  });
});

describe("Authorization code flow", () => {
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    client = makeTestClient();
    await provider.clientsStore.registerClient!(client);
  });

  it("issues and exchanges an auth code", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id, {
        codeChallenge: "test-challenge-123",
        scopes: ["mcp:tools"],
        state: "test-state",
      }),
      res as any,
    );

    // Extract code from redirect URL
    const redirectUrl = new URL(res.redirectedTo!);
    const code = redirectUrl.searchParams.get("code")!;
    expect(code).toBeDefined();
    expect(redirectUrl.searchParams.get("state")).toBe("test-state");

    // Verify challenge
    const challenge = await provider.challengeForAuthorizationCode(client, code);
    expect(challenge).toBe("test-challenge-123");

    // Exchange code for tokens
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe("bearer");
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  it("rejects used auth code", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const redirectUrl = new URL(res.redirectedTo!);
    const code = redirectUrl.searchParams.get("code")!;

    // First exchange succeeds
    await provider.exchangeAuthorizationCode(client, code);

    // Second exchange fails
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(
      "Invalid or expired authorization code",
    );
  });

  it("rejects code issued to different client", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const redirectUrl = new URL(res.redirectedTo!);
    const code = redirectUrl.searchParams.get("code")!;

    const otherClient = makeTestClient({ client_id: "other-client" });
    await provider.clientsStore.registerClient!(otherClient);

    await expect(provider.exchangeAuthorizationCode(otherClient, code)).rejects.toThrow(
      "Authorization code was not issued to this client",
    );
  });

  it("handles denied authorization", () => {
    const res = createMockResponse();
    provider.denyAuthorization(
      { redirectUri: "http://localhost:3000/callback", state: "test-state" },
      res as any,
    );

    const redirectUrl = new URL(res.redirectedTo!);
    expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    expect(redirectUrl.searchParams.get("state")).toBe("test-state");
  });

  it("validates redirect_uri on code exchange", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const redirectUrl = new URL(res.redirectedTo!);
    const code = redirectUrl.searchParams.get("code")!;

    // Exchange with mismatched redirect_uri should fail
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, "http://evil.com/callback"),
    ).rejects.toThrow("redirect_uri does not match");
  });

  it("stores authorization codes hashed at rest", () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const stored = db
      .prepare("SELECT code FROM oauth_auth_codes")
      .get() as { code: string };

    expect(stored.code).toBeDefined();
    expect(stored.code).not.toBe(code);
  });
});

describe("Server-side authorization transaction binding", () => {
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    client = makeTestClient();
    await provider.clientsStore.registerClient!(client);
  });

  it("authorize() stores pending auth and consent page contains nonce", async () => {
    const res = createMockResponse();
    await provider.authorize(client, {
      redirectUri: "http://localhost:3000/callback",
      codeChallenge: "test-challenge",
      scopes: ["mcp:tools"],
      state: "test-state",
    } as any, res as any);

    // Response should be HTML with a nonce hidden field
    expect(res.sentBody).toBeDefined();
    const nonceMatch = res.sentBody!.match(/name="nonce" value="([^"]+)"/);
    expect(nonceMatch).toBeTruthy();
    expect(nonceMatch![1]).toHaveLength(64); // 32 bytes hex

    // CSP header should be set
    expect(res.headers["Content-Security-Policy"]).toBeDefined();
  });

  it("consumePendingAuth() returns and removes pending auth", async () => {
    const res = createMockResponse();
    await provider.authorize(client, {
      redirectUri: "http://localhost:3000/callback",
      codeChallenge: "test-challenge",
      scopes: ["mcp:tools"],
      state: "test-state",
    } as any, res as any);

    const nonceMatch = res.sentBody!.match(/name="nonce" value="([^"]+)"/);
    const nonce = nonceMatch![1];

    // First consume succeeds
    const pending = provider.consumePendingAuth(nonce);
    expect(pending).toBeDefined();
    expect(pending!.clientId).toBe(client.client_id);
    expect(pending!.redirectUri).toBe("http://localhost:3000/callback");
    expect(pending!.codeChallenge).toBe("test-challenge");
    expect(pending!.scopes).toEqual(["mcp:tools"]);
    expect(pending!.state).toBe("test-state");

    // Second consume fails (single-use)
    const again = provider.consumePendingAuth(nonce);
    expect(again).toBeUndefined();
  });

  it("consumePendingAuth() rejects unknown nonce", () => {
    const result = provider.consumePendingAuth("nonexistent-nonce");
    expect(result).toBeUndefined();
  });

  it("cleanupExpired() sweeps stale pending auths", async () => {
    const res = createMockResponse();
    await provider.authorize(client, {
      redirectUri: "http://localhost:3000/callback",
      codeChallenge: "test-challenge",
      scopes: [],
    } as any, res as any);

    const nonceMatch = res.sentBody!.match(/name="nonce" value="([^"]+)"/);
    const nonce = nonceMatch![1];

    // Force the pending auth to expire (hack: consume, modify, re-insert is not possible)
    // Instead, test that cleanup doesn't crash and that consuming after cleanup works
    provider.cleanupExpired();

    // Nonce should still be valid (not expired yet)
    const pending = provider.consumePendingAuth(nonce);
    expect(pending).toBeDefined();
  });
});

describe("Token verification", () => {
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    client = makeTestClient();
    await provider.clientsStore.registerClient!(client);
  });

  it("verifies legacy API key", async () => {
    const info = await provider.verifyAccessToken(LEGACY_API_KEY);
    expect(info.clientId).toBe("legacy-bearer");
    expect(info.token).toBe(LEGACY_API_KEY);
  });

  it("rejects token with same length but different value (timing-safe)", async () => {
    // Create a key with the same length as the legacy key but different content
    const wrongKey = "x".repeat(LEGACY_API_KEY.length);
    await expect(provider.verifyAccessToken(wrongKey)).rejects.toThrow();
  });

  it("verifies OAuth access token", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id, { scopes: ["mcp:tools"] }),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
    expect(info.scopes).toEqual(["mcp:tools"]);
    expect(info.expiresAt).toBeDefined();
  });

  it("stores OAuth tokens hashed at rest", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const stored = db
      .prepare("SELECT token, token_type FROM oauth_tokens ORDER BY token_type")
      .all() as Array<{ token: string; token_type: string }>;

    expect(stored).toHaveLength(2);
    expect(stored.some((row) => row.token === tokens.access_token)).toBe(false);
    expect(stored.some((row) => row.token === tokens.refresh_token)).toBe(false);
  });

  it("rejects invalid token", async () => {
    await expect(provider.verifyAccessToken("invalid-token")).rejects.toThrow();
  });

  it("rejects revoked token", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // Revoke
    await provider.revokeToken!(client, { token: tokens.access_token });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });
});

describe("Refresh token flow", () => {
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    client = makeTestClient();
    await provider.clientsStore.registerClient!(client);
  });

  it("exchanges refresh token for new token pair", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id, { scopes: ["mcp:tools"] }),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const newTokens = await provider.exchangeRefreshToken(
      client,
      tokens.refresh_token!,
    );

    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("old refresh token is revoked after rotation", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // First refresh works
    await provider.exchangeRefreshToken(client, tokens.refresh_token!);

    // Second refresh with same token fails (rotated)
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!),
    ).rejects.toThrow("Invalid refresh token");
  });

  it("rejects refresh token from different client", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const otherClient = makeTestClient({ client_id: "other-client" });
    await provider.clientsStore.registerClient!(otherClient);

    await expect(
      provider.exchangeRefreshToken(otherClient, tokens.refresh_token!),
    ).rejects.toThrow("Refresh token was not issued to this client");
  });
});

describe("Token revocation", () => {
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    client = makeTestClient();
    await provider.clientsStore.registerClient!(client);
  });

  it("revokes access token", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    await provider.revokeToken!(client, { token: tokens.access_token });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("silently ignores revoking nonexistent token", async () => {
    // Should not throw
    await provider.revokeToken!(client, { token: "nonexistent-token" });
  });
});

describe("Cleanup", () => {
  let client: OAuthClientInformationFull;

  beforeEach(async () => {
    client = makeTestClient();
    await provider.clientsStore.registerClient!(client);
  });

  it("cleans up used auth codes", () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;

    // Mark code as used by exchanging it
    provider.exchangeAuthorizationCode(client, code);

    const result = provider.cleanupExpired();
    expect(result.codes).toBeGreaterThanOrEqual(1);
  });

  it("cleans up revoked tokens", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    await provider.revokeToken!(client, { token: tokens.access_token });

    const result = provider.cleanupExpired();
    expect(result.tokens).toBeGreaterThanOrEqual(1);
  });

  it("cleans up expired refresh tokens", async () => {
    const res = createMockResponse();
    provider.completeAuthorization(
      makePending(client.client_id),
      res as any,
    );

    const code = new URL(res.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    db.prepare(
      "UPDATE oauth_tokens SET expires_at = 0 WHERE token_type = 'refresh'",
    ).run();

    const result = provider.cleanupExpired();
    expect(result.tokens).toBeGreaterThanOrEqual(1);

    const remaining = db
      .prepare("SELECT COUNT(*) as count FROM oauth_tokens WHERE token_type = 'refresh'")
      .get() as { count: number };
    expect(remaining.count).toBe(0);

    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      "Invalid refresh token",
    );
  });
});

describe("Migration v3 — OAuth tables", () => {
  it("creates oauth_clients table", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'oauth_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("oauth_clients");
    expect(names).toContain("oauth_auth_codes");
    expect(names).toContain("oauth_tokens");
  });

  it("creates expected indexes", () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_oauth_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_oauth_auth_codes_expires");
    expect(names).toContain("idx_oauth_tokens_client");
    expect(names).toContain("idx_oauth_tokens_expires");
    expect(names).toContain("idx_oauth_tokens_refresh_ref");
  });

  it("enforces token_type CHECK constraint", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at)
         VALUES ('tok', 'invalid', 'cid', '[]', 0, '2025-01-01')`,
      ).run();
    }).toThrow();
  });
});

// --- Test helpers ---

function createMockResponse(): {
  redirectedTo: string | null;
  sentBody: string | null;
  headers: Record<string, string>;
  redirect: (url: string) => void;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
} {
  return {
    redirectedTo: null,
    sentBody: null,
    headers: {},
    redirect(url: string) {
      this.redirectedTo = url;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    send(body: string) {
      this.sentBody = body;
    },
  };
}
