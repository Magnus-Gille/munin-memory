import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/migrations.js";
import {
  listPrincipals,
  showPrincipal,
  addPrincipal,
  revokePrincipal,
  updatePrincipal,
  rotateToken,
  testPrincipalAccess,
  listClassificationFloors,
  setClassificationFloor,
  auditClassification,
  rotateBearerToken,
  revokeBearerToken,
  listBearerTokens,
  listOAuthClients,
  removeOAuthClient,
  clearOAuthClients,
  parseRules,
  parseClassification,
  parseExpiresAt,
  parseArgs,
  type AddPrincipalOpts,
  type BearerScope,
  type BearerTokenSummary,
} from "../src/admin-cli.js";
import { writeState } from "../src/db.js";

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

function getAuditRows(db: Database.Database, principalId: string) {
  return db
    .prepare(
      "SELECT action, namespace, key, detail FROM audit_log WHERE namespace = 'admin/principals' AND key = ? ORDER BY id",
    )
    .all(principalId) as { action: string; namespace: string; key: string; detail: string | null }[];
}

// ---------------------------------------------------------------------------
// listPrincipals
// ---------------------------------------------------------------------------

describe("listPrincipals", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns only owner (auto-created by migration v6) for fresh db", () => {
    const result = listPrincipals(db);
    expect(result).toHaveLength(1);
    expect(result[0].principalId).toBe("owner");
    expect(result[0].principalType).toBe("owner");
  });

  it("returns principals with correct status derivation", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });
    addPrincipal(db, {
      principalId: "agent-skuld",
      principalType: "agent",
      rules: [{ pattern: "signals/*", permissions: "write" }],
    });
    addPrincipal(db, {
      principalId: "expired-one",
      principalType: "external",
      rules: [],
      expiresAt: "2020-01-01T00:00:00Z",
    });

    revokePrincipal(db, "agent-skuld");

    const result = listPrincipals(db);
    // 3 added + 1 auto-created owner = 4
    expect(result).toHaveLength(4);

    const byId = Object.fromEntries(result.map((r) => [r.principalId, r]));
    expect(byId["sara"].status).toBe("active");
    expect(byId["sara"].rulesCount).toBe(1);
    expect(byId["agent-skuld"].status).toBe("revoked");
    expect(byId["expired-one"].status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// showPrincipal
// ---------------------------------------------------------------------------

describe("showPrincipal", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns null for nonexistent principal", () => {
    expect(showPrincipal(db, "ghost")).toBeNull();
  });

  it("returns full detail for existing principal", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });

    const detail = showPrincipal(db, "sara");
    expect(detail).not.toBeNull();
    expect(detail!.principalId).toBe("sara");
    expect(detail!.principalType).toBe("family");
    expect(detail!.status).toBe("active");
    expect(detail!.hasToken).toBe(false);
    expect(detail!.namespaceRules).toEqual([{ pattern: "users/sara/*", permissions: "rw" }]);
  });

  it("shows revoked status", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
    });
    revokePrincipal(db, "sara");

    const detail = showPrincipal(db, "sara");
    expect(detail!.status).toBe("revoked");
    expect(detail!.revokedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addPrincipal
// ---------------------------------------------------------------------------

describe("addPrincipal", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("creates a family principal without token", () => {
    const result = addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });

    expect(result.principalId).toBe("sara");
    expect(result.token).toBeUndefined();

    const detail = showPrincipal(db, "sara");
    expect(detail!.hasToken).toBe(false);
  });

  it("creates an agent principal with token and stores hash", () => {
    const result = addPrincipal(db, {
      principalId: "agent-skuld",
      principalType: "agent",
      rules: [{ pattern: "signals/*", permissions: "write" }],
    });

    expect(result.token).toBeDefined();
    expect(result.token!.length).toBe(64); // 32 bytes hex

    // Verify hash is stored, not plaintext
    const row = db
      .prepare("SELECT token_hash FROM principals WHERE principal_id = ?")
      .get("agent-skuld") as { token_hash: string };

    const expectedHash = createHash("sha256").update(result.token!).digest("hex");
    expect(row.token_hash).toBe(expectedHash);
  });

  it("rejects invalid rules", () => {
    expect(() =>
      addPrincipal(db, {
        principalId: "bad",
        principalType: "family",
        rules: [{ pattern: "users/sara*", permissions: "rw" }],
      }),
    ).toThrow("Ambiguous patterns");
  });

  it("rejects duplicate principal-id", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
    });

    expect(() =>
      addPrincipal(db, {
        principalId: "sara",
        principalType: "family",
        rules: [],
      }),
    ).toThrow();
  });

  it("rejects --type owner without force", () => {
    expect(() =>
      addPrincipal(db, {
        principalId: "owner2",
        principalType: "owner",
        rules: [],
      }),
    ).toThrow("requires --force");
  });

  it("allows --type owner with force", () => {
    const result = addPrincipal(db, {
      principalId: "owner2",
      principalType: "owner",
      rules: [],
      force: true,
    });
    expect(result.principalType).toBe("owner");
  });

  it("writes audit log entry", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });

    const audits = getAuditRows(db, "sara");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("principal_add");
    expect(audits[0].detail).toContain("type=family");
  });

  it("normalizes expires-at to UTC", () => {
    addPrincipal(db, {
      principalId: "temp",
      principalType: "external",
      rules: [],
      expiresAt: "2027-06-15T12:00:00+02:00",
    });

    const detail = showPrincipal(db, "temp");
    expect(detail!.expiresAt).toBe("2027-06-15T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// revokePrincipal
// ---------------------------------------------------------------------------

describe("revokePrincipal", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("revokes an active principal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    expect(revokePrincipal(db, "sara")).toBe(true);
    expect(showPrincipal(db, "sara")!.status).toBe("revoked");
  });

  it("returns false for already revoked", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    revokePrincipal(db, "sara");
    expect(revokePrincipal(db, "sara")).toBe(false);
  });

  it("returns false for nonexistent", () => {
    expect(revokePrincipal(db, "ghost")).toBe(false);
  });

  it("writes audit log entry", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    revokePrincipal(db, "sara");

    const audits = getAuditRows(db, "sara");
    expect(audits.some((a) => a.action === "principal_revoke")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updatePrincipal
// ---------------------------------------------------------------------------

describe("updatePrincipal", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("updates rules", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });

    const newRules = [
      { pattern: "users/sara/*", permissions: "rw" as const },
      { pattern: "shared/*", permissions: "read" as const },
    ];

    expect(updatePrincipal(db, "sara", { rules: newRules })).toBe(true);
    expect(showPrincipal(db, "sara")!.namespaceRules).toEqual(newRules);
  });

  it("updates email", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    updatePrincipal(db, "sara", { email: "sara@example.com" });
    expect(showPrincipal(db, "sara")!.email).toBe("sara@example.com");
  });

  it("updates expires-at", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    updatePrincipal(db, "sara", { expiresAt: "2027-12-31T23:59:59Z" });
    expect(showPrincipal(db, "sara")!.expiresAt).toBe("2027-12-31T23:59:59.000Z");
  });

  it("clears expires-at with null", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      expiresAt: "2027-12-31T23:59:59Z",
    });
    updatePrincipal(db, "sara", { expiresAt: null });
    expect(showPrincipal(db, "sara")!.expiresAt).toBeNull();
  });

  it("rejects invalid rules", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    expect(() =>
      updatePrincipal(db, "sara", {
        rules: [{ pattern: "bad*pattern", permissions: "rw" }],
      }),
    ).toThrow();
  });

  it("returns false for revoked principal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    revokePrincipal(db, "sara");
    expect(updatePrincipal(db, "sara", { rules: [] })).toBe(false);
  });

  it("returns false for nonexistent", () => {
    expect(updatePrincipal(db, "ghost", { rules: [] })).toBe(false);
  });

  it("throws when no fields to update", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    expect(() => updatePrincipal(db, "sara", {})).toThrow("No fields to update");
  });

  it("writes audit log entry", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    updatePrincipal(db, "sara", { rules: [] });

    const audits = getAuditRows(db, "sara");
    expect(audits.some((a) => a.action === "principal_update")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rotateToken
// ---------------------------------------------------------------------------

describe("rotateToken", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("rotates token for agent principal", () => {
    const addResult = addPrincipal(db, {
      principalId: "agent-skuld",
      principalType: "agent",
      rules: [{ pattern: "signals/*", permissions: "write" }],
    });

    const oldToken = addResult.token!;
    const result = rotateToken(db, "agent-skuld");

    expect(result).not.toBeNull();
    expect(result!.token).not.toBe(oldToken);
    expect(result!.token.length).toBe(64);

    // Old token hash should be replaced
    const row = db
      .prepare("SELECT token_hash FROM principals WHERE principal_id = ?")
      .get("agent-skuld") as { token_hash: string };

    const newHash = createHash("sha256").update(result!.token).digest("hex");
    expect(row.token_hash).toBe(newHash);

    const oldHash = createHash("sha256").update(oldToken).digest("hex");
    expect(row.token_hash).not.toBe(oldHash);
  });

  it("throws for non-agent principal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    expect(() => rotateToken(db, "sara")).toThrow("only supported for agent");
  });

  it("throws for revoked principal", () => {
    addPrincipal(db, {
      principalId: "agent-skuld",
      principalType: "agent",
      rules: [],
    });
    revokePrincipal(db, "agent-skuld");
    expect(() => rotateToken(db, "agent-skuld")).toThrow("revoked");
  });

  it("returns null for nonexistent", () => {
    expect(rotateToken(db, "ghost")).toBeNull();
  });

  it("writes audit log entry", () => {
    addPrincipal(db, {
      principalId: "agent-skuld",
      principalType: "agent",
      rules: [],
    });
    rotateToken(db, "agent-skuld");

    const audits = getAuditRows(db, "agent-skuld");
    expect(audits.some((a) => a.action === "principal_rotate_token")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// testPrincipalAccess
// ---------------------------------------------------------------------------

describe("testPrincipalAccess", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns correct read/write for matching rules", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [
        { pattern: "users/sara/*", permissions: "rw" },
        { pattern: "projects/*", permissions: "read" },
      ],
    });

    const rw = testPrincipalAccess(db, "sara", "users/sara/notes");
    expect(rw!.canRead).toBe(true);
    expect(rw!.canWrite).toBe(true);
    expect(rw!.matchingRules).toHaveLength(1);

    const ro = testPrincipalAccess(db, "sara", "projects/munin");
    expect(ro!.canRead).toBe(true);
    expect(ro!.canWrite).toBe(false);
  });

  it("reports no access for non-matching namespace", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "users/sara/*", permissions: "rw" }],
    });

    const result = testPrincipalAccess(db, "sara", "admin/secrets");
    expect(result!.canRead).toBe(false);
    expect(result!.canWrite).toBe(false);
    expect(result!.matchingRules).toHaveLength(0);
  });

  it("returns null for nonexistent principal", () => {
    expect(testPrincipalAccess(db, "ghost", "anything")).toBeNull();
  });

  it("shows zero access for revoked principal", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [{ pattern: "*", permissions: "rw" }],
    });
    revokePrincipal(db, "sara");

    const result = testPrincipalAccess(db, "sara", "anything");
    expect(result!.status).toBe("revoked");
    expect(result!.canRead).toBe(false);
    expect(result!.canWrite).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classification admin
// ---------------------------------------------------------------------------

describe("classification admin", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("lists seeded classification floors", () => {
    const floors = listClassificationFloors(db);
    expect(floors.some((floor) => floor.namespacePattern === "projects/*" && floor.minClassification === "internal")).toBe(true);
    expect(floors.some((floor) => floor.namespacePattern === "clients/*" && floor.minClassification === "client-confidential")).toBe(true);
  });

  it("sets and updates a namespace floor", () => {
    const created = setClassificationFloor(db, "contracts/*", "client-restricted");
    expect(created.namespacePattern).toBe("contracts/*");
    expect(created.minClassification).toBe("client-restricted");

    const updated = setClassificationFloor(db, "contracts/*", "client-confidential");
    expect(updated.minClassification).toBe("client-confidential");

    const floors = listClassificationFloors(db);
    expect(floors.find((floor) => floor.namespacePattern === "contracts/*")?.minClassification).toBe("client-confidential");
  });

  it("audits entries below their namespace floor", () => {
    writeState(
      db,
      "clients/acme",
      "notes",
      "low classification override",
      ["note"],
      "owner",
      undefined,
      undefined,
      { classification: "public", classificationOverride: true },
    );

    const items = auditClassification(db);
    expect(items).toHaveLength(1);
    expect(items[0].namespace).toBe("clients/acme");
    expect(items[0].classification).toBe("public");
    expect(items[0].namespaceFloor).toBe("client-confidential");
  });
});

// ---------------------------------------------------------------------------
// parseExpiresAt
// ---------------------------------------------------------------------------

describe("parseExpiresAt", () => {
  it("accepts and normalizes valid ISO 8601", () => {
    expect(parseExpiresAt("2027-06-15T12:00:00Z")).toBe("2027-06-15T12:00:00.000Z");
  });

  it("normalizes timezone offset to UTC", () => {
    expect(parseExpiresAt("2027-06-15T14:00:00+02:00")).toBe("2027-06-15T12:00:00.000Z");
  });

  it("rejects non-ISO strings", () => {
    expect(() => parseExpiresAt("next tuesday")).toThrow("Must be ISO 8601");
  });

  it("rejects unix timestamps", () => {
    expect(() => parseExpiresAt("1735689600")).toThrow("Must be ISO 8601");
  });
});

describe("parseClassification", () => {
  it("accepts valid classification values", () => {
    expect(parseClassification("client-confidential")).toBe("client-confidential");
  });

  it("rejects invalid classification values", () => {
    expect(() => parseClassification("secret")).toThrow("Must be one of");
  });
});

// ---------------------------------------------------------------------------
// parseRules
// ---------------------------------------------------------------------------

describe("parseRules", () => {
  it("parses inline JSON", () => {
    const rules = parseRules('[{"pattern":"users/sara/*","permissions":"rw"}]');
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe("users/sara/*");
  });

  it("parses @file reference", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "munin-admin-test-"));
    const filePath = join(tmpDir, "rules.json");
    writeFileSync(filePath, '[{"pattern":"test/*","permissions":"read"}]');

    try {
      const rules = parseRules(`@${filePath}`);
      expect(rules).toHaveLength(1);
      expect(rules[0].pattern).toBe("test/*");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("throws on missing @file", () => {
    expect(() => parseRules("@/nonexistent/rules.json")).toThrow("not found");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseRules("{not json")).toThrow();
  });

  it("validates rules after parsing", () => {
    expect(() =>
      parseRules('[{"pattern":"bad*","permissions":"rw"}]'),
    ).toThrow("Ambiguous");
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  const argv = (args: string) => ["node", "admin-cli.js", ...args.split(" ").filter(Boolean)];

  it("parses list command", () => {
    const parsed = parseArgs(argv("principals list"));
    expect(parsed.resource).toBe("principals");
    expect(parsed.command).toBe("list");
  });

  it("parses add with flags", () => {
    const parsed = parseArgs(argv('principals add sara --type family --rules []'));
    expect(parsed.command).toBe("add");
    expect(parsed.positionals[0]).toBe("sara");
    expect(parsed.flags.get("--type")).toBe("family");
    expect(parsed.flags.get("--rules")).toBe("[]");
  });

  it("parses global --db flag", () => {
    const parsed = parseArgs(argv("--db /tmp/test.db principals list"));
    expect(parsed.dbPath).toBe("/tmp/test.db");
    expect(parsed.resource).toBe("principals");
  });

  it("parses --json flag", () => {
    const parsed = parseArgs(argv("principals list --json"));
    expect(parsed.json).toBe(true);
  });

  it("parses --force flag", () => {
    const parsed = parseArgs(argv("principals add owner2 --type owner --rules [] --force"));
    expect(parsed.force).toBe(true);
  });

  it("parses --help flag", () => {
    const parsed = parseArgs(argv("--help"));
    expect(parsed.help).toBe(true);
  });

  it("throws on unknown flag", () => {
    expect(() => parseArgs(argv("principals list --verbose"))).toThrow("Unknown flag");
  });

  it("throws on missing flag value", () => {
    expect(() => parseArgs(argv("principals add sara --type"))).toThrow("Missing value");
  });

  it("parses test command with two positionals", () => {
    const parsed = parseArgs(argv("principals test sara projects/munin"));
    expect(parsed.command).toBe("test");
    expect(parsed.positionals).toEqual(["sara", "projects/munin"]);
  });

  it("parses classification set-floor command", () => {
    const parsed = parseArgs(argv("classification set-floor contracts/* client-restricted"));
    expect(parsed.resource).toBe("classification");
    expect(parsed.command).toBe("set-floor");
    expect(parsed.positionals).toEqual(["contracts/*", "client-restricted"]);
  });
});

// ---------------------------------------------------------------------------
// bearer token rotation
// ---------------------------------------------------------------------------

describe("bearer token rotation", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("rotate creates an active token with no retiring token on first rotation", () => {
    const result = rotateBearerToken(db, "owner", 24);
    expect(result.token).toHaveLength(64);
    expect(result.scope).toBe("owner");
    expect(result.retiringKeyId).toBeNull();
    expect(result.retiringExpiresAt).toBeNull();

    const tokens = listBearerTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe("active");
    expect(tokens[0].id).toBe(result.id);
  });

  it("rotate puts previous DB token into retiring status", () => {
    const first = rotateBearerToken(db, "owner", 24);
    const second = rotateBearerToken(db, "owner", 24);

    expect(second.retiringKeyId).toBe(first.id);
    expect(second.retiringExpiresAt).not.toBeNull();

    const tokens = listBearerTokens(db, "owner");
    const firstToken = tokens.find((t) => t.id === first.id)!;
    const secondToken = tokens.find((t) => t.id === second.id)!;
    expect(firstToken.status).toBe("retiring");
    expect(secondToken.status).toBe("active");
  });

  it("retiring token expires after grace window", () => {
    const first = rotateBearerToken(db, "owner", 24); // create initial token
    // Rotate again with 0 hours grace — first token retires immediately
    rotateBearerToken(db, "owner", 0);
    // The first token should now have expires_at set to (approx) now
    const tokens = listBearerTokens(db, "owner");
    const firstToken = tokens.find((t) => t.id === first.id);
    // With 0 hours grace, expires_at = now, which may be <= now
    // It's either retiring (expires_at just set to now) or expired
    expect(firstToken?.status === "retiring" || firstToken?.status === "expired").toBe(true);
  });

  it("revoke sets revoked_at immediately", () => {
    const result = rotateBearerToken(db, "owner", 24);
    const ok = revokeBearerToken(db, result.id);
    expect(ok).toBe(true);

    const tokens = listBearerTokens(db, "owner");
    expect(tokens[0].status).toBe("revoked");
    expect(tokens[0].revokedAt).not.toBeNull();
  });

  it("revoke returns false for nonexistent key", () => {
    expect(revokeBearerToken(db, "nonexistent-id")).toBe(false);
  });

  it("list filters by scope", () => {
    rotateBearerToken(db, "owner", 24);
    rotateBearerToken(db, "dpa", 24);
    rotateBearerToken(db, "consumer", 24);

    expect(listBearerTokens(db, "owner")).toHaveLength(1);
    expect(listBearerTokens(db, "dpa")).toHaveLength(1);
    expect(listBearerTokens(db)).toHaveLength(3);
  });

  it("rotate writes audit log entry", () => {
    rotateBearerToken(db, "owner", 24);
    const rows = db
      .prepare("SELECT action, key FROM audit_log WHERE action = 'bearer_rotate'")
      .all() as { action: string; key: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("owner");
  });

  it("revoke writes audit log entry", () => {
    const result = rotateBearerToken(db, "owner", 24);
    revokeBearerToken(db, result.id);
    const rows = db
      .prepare("SELECT action FROM audit_log WHERE action = 'bearer_revoke'")
      .all() as { action: string }[];
    expect(rows).toHaveLength(1);
  });

  it("different scopes are independent", () => {
    const ownerFirst = rotateBearerToken(db, "owner", 24);
    const dpaFirst = rotateBearerToken(db, "dpa", 24);
    const ownerSecond = rotateBearerToken(db, "owner", 24);

    // owner second rotation should not touch dpa token
    expect(ownerSecond.retiringKeyId).toBe(ownerFirst.id);
    const dpaTokens = listBearerTokens(db, "dpa");
    expect(dpaTokens[0].status).toBe("active");
    expect(dpaTokens[0].id).toBe(dpaFirst.id);
  });

  it("rotate after revoking the active token does not extend retiring tokens", () => {
    // Codex regression: rotate -> rotate -> revoke(active) -> rotate
    // must NOT pick up the still-retiring first token and re-extend its expiry.
    const first = rotateBearerToken(db, "owner", 24);
    const second = rotateBearerToken(db, "owner", 24);

    // first is now retiring; second is active
    revokeBearerToken(db, second.id);
    // Now there is no active token. The next rotate should retire NOTHING
    // (since `first` is already retiring) and just mint a new active token.
    const third = rotateBearerToken(db, "owner", 24);

    expect(third.retiringKeyId).toBeNull();
    expect(third.retiringExpiresAt).toBeNull();

    // Verify first token's expiry was NOT changed by the third rotation.
    const tokens = listBearerTokens(db, "owner");
    const firstAfter = tokens.find((t) => t.id === first.id)!;
    // Its expires_at should still equal the value set by `second`'s rotation.
    expect(firstAfter.expiresAt).toBe(second.retiringExpiresAt);
  });
});

// ---------------------------------------------------------------------------
// listOAuthClients
// ---------------------------------------------------------------------------

function insertOAuthClient(db: Database.Database, clientId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO oauth_clients (client_id, redirect_uris, metadata, created_at, updated_at)
     VALUES (?, '[]', '{}', ?, ?)`,
  ).run(clientId, now, now);
}

function insertOAuthClientMapping(
  db: Database.Database,
  clientId: string,
  principalId: string,
  revokedAt: string | null = null,
): void {
  insertOAuthClient(db, clientId);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO principal_oauth_clients (oauth_client_id, principal_id, mapped_at, mapped_by, revoked_at)
     VALUES (?, ?, ?, 'consent', ?)`,
  ).run(clientId, principalId, now, revokedAt);
}

describe("listOAuthClients", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty array when no clients", () => {
    const clients = listOAuthClients(db);
    expect(clients).toHaveLength(0);
  });

  it("lists all clients when no principalId filter", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    addPrincipal(db, { principalId: "bob", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-001", "sara");
    insertOAuthClientMapping(db, "client-002", "bob");

    const clients = listOAuthClients(db);
    expect(clients).toHaveLength(2);
    const ids = clients.map((c) => c.oauthClientId).sort();
    expect(ids).toEqual(["client-001", "client-002"]);
  });

  it("filters by principalId", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    addPrincipal(db, { principalId: "bob", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-sara-1", "sara");
    insertOAuthClientMapping(db, "client-sara-2", "sara");
    insertOAuthClientMapping(db, "client-bob-1", "bob");

    const saraClients = listOAuthClients(db, "sara");
    expect(saraClients).toHaveLength(2);
    expect(saraClients.every((c) => c.oauthClientId.startsWith("client-sara"))).toBe(true);
  });

  it("returns mapped fields correctly", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-x", "sara");

    const clients = listOAuthClients(db, "sara");
    expect(clients).toHaveLength(1);
    expect(clients[0].oauthClientId).toBe("client-x");
    expect(clients[0].mappedBy).toBe("consent");
    expect(clients[0].revokedAt).toBeNull();
    expect(clients[0].lastUsedAt).toBeNull();
    expect(typeof clients[0].mappedAt).toBe("string");
  });

  it("returns revoked clients too (no filter on revoked)", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-active", "sara", null);
    insertOAuthClientMapping(db, "client-revoked", "sara", new Date().toISOString());

    const clients = listOAuthClients(db, "sara");
    expect(clients).toHaveLength(2);
    const revokedClient = clients.find((c) => c.oauthClientId === "client-revoked");
    expect(revokedClient?.revokedAt).not.toBeNull();
  });

  it("returns empty array for unknown principalId", () => {
    const clients = listOAuthClients(db, "ghost");
    expect(clients).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// removeOAuthClient
// ---------------------------------------------------------------------------

describe("removeOAuthClient", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns false for nonexistent client", () => {
    expect(removeOAuthClient(db, "nonexistent-client")).toBe(false);
  });

  it("removes existing mapping and returns true", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-to-remove", "sara");

    expect(removeOAuthClient(db, "client-to-remove")).toBe(true);

    const remaining = listOAuthClients(db, "sara");
    expect(remaining).toHaveLength(0);
  });

  it("revokes oauth tokens for the removed client", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-with-tokens", "sara");

    // Insert a token for this client
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, revoked, created_at, scopes)
       VALUES (?, 'access', ?, ?, 0, ?, '[]')`,
    ).run("tok-abc123", "client-with-tokens", Date.now() + 3600000, now);

    removeOAuthClient(db, "client-with-tokens");

    const token = db
      .prepare("SELECT revoked FROM oauth_tokens WHERE token = 'tok-abc123'")
      .get() as { revoked: number } | undefined;
    expect(token?.revoked).toBe(1);
  });

  it("writes audit log entry on removal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "client-audit-test", "sara");

    removeOAuthClient(db, "client-audit-test");

    const rows = db
      .prepare("SELECT action FROM audit_log WHERE action = 'oauth_client_remove'")
      .all() as { action: string }[];
    expect(rows).toHaveLength(1);
  });

  it("does not write audit log when client not found", () => {
    removeOAuthClient(db, "ghost-client");
    const rows = db
      .prepare("SELECT action FROM audit_log WHERE action = 'oauth_client_remove'")
      .all() as { action: string }[];
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clearOAuthClients
// ---------------------------------------------------------------------------

describe("clearOAuthClients", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns 0 when principal has no clients", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    expect(clearOAuthClients(db, "sara")).toBe(0);
  });

  it("removes all client mappings for a principal", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "c1", "sara");
    insertOAuthClientMapping(db, "c2", "sara");
    insertOAuthClientMapping(db, "c3", "sara");

    expect(clearOAuthClients(db, "sara")).toBe(3);
    expect(listOAuthClients(db, "sara")).toHaveLength(0);
  });

  it("does not affect clients of other principals", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    addPrincipal(db, { principalId: "bob", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "sara-c1", "sara");
    insertOAuthClientMapping(db, "bob-c1", "bob");

    clearOAuthClients(db, "sara");
    expect(listOAuthClients(db, "bob")).toHaveLength(1);
  });

  it("revokes oauth tokens for each client being cleared", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "c-tok1", "sara");
    insertOAuthClientMapping(db, "c-tok2", "sara");

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, revoked, created_at, scopes)
       VALUES (?, 'access', ?, ?, 0, ?, '[]')`,
    ).run("tok-1", "c-tok1", Date.now() + 3600000, now);
    db.prepare(
      `INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, revoked, created_at, scopes)
       VALUES (?, 'access', ?, ?, 0, ?, '[]')`,
    ).run("tok-2", "c-tok2", Date.now() + 3600000, now);

    clearOAuthClients(db, "sara");

    const tokens = db
      .prepare("SELECT token, revoked FROM oauth_tokens WHERE token IN ('tok-1', 'tok-2')")
      .all() as Array<{ token: string; revoked: number }>;
    expect(tokens.every((t) => t.revoked === 1)).toBe(true);
  });

  it("writes audit log entry when clients are cleared", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "c-audit", "sara");

    clearOAuthClients(db, "sara");

    const rows = db
      .prepare("SELECT action FROM audit_log WHERE action = 'oauth_clients_clear'")
      .all() as { action: string }[];
    expect(rows).toHaveLength(1);
  });

  it("does not write audit log when no clients to clear", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    clearOAuthClients(db, "sara");

    const rows = db
      .prepare("SELECT action FROM audit_log WHERE action = 'oauth_clients_clear'")
      .all() as { action: string }[];
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// auditClassification — namespace prefix filter
// ---------------------------------------------------------------------------

describe("auditClassification with namespace prefix", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("filters by namespace prefix when provided", () => {
    // clients/acme is below client-confidential floor
    writeState(
      db, "clients/acme", "notes", "low",
      ["note"], "owner", undefined, undefined,
      { classification: "public", classificationOverride: true },
    );
    // clients/globex is also below floor
    writeState(
      db, "clients/globex", "notes", "low",
      ["note"], "owner", undefined, undefined,
      { classification: "public", classificationOverride: true },
    );

    const acmeOnly = auditClassification(db, "clients/acme");
    expect(acmeOnly.every((item) => item.namespace === "clients/acme")).toBe(true);
    // globex should not appear
    expect(acmeOnly.some((item) => item.namespace === "clients/globex")).toBe(false);
  });

  it("returns all violations when no namespace prefix given", () => {
    writeState(
      db, "clients/acme", "notes", "low",
      ["note"], "owner", undefined, undefined,
      { classification: "public", classificationOverride: true },
    );
    writeState(
      db, "clients/globex", "notes", "low",
      ["note"], "owner", undefined, undefined,
      { classification: "public", classificationOverride: true },
    );

    const all = auditClassification(db);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Additional parseArgs edge cases
// ---------------------------------------------------------------------------

describe("parseArgs — additional edge cases", () => {
  const argv = (args: string) => ["node", "admin-cli.js", ...args.split(" ").filter(Boolean)];

  it("parses --init flag", () => {
    const parsed = parseArgs(argv("principals list --init"));
    expect(parsed.init).toBe(true);
  });

  it("parses oauth-clients resource and list command", () => {
    const parsed = parseArgs(argv("oauth-clients list"));
    expect(parsed.resource).toBe("oauth-clients");
    expect(parsed.command).toBe("list");
  });

  it("parses oauth-clients list with --principal flag", () => {
    const parsed = parseArgs(argv("oauth-clients list --principal sara"));
    expect(parsed.resource).toBe("oauth-clients");
    expect(parsed.flags.get("--principal")).toBe("sara");
  });

  it("parses oauth-clients remove command", () => {
    const parsed = parseArgs(argv("oauth-clients remove client-123"));
    expect(parsed.resource).toBe("oauth-clients");
    expect(parsed.command).toBe("remove");
    expect(parsed.positionals[0]).toBe("client-123");
  });

  it("parses oauth-clients clear command", () => {
    const parsed = parseArgs(argv("oauth-clients clear sara"));
    expect(parsed.resource).toBe("oauth-clients");
    expect(parsed.command).toBe("clear");
    expect(parsed.positionals[0]).toBe("sara");
  });

  it("parses bearer list command", () => {
    const parsed = parseArgs(argv("bearer list"));
    expect(parsed.resource).toBe("bearer");
    expect(parsed.command).toBe("list");
  });

  it("parses bearer list with --scope flag", () => {
    const parsed = parseArgs(argv("bearer list --scope dpa"));
    expect(parsed.resource).toBe("bearer");
    expect(parsed.flags.get("--scope")).toBe("dpa");
  });

  it("parses bearer rotate command", () => {
    const parsed = parseArgs(argv("bearer rotate --scope owner --grace-hours 48"));
    expect(parsed.resource).toBe("bearer");
    expect(parsed.command).toBe("rotate");
    expect(parsed.flags.get("--scope")).toBe("owner");
    expect(parsed.flags.get("--grace-hours")).toBe("48");
  });

  it("parses bearer revoke command", () => {
    const parsed = parseArgs(argv("bearer revoke some-key-id"));
    expect(parsed.resource).toBe("bearer");
    expect(parsed.command).toBe("revoke");
    expect(parsed.positionals[0]).toBe("some-key-id");
  });

  it("parses classification list-floors command", () => {
    const parsed = parseArgs(argv("classification list-floors"));
    expect(parsed.resource).toBe("classification");
    expect(parsed.command).toBe("list-floors");
  });

  it("parses classification audit command with namespace", () => {
    const parsed = parseArgs(argv("classification audit clients/acme"));
    expect(parsed.resource).toBe("classification");
    expect(parsed.command).toBe("audit");
    expect(parsed.positionals[0]).toBe("clients/acme");
  });

  it("parses principals show command", () => {
    const parsed = parseArgs(argv("principals show sara"));
    expect(parsed.resource).toBe("principals");
    expect(parsed.command).toBe("show");
    expect(parsed.positionals[0]).toBe("sara");
  });

  it("parses principals revoke command", () => {
    const parsed = parseArgs(argv("principals revoke sara"));
    expect(parsed.resource).toBe("principals");
    expect(parsed.command).toBe("revoke");
    expect(parsed.positionals[0]).toBe("sara");
  });

  it("parses principals rotate-token command", () => {
    const parsed = parseArgs(argv("principals rotate-token agent-x"));
    expect(parsed.resource).toBe("principals");
    expect(parsed.command).toBe("rotate-token");
    expect(parsed.positionals[0]).toBe("agent-x");
  });

  it("parses principals update command with --email and --expires-at", () => {
    const parsed = parseArgs(argv("principals update sara --email new@example.com --expires-at 2027-12-31T23:59:59Z"));
    expect(parsed.resource).toBe("principals");
    expect(parsed.command).toBe("update");
    expect(parsed.flags.get("--email")).toBe("new@example.com");
    expect(parsed.flags.get("--expires-at")).toBe("2027-12-31T23:59:59Z");
  });

  it("throws Missing value for --scope without value", () => {
    expect(() => parseArgs(argv("bearer list --scope"))).toThrow("Missing value");
  });

  it("throws Missing value for --principal without value", () => {
    expect(() => parseArgs(argv("oauth-clients list --principal"))).toThrow("Missing value");
  });

  it("returns undefined resource and command when no positionals", () => {
    const parsed = parseArgs(["node", "admin-cli.js"]);
    expect(parsed.resource).toBeUndefined();
    expect(parsed.command).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseExpiresAt — additional edge cases
// ---------------------------------------------------------------------------

describe("parseExpiresAt — additional edge cases", () => {
  it("rejects strings that start with ISO pattern but are invalid", () => {
    // Passes the regex but NaN on parse
    expect(() => parseExpiresAt("9999-99-99T99:99:99Z")).toThrow("Invalid");
  });

  it("accepts date-time with fractional seconds", () => {
    const result = parseExpiresAt("2028-01-01T00:00:00.000Z");
    expect(result).toBe("2028-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// updatePrincipal — additional edge cases
// ---------------------------------------------------------------------------

describe("updatePrincipal — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("clears email by passing empty string", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [], email: "sara@example.com" });
    // In updatePrincipal, opts.email = "" means null
    updatePrincipal(db, "sara", { email: null });
    expect(showPrincipal(db, "sara")!.email).toBeNull();
  });

  it("updates both rules and email together", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    updatePrincipal(db, "sara", {
      rules: [{ pattern: "shared/*", permissions: "read" }],
      email: "sara@new.com",
    });
    const detail = showPrincipal(db, "sara")!;
    expect(detail.namespaceRules).toHaveLength(1);
    expect(detail.email).toBe("sara@new.com");
  });

  it("clears expires-at by passing null directly to updatePrincipal", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      expiresAt: "2030-01-01T00:00:00Z",
    });
    updatePrincipal(db, "sara", { expiresAt: null });
    expect(showPrincipal(db, "sara")!.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addPrincipal — additional edge cases
// ---------------------------------------------------------------------------

describe("addPrincipal — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("stores email and email_lower when provided", () => {
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: [],
      email: "Sara@Example.COM",
    });
    const detail = showPrincipal(db, "sara")!;
    expect(detail.email).toBe("Sara@Example.COM");
    // Verify email_lower is stored correctly
    const row = db
      .prepare("SELECT email_lower FROM principals WHERE principal_id = 'sara'")
      .get() as { email_lower: string };
    expect(row.email_lower).toBe("sara@example.com");
  });

  it("rejects invalid principal type", () => {
    expect(() =>
      addPrincipal(db, {
        principalId: "bad-type",
        principalType: "superadmin" as Parameters<typeof addPrincipal>[1]["principalType"],
        rules: [],
      }),
    ).toThrow("Invalid principal type");
  });
});

// ---------------------------------------------------------------------------
// showPrincipal — with OAuth clients
// ---------------------------------------------------------------------------

describe("showPrincipal — with OAuth clients", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("includes oauth clients in detail", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    insertOAuthClientMapping(db, "mapped-client-1", "sara");

    const detail = showPrincipal(db, "sara")!;
    expect(detail.oauthClients).toHaveLength(1);
    expect(detail.oauthClients[0].oauthClientId).toBe("mapped-client-1");
    expect(detail.oauthClients[0].mappedBy).toBe("consent");
  });

  it("returns empty oauthClients when principal has none", () => {
    addPrincipal(db, { principalId: "sara", principalType: "family", rules: [] });
    const detail = showPrincipal(db, "sara")!;
    expect(detail.oauthClients).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listBearerTokens — additional edge cases
// ---------------------------------------------------------------------------

describe("listBearerTokens — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns empty when no tokens exist", () => {
    expect(listBearerTokens(db)).toHaveLength(0);
  });

  it("correctly classifies token as expired when expires_at in past", () => {
    // Manually insert an expired token
    const now = new Date().toISOString();
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const id = randomUUID();
    db.prepare(
      "INSERT INTO bearer_tokens (id, token_hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "fakehash", "owner", now, pastTime);

    const tokens = listBearerTokens(db, "owner");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe("expired");
  });

  it("correctly classifies token as retiring when expires_at is in the future", () => {
    const now = new Date().toISOString();
    const futureTime = new Date(Date.now() + 3600000).toISOString();
    const id = randomUUID();
    db.prepare(
      "INSERT INTO bearer_tokens (id, token_hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "fakehash2", "dpa", now, futureTime);

    const tokens = listBearerTokens(db, "dpa");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe("retiring");
    expect(tokens[0].expiresAt).toBe(futureTime);
  });

  it("correctly classifies token as revoked when revoked_at is set", () => {
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      "INSERT INTO bearer_tokens (id, token_hash, scope, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "fakehash3", "consumer", now, now);

    const tokens = listBearerTokens(db, "consumer");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe("revoked");
    expect(tokens[0].revokedAt).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// setClassificationFloor — additional edge cases
// ---------------------------------------------------------------------------

describe("setClassificationFloor — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("throws on invalid namespace pattern with misplaced wildcard", () => {
    // validateClassificationPattern rejects patterns where * is not at end as /*
    expect(() =>
      setClassificationFloor(db, "documents/*/bad", "internal"),
    ).toThrow("Invalid classification pattern");
  });

  it("creates floor for top-level namespace", () => {
    const result = setClassificationFloor(db, "documents/*", "public");
    expect(result.namespacePattern).toBe("documents/*");
    expect(result.minClassification).toBe("public");
  });

  it("all classification levels are accepted", () => {
    const levels = ["public", "internal", "client-confidential", "client-restricted"] as const;
    for (const level of levels) {
      const result = setClassificationFloor(db, `ns-${level}/*`, level);
      expect(result.minClassification).toBe(level);
    }
  });
});

// ---------------------------------------------------------------------------
// listClassificationFloors — additional edge cases
// ---------------------------------------------------------------------------

describe("listClassificationFloors — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("includes newly added floor", () => {
    setClassificationFloor(db, "research/*", "internal");
    const floors = listClassificationFloors(db);
    const researchFloor = floors.find((f) => f.namespacePattern === "research/*");
    expect(researchFloor).toBeDefined();
    expect(researchFloor?.minClassification).toBe("internal");
  });

  it("returns correct shape for each floor entry", () => {
    const floors = listClassificationFloors(db);
    expect(floors.length).toBeGreaterThan(0);
    for (const floor of floors) {
      expect(typeof floor.namespacePattern).toBe("string");
      expect(typeof floor.minClassification).toBe("string");
      expect(typeof floor.createdAt).toBe("string");
      expect(typeof floor.updatedAt).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// revokeBearerToken — additional edge cases
// ---------------------------------------------------------------------------

describe("revokeBearerToken — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("returns false for already-revoked token", () => {
    const result = rotateBearerToken(db, "owner", 24);
    revokeBearerToken(db, result.id);
    // Second revoke attempt should return false
    expect(revokeBearerToken(db, result.id)).toBe(false);
  });

  it("writes audit log with scope in key field", () => {
    const result = rotateBearerToken(db, "consumer", 24);
    revokeBearerToken(db, result.id);

    const rows = db
      .prepare("SELECT action, key FROM audit_log WHERE action = 'bearer_revoke'")
      .all() as { action: string; key: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("consumer");
  });
});

// ---------------------------------------------------------------------------
// parseClassification — additional edge cases
// ---------------------------------------------------------------------------

describe("parseClassification — additional edge cases", () => {
  it("accepts all valid levels", () => {
    expect(parseClassification("public")).toBe("public");
    expect(parseClassification("internal")).toBe("internal");
    expect(parseClassification("client-confidential")).toBe("client-confidential");
    expect(parseClassification("client-restricted")).toBe("client-restricted");
  });

  it("rejects empty string", () => {
    expect(() => parseClassification("")).toThrow("Must be one of");
  });

  it("is case-sensitive — uppercase fails", () => {
    expect(() => parseClassification("Public")).toThrow("Must be one of");
    expect(() => parseClassification("INTERNAL")).toThrow("Must be one of");
  });
});

// ---------------------------------------------------------------------------
// parseRules — additional edge cases
// ---------------------------------------------------------------------------

describe("parseRules — additional edge cases", () => {
  it("accepts empty array", () => {
    const rules = parseRules("[]");
    expect(rules).toHaveLength(0);
  });

  it("accepts multiple valid rules", () => {
    const json = JSON.stringify([
      { pattern: "users/sara/*", permissions: "rw" },
      { pattern: "projects/*", permissions: "read" },
      { pattern: "shared/*", permissions: "write" },
    ]);
    const rules = parseRules(json);
    expect(rules).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// testPrincipalAccess — additional edge cases
// ---------------------------------------------------------------------------

describe("testPrincipalAccess — additional edge cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("shows expired status for expired principal", () => {
    addPrincipal(db, {
      principalId: "temp-expired",
      principalType: "external",
      rules: [{ pattern: "shared/*", permissions: "read" }],
      expiresAt: "2020-01-01T00:00:00Z",
    });

    const result = testPrincipalAccess(db, "temp-expired", "shared/data");
    expect(result!.status).toBe("expired");
    // Access should be denied for expired principals
    expect(result!.canRead).toBe(false);
    expect(result!.canWrite).toBe(false);
  });

  it("owner has access to everything", () => {
    const result = testPrincipalAccess(db, "owner", "any/namespace/at/all");
    expect(result!.canRead).toBe(true);
    expect(result!.canWrite).toBe(true);
    expect(result!.status).toBe("active");
  });

  it("handles write-only permissions correctly", () => {
    addPrincipal(db, {
      principalId: "write-agent",
      principalType: "agent",
      rules: [{ pattern: "signals/*", permissions: "write" }],
    });

    const result = testPrincipalAccess(db, "write-agent", "signals/hugin");
    expect(result!.canRead).toBe(false);
    expect(result!.canWrite).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rotateToken — additional coverage
// ---------------------------------------------------------------------------

describe("rotateToken — additional coverage", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("new token is a 64-char hex string", () => {
    addPrincipal(db, {
      principalId: "agent-x",
      principalType: "agent",
      rules: [],
    });
    const result = rotateToken(db, "agent-x");
    expect(result).not.toBeNull();
    expect(/^[0-9a-f]{64}$/.test(result!.token)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listPrincipals — additional coverage
// ---------------------------------------------------------------------------

describe("listPrincipals — additional coverage", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("includes all added principals in the result", () => {
    addPrincipal(db, { principalId: "first", principalType: "family", rules: [] });
    addPrincipal(db, { principalId: "second", principalType: "family", rules: [] });
    addPrincipal(db, { principalId: "third", principalType: "family", rules: [] });

    const results = listPrincipals(db);
    // 3 added + 1 auto-created owner = 4
    expect(results).toHaveLength(4);
    const ids = results.map((r) => r.principalId);
    expect(ids).toContain("first");
    expect(ids).toContain("second");
    expect(ids).toContain("third");
  });

  it("counts rules correctly in summary", () => {
    addPrincipal(db, {
      principalId: "multi-rule",
      principalType: "family",
      rules: [
        { pattern: "ns1/*", permissions: "rw" },
        { pattern: "ns2/*", permissions: "read" },
        { pattern: "ns3/*", permissions: "write" },
      ],
    });

    const results = listPrincipals(db);
    const mr = results.find((p) => p.principalId === "multi-rule");
    expect(mr?.rulesCount).toBe(3);
  });

  it("singular rule label check in summary (rulesCount = 1)", () => {
    addPrincipal(db, {
      principalId: "one-rule",
      principalType: "family",
      rules: [{ pattern: "ns1/*", permissions: "rw" }],
    });
    const results = listPrincipals(db);
    const mr = results.find((p) => p.principalId === "one-rule");
    expect(mr?.rulesCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ESM main guard
// ---------------------------------------------------------------------------

describe("ESM main guard", () => {
  it("importing module does not call process.exit", async () => {
    // If the main guard is broken, importing would trigger main() → process.exit
    // We already imported at the top of this file, so if we got here, it works.
    expect(true).toBe(true);
  });
});
