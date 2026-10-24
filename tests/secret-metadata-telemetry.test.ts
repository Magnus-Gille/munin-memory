import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { join } from "node:path";
import { initDatabase, writeState, logRetrievalEvent, logRetrievalFeedback } from "../src/db.js";
import { registerTools } from "../src/tools.js";
import { validateTags, validateWriteInput, validateLogInput, redactSecrets } from "../src/security.js";
import { createTestStorage } from "./helpers/test-storage.js";

// Fixtures are assembled by concatenation so no secret-shaped literal appears in source.
const FIXTURE_TOKEN = "ghp_" + "X".repeat(36);
const FIXTURE_TOKEN_2 = "ghp_" + "Y".repeat(36);
const FIXTURE_TOKEN_3 = "ghp_" + "Z".repeat(36);
const SECRET_ERROR = "appears to contain a secret or credential (matched pattern: GitHub personal access token)";
const SESSION_ID = "secret-metadata-telemetry-session";

const TEST_STORAGE = createTestStorage("secret-metadata-telemetry");
let dbCounter = 0;
let db: Database.Database;
let server: Server;

afterAll(TEST_STORAGE.cleanup);

beforeEach(() => {
  dbCounter += 1;
  db = initDatabase(join(TEST_STORAGE.dir, `memory-${dbCounter}.db`));
  server = new Server({ name: "test-munin", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, db, SESSION_ID);
});

afterEach(() => {
  db.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call")!;
  const response = await handler({ method: "tools/call", params: { name, arguments: args } });
  return JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
}

function expectSecretRejection(result: Record<string, any>): void {
  expect(result.ok).toBe(false);
  expect(result.error).toBe("validation_error");
  expect(result.message).toContain(SECRET_ERROR);
  expect(JSON.stringify(result)).not.toContain(FIXTURE_TOKEN);
}

describe("secret scanning of stored metadata (#409)", () => {
  it("validateTags rejects a recognised credential without echoing it", () => {
    const result = validateTags(["ok", FIXTURE_TOKEN]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(SECRET_ERROR);
    expect(result.error).not.toContain(FIXTURE_TOKEN);
  });

  it("validateTags scans before format validation so a malformed secret tag is not echoed", () => {
    const result = validateTags([`Bearer ${"a".repeat(30)}`]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Bearer token");
    expect(result.error).not.toContain("a".repeat(30));
  });

  it("validateWriteInput and validateLogInput reject secrets in namespace, key and tags", () => {
    for (const result of [
      validateWriteInput("testing/ns", "note", "ordinary", [FIXTURE_TOKEN], 1000),
      validateWriteInput("testing/ns", FIXTURE_TOKEN, "ordinary", [], 1000),
      validateWriteInput(`testing/${FIXTURE_TOKEN}`, "note", "ordinary", [], 1000),
      validateLogInput("testing/ns", "ordinary", [FIXTURE_TOKEN], 1000),
      validateLogInput(`testing/${FIXTURE_TOKEN}`, "ordinary", [], 1000),
    ]) {
      expect(result.valid).toBe(false);
      expect(result.error).toContain(SECRET_ERROR);
      expect(result.error).not.toContain(FIXTURE_TOKEN);
    }
  });

  it("validateWriteInput still accepts ordinary metadata", () => {
    expect(validateWriteInput("testing/ns", "note", "ordinary", ["decision", "topic:x"], 1000).valid).toBe(true);
  });

  it("memory_write rejects a secret in tags and stores nothing", async () => {
    const result = await call("memory_write", {
      namespace: "testing/metadata", key: "note", content: "ordinary fixture text", tags: [FIXTURE_TOKEN],
    });
    expectSecretRejection(result);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE namespace = ?").get("testing/metadata")).toEqual({ n: 0 });
  });

  it("memory_write rejects a secret in the key and in the namespace", async () => {
    expectSecretRejection(await call("memory_write", {
      namespace: "testing/metadata", key: FIXTURE_TOKEN, content: "ordinary fixture text",
    }));
    expectSecretRejection(await call("memory_write", {
      namespace: `testing/${FIXTURE_TOKEN}`, key: "note", content: "ordinary fixture text",
    }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
  });

  it("memory_write patch rejects a secret in tags_add and leaves tags unchanged", async () => {
    writeState(db, "testing/metadata", "note", "ordinary fixture text", ["keep"]);
    const result = await call("memory_write", {
      namespace: "testing/metadata", key: "note", patch: { tags_add: [FIXTURE_TOKEN] },
    });
    expectSecretRejection(result);
    const row = db.prepare("SELECT tags FROM entries WHERE namespace = ? AND key = ?").get("testing/metadata", "note") as { tags: string };
    expect(row.tags).not.toContain(FIXTURE_TOKEN);
    expect(row.tags).toContain("keep");
  });

  it("memory_log rejects a secret in tags and in the namespace", async () => {
    expectSecretRejection(await call("memory_log", {
      namespace: "testing/metadata", content: "ordinary log text", tags: [FIXTURE_TOKEN],
    }));
    expectSecretRejection(await call("memory_log", {
      namespace: `testing/${FIXTURE_TOKEN}`, content: "ordinary log text",
    }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
  });

  it("memory_update_status rejects a secret in the namespace", async () => {
    const result = await call("memory_update_status", {
      namespace: `projects/${FIXTURE_TOKEN}`, phase: "Planning",
    });
    expectSecretRejection(result);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 0 });
  });

  it("a secret in content still yields the same message prefix contract", async () => {
    const result = await call("memory_write", {
      namespace: "testing/metadata", key: "note", content: `token ${FIXTURE_TOKEN}`,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`Content ${SECRET_ERROR}`);
  });
});

describe("secret masking in retrieval telemetry (#409)", () => {
  it("memory_query persists a masked query_text but still searches with the original", async () => {
    writeState(db, "projects/telemetry", "status", `needle ghp ${"X".repeat(36)}`, ["active"]);
    const result = await call("memory_query", { query: FIXTURE_TOKEN, search_mode: "lexical" });
    expect(result.ok).toBe(true);
    // Searching used the original text: the in-memory response still echoes it
    // and the lexical match on the tokenised secret is found.
    expect(result.query).toBe(FIXTURE_TOKEN);
    expect(result.results.length).toBeGreaterThan(0);

    const rows = db.prepare("SELECT query_text FROM retrieval_events WHERE tool_name = 'memory_query'").all() as Array<{ query_text: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].query_text).toBe("[REDACTED]");
  });

  it("masks only the secret match and keeps surrounding query words", async () => {
    await call("memory_query", { query: `deploy token ${FIXTURE_TOKEN_2} please`, search_mode: "lexical" });
    const row = db.prepare("SELECT query_text FROM retrieval_events WHERE tool_name = 'memory_query'").get() as { query_text: string };
    expect(row.query_text).toBe("deploy token [REDACTED] please");
  });

  it("leaves ordinary query text untouched", async () => {
    await call("memory_query", { query: "ordinary project status", search_mode: "lexical" });
    const row = db.prepare("SELECT query_text FROM retrieval_events WHERE tool_name = 'memory_query'").get() as { query_text: string };
    expect(row.query_text).toBe("ordinary project status");
  });

  it("masks secrets in a filter-only query description", async () => {
    // tags filter values flow into the synthetic filter-only query_text
    await call("memory_query", { namespace: "projects/", tags: [FIXTURE_TOKEN_3] });
    const row = db.prepare("SELECT query_text FROM retrieval_events WHERE tool_name = 'memory_query'").get() as { query_text: string };
    expect(row.query_text).not.toContain(FIXTURE_TOKEN_3);
  });

  it("does not persist the raw query in pagination snapshots and cursors still resume", async () => {
    for (let index = 0; index < 15; index += 1) {
      writeState(db, `projects/page-${index}`, "status", `ghp ${"X".repeat(36)} paged ${index}`, ["active"]);
    }
    const first = await call("memory_query", { query: FIXTURE_TOKEN, search_mode: "lexical", limit: 10 });
    expect(first.ok).toBe(true);
    expect(first.has_more).toBe(true);

    const snapshots = db.prepare("SELECT request_shape, response_meta FROM query_snapshots").all() as Array<Record<string, string>>;
    expect(snapshots).toHaveLength(1);
    expect(JSON.stringify(snapshots)).not.toContain(FIXTURE_TOKEN);
    expect(JSON.parse(snapshots[0].request_shape).query).toBe("[REDACTED]");

    // The client may resend the same query alongside the cursor.
    const second = await call("memory_query", { cursor: first.next_cursor, query: FIXTURE_TOKEN });
    expect(second.ok).toBe(true);
    expect(second.returned).toBeGreaterThan(0);
    const events = db.prepare("SELECT query_text FROM retrieval_events WHERE tool_name = 'memory_query'").all() as Array<{ query_text: string }>;
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) expect(event.query_text).toBe("[REDACTED]");
  });

  it("logRetrievalEvent and logRetrievalFeedback mask at the persistence boundary", () => {
    logRetrievalEvent(db, {
      sessionId: "direct", toolName: "memory_query", queryText: `find ${FIXTURE_TOKEN}`,
      resultIds: [], resultNamespaces: [], resultRanks: [],
    });
    logRetrievalFeedback(db, { sessionId: "direct", feedbackType: "bad_results", queryText: `find ${FIXTURE_TOKEN}` });
    const event = db.prepare("SELECT query_text FROM retrieval_events WHERE session_id = 'direct'").get() as { query_text: string };
    const feedback = db.prepare("SELECT query_text FROM retrieval_feedback WHERE session_id = 'direct'").get() as { query_text: string };
    expect(event.query_text).toBe("find [REDACTED]");
    expect(feedback.query_text).toBe("find [REDACTED]");
    expect(redactSecrets(`find ${FIXTURE_TOKEN}`)).toBe("find [REDACTED]");
  });

  it("memory_retrieval_feedback persists a masked query", async () => {
    const result = await call("memory_retrieval_feedback", { feedback_type: "bad_results", query: `find ${FIXTURE_TOKEN}` });
    expect(result.ok).toBe(true);
    const row = db.prepare("SELECT query_text FROM retrieval_feedback").get() as { query_text: string };
    expect(row.query_text).toBe("find [REDACTED]");
  });
});
