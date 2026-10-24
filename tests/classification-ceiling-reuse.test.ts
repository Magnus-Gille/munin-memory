/**
 * #406: an existing entry that the caller cannot read because of its
 * classification ceiling must not be reused as the source of a patch, a
 * status merge, or a status preview, and its classification must not be
 * lowered through those paths. Denial follows the same agent/human contract
 * as other hidden-target write denials (access_denied vs found:false).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";
import type { AccessContext } from "../src/access.js";

const SECRET = "FIXTURE_RESTRICTED_BUSINESS_DETAIL";
const STATUS_SECRET = "FIXTURE_PRIVATE_STATUS";

let db: Database.Database;

function makeCallTool(ctx: AccessContext) {
  const server = new Server(
    { name: "test-munin-ceiling-reuse", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, db, undefined, ctx);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    const response = (await handler({ method: "tools/call", params: { name, arguments: args } })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
  };
}

function principal(
  principalType: "agent" | "family",
  maxClassification: AccessContext["maxClassification"],
): AccessContext {
  return {
    principalId: `${principalType}-fixture`,
    principalType,
    accessibleNamespaces: [{ pattern: "projects/*", permissions: "rw" }],
    maxClassification,
    transportType: "consumer",
  };
}

function snapshot(): string {
  return JSON.stringify({
    entries: db.prepare("SELECT * FROM entries ORDER BY id").all(),
    audit: db.prepare("SELECT action, namespace, key FROM audit_log WHERE action != 'access_denied' ORDER BY rowid").all(),
  });
}

const NS = "projects/ceiling";

describe("classification ceiling is enforced on existing entries reused by writes (#406)", () => {
  let owner: ReturnType<typeof makeCallTool>;

  beforeEach(async () => {
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    db = initDatabase(":memory:");
    owner = makeCallTool(ownerContext());
    expect((await owner("memory_write", {
      namespace: NS, key: "note", content: SECRET, classification: "client-restricted",
    })).status).toBe("created");
    expect((await owner("memory_write", {
      namespace: NS, key: "status",
      content: `## Phase\nPlanning\n\n## Notes\n${STATUS_SECRET}`,
      tags: ["active"],
      classification: "client-restricted",
    })).status).toBe("created");
  });

  afterEach(() => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    db.close();
  });

  const classificationOf = (key: string) =>
    (db.prepare("SELECT classification FROM entries WHERE namespace = ? AND key = ?").get(NS, key) as { classification: string }).classification;

  const contentOf = (key: string) =>
    (db.prepare("SELECT content FROM entries WHERE namespace = ? AND key = ?").get(NS, key) as { content: string }).content;

  for (const type of ["agent", "family"] as const) {
    describe(`${type} principal with an internal ceiling`, () => {
      const denied = (result: Record<string, unknown>) => {
        if (type === "agent") {
          expect(result.ok).toBe(false);
          expect(result.error).toBe("access_denied");
        } else {
          expect(result.found).toBe(false);
        }
      };

      it("cannot downgrade a hidden entry with a tag-only patch", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        expect(JSON.stringify(await caller("memory_read", { namespace: NS, key: "note" }))).not.toContain(SECRET);
        const before = snapshot();

        const result = await caller("memory_write", {
          namespace: NS, key: "note", patch: { tags_add: ["checked"] }, classification: "internal",
        });

        denied(result);
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(snapshot()).toBe(before);
        expect(classificationOf("note")).toBe("client-restricted");
        expect(JSON.stringify(await caller("memory_read", { namespace: NS, key: "note" }))).not.toContain(SECRET);
      });

      it("cannot patch a hidden entry without an explicit classification", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const before = snapshot();
        const result = await caller("memory_write", {
          namespace: NS, key: "note", patch: { content_append: "more" },
        });
        denied(result);
        expect(snapshot()).toBe(before);
      });

      it("cannot overwrite a hidden entry with a full write and a lower classification", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const before = snapshot();

        const result = await caller("memory_write", {
          namespace: NS, key: "note", content: "attacker replacement", classification: "internal",
        });

        denied(result);
        expect(snapshot()).toBe(before);
        expect(classificationOf("note")).toBe("client-restricted");
        expect(contentOf("note")).toBe(SECRET);
      });

      it("does not disclose the hidden revision on a CAS mismatch or create_if_absent conflict", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const hiddenUpdatedAt = (db.prepare("SELECT updated_at FROM entries WHERE namespace = ? AND key = ?").get(NS, "note") as { updated_at: string }).updated_at;
        const before = snapshot();

        const stale = await caller("memory_write", {
          namespace: NS, key: "note", content: "x", classification: "internal",
          expected_updated_at: "2000-01-01T00:00:00.000Z",
        });
        const createOnly = await caller("memory_write", {
          namespace: NS, key: "note", content: "x", classification: "internal", create_if_absent: true,
        });

        for (const result of [stale, createOnly]) {
          denied(result);
          expect(JSON.stringify(result)).not.toContain(hiddenUpdatedAt);
          expect(result.current_updated_at).toBeUndefined();
        }
        expect(snapshot()).toBe(before);
      });

      it("does not reuse hidden lifecycle tags on a full write to a hidden status", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const before = snapshot();

        const result = await caller("memory_write", {
          namespace: NS, key: "status", content: "## Phase\nReplaced", classification: "internal",
        });

        denied(result);
        expect(JSON.stringify(result)).not.toContain("active");
        expect(snapshot()).toBe(before);
        expect(classificationOf("status")).toBe("client-restricted");
      });

      it("does not preview a hidden status in memory_update_status validate_only", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const before = snapshot();

        const result = await caller("memory_update_status", {
          namespace: NS, phase: "Reviewed", classification: "internal", validate_only: true,
        });

        denied(result);
        expect(JSON.stringify(result)).not.toContain(STATUS_SECRET);
        expect(snapshot()).toBe(before);
      });

      it("does not merge into or downgrade a hidden status in a real memory_update_status", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const before = snapshot();

        const result = await caller("memory_update_status", {
          namespace: NS, phase: "Reviewed", classification: "internal",
        });

        denied(result);
        expect(JSON.stringify(result)).not.toContain(STATUS_SECRET);
        expect(snapshot()).toBe(before);
        expect(classificationOf("status")).toBe("client-restricted");
      });

      it("does not preview a hidden status without an explicit classification", async () => {
        const caller = makeCallTool(principal(type, "internal"));
        const result = await caller("memory_update_status", {
          namespace: NS, phase: "Reviewed", validate_only: true,
        });
        denied(result);
        expect(JSON.stringify(result)).not.toContain(STATUS_SECRET);
      });
    });
  }

  describe("authorized callers are unaffected", () => {
    it("allows a principal whose ceiling covers the entry to patch and downgrade it", async () => {
      const caller = makeCallTool(principal("agent", "client-restricted"));
      const result = await caller("memory_write", {
        namespace: NS, key: "note", patch: { tags_add: ["checked"] }, classification: "internal",
      });
      expect(result.ok).toBe(true);
      expect(result.status).toBe("patched");
      expect(classificationOf("note")).toBe("internal");
    });

    it("allows a principal whose ceiling covers the entry to overwrite it with a full write", async () => {
      const caller = makeCallTool(principal("agent", "client-restricted"));
      const result = await caller("memory_write", {
        namespace: NS, key: "note", content: "replacement", classification: "internal",
      });
      expect(result.ok).toBe(true);
      expect(result.status).toBe("updated");
      expect(contentOf("note")).toBe("replacement");
      expect(classificationOf("note")).toBe("internal");
    });

    it("previews and updates a status for a principal whose ceiling covers it", async () => {
      const caller = makeCallTool(principal("agent", "client-restricted"));
      const preview = await caller("memory_update_status", {
        namespace: NS, phase: "Reviewed", validate_only: true,
      });
      expect(preview.ok).toBe(true);
      expect(preview.status).toBe("validated");
      expect(JSON.stringify(preview)).toContain(STATUS_SECRET);

      const real = await caller("memory_update_status", { namespace: NS, phase: "Reviewed" });
      expect(real.ok).toBe(true);
      expect(JSON.stringify(real)).toContain(STATUS_SECRET);
      expect(classificationOf("status")).toBe("client-restricted");
    });

    it("keeps the owner on a local transport unaffected", async () => {
      const patch = await owner("memory_write", {
        namespace: NS, key: "note", patch: { tags_add: ["checked"] },
      });
      expect(patch.status).toBe("patched");
      const overwrite = await owner("memory_write", {
        namespace: NS, key: "note", content: "owner replacement",
      });
      expect(overwrite.status).toBe("updated");
      const preview = await owner("memory_update_status", {
        namespace: NS, phase: "Reviewed", validate_only: true,
      });
      expect(preview.status).toBe("validated");
      expect(JSON.stringify(preview)).toContain(STATUS_SECRET);
    });

    it("blocks an owner on a lower-ceiling transport from downgrading a hidden entry", async () => {
      const caller = makeCallTool({ ...ownerContext(), transportType: "consumer", maxClassification: "internal" });
      const before = snapshot();
      for (const result of [
        await caller("memory_write", {
          namespace: NS, key: "note", patch: { tags_add: ["checked"] }, classification: "internal",
        }),
        await caller("memory_write", {
          namespace: NS, key: "note", content: "replacement", classification: "internal",
        }),
        await caller("memory_update_status", {
          namespace: NS, phase: "Reviewed", classification: "internal", validate_only: true,
        }),
        await caller("memory_update_status", {
          namespace: NS, phase: "Reviewed", classification: "internal",
        }),
      ]) {
        expect(result.error).toBe("classification_error");
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).not.toContain(STATUS_SECRET);
      }
      expect(snapshot()).toBe(before);
    });

    it("still lets a lower-ceiling principal patch and read an entry within its ceiling", async () => {
      const caller = makeCallTool(principal("agent", "internal"));
      expect((await caller("memory_write", {
        namespace: NS, key: "open-note", content: "plain", classification: "internal",
      })).ok).toBe(true);
      const patch = await caller("memory_write", {
        namespace: NS, key: "open-note", patch: { tags_add: ["checked"] },
      });
      expect(patch.status).toBe("patched");
    });
  });

  it("is a no-op when the librarian is disabled (ceiling not enforced on reads either)", async () => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    const caller = makeCallTool(principal("agent", "internal"));
    const read = await caller("memory_read", { namespace: NS, key: "note" });
    expect(JSON.stringify(read)).toContain(SECRET);
    const patch = await caller("memory_write", {
      namespace: NS, key: "note", patch: { tags_add: ["checked"] },
    });
    expect(patch.status).toBe("patched");
  });
});
