/**
 * Multi-user follow-ups from the Codex review of #162 (issue #164).
 *
 * Part 2 — shared-namespace home hardening: --profile seeding refuses to seed a
 *          principal's personal conventions under a home that another principal
 *          can also read.
 * Part 3 — classification floor vs external-principal max under the Librarian:
 *          a seeded principal must be able to read its own conventions even when
 *          the home namespace floor exceeds the principal's effective max.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { addPrincipal } from "../src/admin-cli.js";
import { registerTools } from "../src/tools.js";
import type { AccessContext, NamespaceRule } from "../src/access.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeServer(
  db: Database.Database,
  ctx: AccessContext,
): (name: string, args?: Record<string, unknown>) => Promise<unknown> {
  const server = new Server(
    { name: "test-munin-hardening", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ctx);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    return handler({ method: "tools/call", params: { name, arguments: args } });
  };
}

function parse(response: unknown): unknown {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

// ---------------------------------------------------------------------------
// Part 2 — shared-namespace home hardening
// ---------------------------------------------------------------------------

describe("addPrincipal --profile — shared-home hardening (#164 part 2)", () => {
  it("rejects --profile when the chosen home overlaps another principal's grant", () => {
    const db = makeDb();
    // Bob already has read/write access to the whole shared/family subtree.
    addPrincipal(db, {
      principalId: "bob",
      principalType: "family",
      rules: [
        { pattern: "users/bob/*", permissions: "rw" },
        { pattern: "shared/family/*", permissions: "rw" },
      ],
    });

    // Sara is (mis)configured with the SHARED rule first, so her home would
    // derive to shared/family — readable by Bob.
    const saraRules: NamespaceRule[] = [
      { pattern: "shared/family/*", permissions: "rw" },
      { pattern: "users/sara/*", permissions: "rw" },
    ];

    expect(() =>
      addPrincipal(db, {
        principalId: "sara",
        principalType: "family",
        rules: saraRules,
        profile: "household",
      }),
    ).toThrow(/shared/i);

    // Rejected up front — no principal row, no seeded entries.
    expect(db.prepare("SELECT 1 FROM principals WHERE principal_id='sara'").get()).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM entries WHERE namespace='shared/family/meta'").get(),
    ).toBeUndefined();
  });

  it("accepts --profile for a private home that no other principal can read", () => {
    const db = makeDb();
    addPrincipal(db, {
      principalId: "bob",
      principalType: "family",
      rules: [{ pattern: "users/bob/*", permissions: "rw" }],
    });

    const result = addPrincipal(db, {
      principalId: "alice",
      principalType: "family",
      rules: [{ pattern: "users/alice/*", permissions: "rw" }],
      profile: "household",
    });

    expect(result.seeded).toEqual({
      profile: "household",
      conventions: "users/alice/meta",
      config: "users/alice/meta",
    });
  });
});

// ---------------------------------------------------------------------------
// Part 3 — classification floor vs external-principal max under the Librarian
// ---------------------------------------------------------------------------

describe("addPrincipal --profile — Librarian classification floor (#164 part 3)", () => {
  let originalLibrarian: string | undefined;

  beforeEach(() => {
    originalLibrarian = process.env.MUNIN_LIBRARIAN_ENABLED;
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
  });

  afterEach(() => {
    if (originalLibrarian === undefined) delete process.env.MUNIN_LIBRARIAN_ENABLED;
    else process.env.MUNIN_LIBRARIAN_ENABLED = originalLibrarian;
  });

  function guestContext(): AccessContext {
    return {
      principalId: "guest",
      principalType: "external",
      accessibleNamespaces: [{ pattern: "users/guest/*", permissions: "rw" }],
      maxClassification: "public",
      transportType: "consumer",
    };
  }

  it("an external principal can read its own seeded conventions via memory_orient(full)", async () => {
    const db = initDatabase(":memory:");
    try {
      addPrincipal(db, {
        principalId: "guest",
        principalType: "external",
        rules: [{ pattern: "users/guest/*", permissions: "rw" }],
        profile: "personal-knowledge",
      });

      const guestCall = makeServer(db, guestContext());
      const full = parse(
        await guestCall("memory_orient", { include_full_conventions: true }),
      ) as { conventions: { content: string; source?: string } };

      // The seeded conventions must NOT be redacted away to the universal default.
      expect(full.conventions.source).toBe("principal");
      expect(full.conventions.content).toContain("Personal knowledge");
      expect(full.conventions.content).toContain("users/guest/");
    } finally {
      db.close();
    }
  });
});
