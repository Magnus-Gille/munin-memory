/**
 * Tests for the Librarian orphan prevention fix.
 *
 * Verifies that writes are rejected at write-time when the resulting entry
 * would be invisible to the caller's transport type due to classification
 * enforcement. This prevents "orphaned" entries that are written successfully
 * but become invisible at read-time.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { initDatabase } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { ownerContext } from "../src/access.js";
import type { AccessContext } from "../src/access.js";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

let db: Database.Database;

function makeCallTool(
  dbInstance: Database.Database,
  ctx: AccessContext,
  sessionId?: string,
) {
  const server = new Server(
    { name: "test-munin-orphans", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, dbInstance, sessionId, ctx);

  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = (
      server as unknown as { _requestHandlers: Map<string, Function> }
    )._requestHandlers?.get("tools/call");
    if (!handler) throw new Error("Cannot access tool handler");
    return handler({ method: "tools/call", params: { name, arguments: args } });
  };
}

function parse(response: unknown): Record<string, unknown> {
  const resp = response as { content: Array<{ text: string }> };
  return JSON.parse(resp.content[0].text);
}

function consumerOwnerContext(): AccessContext {
  return {
    ...ownerContext(),
    transportType: "consumer",
    maxClassification: "internal",
  };
}

function dpaCoveredOwnerContext(): AccessContext {
  return {
    ...ownerContext(),
    transportType: "dpa_covered",
    maxClassification: "client-confidential",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Librarian orphan prevention", () => {
  let ownerCall: ReturnType<typeof makeCallTool>;
  let consumerCall: ReturnType<typeof makeCallTool>;
  let dpaCall: ReturnType<typeof makeCallTool>;

  beforeEach(() => {
    process.env.MUNIN_LIBRARIAN_ENABLED = "true";
    db = initDatabase(":memory:");
    ownerCall = makeCallTool(db, ownerContext());
    consumerCall = makeCallTool(db, consumerOwnerContext());
    dpaCall = makeCallTool(db, dpaCoveredOwnerContext());
  });

  afterEach(() => {
    delete process.env.MUNIN_LIBRARIAN_ENABLED;
    db.close();
  });

  // -------------------------------------------------------------------------
  // Write-reject tests
  // -------------------------------------------------------------------------

  describe("memory_write rejects orphan-creating writes", () => {
    it("rejects consumer write to client-confidential namespace", async () => {
      const raw = await consumerCall("memory_write", {
        namespace: "clients/acme",
        key: "status",
        content: "Active client engagement",
        tags: ["active"],
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
      expect(result.message).toContain("client-confidential");
      expect(result.message).toContain("consumer");
    });

    it("rejects consumer write to people/* namespace", async () => {
      const raw = await consumerCall("memory_write", {
        namespace: "people/john-doe",
        key: "contact",
        content: "John Doe contact info",
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
      expect(result.message).toContain("client-confidential");
    });

    it("rejects consumer write with explicit client-confidential classification", async () => {
      const raw = await consumerCall("memory_write", {
        namespace: "projects/demo",
        key: "notes",
        content: "Some confidential notes",
        classification: "client-confidential",
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
    });

    it("rejects dpa_covered write with client-restricted classification", async () => {
      const raw = await dpaCall("memory_write", {
        namespace: "projects/sensitive",
        key: "data",
        content: "Restricted content",
        classification: "client-restricted",
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
      expect(result.message).toContain("client-restricted");
      expect(result.message).toContain("DPA-covered");
    });
  });

  // -------------------------------------------------------------------------
  // Consistency tests: writes that succeed must remain readable
  // -------------------------------------------------------------------------

  describe("write-read consistency", () => {
    it("consumer can write and read back from internal-floor namespace", async () => {
      const writeRaw = await consumerCall("memory_write", {
        namespace: "projects/demo",
        key: "notes",
        content: "Internal project notes",
        tags: ["active"],
      });
      const writeResult = parse(writeRaw);
      expect(writeResult.status).toBe("created");

      const readRaw = await consumerCall("memory_read", {
        namespace: "projects/demo",
        key: "notes",
      });
      const readResult = parse(readRaw);
      expect(readResult.found).toBe(true);
      expect(readResult.content).toBe("Internal project notes");
      expect(readResult.redacted).toBeUndefined();
    });

    it("consumer can write and read back from public-floor namespace", async () => {
      const writeRaw = await consumerCall("memory_write", {
        namespace: "reading/articles",
        key: "book1",
        content: "A great book",
      });
      const writeResult = parse(writeRaw);
      expect(writeResult.status).toBe("created");

      const readRaw = await consumerCall("memory_read", {
        namespace: "reading/articles",
        key: "book1",
      });
      const readResult = parse(readRaw);
      expect(readResult.found).toBe(true);
      expect(readResult.content).toBe("A great book");
    });

    it("dpa_covered can write and read back from client-confidential namespace", async () => {
      const writeRaw = await dpaCall("memory_write", {
        namespace: "clients/acme",
        key: "status",
        content: "Active retainer",
        tags: ["active"],
      });
      const writeResult = parse(writeRaw);
      expect(writeResult.status).toBe("created");

      const readRaw = await dpaCall("memory_read", {
        namespace: "clients/acme",
        key: "status",
      });
      const readResult = parse(readRaw);
      expect(readResult.found).toBe(true);
      expect(readResult.content).toBe("Active retainer");
    });

    it("local/owner can write and read anything", async () => {
      const writeRaw = await ownerCall("memory_write", {
        namespace: "clients/acme",
        key: "restricted",
        content: "Highly restricted data",
        classification: "client-restricted",
      });
      const writeResult = parse(writeRaw);
      expect(writeResult.status).toBe("created");

      const readRaw = await ownerCall("memory_read", {
        namespace: "clients/acme",
        key: "restricted",
      });
      const readResult = parse(readRaw);
      expect(readResult.found).toBe(true);
      expect(readResult.content).toBe("Highly restricted data");
    });
  });

  // -------------------------------------------------------------------------
  // memory_log orphan prevention
  // -------------------------------------------------------------------------

  describe("memory_log rejects orphan-creating logs", () => {
    it("rejects consumer log to client-confidential namespace", async () => {
      const raw = await consumerCall("memory_log", {
        namespace: "clients/acme",
        content: "Meeting notes with client",
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
      expect(result.message).toContain("client-confidential");
    });

    it("allows consumer log to internal namespace", async () => {
      const raw = await consumerCall("memory_log", {
        namespace: "projects/demo",
        content: "Worked on demo feature today",
        tags: ["milestone"],
      });
      const result = parse(raw);

      expect(result.status).toBe("logged");
      expect(result.id).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // memory_update_status orphan prevention
  // -------------------------------------------------------------------------

  describe("memory_update_status rejects orphan-creating updates", () => {
    it("rejects consumer status update to client-confidential namespace", async () => {
      // First create the status as owner
      await ownerCall("memory_write", {
        namespace: "clients/acme",
        key: "status",
        content: "## Phase\nActive\n## Current Work\nRetainer work",
        tags: ["active"],
      });

      const raw = await consumerCall("memory_update_status", {
        namespace: "clients/acme",
        phase: "Review",
        current_work: "Reviewing deliverables",
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
    });

    it("allows consumer status update to internal namespace", async () => {
      // First create the project as owner
      await ownerCall("memory_write", {
        namespace: "projects/demo",
        key: "status",
        content: "## Phase\nActive\n## Current Work\nDemo work",
        tags: ["active"],
      });

      const raw = await consumerCall("memory_update_status", {
        namespace: "projects/demo",
        phase: "Testing",
        current_work: "Running tests",
      });
      const result = parse(raw);

      expect(result.status).toBeDefined();
      expect(result.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Delete visibility
  // -------------------------------------------------------------------------

  describe("delete visibility reflects classification filtering", () => {
    it("consumer delete preview shows 0 for classified entries", async () => {
      // Write as owner (local) — entry gets client-confidential classification
      await ownerCall("memory_write", {
        namespace: "clients/acme",
        key: "status",
        content: "Confidential client data",
        tags: ["active"],
      });

      // Consumer tries to delete — should see 0 entries (filtered by classification)
      const raw = await consumerCall("memory_delete", {
        namespace: "clients/acme",
      });
      const result = parse(raw);

      expect(result.phase).toBe("preview");
      expect(result.will_delete).toBeDefined();
      const willDelete = result.will_delete as { state_count: number; log_count: number };
      expect(willDelete.state_count).toBe(0);
      expect(willDelete.log_count).toBe(0);
    });

    it("owner delete preview shows correct counts for classified entries", async () => {
      await ownerCall("memory_write", {
        namespace: "clients/acme",
        key: "status",
        content: "Confidential client data",
        tags: ["active"],
      });

      const raw = await ownerCall("memory_delete", {
        namespace: "clients/acme",
      });
      const result = parse(raw);

      expect(result.phase).toBe("preview");
      const willDelete = result.will_delete as { state_count: number; log_count: number };
      expect(willDelete.state_count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Patch path orphan prevention
  // -------------------------------------------------------------------------

  describe("memory_write patch rejects orphan-creating patches", () => {
    it("rejects consumer patch to client-confidential namespace entry", async () => {
      // Create entry as owner
      await ownerCall("memory_write", {
        namespace: "clients/acme",
        key: "notes",
        content: "Original notes",
        tags: ["active"],
      });

      // Consumer tries to patch — should be rejected since namespace floor is client-confidential
      const raw = await consumerCall("memory_write", {
        namespace: "clients/acme",
        key: "notes",
        patch: { content_append: "\nAdditional note" },
      });
      const result = parse(raw);

      expect(result.error).toBe("classification_error");
    });
  });

  // -------------------------------------------------------------------------
  // Librarian disabled: no interference
  // -------------------------------------------------------------------------

  describe("with Librarian disabled", () => {
    beforeEach(() => {
      process.env.MUNIN_LIBRARIAN_ENABLED = "false";
    });

    it("allows consumer write to any namespace when Librarian is off", async () => {
      const raw = await consumerCall("memory_write", {
        namespace: "clients/acme",
        key: "status",
        content: "Should be allowed when Librarian is off",
        tags: ["active"],
      });
      const result = parse(raw);

      expect(result.status).toBe("created");
    });
  });
});
