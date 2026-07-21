import { describe, it, expect } from "vitest";
import { initDatabase } from "../src/db.js";
import { runMaintenancePrune } from "../src/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function insertRedactionLog(db: ReturnType<typeof initDatabase>, id: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO redaction_log
       (id, session_id, principal_id, transport_type, entry_id, entry_namespace, entry_classification, connection_max_classification, tool_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `session-${id}`,
    "owner",
    "consumer",
    `entry-${id}`,
    "clients/acme",
    "client-confidential",
    "internal",
    "memory_read",
    createdAt,
  );
}

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
        "clients/acme",
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
        "clients/acme",
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

  it.each([
    ["unset", undefined],
    ["non-numeric", "not-a-number"],
    ["partially numeric", "30oops"],
    ["fractional", "30.5"],
    ["zero", "0"],
    ["negative", "-30"],
    ["unsafe integer", "9007199254740992"],
  ])("defaults redaction audit retention to 365 days when configuration is %s", (_label, configuredValue) => {
    const db = initDatabase(":memory:");
    const originalRetention = process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;

    if (configuredValue === undefined) {
      delete process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;
    } else {
      process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS = configuredValue;
    }

    try {
      insertRedactionLog(
        db,
        "within-default-retention",
        new Date(Date.now() - (200 * DAY_MS)).toISOString(),
      );
      insertRedactionLog(
        db,
        "outside-default-retention",
        new Date(Date.now() - (400 * DAY_MS)).toISOString(),
      );

      runMaintenancePrune(db);

      const rows = db
        .prepare("SELECT id FROM redaction_log ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(rows).toEqual([{ id: "within-default-retention" }]);
    } finally {
      if (originalRetention === undefined) {
        delete process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;
      } else {
        process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS = originalRetention;
      }
      db.close();
    }
  });

  it.each([
    ["plain decimal", "180"],
    ["surrounding whitespace", "  180  "],
  ])("honors an explicit positive safe integer with %s", (_label, configuredValue) => {
    const db = initDatabase(":memory:");
    const originalRetention = process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS;
    process.env.MUNIN_REDACTION_LOG_RETENTION_DAYS = configuredValue;

    try {
      insertRedactionLog(
        db,
        "within-explicit-retention",
        new Date(Date.now() - (100 * DAY_MS)).toISOString(),
      );
      insertRedactionLog(
        db,
        "outside-explicit-retention",
        new Date(Date.now() - (200 * DAY_MS)).toISOString(),
      );

      runMaintenancePrune(db);

      const rows = db
        .prepare("SELECT id FROM redaction_log ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(rows).toEqual([{ id: "within-explicit-retention" }]);
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
