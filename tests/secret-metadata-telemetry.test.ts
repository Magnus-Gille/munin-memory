import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { join } from "node:path";
import { initDatabase, writeState, logRetrievalEvent, logRetrievalFeedback } from "../src/db.js";
import { registerTools, _rotateQueryDigestKeyForTesting } from "../src/tools.js";
import { createHmac } from "node:crypto";
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

describe("query cursor resume with secret-bearing arguments (#409)", () => {
  const CURSOR_MISMATCH = "Query cursor does not match the supplied query arguments.";

  function seed(namespaceFor: (i: number) => string, tags: string[]): void {
    for (let index = 0; index < 15; index += 1) {
      writeState(db, namespaceFor(index), "status", `ghp ${"X".repeat(36)} REDACTED resume ${index}`, tags);
    }
  }

  it("rejects a different secret-shaped query on resume but accepts the identical one", async () => {
    seed((i) => `projects/resume-${i}`, ["active"]);
    const first = await call("memory_query", { query: FIXTURE_TOKEN, search_mode: "lexical", limit: 10 });
    expect(first.has_more).toBe(true);

    const other = await call("memory_query", { cursor: first.next_cursor, query: FIXTURE_TOKEN_2 });
    expect(other.ok).toBe(false);
    expect(other.message).toBe(CURSOR_MISMATCH);

    // A literal masked placeholder is not the original query either.
    const placeholder = await call("memory_query", { cursor: first.next_cursor, query: "[REDACTED]" });
    expect(placeholder.ok).toBe(false);
    expect(placeholder.message).toBe(CURSOR_MISMATCH);

    const same = await call("memory_query", { cursor: first.next_cursor, query: FIXTURE_TOKEN });
    expect(same.ok).toBe(true);
    expect(same.returned).toBeGreaterThan(0);
  });

  it("does not let a literal placeholder query cursor accept a secret query", async () => {
    seed((i) => `projects/placeholder-${i}`, ["active"]);
    const first = await call("memory_query", { query: "[REDACTED]", search_mode: "lexical", limit: 10 });
    expect(first.has_more).toBe(true);
    const secret = await call("memory_query", { cursor: first.next_cursor, query: FIXTURE_TOKEN });
    expect(secret.ok).toBe(false);
    expect(secret.message).toBe(CURSOR_MISMATCH);
    expect((await call("memory_query", { cursor: first.next_cursor, query: "[REDACTED]" })).ok).toBe(true);
  });

  it("rejects a different secret-shaped tag filter on resume", async () => {
    seed((i) => `projects/tagged-${i}`, [FIXTURE_TOKEN_2]);
    const first = await call("memory_query", { tags: [FIXTURE_TOKEN_2], namespace: "projects/", limit: 10 });
    expect(first.ok).toBe(true);
    expect(first.has_more).toBe(true);
    const stored = db.prepare("SELECT request_shape FROM query_snapshots").get() as { request_shape: string };
    expect(stored.request_shape).not.toContain(FIXTURE_TOKEN_2);

    const other = await call("memory_query", { cursor: first.next_cursor, tags: [FIXTURE_TOKEN_3] });
    expect(other.ok).toBe(false);
    expect(other.message).toBe(CURSOR_MISMATCH);
    const same = await call("memory_query", { cursor: first.next_cursor, tags: [FIXTURE_TOKEN_2] });
    expect(same.ok).toBe(true);
  });

  it("rejects a different secret-shaped namespace filter on resume", async () => {
    seed((i) => `projects/${FIXTURE_TOKEN_2}/n${i}`, ["active"]);
    const first = await call("memory_query", { namespace: `projects/${FIXTURE_TOKEN_2}`, limit: 10 });
    expect(first.ok).toBe(true);
    expect(first.has_more).toBe(true);
    const stored = db.prepare("SELECT request_shape FROM query_snapshots").get() as { request_shape: string };
    expect(stored.request_shape).not.toContain(FIXTURE_TOKEN_2);

    const other = await call("memory_query", { cursor: first.next_cursor, namespace: `projects/${FIXTURE_TOKEN_3}` });
    expect(other.ok).toBe(false);
    expect(other.message).toBe(CURSOR_MISMATCH);
    const same = await call("memory_query", { cursor: first.next_cursor, namespace: `projects/${FIXTURE_TOKEN_2}` });
    expect(same.ok).toBe(true);
  });
});

describe("resume digests are keyed outside the database (#409)", () => {
  const UNVERIFIABLE = "Resume with the cursor only";

  function seedPaged(): void {
    for (let index = 0; index < 15; index += 1) {
      writeState(db, `projects/keyed-${index}`, "status", `ghp ${"X".repeat(36)} keyed ${index}`, ["active"]);
    }
  }

  async function firstPage(): Promise<Record<string, any>> {
    seedPaged();
    const first = await call("memory_query", { query: FIXTURE_TOKEN, search_mode: "lexical", limit: 10 });
    expect(first.has_more).toBe(true);
    return first;
  }

  it("does not key the digest with the snapshot's stored cursor secret", async () => {
    await firstPage();
    const row = db.prepare("SELECT request_shape, cursor_secret FROM query_snapshots").get() as { request_shape: string; cursor_secret: string };
    const stored = JSON.parse(row.request_shape).original_digests.query as string;
    expect(typeof stored).toBe("string");
    const guesses = [
      createHmac("sha256", row.cursor_secret).update(`query\0${FIXTURE_TOKEN}`).digest("base64url"),
      createHmac("sha256", row.cursor_secret).update(`query\0${row.cursor_secret}\0${FIXTURE_TOKEN}`).digest("base64url"),
    ];
    for (const guess of guesses) expect(guess).not.toBe(stored);
  });

  it("explains how to resume when a legacy snapshot has a masked field but no digest", async () => {
    const first = await firstPage();
    const row = db.prepare("SELECT id, request_shape FROM query_snapshots").get() as { id: string; request_shape: string };
    const legacy = JSON.parse(row.request_shape);
    delete legacy.original_digests;
    delete legacy.digest_key_id;
    db.prepare("UPDATE query_snapshots SET request_shape = ? WHERE id = ?").run(JSON.stringify(legacy), row.id);

    const withSecret = await call("memory_query", { cursor: first.next_cursor, query: FIXTURE_TOKEN });
    expect(withSecret.ok).toBe(false);
    expect(withSecret.error).toBe("validation_error");
    expect(withSecret.message).toContain(UNVERIFIABLE);
    expect(JSON.stringify(withSecret)).not.toContain(FIXTURE_TOKEN);

    const cursorOnly = await call("memory_query", { cursor: first.next_cursor });
    expect(cursorOnly.ok).toBe(true);
    expect(cursorOnly.returned).toBeGreaterThan(0);
  });

  it("explains how to resume after the process digest key is lost", async () => {
    const first = await firstPage();
    _rotateQueryDigestKeyForTesting();

    const withSecret = await call("memory_query", { cursor: first.next_cursor, query: FIXTURE_TOKEN });
    expect(withSecret.ok).toBe(false);
    expect(withSecret.message).toContain(UNVERIFIABLE);

    const cursorOnly = await call("memory_query", { cursor: first.next_cursor });
    expect(cursorOnly.ok).toBe(true);

    // New snapshots use the new key and verify normally.
    const fresh = await call("memory_query", { query: FIXTURE_TOKEN, search_mode: "lexical", limit: 10 });
    const same = await call("memory_query", { cursor: fresh.next_cursor, query: FIXTURE_TOKEN });
    expect(same.ok).toBe(true);
    const other = await call("memory_query", { cursor: fresh.next_cursor, query: FIXTURE_TOKEN_2 });
    expect(other.ok).toBe(false);
    expect(other.message).toBe("Query cursor does not match the supplied query arguments.");
  });
});

describe("memory_read_batch failure items never echo credential-shaped identifiers (#409)", () => {
  it("masks namespace and key echoed in validation-error items", async () => {
    const result = await call("memory_read_batch", {
      reads: [
        { namespace: "projects/ok", key: `${FIXTURE_TOKEN}.invalid` },
        { namespace: `projects/${FIXTURE_TOKEN}.invalid`, key: "k" },
        { namespace: "projects/ok", key: "missing" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_TOKEN);
    expect(result.results[0]).toMatchObject({ found: false, namespace: "projects/ok", key: "[REDACTED].invalid" });
    expect(result.results[1]).toMatchObject({ found: false, namespace: "projects/[REDACTED].invalid", key: "k" });
    expect(result.results[2]).toMatchObject({ found: false, namespace: "projects/ok", key: "missing" });
  });

  it("masks well-formed secret-shaped identifiers in not-found and unreadable items", async () => {
    // Well-formed identifiers pass validation, so the not-found and denied branches echo them too.
    const ownerResult = await call("memory_read_batch", {
      reads: [{ namespace: "projects/ok", key: FIXTURE_TOKEN }],
    });
    expect(JSON.stringify(ownerResult)).not.toContain(FIXTURE_TOKEN);
    expect(ownerResult.results[0]).toMatchObject({ found: false, key: "[REDACTED]" });

    const familyServer = new Server({ name: "test-munin", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerTools(familyServer, db, SESSION_ID, {
      principalId: "alice",
      principalType: "family",
      accessibleNamespaces: [{ pattern: "users/alice/*", permissions: "rw" }],
      maxClassification: "internal",
      transportType: "consumer",
    } as never);
    const handler = (familyServer as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get("tools/call")!;
    const response = await handler({ method: "tools/call", params: { name: "memory_read_batch", arguments: {
      reads: [{ namespace: `projects/${FIXTURE_TOKEN}`, key: "k" }],
    } } });
    const familyResult = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(JSON.stringify(familyResult)).not.toContain(FIXTURE_TOKEN);
    expect(familyResult.results[0]).toMatchObject({ found: false, namespace: "projects/[REDACTED]" });
  });
});

describe("keyed writes never replay credential-shaped identifiers (#409)", () => {
  it("rejects a secret-shaped namespace before looking up an idempotency receipt", async () => {
    // A receipt stored before #409 could carry a credential-shaped namespace; the
    // secret scan must run before the receipt lookup, so it is never replayed.
    const idempotencyKey = "6f1c2e3a-4b5d-4c6e-8f7a-9b0c1d2e3f4a";
    db.prepare(`INSERT INTO write_receipts (principal_id, idempotency_key, tool_name, namespace,
      request_hash, entry_id, entry_key, entry_updated_at, classification, result_status)
      VALUES ('owner', ?, 'memory_write', ?, 'legacy-hash', 'legacy-entry', 'k', '2026-01-01T00:00:00Z', 'internal', 'created')`)
      .run(idempotencyKey, `projects/${FIXTURE_TOKEN}`);
    expectSecretRejection(await call("memory_write", {
      namespace: `projects/${FIXTURE_TOKEN}`, key: "k", content: "x", idempotency_key: idempotencyKey,
    }));
  });
});

describe("format errors never echo credential-shaped namespaces or keys (#409)", () => {
  it("memory_update_status rejects a malformed secret-bearing namespace as a secret", async () => {
    const result = await call("memory_update_status", { namespace: `projects/${FIXTURE_TOKEN}.invalid`, phase: "Planning" });
    expectSecretRejection(result);
  });

  it("memory_write and memory_log reject a malformed secret-bearing namespace as a secret", async () => {
    expectSecretRejection(await call("memory_write", { namespace: `testing/${FIXTURE_TOKEN}.invalid`, key: "k", content: "x" }));
    expectSecretRejection(await call("memory_log", { namespace: `testing/${FIXTURE_TOKEN}.invalid`, content: "x" }));
  });

  it("read-side validation errors redact credential-shaped namespaces and keys", async () => {
    for (const [tool, args] of [
      ["memory_read", { namespace: `projects/${FIXTURE_TOKEN}.invalid`, key: "k" }],
      ["memory_read", { namespace: "projects/ok", key: `${FIXTURE_TOKEN}.invalid` }],
      ["memory_list", { namespace: `projects/${FIXTURE_TOKEN}.invalid` }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(FIXTURE_TOKEN);
    }
  });
});

describe("secret masking in retrieval telemetry (#409)", () => {
  it("memory_query persists a masked query_text but still searches with the original", async () => {
    writeState(db, "projects/telemetry", "status", `needle ghp ${"X".repeat(36)}`, ["active"]);
    const result = await call("memory_query", { query: FIXTURE_TOKEN, search_mode: "lexical" });
    expect(result.ok).toBe(true);
    // Searching used the original text (the lexical match on the tokenised
    // secret is found), but the response never echoes the secret back.
    expect(result.query).toBe("[REDACTED]");
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
    // Consistent, masked echo on every page.
    expect(first.query).toBe("[REDACTED]");
    expect(second.query).toBe(first.query);
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
