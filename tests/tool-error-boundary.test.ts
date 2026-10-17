import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as storage from "../src/db.js";
import * as librarian from "../src/librarian.js";
import { PublicValidationError } from "../src/internal/public-errors.js";
import { _consolidationConfig } from "../src/consolidation.js";
import { registerTools, _setHealthSectionOverridesForTesting } from "../src/tools.js";

const privateDetail = "PRIVATE_BACKEND_DETAIL /srv/private/customer.sqlite bearer-secret-placeholder";
let db: ReturnType<typeof storage.initDatabase>;
let server: Server;

async function call(name: string, args: Record<string, unknown> = {}) {
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (request: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>;
  })._requestHandlers.get("tools/call")!;
  const response = await handler({ method: "tools/call", params: { name, arguments: args } });
  return { response, payload: JSON.parse(response.content[0].text) };
}

beforeEach(() => {
  db = storage.initDatabase(":memory:");
  server = new Server({ name: "boundary-test", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _setHealthSectionOverridesForTesting(null);
  if (db.open) db.close();
});

describe("unexpected MCP exception boundary", () => {
  const hostile = Object.defineProperties({}, {
    message: { get() { throw new Error(privateDetail); } },
    constructor: { get() { throw new Error(privateDetail); } },
    toString: { value() { throw new Error(privateDetail); } },
  });
  it.each([new Error(privateDetail), privateDetail, null, undefined, hostile])(
    "never inspects or serializes an unexpected thrown value (%#)", async (thrown) => {
      const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      vi.spyOn(storage, "readState").mockImplementation(() => { throw thrown; });
      const { response, payload } = await call("memory_read", { namespace: "projects/boundary", key: "missing" });
      expect(response.isError).toBe(true);
      expect(payload).toMatchObject({ ok: false, action: "memory_read", error: "internal_error" });
      expect(payload.message).toContain("unexpected error");
      expect(payload.error_reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(response)).not.toContain(privateDetail);
      expect(diagnostic.mock.calls.flat().join(" ")).not.toContain(privateDetail);
      expect(diagnostic.mock.calls.flat().join(" ")).toContain(payload.error_reference);
    },
  );

  it.each([
    ["writeState", "memory_write", { namespace: "projects/boundary", key: "fact", content: "A normal durable decision." }],
    ["patchState", "memory_write", { namespace: "projects/boundary", key: "fact", patch: { content_append: " An addition." } }],
    ["writeState", "memory_update_status", { namespace: "projects/boundary", phase: "Testing", lifecycle: "active", next_steps: ["Verify behavior"] }],
    ["appendLog", "memory_log", { namespace: "projects/boundary", content: "A normal durable decision." }],
    ["previewDelete", "memory_delete", { namespace: "projects/boundary", key: "fact" }],
  ] as const)("classifies unexpected %s failures as internal errors", async (method, name, args) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    storage.writeState(db, "projects/boundary", "fact", "A normal durable decision.", []);
    vi.spyOn(storage, method).mockImplementation(() => { throw new Error(privateDetail); });
    const { response, payload } = await call(name, args);
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(response)).not.toContain(privateDetail);
  });

  it("keeps a committed success when telemetry and diagnostic output fail", async () => {
    vi.spyOn(storage, "logToolCall").mockImplementation(() => { throw new Error(privateDetail); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error(privateDetail); });
    const { payload } = await call("memory_write", { namespace: "projects/boundary", key: "fact", content: "A normal durable decision." });
    expect(payload.ok).toBe(true);
    expect(storage.readState(db, "projects/boundary", "fact")?.content).toBe("A normal durable decision.");
  });

  it.each(["memory_write", "memory_update_status", "memory_extract"])(
    "does not mistake a classification lookup failure for validation in %s", async (name) => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      vi.spyOn(librarian, "resolveNamespaceClassificationFloor").mockImplementation(() => { throw new Error(privateDetail); });
      const args = name === "memory_extract"
        ? { conversation_text: "We decided to preserve all audit evidence.", namespace_hint: "projects/boundary", persist: true }
        : name === "memory_update_status"
          ? { namespace: "projects/boundary", phase: "Testing", lifecycle: "active" }
          : { namespace: "projects/boundary", key: "fact", content: "A normal durable decision." };
      const { payload } = await call(name, args);
      expect(payload.error).toBe("internal_error");
      expect(JSON.stringify(payload)).not.toContain(privateDetail);
    },
  );

  it("keeps unexpected delete confirmation failures behind the boundary", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    storage.writeState(db, "projects/boundary", "fact", "A normal durable decision.", []);
    const preview = await call("memory_delete", { namespace: "projects/boundary", key: "fact" });
    vi.spyOn(storage, "executeDelete").mockImplementation(() => { throw new Error(privateDetail); });
    const { payload } = await call("memory_delete", { namespace: "projects/boundary", key: "fact", delete_token: preview.payload.delete_token });
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
    expect(storage.readState(db, "projects/boundary", "fact")).not.toBeNull();
  });

  it("keeps optional intake failures from breaking committed writes even if diagnostics fail", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error(privateDetail); });
    vi.spyOn(storage, "getNamespaceEntriesForIntake").mockImplementation(() => { throw new Error(privateDetail); });
    const { payload } = await call("memory_write", { namespace: "projects/boundary", key: "fact", content: "A normal durable decision." });
    expect(payload.ok).toBe(true);
    expect(payload.warnings.join(" ")).toContain("[intake:unavailable]");
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
    expect(storage.readState(db, "projects/boundary", "fact")).not.toBeNull();
  });

  it("keeps optional intake persistence failures from breaking committed writes", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error(privateDetail); });
    db.exec("DROP TABLE entry_intake");
    const { payload } = await call("memory_write", { namespace: "projects/boundary", key: "fact", content: "A normal durable decision." });
    expect(payload.ok).toBe(true);
    expect(payload.warnings.join(" ")).toContain("[intake:persistence_unavailable]");
    expect(storage.readState(db, "projects/boundary", "fact")).not.toBeNull();
  });

  it("does not trust a lookalike public error or inspect its message", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const spoofed = Object.create(PublicValidationError.prototype);
    Object.defineProperty(spoofed, "message", { get() { throw new Error(privateDetail); } });
    vi.spyOn(storage, "writeState").mockImplementation(() => { throw spoofed; });
    const { payload } = await call("memory_write", { namespace: "projects/boundary", key: "fact", content: "A normal durable decision." });
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
  });

  it("keeps the primary safe error when telemetry and diagnostic output fail", async () => {
    vi.spyOn(storage, "readState").mockImplementation(() => { throw new Error(privateDetail); });
    vi.spyOn(storage, "logToolCall").mockImplementation(() => { throw new Error(privateDetail); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error(privateDetail); });
    const { payload } = await call("memory_read", { namespace: "projects/boundary", key: "fact" });
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
  });

  it("returns a safe response for a closed database", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    db.close();
    const { payload } = await call("memory_read", { namespace: "projects/boundary", key: "fact" });
    expect(payload.error).toBe("internal_error");
    expect(payload.message).not.toContain("closed");
  });

  it("keeps optional health section failures isolated even with hostile diagnostics", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error(privateDetail); });
    _setHealthSectionOverridesForTesting({ embedding: () => { throw hostile; } });
    const { payload } = await call("memory_health");
    expect(payload.ok).toBe(true);
    expect(payload.partial).toBe(true);
    expect(payload.sections.embedding).toEqual({ ok: false, error: "section_unavailable" });
    expect(payload.sections.size.ok).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
  });

  it("preserves deliberate history validation guidance", async () => {
    const { payload } = await call("memory_history", { namespace: "projects/boundary", since: "not-a-date" });
    expect(payload).toMatchObject({ error: "internal_error", action: "memory_history" });
    expect(payload.message).toContain("Must be a valid ISO 8601 timestamp");
  });

  it("does not serialize a code-health append storage failure as validation", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/code-health/agent-positive.json", import.meta.url), "utf8")) as { records: Array<Record<string, unknown>> };
    const record = { ...fixture.records.find(item => item.record_id === "ref:rec-worker")!, observed_at: new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    db.exec(`CREATE TEMP TRIGGER fail_code_health BEFORE INSERT ON code_health_records
      BEGIN SELECT RAISE(ABORT, '${privateDetail}'); END;`);
    const { payload } = await call("memory_code_health", { action: "append", namespace: "projects/boundary", record, idempotency_key: randomUUID() });
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
    expect(db.prepare("SELECT COUNT(*) AS n FROM code_health_records").get()).toEqual({ n: 0 });
  });

  it("does not serialize a code-health export storage failure as validation", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    db.exec(`CREATE TEMP TRIGGER fail_export BEFORE INSERT ON code_health_export_snapshots
      BEGIN SELECT RAISE(ABORT, '${privateDetail}'); END;`);
    const { payload } = await call("memory_code_health", { action: "export", namespace: "projects/boundary" });
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
  });

  it.each([new Error(privateDetail), privateDetail, hostile])("does not serialize or log unexpected consolidation provider failures (%#)", async (thrown) => {
    const previousEnabled = _consolidationConfig.enabled;
    _consolidationConfig.enabled = true;
    vi.stubEnv("MUNIN_LLM_BASE_URL", "http://127.0.0.1:1/v1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(thrown));
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      storage.appendLog(db, "projects/boundary", "We decided to preserve audit evidence for this project.", []);
      const { payload } = await call("memory_consolidate", { namespace: "projects/boundary" });
      expect(payload.error).toBe("synthesis_error");
      expect(JSON.stringify(payload)).not.toContain(privateDetail);
      expect(payload.message).toContain("error reference");
      expect(diagnostic.mock.calls.flat().join(" ")).not.toContain(privateDetail);
      expect(warning.mock.calls.flat().join(" ")).not.toContain(privateDetail);
    } finally {
      _consolidationConfig.enabled = previousEnabled;
    }
  });
});
