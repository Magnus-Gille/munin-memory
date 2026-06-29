import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/migrations.js";
import { addPrincipal } from "../src/admin-cli.js";
import type { NamespaceRule } from "../src/access.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function readState(db: Database.Database, namespace: string, key: string) {
  return db
    .prepare(
      "SELECT content, tags, owner_principal_id FROM entries WHERE namespace=? AND key=? AND entry_type='state'",
    )
    .get(namespace, key) as
    | { content: string; tags: string; owner_principal_id: string }
    | undefined;
}

const saraRules: NamespaceRule[] = [{ pattern: "users/sara/*", permissions: "rw" }];

describe("addPrincipal --profile seeding", () => {
  it("seeds per-principal conventions + tracked-pattern config under <home>/meta", () => {
    const db = makeDb();
    const result = addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: saraRules,
      profile: "household",
    });

    expect(result.seeded).toEqual({
      profile: "household",
      conventions: "users/sara/meta",
      config: "users/sara/meta",
    });

    const conv = readState(db, "users/sara/meta", "conventions");
    expect(conv).toBeDefined();
    expect(conv!.content).toContain("Household");
    expect(conv!.content).toContain("users/sara/home");
    expect(conv!.content).not.toContain("{home}");
    expect(conv!.owner_principal_id).toBe("sara");
    expect(JSON.parse(conv!.tags)).toContain("profile:household");

    const cfg = readState(db, "users/sara/meta", "config");
    expect(cfg).toBeDefined();
    const parsed = JSON.parse(cfg!.content) as { tracked_patterns: string[] };
    expect(parsed.tracked_patterns).toContain("users/sara/home/*");
    expect(parsed.tracked_patterns.every((p) => p.startsWith("users/sara/"))).toBe(true);
    expect(cfg!.owner_principal_id).toBe("sara");
  });

  it("writes a principal_profile_seed audit row", () => {
    const db = makeDb();
    addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: saraRules,
      profile: "researcher",
    });
    const rows = db
      .prepare(
        "SELECT action, detail FROM audit_log WHERE namespace='admin/principals' AND key='sara' ORDER BY id",
      )
      .all() as { action: string; detail: string | null }[];
    expect(
      rows.some((r) => r.action === "principal_profile_seed" && (r.detail ?? "").includes("researcher")),
    ).toBe(true);
  });

  it("rejects an unknown profile before creating the principal", () => {
    const db = makeDb();
    expect(() =>
      addPrincipal(db, {
        principalId: "x",
        principalType: "family",
        rules: saraRules,
        profile: "astronaut",
      }),
    ).toThrow(/Unknown profile/);
    expect(db.prepare("SELECT 1 FROM principals WHERE principal_id='x'").get()).toBeUndefined();
  });

  it("rejects --profile when the principal has no writable prefix rule", () => {
    const db = makeDb();
    expect(() =>
      addPrincipal(db, {
        principalId: "ro",
        principalType: "external",
        rules: [{ pattern: "docs/*", permissions: "read" }],
        profile: "household",
      }),
    ).toThrow(/writable/);
  });

  it("does not seed when --profile is omitted", () => {
    const db = makeDb();
    const result = addPrincipal(db, {
      principalId: "sara",
      principalType: "family",
      rules: saraRules,
    });
    expect(result.seeded).toBeUndefined();
    expect(readState(db, "users/sara/meta", "conventions")).toBeUndefined();
  });
});
