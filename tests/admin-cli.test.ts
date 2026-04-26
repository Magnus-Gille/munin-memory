import { describe, it, expect, beforeEach } from "vitest";
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
// ESM main guard
// ---------------------------------------------------------------------------

describe("ESM main guard", () => {
  it("importing module does not call process.exit", async () => {
    // If the main guard is broken, importing would trigger main() → process.exit
    // We already imported at the top of this file, so if we got here, it works.
    expect(true).toBe(true);
  });
});
