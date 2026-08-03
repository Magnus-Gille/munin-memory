import { describe, it, expect, vi } from "vitest";
import { createQuerySnapshot, initDatabase } from "../src/db.js";
import {
  runMaintenancePrune,
  startMaintenancePruneTimer,
  stopMaintenancePruneTimer,
} from "../src/index.js";
import { createReviewProposal, declineReviewProposal } from "../src/review-inbox.js";

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

function insertQuerySnapshot(
  db: ReturnType<typeof initDatabase>,
  id: string,
  createdAt: string,
  expiresAt: string,
): void {
  createQuerySnapshot(db, {
    id,
    principalId: "maintenance-test",
    accessFingerprint: JSON.stringify({ domain: "test", version: 1 }),
    requestFingerprint: "b".repeat(64),
    requestShape: JSON.stringify({ query: id }),
    responseMeta: JSON.stringify({ search_mode: "filter", retrieval: { serialization: "linear" } }),
    resultIds: JSON.stringify([`result-${id}`]),
    resultMatchMeta: "{}",
    cursorSecret: `secret-${id}`,
    createdAt,
    expiresAt,
    totalMatched: 1,
  });
}

describe("runMaintenancePrune", () => {
  it("physically removes expired query snapshots during startup maintenance", () => {
    const db = initDatabase(":memory:");
    insertQuerySnapshot(
      db,
      "active-maintenance-snapshot",
      "2026-08-03T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
    );
    insertQuerySnapshot(
      db,
      "expired-maintenance-snapshot",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:05:00.000Z",
    );

    runMaintenancePrune(db);

    const rows = db.prepare("SELECT id FROM query_snapshots ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(rows).toEqual([{ id: "active-maintenance-snapshot" }]);
    db.close();
  });

  it("periodically prunes an idle snapshot and stops before the database closes", () => {
    vi.useFakeTimers();
    const db = initDatabase(":memory:");
    const additionalCleanup = vi.fn();
    let timer: ReturnType<typeof setInterval> | undefined;

    try {
      insertQuerySnapshot(
        db,
        "idle-expired-snapshot",
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:05:00.000Z",
      );
      timer = startMaintenancePruneTimer(db, {
        intervalMs: 1_000,
        additionalCleanup,
      });

      vi.advanceTimersByTime(999);
      expect(db.prepare("SELECT COUNT(*) AS count FROM query_snapshots").get()).toEqual({ count: 1 });
      vi.advanceTimersByTime(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM query_snapshots").get()).toEqual({ count: 0 });
      expect(additionalCleanup).toHaveBeenCalledTimes(1);

      stopMaintenancePruneTimer(timer);
      timer = undefined;
      db.close();
      expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
      expect(additionalCleanup).toHaveBeenCalledTimes(1);
    } finally {
      if (timer !== undefined) stopMaintenancePruneTimer(timer);
      if (db.open) db.close();
      vi.useRealTimers();
    }
  });

  it("expires stale review proposals and prunes terminal proposal payloads", () => {
    const db = initDatabase(":memory:");
    const created = createReviewProposal(db, {
      creatorPrincipalId: "owner",
      operation: {
        action: "memory_log",
        namespace: "projects/test",
        content: "Review me",
      },
      classification: "internal",
      confidence: 0.8,
      reasons: ["test"],
      sourceRefs: [],
      sourceExcerpt: "Review me",
      sourceHash: "hash",
      createdAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-31T00:00:00.000Z",
    });
    const declined = createReviewProposal(db, {
      creatorPrincipalId: "owner",
      operation: {
        action: "memory_log",
        namespace: "projects/test",
        content: "Purge me",
      },
      classification: "internal",
      confidence: 0.8,
      reasons: ["test"],
      sourceRefs: [],
      sourceExcerpt: "Purge me",
      sourceHash: "hash",
      createdAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-31T00:00:00.000Z",
    });
    declineReviewProposal(
      db,
      declined.id,
      "owner",
      "old decline",
      "2000-01-02T00:00:00.000Z",
    );

    runMaintenancePrune(db);

    expect(db.prepare(
      "SELECT status FROM review_proposals WHERE id = ?",
    ).get(created.id)).toEqual({ status: "expired" });
    expect(db.prepare(
      "SELECT current_operation, payload_purged_at FROM review_proposals WHERE id = ?",
    ).get(declined.id)).toEqual({
      current_operation: null,
      payload_purged_at: expect.any(String),
    });
    db.close();
  });

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
