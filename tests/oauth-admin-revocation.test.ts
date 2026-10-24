/**
 * Regression tests for #407: admin OAuth revocation must cover tokens and
 * outstanding authorization codes bound to a principal even when the
 * principal<->client mapping belongs to someone else, and removing a client
 * must invalidate its approved-but-unredeemed authorization codes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { runMigrations } from "../src/migrations.js";
import { MuninOAuthProvider } from "../src/oauth.js";
import {
  clearOAuthClients,
  removeOAuthClient,
  listOAuthClients,
  handleOAuthClientsRemove,
  handleOAuthClientsClear,
} from "../src/admin-cli.js";

const SHARED_CLIENT = {
  client_id: "fixture-public-client",
  redirect_uris: ["https://client.invalid/cb"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
} as unknown as OAuthClientInformationFull;

const OTHER_CLIENT = {
  ...SHARED_CLIENT,
  client_id: "fixture-other-client",
} as unknown as OAuthClientInformationFull;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  for (const principal of ["alice", "bob"]) {
    db.prepare(
      `INSERT INTO principals (id, principal_id, principal_type, namespace_rules, created_at)
       VALUES (?, ?, 'family', ?, ?)`,
    ).run(
      principal,
      principal,
      JSON.stringify([{ pattern: `users/${principal}/*`, permissions: "rw" }]),
      new Date().toISOString(),
    );
  }
  return db;
}

/** Approve an authorization request and return the issued code. */
function approve(
  provider: MuninOAuthProvider,
  principal: string,
  client: OAuthClientInformationFull = SHARED_CLIENT,
): string {
  let redirect = "";
  provider.completeAuthorization(
    {
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0].toString(),
      codeChallenge: createHash("sha256").update("fixture-verifier-".repeat(4)).digest("base64url"),
      scopes: ["mcp:tools"],
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      resolvedPrincipalId: principal,
    },
    { redirect: (url: string) => { redirect = url; } } as never,
  );
  return new URL(redirect).searchParams.get("code")!;
}

describe("admin OAuth revocation (#407)", () => {
  let db: Database.Database;
  let provider: MuninOAuthProvider;

  beforeEach(async () => {
    db = makeDb();
    provider = new MuninOAuthProvider(db);
    await provider.clientsStore.registerClient!(SHARED_CLIENT);
    await provider.clientsStore.registerClient!(OTHER_CLIENT);
  });
  afterEach(() => db.close());

  describe("clearOAuthClients", () => {
    it("revokes a principal's tokens on a shared client even though the mapping belongs to another principal", async () => {
      const alice = await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
      const bob = await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "bob"));

      // Alice owns the mapping; Bob's approval only logged a conflict.
      expect(listOAuthClients(db, "alice")).toHaveLength(1);
      expect(listOAuthClients(db, "bob")).toHaveLength(0);

      const result = clearOAuthClients(db, "bob");
      expect(result).toEqual({ mappingsRemoved: 0, tokensRevoked: 2, codesInvalidated: 0 });

      await expect(provider.verifyAccessToken(bob.access_token)).rejects.toThrow();
      await expect(
        provider.exchangeRefreshToken(SHARED_CLIENT, bob.refresh_token!),
      ).rejects.toThrow("Invalid refresh token");

      // Alice is untouched, mapping included.
      const auth = await provider.verifyAccessToken(alice.access_token);
      expect(auth.clientId).toBe(SHARED_CLIENT.client_id);
      expect(listOAuthClients(db, "alice")).toHaveLength(1);
    });

    it("invalidates the principal's outstanding authorization codes regardless of mapping", async () => {
      await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
      const bobCode = approve(provider, "bob"); // conflict: no mapping for bob
      const aliceCode = approve(provider, "alice");

      const result = clearOAuthClients(db, "bob");
      expect(result.codesInvalidated).toBe(1);

      await expect(provider.exchangeAuthorizationCode(SHARED_CLIENT, bobCode)).rejects.toThrow(
        "Invalid or expired authorization code",
      );
      // Another principal's pending code on the same client still works.
      const tokens = await provider.exchangeAuthorizationCode(SHARED_CLIENT, aliceCode);
      expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(SHARED_CLIENT.client_id);
    });

    it("reports mappings, tokens and codes actually affected for a mapped principal", async () => {
      const code = approve(provider, "alice"); // maps shared client to alice
      const issued = await provider.exchangeAuthorizationCode(SHARED_CLIENT, code);
      approve(provider, "alice", OTHER_CLIENT); // second mapping + pending code

      const result = clearOAuthClients(db, "alice");
      expect(result).toEqual({ mappingsRemoved: 2, tokensRevoked: 2, codesInvalidated: 1 });
      await expect(provider.verifyAccessToken(issued.access_token)).rejects.toThrow();
      expect(listOAuthClients(db, "alice")).toHaveLength(0);
    });

    it("does not count already-revoked tokens or already-used codes", async () => {
      await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
      expect(clearOAuthClients(db, "alice").tokensRevoked).toBe(2);
      expect(clearOAuthClients(db, "alice")).toEqual({
        mappingsRemoved: 0,
        tokensRevoked: 0,
        codesInvalidated: 0,
      });
    });

    it("writes an audit entry when only tokens/codes (no mapping) were affected", async () => {
      await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
      await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "bob"));
      clearOAuthClients(db, "bob");
      const rows = db
        .prepare("SELECT detail FROM audit_log WHERE action = 'oauth_clients_clear' AND key = 'bob'")
        .all() as Array<{ detail: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toContain("2 token(s) revoked");
    });
  });

  describe("removeOAuthClient", () => {
    it("invalidates an approved but unredeemed authorization code", async () => {
      const approvedCode = approve(provider, "alice");

      expect(removeOAuthClient(db, SHARED_CLIENT.client_id).removed).toBe(true);

      await expect(provider.exchangeAuthorizationCode(SHARED_CLIENT, approvedCode)).rejects.toThrow(
        "Invalid or expired authorization code",
      );
      expect(
        db.prepare("SELECT count(*) AS n FROM oauth_tokens WHERE principal_id = 'alice'").get(),
      ).toEqual({ n: 0 });
    });

    it("leaves other clients' pending codes redeemable", async () => {
      approve(provider, "alice");
      const otherCode = approve(provider, "alice", OTHER_CLIENT);

      removeOAuthClient(db, SHARED_CLIENT.client_id);

      const tokens = await provider.exchangeAuthorizationCode(OTHER_CLIENT, otherCode);
      expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(OTHER_CLIENT.client_id);
    });

    it("returns false once nothing is left to remove or revoke", async () => {
      approve(provider, "alice");
      expect(removeOAuthClient(db, SHARED_CLIENT.client_id)).toEqual({
        removed: true,
        mappingsRemoved: 1,
        tokensRevoked: 0,
        codesInvalidated: 1,
      });
      // Mapping, tokens and codes are all gone on the second call.
      expect(removeOAuthClient(db, SHARED_CLIENT.client_id)).toEqual({
        removed: false,
        mappingsRemoved: 0,
        tokensRevoked: 0,
        codesInvalidated: 0,
      });
    });
  });

  describe("token exchange for a client that no longer exists", () => {
    // Deleting the client row cascades with foreign keys on; turn them off so
    // the stale code/token rows survive and the provider-level guard is exercised.
    it("refuses authorization code exchange with invalid_grant", async () => {
      const code = approve(provider, "alice");
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(SHARED_CLIENT.client_id);

      const err = await provider
        .exchangeAuthorizationCode(SHARED_CLIENT, code)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidGrantError);
      expect(db.prepare("SELECT count(*) AS n FROM oauth_tokens").get()).toEqual({ n: 0 });
    });

    it("refuses refresh token exchange with invalid_grant", async () => {
      const issued = await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(SHARED_CLIENT.client_id);

      const err = await provider
        .exchangeRefreshToken(SHARED_CLIENT, issued.refresh_token!)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidGrantError);
    });
  });
});

describe("admin CLI output reports what was actually affected (#407)", () => {
  let db: Database.Database;
  let provider: MuninOAuthProvider;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = makeDb();
    provider = new MuninOAuthProvider(db);
    await provider.clientsStore.registerClient!(SHARED_CLIENT);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it("remove --json prints mapping, token and code counts", async () => {
    await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
    approve(provider, "alice"); // one unredeemed code
    handleOAuthClientsRemove(db, SHARED_CLIENT.client_id, true);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      oauthClientId: SHARED_CLIENT.client_id,
      removed: true,
      mappingsRemoved: 1,
      tokensRevoked: 2,
      codesInvalidated: 1,
    });
  });

  it("remove text output prints the real numbers", async () => {
    await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
    approve(provider, "alice");
    handleOAuthClientsRemove(db, SHARED_CLIENT.client_id, false);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("1 mapping(s) removed");
    expect(line).toContain("2 token(s) revoked");
    expect(line).toContain("1 authorization code(s) invalidated");
  });

  it("remove reports a client with only an unredeemed code (no mapping) as removed", async () => {
    approve(provider, "bob");
    db.prepare("DELETE FROM principal_oauth_clients").run();
    handleOAuthClientsRemove(db, SHARED_CLIENT.client_id, true);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      removed: true,
      mappingsRemoved: 0,
      codesInvalidated: 1,
    });
  });

  it("clear --json and text print all counts", async () => {
    await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "alice"));
    handleOAuthClientsClear(db, "alice", false);
    expect(logSpy.mock.calls[0][0]).toContain("1 OAuth client mapping(s)");
    expect(logSpy.mock.calls[0][0]).toContain("2 token(s) revoked");
  });
});

// The admin CLI is a separate process on the same SQLite file. Exchanges and
// admin revocation must serialize on the write lock, otherwise an admin run
// between "claim code" and "issue tokens" sees nothing to revoke and a valid
// token pair appears afterwards.
describe("cross-connection serialization (#407)", () => {
  let dir: string;
  let exchangeDb: Database.Database;
  let adminDb: Database.Database;
  let provider: MuninOAuthProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "munin-t2-"));
    const file = join(dir, "munin.db");
    exchangeDb = new Database(file);
    exchangeDb.pragma("journal_mode = WAL");
    exchangeDb.pragma("foreign_keys = ON");
    runMigrations(exchangeDb);
    for (const principal of ["alice", "bob"]) {
      exchangeDb.prepare(
        `INSERT INTO principals (id, principal_id, principal_type, namespace_rules, created_at)
         VALUES (?, ?, 'family', '[]', ?)`,
      ).run(principal, principal, new Date().toISOString());
    }
    adminDb = new Database(file);
    adminDb.pragma("foreign_keys = ON");
    adminDb.pragma("busy_timeout = 0");
    provider = new MuninOAuthProvider(exchangeDb);
    await provider.clientsStore.registerClient!(SHARED_CLIENT);
  });
  afterEach(() => {
    exchangeDb.close();
    adminDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run `admin` on the second connection at the moment tokens are about to be issued. */
  function adminBeforeIssue(admin: () => unknown): { outcome: () => unknown } {
    let outcome: unknown = "not-run";
    const original = (provider as unknown as { issueTokenPair: (...a: unknown[]) => unknown }).issueTokenPair;
    vi.spyOn(provider as never, "issueTokenPair" as never).mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      try {
        outcome = admin();
      } catch (e) {
        outcome = e;
      }
      return original.apply(provider, args);
    } as never);
    return { outcome: () => outcome };
  }

  function activeTokens(): number {
    return (exchangeDb.prepare("SELECT count(*) AS n FROM oauth_tokens WHERE revoked = 0").get() as { n: number }).n;
  }

  it("code exchange: admin clear cannot run between claim and issue", async () => {
    const code = approve(provider, "bob");
    const probe = adminBeforeIssue(() => clearOAuthClients(adminDb, "bob"));

    const tokens = await provider.exchangeAuthorizationCode(SHARED_CLIENT, code);

    // The admin call was blocked by the exchange's write lock (not run on a half-done grant).
    expect(probe.outcome()).toMatchObject({ code: "SQLITE_BUSY" });
    expect(activeTokens()).toBe(2);
    // Once the exchange committed, the admin clear sees and revokes the pair.
    expect(clearOAuthClients(adminDb, "bob").tokensRevoked).toBe(2);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("code exchange: admin remove cannot run between claim and issue", async () => {
    const code = approve(provider, "alice");
    const probe = adminBeforeIssue(() => removeOAuthClient(adminDb, SHARED_CLIENT.client_id));

    const tokens = await provider.exchangeAuthorizationCode(SHARED_CLIENT, code);

    expect(probe.outcome()).toMatchObject({ code: "SQLITE_BUSY" });
    expect(removeOAuthClient(adminDb, SHARED_CLIENT.client_id).tokensRevoked).toBe(2);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("refresh exchange: admin clear cannot run between consume and issue", async () => {
    const issued = await provider.exchangeAuthorizationCode(SHARED_CLIENT, approve(provider, "bob"));
    const probe = adminBeforeIssue(() => clearOAuthClients(adminDb, "bob"));

    const rotated = await provider.exchangeRefreshToken(SHARED_CLIENT, issued.refresh_token!);

    expect(probe.outcome()).toMatchObject({ code: "SQLITE_BUSY" });
    expect(clearOAuthClients(adminDb, "bob").tokensRevoked).toBe(2);
    await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toThrow();
  });

  it("a code presented by the wrong client is still burned", async () => {
    const code = approve(provider, "alice");
    await provider.clientsStore.registerClient!(OTHER_CLIENT);
    await expect(provider.exchangeAuthorizationCode(OTHER_CLIENT, code)).rejects.toThrow(
      "not issued to this client",
    );
    await expect(provider.exchangeAuthorizationCode(SHARED_CLIENT, code)).rejects.toThrow(
      "Invalid or expired authorization code",
    );
  });
});
