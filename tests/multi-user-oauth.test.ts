/**
 * Tests for multi-user OAuth auto-mapping (migration v6).
 *
 * Covers:
 * - Migration v6 schema changes
 * - Token-bound principal resolution in resolveAccessContext
 * - Consent-time auto-mapping in OAuth provider
 * - Admin CLI email and oauth-clients subcommand
 * - Conflict detection
 * - Identity resolution (resolveConsentIdentity)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { runMigrations, getSchemaVersion } from "../src/migrations.js";
import {
  resolveAccessContext,
  ownerContext,
  canRead,
  canWrite,
  type NamespaceRule,
} from "../src/access.js";
import {
  addPrincipal,
  showPrincipal,
  listPrincipals,
  updatePrincipal,
  listOAuthClients,
  removeOAuthClient,
  clearOAuthClients,
} from "../src/admin-cli.js";
import { resolveConsentIdentity, type ConsentAuthConfig } from "../src/index.js";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertOAuthClient(db: Database.Database, clientId: string): void {
  db.prepare(
    `INSERT INTO oauth_clients (client_id, redirect_uris, created_at, updated_at)
     VALUES (?, '[]', datetime('now'), datetime('now'))`,
  ).run(clientId);
}

function insertOAuthMapping(
  db: Database.Database,
  oauthClientId: string,
  principalId: string,
  mappedBy = "consent",
): void {
  db.prepare(
    `INSERT INTO principal_oauth_clients (oauth_client_id, principal_id, mapped_at, mapped_by)
     VALUES (?, ?, datetime('now'), ?)`,
  ).run(oauthClientId, principalId, mappedBy);
}

function insertToken(
  db: Database.Database,
  token: string,
  clientId: string,
  principalId?: string,
): void {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare(
    `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at, principal_id)
     VALUES (?, 'access', ?, '[]', ?, datetime('now'), ?)`,
  ).run(tokenHash, clientId, Math.floor(Date.now() / 1000) + 3600, principalId ?? null);
}

function mockRequest(headers: Record<string, string>, remoteAddress = "1.2.3.4"): Request {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress },
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// Migration v6
// ---------------------------------------------------------------------------

describe("migration v6", () => {
  it("creates principal_oauth_clients table", () => {
    const db = makeDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='principal_oauth_clients'")
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("adds email and email_lower columns to principals", () => {
    const db = makeDb();
    const cols = db.pragma("table_info(principals)") as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("email");
    expect(colNames).toContain("email_lower");
    db.close();
  });

  it("adds principal_id column to oauth_auth_codes", () => {
    const db = makeDb();
    const cols = db.pragma("table_info(oauth_auth_codes)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("principal_id");
    db.close();
  });

  it("adds principal_id column to oauth_tokens", () => {
    const db = makeDb();
    const cols = db.pragma("table_info(oauth_tokens)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("principal_id");
    db.close();
  });

  it("auto-creates owner principal row", () => {
    const db = makeDb();
    const owner = db
      .prepare("SELECT principal_id, principal_type FROM principals WHERE principal_id = 'owner'")
      .get() as { principal_id: string; principal_type: string } | undefined;
    expect(owner).toBeDefined();
    expect(owner!.principal_type).toBe("owner");
    db.close();
  });

  it("creates unique index on email_lower", () => {
    const db = makeDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_principals_email_lower'")
      .all();
    expect(indexes).toHaveLength(1);
    db.close();
  });

  it("sets schema version to latest migration", () => {
    const db = makeDb();
    expect(getSchemaVersion(db)).toBe(10);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// resolveAccessContext with token-bound principal
// ---------------------------------------------------------------------------

describe("resolveAccessContext — token-bound principal", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("resolves principal from tokenPrincipalId (step 3)", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });

    const ctx = resolveAccessContext(db, "some-client-id", undefined, "sara");
    expect(ctx.principalId).toBe("sara");
    expect(ctx.principalType).toBe("family");
    expect(canWrite(ctx, "users/sara/notes")).toBe(true);
    expect(canRead(ctx, "projects/foo")).toBe(false);
  });

  it("resolves via principal_oauth_clients mapping table (step 4)", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });
    insertOAuthClient(db, "client-abc");
    insertOAuthMapping(db, "client-abc", "sara");

    const ctx = resolveAccessContext(db, "client-abc");
    expect(ctx.principalId).toBe("sara");
    expect(ctx.principalType).toBe("family");
  });

  it("returns ZERO_ACCESS for revoked principal via token-bound", () => {
    addPrincipal(db, {
      principalId: "revoked-sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });
    // Revoke
    db.prepare("UPDATE principals SET revoked_at = datetime('now') WHERE principal_id = ?")
      .run("revoked-sara");

    const ctx = resolveAccessContext(db, "any-client", undefined, "revoked-sara");
    expect(ctx.principalId).toBe("anonymous");
    expect(ctx.principalType).toBe("external");
  });

  it("returns ZERO_ACCESS for revoked mapping", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });
    insertOAuthClient(db, "revoked-client");
    db.prepare(
      `INSERT INTO principal_oauth_clients (oauth_client_id, principal_id, mapped_at, mapped_by, revoked_at)
       VALUES (?, ?, datetime('now'), 'consent', datetime('now'))`,
    ).run("revoked-client", "sara");

    const ctx = resolveAccessContext(db, "revoked-client");
    expect(ctx.principalId).toBe("anonymous");
  });

  it("multiple clients mapped to same principal all resolve correctly", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });
    insertOAuthClient(db, "client-mobile");
    insertOAuthClient(db, "client-web");
    insertOAuthMapping(db, "client-mobile", "sara");
    insertOAuthMapping(db, "client-web", "sara");

    const ctx1 = resolveAccessContext(db, "client-mobile");
    const ctx2 = resolveAccessContext(db, "client-web");
    expect(ctx1.principalId).toBe("sara");
    expect(ctx2.principalId).toBe("sara");
  });

  it("token-bound principal takes priority over mapping table", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });
    addPrincipal(db, {
      principalId: "bob",
      principalType: "external",
      rules: [{ pattern: "orgs/acme/*", permissions: "rw" }],
    });
    insertOAuthClient(db, "client-x");
    insertOAuthMapping(db, "client-x", "bob");

    // Token says "sara" but mapping says "bob" — token wins
    const ctx = resolveAccessContext(db, "client-x", undefined, "sara");
    expect(ctx.principalId).toBe("sara");
  });

  it("legacy-bearer still returns owner (unchanged)", () => {
    const ctx = resolveAccessContext(db, "legacy-bearer");
    expect(ctx.principalType).toBe("owner");
  });

  it("unmapped client_id with no token returns ZERO_ACCESS", () => {
    const ctx = resolveAccessContext(db, "unknown-client-id");
    expect(ctx.principalId).toBe("anonymous");
    expect(ctx.principalType).toBe("external");
  });
});

// ---------------------------------------------------------------------------
// resolveConsentIdentity
// ---------------------------------------------------------------------------

describe("resolveConsentIdentity", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  const baseConfig: ConsentAuthConfig = {
    trustedHeaderName: "x-proxy-user",
    trustedHeaderValue: "magnus@example.com",
    identityHeaderName: "x-user-email",
    allowLocalhost: false,
  };

  it("returns owner for trusted header match", () => {
    const req = mockRequest({ "x-proxy-user": "magnus@example.com" });
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).not.toBeNull();
    expect(result!.isOwner).toBe(true);
    expect(result!.principalId).toBe("owner");
  });

  it("resolves non-owner principal by email from identity header", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
      email: "sara@example.com",
    });

    const req = mockRequest({ "x-user-email": "sara@example.com" });
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).not.toBeNull();
    expect(result!.principalId).toBe("sara");
    expect(result!.isOwner).toBe(false);
    expect(result!.email).toBe("sara@example.com");
  });

  it("email lookup is case-insensitive", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      email: "Sara@Example.COM",
    });

    const req = mockRequest({ "x-user-email": "sara@example.com" });
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).not.toBeNull();
    expect(result!.principalId).toBe("sara");
  });

  it("returns null for unknown email (fail-closed)", () => {
    const req = mockRequest({ "x-user-email": "unknown@example.com" });
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).toBeNull();
  });

  it("returns null for revoked principal email", () => {
    addPrincipal(db, {
      principalId: "revoked-user",
      principalType: "family",
      rules: [],
      email: "revoked@example.com",
    });
    db.prepare("UPDATE principals SET revoked_at = datetime('now') WHERE principal_id = ?")
      .run("revoked-user");

    const req = mockRequest({ "x-user-email": "revoked@example.com" });
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).toBeNull();
  });

  it("returns null for expired principal email", () => {
    addPrincipal(db, {
      principalId: "expired-user",
      principalType: "family",
      rules: [],
      email: "expired@example.com",
      expiresAt: "2020-01-01T00:00:00Z",
    });

    const req = mockRequest({ "x-user-email": "expired@example.com" });
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).toBeNull();
  });

  it("returns owner for localhost when allowed", () => {
    const config = { ...baseConfig, allowLocalhost: true };
    const req = mockRequest({}, "127.0.0.1");
    const result = resolveConsentIdentity(req, config, db);
    expect(result).not.toBeNull();
    expect(result!.isOwner).toBe(true);
  });

  it("returns null for localhost when not allowed", () => {
    const req = mockRequest({}, "127.0.0.1");
    const result = resolveConsentIdentity(req, baseConfig, db);
    expect(result).toBeNull();
  });

  it("owner via identity header (matched in DB)", () => {
    // The auto-created owner has no email by default; update it
    db.prepare("UPDATE principals SET email = ?, email_lower = ? WHERE principal_id = 'owner'")
      .run("owner@example.com", "owner@example.com");

    const config: ConsentAuthConfig = {
      identityHeaderName: "x-user-email",
      allowLocalhost: false,
    };
    const req = mockRequest({ "x-user-email": "owner@example.com" });
    const result = resolveConsentIdentity(req, config, db);
    expect(result).not.toBeNull();
    expect(result!.principalId).toBe("owner");
    expect(result!.isOwner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin CLI — email support
// ---------------------------------------------------------------------------

describe("admin CLI — email", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("addPrincipal stores email and email_lower", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      email: "Sara@Example.COM",
    });

    const detail = showPrincipal(db, "sara");
    expect(detail).not.toBeNull();
    expect(detail!.email).toBe("Sara@Example.COM");

    // Verify email_lower stored correctly
    const row = db.prepare("SELECT email_lower FROM principals WHERE principal_id = 'sara'")
      .get() as { email_lower: string };
    expect(row.email_lower).toBe("sara@example.com");
  });

  it("updatePrincipal updates email", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    updatePrincipal(db, "sara", { email: "sara@newdomain.com" });
    expect(showPrincipal(db, "sara")!.email).toBe("sara@newdomain.com");
  });

  it("updatePrincipal clears email with null", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      email: "sara@example.com",
    });
    updatePrincipal(db, "sara", { email: null });
    expect(showPrincipal(db, "sara")!.email).toBeNull();
  });

  it("listPrincipals includes email", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      email: "sara@example.com",
    });

    const list = listPrincipals(db);
    const sara = list.find((p) => p.principalId === "sara");
    expect(sara).toBeDefined();
    expect(sara!.email).toBe("sara@example.com");
  });

  it("rejects duplicate email_lower", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      email: "sara@example.com",
    });

    expect(() =>
      addPrincipal(db, {
        principalId: "sara2",
        principalType: "family",
        rules: [],
        email: "SARA@example.com", // same when lowercased
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Admin CLI — oauth-clients subcommand
// ---------------------------------------------------------------------------

describe("admin CLI — oauth-clients", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("listOAuthClients returns empty for no mappings", () => {
    expect(listOAuthClients(db)).toEqual([]);
  });

  it("listOAuthClients returns all mappings", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClient(db, "client-1");
    insertOAuthClient(db, "client-2");
    insertOAuthMapping(db, "client-1", "sara");
    insertOAuthMapping(db, "client-2", "sara");

    const result = listOAuthClients(db);
    expect(result).toHaveLength(2);
  });

  it("listOAuthClients filters by principal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    addPrincipal(db, {
      principalId: "bob",
      principalType: "external",
      rules: [{ pattern: "orgs/acme/*", permissions: "rw" }],
    });
    insertOAuthClient(db, "client-sara");
    insertOAuthClient(db, "client-bob");
    insertOAuthMapping(db, "client-sara", "sara");
    insertOAuthMapping(db, "client-bob", "bob");

    expect(listOAuthClients(db, "sara")).toHaveLength(1);
    expect(listOAuthClients(db, "sara")[0].oauthClientId).toBe("client-sara");
    expect(listOAuthClients(db, "bob")).toHaveLength(1);
  });

  it("removeOAuthClient deletes mapping and revokes tokens", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClient(db, "client-rm");
    insertOAuthMapping(db, "client-rm", "sara");
    insertToken(db, "token-1", "client-rm", "sara");

    expect(removeOAuthClient(db, "client-rm")).toBe(true);
    expect(listOAuthClients(db, "sara")).toHaveLength(0);

    // Token should be revoked
    const token = db.prepare("SELECT revoked FROM oauth_tokens WHERE client_id = 'client-rm'")
      .get() as { revoked: number } | undefined;
    expect(token?.revoked).toBe(1);
  });

  it("removeOAuthClient returns false for non-existent", () => {
    expect(removeOAuthClient(db, "nonexistent")).toBe(false);
  });

  it("clearOAuthClients removes all mappings for principal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClient(db, "c1");
    insertOAuthClient(db, "c2");
    insertOAuthClient(db, "c3");
    insertOAuthMapping(db, "c1", "sara");
    insertOAuthMapping(db, "c2", "sara");
    insertOAuthMapping(db, "c3", "sara");

    expect(clearOAuthClients(db, "sara")).toBe(3);
    expect(listOAuthClients(db, "sara")).toHaveLength(0);
  });

  it("showPrincipal includes oauthClients", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClient(db, "client-show");
    insertOAuthMapping(db, "client-show", "sara");

    const detail = showPrincipal(db, "sara");
    expect(detail!.oauthClients).toHaveLength(1);
    expect(detail!.oauthClients[0].oauthClientId).toBe("client-show");
    expect(detail!.oauthClients[0].mappedBy).toBe("consent");
  });
});

// ---------------------------------------------------------------------------
// OAuth provider — token-bound principal
// ---------------------------------------------------------------------------

describe("OAuth token principal binding", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("oauth_tokens table accepts principal_id", () => {
    insertOAuthClient(db, "test-client");
    db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at, principal_id)
       VALUES ('hash1', 'access', 'test-client', '[]', ?, datetime('now'), 'sara')`,
    ).run(Math.floor(Date.now() / 1000) + 3600);

    const row = db.prepare("SELECT principal_id FROM oauth_tokens WHERE token = 'hash1'")
      .get() as { principal_id: string };
    expect(row.principal_id).toBe("sara");
  });

  it("oauth_auth_codes table accepts principal_id", () => {
    insertOAuthClient(db, "test-client");
    db.prepare(
      `INSERT INTO oauth_auth_codes (code, client_id, code_challenge, redirect_uri, scopes, expires_at, created_at, principal_id)
       VALUES ('hash2', 'test-client', 'challenge', 'http://localhost/cb', '[]', ?, datetime('now'), 'sara')`,
    ).run(Math.floor(Date.now() / 1000) + 600);

    const row = db.prepare("SELECT principal_id FROM oauth_auth_codes WHERE code = 'hash2'")
      .get() as { principal_id: string };
    expect(row.principal_id).toBe("sara");
  });

  it("null principal_id is valid (pre-v6 compat)", () => {
    insertOAuthClient(db, "test-client");
    db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at, principal_id)
       VALUES ('hash3', 'access', 'test-client', '[]', ?, datetime('now'), NULL)`,
    ).run(Math.floor(Date.now() / 1000) + 3600);

    const row = db.prepare("SELECT principal_id FROM oauth_tokens WHERE token = 'hash3'")
      .get() as { principal_id: string | null };
    expect(row.principal_id).toBeNull();
  });
});
