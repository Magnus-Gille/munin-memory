/**
 * Regression tests for #408: OAuth token lifecycle.
 *
 * - revocation cascades across the access/refresh pair in both directions
 * - refresh rotation revokes the previous access token
 * - refresh scopes must be a subset of the originally granted scopes (RFC 6749 section 6)
 * - expected grant failures use the SDK's typed OAuth errors (HTTP 400, not 500)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { runMigrations } from "../src/migrations.js";
import { MuninOAuthProvider } from "../src/oauth.js";

const CLIENT = {
  client_id: "fixture-lifecycle-client",
  redirect_uris: ["https://client.invalid/cb"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
} as unknown as OAuthClientInformationFull;

const OTHER_CLIENT = {
  ...CLIENT,
  client_id: "fixture-lifecycle-other-client",
} as unknown as OAuthClientInformationFull;

const GRANTED = ["mcp:tools", "mcp:read"];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("OAuth token lifecycle (#408)", () => {
  let db: Database.Database;
  let provider: MuninOAuthProvider;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    provider = new MuninOAuthProvider(db);
    await provider.clientsStore.registerClient!(CLIENT);
    await provider.clientsStore.registerClient!(OTHER_CLIENT);
  });
  afterEach(() => db.close());

  /** Run the real authorize -> code exchange flow and return the token pair. */
  async function issuePair(client: OAuthClientInformationFull = CLIENT): Promise<OAuthTokens> {
    const code = approveCode(client);
    return provider.exchangeAuthorizationCode(client, code);
  }

  function approveCode(client: OAuthClientInformationFull = CLIENT, scopes: string[] = GRANTED): string {
    let redirect = "";
    provider.completeAuthorization(
      {
        clientId: client.client_id,
        redirectUri: client.redirect_uris[0].toString(),
        codeChallenge: createHash("sha256").update("fixture-verifier-".repeat(4)).digest("base64url"),
        scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
      { redirect: (url: string) => { redirect = url; } } as never,
    );
    return new URL(redirect).searchParams.get("code")!;
  }

  async function accessIsValid(token: string): Promise<boolean> {
    try {
      await provider.verifyAccessToken(token);
      return true;
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTokenError);
      return false;
    }
  }

  async function refreshIsUsable(client: OAuthClientInformationFull, token: string): Promise<boolean> {
    try {
      await provider.exchangeRefreshToken(client, token);
      return true;
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidGrantError);
      return false;
    }
  }

  describe("revocation cascade", () => {
    it("revoking the refresh token also revokes the linked access token", async () => {
      const pair = await issuePair();
      expect(await accessIsValid(pair.access_token)).toBe(true);

      await provider.revokeToken!(CLIENT, { token: pair.refresh_token! });

      expect(await accessIsValid(pair.access_token)).toBe(false);
      expect(await refreshIsUsable(CLIENT, pair.refresh_token!)).toBe(false);
    });

    it("revoking the access token also revokes the linked refresh token", async () => {
      const pair = await issuePair();

      await provider.revokeToken!(CLIENT, { token: pair.access_token });

      expect(await accessIsValid(pair.access_token)).toBe(false);
      expect(await refreshIsUsable(CLIENT, pair.refresh_token!)).toBe(false);
    });

    it("does not cascade into the token pairs of other grants", async () => {
      const first = await issuePair();
      const second = await issuePair();

      await provider.revokeToken!(CLIENT, { token: first.access_token });

      expect(await accessIsValid(second.access_token)).toBe(true);
      expect(await refreshIsUsable(CLIENT, second.refresh_token!)).toBe(true);
    });

    it("ignores a revocation request from a different client", async () => {
      const pair = await issuePair();

      await provider.revokeToken!(OTHER_CLIENT, { token: pair.access_token });
      await provider.revokeToken!(OTHER_CLIENT, { token: pair.refresh_token! });

      expect(await accessIsValid(pair.access_token)).toBe(true);
      expect(await refreshIsUsable(CLIENT, pair.refresh_token!)).toBe(true);
    });

    it("treats revocation of an unknown token as a no-op", async () => {
      const pair = await issuePair();

      await expect(provider.revokeToken!(CLIENT, { token: "unknown-token" })).resolves.toBeUndefined();

      expect(await accessIsValid(pair.access_token)).toBe(true);
    });
  });

  describe("refresh rotation", () => {
    it("revokes the previous access token and issues a working new pair", async () => {
      const pair = await issuePair();

      const rotated = await provider.exchangeRefreshToken(CLIENT, pair.refresh_token!);

      expect(await accessIsValid(pair.access_token)).toBe(false);
      expect(await accessIsValid(rotated.access_token)).toBe(true);
      expect(rotated.refresh_token).not.toBe(pair.refresh_token);
      // The consumed refresh token cannot be replayed.
      expect(await refreshIsUsable(CLIENT, pair.refresh_token!)).toBe(false);
    });

    it("keeps the rotated pair revocable as a pair", async () => {
      const pair = await issuePair();
      const rotated = await provider.exchangeRefreshToken(CLIENT, pair.refresh_token!);

      await provider.revokeToken!(CLIENT, { token: rotated.access_token });

      expect(await refreshIsUsable(CLIENT, rotated.refresh_token!)).toBe(false);
    });
  });

  describe("refresh scope handling (RFC 6749 section 6)", () => {
    it("rejects scopes outside the originally granted set with invalid_scope", async () => {
      const pair = await issuePair();

      await expect(
        provider.exchangeRefreshToken(CLIENT, pair.refresh_token!, ["mcp:tools", "admin:everything"]),
      ).rejects.toBeInstanceOf(InvalidScopeError);
    });

    it("does not consume the refresh token when the scope request is rejected", async () => {
      const pair = await issuePair();

      await expect(
        provider.exchangeRefreshToken(CLIENT, pair.refresh_token!, ["admin:everything"]),
      ).rejects.toBeInstanceOf(InvalidScopeError);

      expect(await accessIsValid(pair.access_token)).toBe(true);
      const rotated = await provider.exchangeRefreshToken(CLIENT, pair.refresh_token!);
      expect(rotated.scope).toBe(GRANTED.join(" "));
    });

    it("keeps the stored scopes when none are requested", async () => {
      const pair = await issuePair();

      const rotated = await provider.exchangeRefreshToken(CLIENT, pair.refresh_token!);

      expect(rotated.scope).toBe(GRANTED.join(" "));
    });

    it("issues narrowed scopes for a strict subset and keeps them on later refreshes", async () => {
      const pair = await issuePair();

      const narrowed = await provider.exchangeRefreshToken(CLIENT, pair.refresh_token!, ["mcp:read"]);
      expect(narrowed.scope).toBe("mcp:read");
      const info = await provider.verifyAccessToken(narrowed.access_token);
      expect(info.scopes).toEqual(["mcp:read"]);

      // A narrowed grant cannot be widened again by a later refresh.
      await expect(
        provider.exchangeRefreshToken(CLIENT, narrowed.refresh_token!, GRANTED),
      ).rejects.toBeInstanceOf(InvalidScopeError);
    });
  });

  describe("typed grant errors", () => {
    it("rejects unknown and replayed refresh tokens with InvalidGrantError", async () => {
      await expect(provider.exchangeRefreshToken(CLIENT, "unknown")).rejects.toBeInstanceOf(InvalidGrantError);

      const pair = await issuePair();
      await provider.exchangeRefreshToken(CLIENT, pair.refresh_token!);
      await expect(
        provider.exchangeRefreshToken(CLIENT, pair.refresh_token!),
      ).rejects.toBeInstanceOf(InvalidGrantError);
    });

    it("rejects a refresh token presented by another client without consuming it", async () => {
      const pair = await issuePair();

      await expect(
        provider.exchangeRefreshToken(OTHER_CLIENT, pair.refresh_token!),
      ).rejects.toBeInstanceOf(InvalidGrantError);

      expect(await refreshIsUsable(CLIENT, pair.refresh_token!)).toBe(true);
    });

    it("rejects an expired refresh token with InvalidGrantError", async () => {
      const pair = await issuePair();
      db.prepare("UPDATE oauth_tokens SET expires_at = 1 WHERE token = ?").run(hash(pair.refresh_token!));

      await expect(
        provider.exchangeRefreshToken(CLIENT, pair.refresh_token!),
      ).rejects.toBeInstanceOf(InvalidGrantError);
    });

    it("rejects unknown, used, foreign, expired codes and redirect mismatch with InvalidGrantError", async () => {
      await expect(
        provider.exchangeAuthorizationCode(CLIENT, "unknown-code"),
      ).rejects.toBeInstanceOf(InvalidGrantError);
      await expect(
        provider.challengeForAuthorizationCode(CLIENT, "unknown-code"),
      ).rejects.toBeInstanceOf(InvalidGrantError);

      const used = approveCode();
      await provider.exchangeAuthorizationCode(CLIENT, used);
      await expect(provider.exchangeAuthorizationCode(CLIENT, used)).rejects.toBeInstanceOf(InvalidGrantError);

      const foreign = approveCode();
      await expect(
        provider.exchangeAuthorizationCode(OTHER_CLIENT, foreign),
      ).rejects.toBeInstanceOf(InvalidGrantError);

      const expired = approveCode();
      db.prepare("UPDATE oauth_auth_codes SET expires_at = 1 WHERE code = ?").run(hash(expired));
      await expect(provider.exchangeAuthorizationCode(CLIENT, expired)).rejects.toBeInstanceOf(InvalidGrantError);

      const mismatched = approveCode();
      await expect(
        provider.exchangeAuthorizationCode(CLIENT, mismatched, undefined, "https://evil.invalid/cb"),
      ).rejects.toBeInstanceOf(InvalidGrantError);
    });

    it("does not leak token material in error messages", async () => {
      const secret = "fixture-secret-refresh-value";
      const err = await provider.exchangeRefreshToken(CLIENT, secret).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidGrantError);
      expect((err as Error).message).not.toContain(secret);
    });
  });

  describe("SDK token handler mapping", () => {
    async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
      const router = tokenHandler({ provider, rateLimit: false }) as unknown as {
        stack: Array<{ route?: { methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
      };
      const handler = router.stack.find((layer) => layer.route?.methods.post)!.route!.stack[0].handle;
      let status = 200;
      let json: Record<string, unknown> = {};
      const res = {
        setHeader() {},
        status(n: number) { status = n; return this; },
        json(x: Record<string, unknown>) { json = x; return this; },
      };
      await handler({ client: CLIENT, body }, res);
      return { status, body: json };
    }

    it("returns 400 invalid_grant for an invalid refresh token", async () => {
      const res = await post({ grant_type: "refresh_token", refresh_token: "fixture-invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("returns 400 invalid_scope for scope escalation on refresh", async () => {
      const pair = await issuePair();
      const res = await post({
        grant_type: "refresh_token",
        refresh_token: pair.refresh_token,
        scope: "mcp:tools admin:everything",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_scope");
    });

    it("returns 400 invalid_grant for an unknown authorization code", async () => {
      const res = await post({
        grant_type: "authorization_code",
        code: "unknown-code",
        code_verifier: "x".repeat(64),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("still serves a normal refresh with 200", async () => {
      const pair = await issuePair();
      const res = await post({ grant_type: "refresh_token", refresh_token: pair.refresh_token });
      expect(res.status).toBe(200);
      expect(typeof res.body.access_token).toBe("string");
    });
  });
});
