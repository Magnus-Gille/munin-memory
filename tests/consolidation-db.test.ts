import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import {
  initDatabase,
  writeState,
  appendLog,
  getNamespacesNeedingConsolidation,
  getLogsForConsolidation,
  getConsolidationMetadata,
  upsertConsolidationMetadata,
  replaceCrossReferences,
  getCrossReferences,
} from "../src/db.js";

const TEST_DB_PATH = "/tmp/munin-memory-consolidation-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

let db: Database.Database;

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  cleanupTestDb();
});

// Helper: insert a log entry at a specific timestamp by appending then overriding created_at
function appendLogAndSetTime(
  db: Database.Database,
  namespace: string,
  content: string,
  timestamp: string,
): string {
  const result = appendLog(db, namespace, content, []);
  db.prepare(
    "UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?",
  ).run(timestamp, timestamp, result.id);
  return result.id;
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("Migration v12 — consolidation tables", () => {
  it("creates consolidation_metadata and cross_references tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("consolidation_metadata");
    expect(names).toContain("cross_references");
  });

  it("creates indexes on cross_references", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cross_references'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_cross_refs_source");
    expect(indexNames).toContain("idx_cross_refs_target");
  });
});

describe("getNamespacesNeedingConsolidation", () => {
  it("returns tracked namespace with enough logs", () => {
    for (let i = 0; i < 5; i++) {
      appendLog(db, "projects/alpha", `Log entry ${i}`, []);
    }
    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].namespace).toBe("projects/alpha");
    expect(candidates[0].unincorporated_log_count).toBe(5);
    expect(candidates[0].last_consolidated_at).toBeNull();
  });

  it("excludes namespace with fewer logs than threshold", () => {
    // 2 logs — below default threshold of 3
    appendLog(db, "projects/beta", "Log 1", []);
    appendLog(db, "projects/beta", "Log 2", []);
    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates).toHaveLength(0);
  });

  it("excludes non-tracked namespaces (e.g. people/*)", () => {
    for (let i = 0; i < 5; i++) {
      appendLog(db, "people/alice", `Log ${i}`, []);
    }
    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates).toHaveLength(0);
  });

  it("supports clients/* namespaces", () => {
    for (let i = 0; i < 4; i++) {
      appendLog(db, "clients/acme", `Log ${i}`, []);
    }
    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].namespace).toBe("clients/acme");
  });

  it("sorts by unincorporated_log_count DESC", () => {
    for (let i = 0; i < 6; i++) appendLog(db, "projects/busy", `Log ${i}`, []);
    for (let i = 0; i < 3; i++) appendLog(db, "clients/quiet", `Log ${i}`, []);
    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates[0].namespace).toBe("projects/busy");
    expect(candidates[1].namespace).toBe("clients/quiet");
  });
});

describe("getNamespacesNeedingConsolidation — with prior consolidation checkpoint", () => {
  it("counts only logs after last_log_created_at", () => {
    // Insert 2 old logs before checkpoint
    appendLogAndSetTime(db, "projects/gamma", "Old log 1", "2026-01-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/gamma", "Old log 2", "2026-01-01T11:00:00.000Z");

    // Record consolidation at 2026-01-01T12:00:00.000Z
    upsertConsolidationMetadata(db, {
      namespace: "projects/gamma",
      last_consolidated_at: "2026-01-01T12:00:00.000Z",
      last_log_id: null,
      last_log_created_at: "2026-01-01T11:00:00.000Z",
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: null,
      run_duration_ms: null,
    });

    // Insert 3 new logs after checkpoint
    appendLogAndSetTime(db, "projects/gamma", "New log 1", "2026-02-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/gamma", "New log 2", "2026-02-01T11:00:00.000Z");
    appendLogAndSetTime(db, "projects/gamma", "New log 3", "2026-02-01T12:00:00.000Z");

    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].namespace).toBe("projects/gamma");
    expect(candidates[0].unincorporated_log_count).toBe(3);
    expect(candidates[0].last_consolidated_at).toBe("2026-01-01T12:00:00.000Z");
  });

  it("excludes namespace when new log count is below threshold after checkpoint", () => {
    appendLogAndSetTime(db, "projects/delta", "Old log 1", "2026-01-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/delta", "Old log 2", "2026-01-01T11:00:00.000Z");
    appendLogAndSetTime(db, "projects/delta", "Old log 3", "2026-01-01T12:00:00.000Z");

    upsertConsolidationMetadata(db, {
      namespace: "projects/delta",
      last_consolidated_at: "2026-01-01T13:00:00.000Z",
      last_log_id: null,
      last_log_created_at: "2026-01-01T12:00:00.000Z",
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: null,
      run_duration_ms: null,
    });

    // Only 2 new logs — below threshold
    appendLogAndSetTime(db, "projects/delta", "New log 1", "2026-02-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/delta", "New log 2", "2026-02-01T11:00:00.000Z");

    const candidates = getNamespacesNeedingConsolidation(db, 3);
    expect(candidates).toHaveLength(0);
  });
});

describe("getLogsForConsolidation", () => {
  it("returns all log entries for a namespace ordered ASC", () => {
    appendLogAndSetTime(db, "projects/epsilon", "Entry A", "2026-01-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/epsilon", "Entry B", "2026-01-01T11:00:00.000Z");
    appendLogAndSetTime(db, "projects/epsilon", "Entry C", "2026-01-01T12:00:00.000Z");
    appendLogAndSetTime(db, "projects/epsilon", "Entry D", "2026-01-01T13:00:00.000Z");
    appendLogAndSetTime(db, "projects/epsilon", "Entry E", "2026-01-01T14:00:00.000Z");

    const logs = getLogsForConsolidation(db, "projects/epsilon");
    expect(logs).toHaveLength(5);
    expect(logs[0].content).toBe("Entry A");
    expect(logs[4].content).toBe("Entry E");
    // Verify ascending order
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i].created_at >= logs[i - 1].created_at).toBe(true);
    }
  });

  it("filters logs by sinceTimestamp", () => {
    appendLogAndSetTime(db, "projects/zeta", "Before 1", "2026-01-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/zeta", "Before 2", "2026-01-01T11:00:00.000Z");
    appendLogAndSetTime(db, "projects/zeta", "After 1",  "2026-02-01T10:00:00.000Z");
    appendLogAndSetTime(db, "projects/zeta", "After 2",  "2026-02-01T11:00:00.000Z");
    appendLogAndSetTime(db, "projects/zeta", "After 3",  "2026-02-01T12:00:00.000Z");

    const logs = getLogsForConsolidation(db, "projects/zeta", "2026-01-01T11:00:00.000Z");
    // created_at > '2026-01-01T11:00:00.000Z' — only the 3 after-entries
    expect(logs).toHaveLength(3);
    expect(logs[0].content).toBe("After 1");
  });

  it("returns empty array for namespace with no logs", () => {
    const logs = getLogsForConsolidation(db, "projects/nonexistent");
    expect(logs).toHaveLength(0);
  });

  it("excludes state entries", () => {
    writeState(db, "projects/eta", "status", "state content", []);
    appendLog(db, "projects/eta", "log content", []);

    const logs = getLogsForConsolidation(db, "projects/eta");
    expect(logs).toHaveLength(1);
    expect(logs[0].entry_type).toBe("log");
  });
});

describe("getConsolidationMetadata / upsertConsolidationMetadata", () => {
  it("returns null for unknown namespace", () => {
    const result = getConsolidationMetadata(db, "projects/unknown");
    expect(result).toBeNull();
  });

  it("upserts and reads back metadata", () => {
    upsertConsolidationMetadata(db, {
      namespace: "projects/theta",
      last_consolidated_at: "2026-03-01T12:00:00.000Z",
      last_log_id: "abc-123",
      last_log_created_at: "2026-03-01T11:00:00.000Z",
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: 1234,
      run_duration_ms: 5000,
    });

    const meta = getConsolidationMetadata(db, "projects/theta");
    expect(meta).not.toBeNull();
    expect(meta!.namespace).toBe("projects/theta");
    expect(meta!.last_consolidated_at).toBe("2026-03-01T12:00:00.000Z");
    expect(meta!.last_log_id).toBe("abc-123");
    expect(meta!.last_log_created_at).toBe("2026-03-01T11:00:00.000Z");
    expect(meta!.synthesis_model).toBe("claude-haiku-3-5");
    expect(meta!.synthesis_token_count).toBe(1234);
    expect(meta!.run_duration_ms).toBe(5000);
    expect(meta!.created_at).toBeTruthy();
    expect(meta!.updated_at).toBeTruthy();
  });

  it("updates updated_at on second upsert but preserves created_at", () => {
    upsertConsolidationMetadata(db, {
      namespace: "projects/iota",
      last_consolidated_at: "2026-03-01T12:00:00.000Z",
      last_log_id: null,
      last_log_created_at: null,
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: null,
      run_duration_ms: null,
    });

    const first = getConsolidationMetadata(db, "projects/iota")!;

    // Small delay to ensure updated_at changes
    // Use a direct SQL update to simulate time passing
    db.prepare("UPDATE consolidation_metadata SET updated_at = '2026-01-01T00:00:00.000Z' WHERE namespace = ?")
      .run("projects/iota");

    upsertConsolidationMetadata(db, {
      namespace: "projects/iota",
      last_consolidated_at: "2026-04-01T12:00:00.000Z",
      last_log_id: "def-456",
      last_log_created_at: "2026-04-01T11:00:00.000Z",
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: 2000,
      run_duration_ms: 3000,
    });

    const second = getConsolidationMetadata(db, "projects/iota")!;
    expect(second.last_consolidated_at).toBe("2026-04-01T12:00:00.000Z");
    expect(second.synthesis_token_count).toBe(2000);
    // updated_at should have changed from the '2026-01-01' we set
    expect(second.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
    // created_at should remain from first insert
    expect(second.created_at).toBe(first.created_at);
  });

  it("handles null optional fields", () => {
    upsertConsolidationMetadata(db, {
      namespace: "projects/kappa",
      last_consolidated_at: "2026-03-01T12:00:00.000Z",
      last_log_id: null,
      last_log_created_at: null,
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: null,
      run_duration_ms: null,
    });

    const meta = getConsolidationMetadata(db, "projects/kappa")!;
    expect(meta.last_log_id).toBeNull();
    expect(meta.last_log_created_at).toBeNull();
    expect(meta.synthesis_token_count).toBeNull();
    expect(meta.run_duration_ms).toBeNull();
  });
});

describe("replaceCrossReferences", () => {
  const ns = "projects/lambda";
  const ns2 = "projects/mu";

  it("inserts new cross-references", () => {
    replaceCrossReferences(db, ns, [
      { source_namespace: ns, target_namespace: ns2, reference_type: "depends_on", context: "needs mu output", confidence: 0.9 },
      { source_namespace: ns, target_namespace: "projects/nu", reference_type: "related_to", context: null, confidence: 1.0 },
      { source_namespace: ns, target_namespace: "projects/xi", reference_type: "blocks", context: "blocking", confidence: 0.8 },
    ]);

    const rows = db
      .prepare("SELECT * FROM cross_references WHERE source_namespace = ?")
      .all(ns) as Array<{ source_namespace: string; target_namespace: string; reference_type: string }>;
    expect(rows).toHaveLength(3);
  });

  it("replaces existing references when called again", () => {
    replaceCrossReferences(db, ns, [
      { source_namespace: ns, target_namespace: ns2, reference_type: "depends_on", context: "v1", confidence: 1.0 },
      { source_namespace: ns, target_namespace: "projects/old", reference_type: "related_to", context: null, confidence: 1.0 },
    ]);

    // Now replace with just 2 (different) refs
    replaceCrossReferences(db, ns, [
      { source_namespace: ns, target_namespace: ns2, reference_type: "feeds_into", context: "v2", confidence: 0.75 },
      { source_namespace: ns, target_namespace: "projects/new", reference_type: "supersedes", context: null, confidence: 1.0 },
    ]);

    const rows = db
      .prepare("SELECT * FROM cross_references WHERE source_namespace = ?")
      .all(ns) as Array<{ reference_type: string; target_namespace: string }>;
    expect(rows).toHaveLength(2);
    const types = rows.map((r) => r.reference_type);
    expect(types).toContain("feeds_into");
    expect(types).toContain("supersedes");
    expect(types).not.toContain("depends_on");
    expect(types).not.toContain("related_to");
  });

  it("records sourceSynthesisId on each inserted row", () => {
    const synthId = "synth-id-42";
    replaceCrossReferences(
      db,
      ns,
      [{ source_namespace: ns, target_namespace: ns2, reference_type: "blocks", context: null, confidence: 1.0 }],
      synthId,
    );
    const row = db
      .prepare("SELECT source_synthesis_id FROM cross_references WHERE source_namespace = ?")
      .get(ns) as { source_synthesis_id: string };
    expect(row.source_synthesis_id).toBe(synthId);
  });

  it("clears all refs when called with empty array", () => {
    replaceCrossReferences(db, ns, [
      { source_namespace: ns, target_namespace: ns2, reference_type: "depends_on", context: null, confidence: 1.0 },
    ]);
    replaceCrossReferences(db, ns, []);
    const rows = db
      .prepare("SELECT * FROM cross_references WHERE source_namespace = ?")
      .all(ns);
    expect(rows).toHaveLength(0);
  });
});

describe("getCrossReferences", () => {
  it("returns refs for both source and target directions", () => {
    const srcNs = "projects/omicron";
    const tgtNs = "projects/pi";
    const otherNs = "projects/rho";

    // srcNs → tgtNs
    replaceCrossReferences(db, srcNs, [
      { source_namespace: srcNs, target_namespace: tgtNs, reference_type: "depends_on", context: null, confidence: 1.0 },
    ]);
    // otherNs → srcNs (srcNs is target here)
    replaceCrossReferences(db, otherNs, [
      { source_namespace: otherNs, target_namespace: srcNs, reference_type: "feeds_into", context: null, confidence: 1.0 },
    ]);
    // tgtNs → unrelated
    replaceCrossReferences(db, tgtNs, [
      { source_namespace: tgtNs, target_namespace: "projects/sigma", reference_type: "related_to", context: null, confidence: 1.0 },
    ]);

    const refs = getCrossReferences(db, srcNs);
    // Should include: srcNs→tgtNs and otherNs→srcNs
    expect(refs).toHaveLength(2);
    const pairs = refs.map((r) => `${r.source_namespace}→${r.target_namespace}`);
    expect(pairs).toContain(`${srcNs}→${tgtNs}`);
    expect(pairs).toContain(`${otherNs}→${srcNs}`);
  });

  it("returns empty array for namespace with no cross-references", () => {
    const refs = getCrossReferences(db, "projects/tau");
    expect(refs).toHaveLength(0);
  });

  it("orders results by extracted_at DESC", () => {
    const srcNs = "projects/upsilon";
    const tgtNs1 = "projects/phi";
    const tgtNs2 = "projects/chi";

    // Insert two refs — they'll have the same extracted_at from the same replaceCrossReferences call
    // We can test ordering by doing two separate calls
    replaceCrossReferences(db, srcNs, [
      { source_namespace: srcNs, target_namespace: tgtNs1, reference_type: "depends_on", context: null, confidence: 1.0 },
    ]);
    // Override extracted_at to an earlier time
    db.prepare("UPDATE cross_references SET extracted_at = '2026-01-01T00:00:00.000Z' WHERE source_namespace = ?")
      .run(srcNs);

    // Second ref with a later timestamp (default nowUTC)
    db.prepare(
      `INSERT INTO cross_references (id, source_namespace, target_namespace, reference_type, confidence, extracted_at)
       VALUES ('test-id-later', ?, ?, 'blocks', 1.0, '2026-06-01T00:00:00.000Z')`,
    ).run(srcNs, tgtNs2);

    const refs = getCrossReferences(db, srcNs);
    expect(refs).toHaveLength(2);
    expect(refs[0].target_namespace).toBe(tgtNs2); // later one first
    expect(refs[1].target_namespace).toBe(tgtNs1);
  });
});
