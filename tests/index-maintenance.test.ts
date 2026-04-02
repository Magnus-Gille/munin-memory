import { describe, it, expect } from "vitest";
import { initDatabase } from "../src/db.js";
import { runMaintenancePrune } from "../src/index.js";

describe("runMaintenancePrune", () => {
  it("prunes expired redaction log rows", () => {
    const db = initDatabase(":memory:");
    const originalRetention = process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;
    process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS = "1";

    try {
      db.prepare(
        `INSERT INTO redaction_log
           (id, session_id, principal_id, transport_type, entry_id, entry_namespace, entry_classification, connection_max_classification, tool_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "old-redaction",
        "session-1",
        "owner",
        "consumer",
        "entry-1",
        "clients/lofalk",
        "client-confidential",
        "internal",
        "memory_read",
        "2026-03-01T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO redaction_log
           (id, session_id, principal_id, transport_type, entry_id, entry_namespace, entry_classification, connection_max_classification, tool_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "fresh-redaction",
        "session-2",
        "owner",
        "consumer",
        "entry-2",
        "clients/lofalk",
        "client-confidential",
        "internal",
        "memory_read",
        "2099-03-01T00:00:00.000Z",
      );

      runMaintenancePrune(db);

      const rows = db
        .prepare("SELECT id FROM redaction_log ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(rows).toEqual([{ id: "fresh-redaction" }]);
    } finally {
      if (originalRetention === undefined) {
        delete process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;
      } else {
        process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS = originalRetention;
      }
      db.close();
    }
  });
});
