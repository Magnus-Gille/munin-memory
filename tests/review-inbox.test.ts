import { describe, expect, it, vi } from "vitest";
import { initDatabase, readState, writeState } from "../src/db.js";
import {
  approveReviewProposal,
  createReviewProposal,
  createUndoReviewProposal,
  declineReviewProposal,
  editReviewProposal,
  getReviewProposal,
  listReviewProposalEvents,
  listReviewProposals,
  markReviewProposalSuperseded,
  pruneReviewProposals,
  type ReviewOperation,
} from "../src/review-inbox.js";

const CREATED_AT = "2026-07-23T10:00:00.000Z";
const EXPIRES_AT = "2026-08-22T10:00:00.000Z";

function writeOperation(content = "Draft durable review inbox"): ReviewOperation {
  return {
    action: "memory_write",
    namespace: "projects/munin-memory",
    key: "status",
    content,
    tags: ["active"],
    create_if_absent: true,
  };
}

function createPending(db: ReturnType<typeof initDatabase>) {
  return createReviewProposal(db, {
    creatorPrincipalId: "owner",
    operation: writeOperation(),
    classification: "internal",
    confidence: 0.92,
    reasons: ["explicit current work"],
    sourceRefs: [],
    sourceExcerpt: "Current work: draft the durable review inbox.",
    sourceHash: "sha256:source",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  });
}

describe("durable review inbox persistence", () => {
  it("persists bounded proposal payloads and an attributable created event", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    const proposal = getReviewProposal(db, created.id, "owner");
    expect(proposal).toMatchObject({
      id: created.id,
      creator_principal_id: "owner",
      operation_type: "memory_write",
      target_namespace: "projects/munin-memory",
      target_key: "status",
      classification: "internal",
      status: "pending",
      original_operation: writeOperation(),
      current_operation: writeOperation(),
      source_excerpt: "Current work: draft the durable review inbox.",
    });
    expect(listReviewProposalEvents(db, created.id, "owner")).toEqual([
      expect.objectContaining({
        actor_principal_id: "owner",
        event_type: "created",
        from_status: null,
        to_status: "pending",
      }),
    ]);
    db.close();
  });

  it("isolates proposals by creator principal even when IDs are known", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    expect(getReviewProposal(db, created.id, "alice")).toBeNull();
    expect(listReviewProposals(db, "alice")).toEqual([]);
    expect(listReviewProposalEvents(db, created.id, "alice")).toEqual([]);
    db.close();
  });

  it("rejects oversized source excerpts and excessive source references", () => {
    const db = initDatabase(":memory:");
    expect(() => createReviewProposal(db, {
      creatorPrincipalId: "owner",
      operation: writeOperation(),
      classification: "internal",
      confidence: 0.5,
      reasons: [],
      sourceRefs: [],
      sourceExcerpt: "x".repeat(501),
      sourceHash: "sha256:source",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    })).toThrow(/source excerpt/i);
    expect(() => createReviewProposal(db, {
      creatorPrincipalId: "owner",
      operation: writeOperation(),
      classification: "internal",
      confidence: 0.5,
      reasons: [],
      sourceRefs: Array.from({ length: 11 }, (_, index) => ({
        id: `entry-${index}`,
        namespace: "projects/munin-memory",
        key: "status",
        entry_type: "state" as const,
        updated_at: CREATED_AT,
        content_hash: `hash-${index}`,
      })),
      sourceExcerpt: "bounded",
      sourceHash: "sha256:source",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    })).toThrow(/source references/i);
    db.close();
  });

  it("rejects invalid creator, confidence, reason count, expiry, and event detail", () => {
    const db = initDatabase(":memory:");
    const valid = {
      creatorPrincipalId: "owner",
      operation: writeOperation(),
      classification: "internal" as const,
      confidence: 0.5,
      reasons: [] as string[],
      sourceRefs: [],
      sourceExcerpt: "bounded",
      sourceHash: "sha256:source",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    };

    expect(() => createReviewProposal(db, {
      ...valid,
      creatorPrincipalId: "",
    })).toThrow(/creator principal/i);
    expect(() => createReviewProposal(db, {
      ...valid,
      confidence: Number.NaN,
    })).toThrow(/confidence/i);
    expect(() => createReviewProposal(db, {
      ...valid,
      reasons: Array.from({ length: 11 }, () => "reason"),
    })).toThrow(/reasons/i);
    expect(() => createReviewProposal(db, {
      ...valid,
      expiresAt: CREATED_AT,
    })).toThrow(/expiry/i);
    const created = createReviewProposal(db, valid);
    expect(() => approveReviewProposal(
      db,
      created.id,
      "owner",
      () => ({
        outcome: "applied" as const,
        entryId: "x".repeat(2_100),
        entryUpdatedAt: CREATED_AT,
        priorEntrySnapshot: null,
      }),
      "2026-07-23T10:05:00.000Z",
    )).toThrow(/event detail/i);
    expect(getReviewProposal(db, created.id, "owner")?.status).toBe("pending");
    db.close();
  });
});

describe("review proposal lifecycle", () => {
  it("edits a pending proposal while preserving its original operation", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);
    const editedOperation = writeOperation("Implement durable review inbox");

    const edited = editReviewProposal(
      db,
      created.id,
      "owner",
      editedOperation,
      "corrected wording",
      "2026-07-23T10:05:00.000Z",
    );

    expect(edited.status).toBe("edited");
    const proposal = getReviewProposal(db, created.id, "owner");
    expect(proposal?.original_operation).toEqual(writeOperation());
    expect(proposal?.current_operation).toEqual(editedOperation);
    expect(listReviewProposalEvents(db, created.id, "owner").at(-1)).toMatchObject({
      actor_principal_id: "owner",
      event_type: "edited",
      from_status: "pending",
      to_status: "edited",
    });
    db.close();
  });

  it("declines once and treats a duplicate decline as idempotent", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    expect(declineReviewProposal(
      db,
      created.id,
      "owner",
      "not durable enough",
      "2026-07-23T10:05:00.000Z",
    ).status).toBe("declined");
    expect(declineReviewProposal(
      db,
      created.id,
      "owner",
      "duplicate click",
      "2026-07-23T10:06:00.000Z",
    )).toMatchObject({ status: "declined", duplicate: true });
    expect(listReviewProposalEvents(db, created.id, "owner")
      .filter((event) => event.event_type === "declined")).toHaveLength(1);
    db.close();
  });

  it("bounds JSON-expanding review reasons without aborting the transition", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    expect(declineReviewProposal(
      db,
      created.id,
      "owner",
      "\u0001".repeat(500),
      "2026-07-23T10:05:00.000Z",
    )).toMatchObject({ status: "declined", duplicate: false });
    expect(getReviewProposal(db, created.id, "owner")?.terminal_detail).toHaveLength(250);
    expect(listReviewProposalEvents(db, created.id, "owner").at(-1))
      .toMatchObject({ event_type: "declined", to_status: "declined" });
    db.close();
  });

  it("atomically approves once and returns the stored result on duplicate approval", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);
    const apply = vi.fn(() => {
      const result = writeState(
        db,
        "projects/munin-memory",
        "status",
        "Draft durable review inbox",
        ["active"],
        "owner",
        undefined,
        undefined,
        { createIfAbsent: true },
      );
      if (result.status === "conflict") {
        return { outcome: "conflict" as const, code: "target_conflict", detail: result.message };
      }
      return {
        outcome: "applied" as const,
        entryId: result.id!,
        entryUpdatedAt: result.updated_at!,
        priorEntrySnapshot: null,
      };
    });

    const first = approveReviewProposal(
      db,
      created.id,
      "owner",
      apply,
      "2026-07-23T10:05:00.000Z",
    );
    const second = approveReviewProposal(
      db,
      created.id,
      "owner",
      apply,
      "2026-07-23T10:06:00.000Z",
    );

    expect(first).toMatchObject({ status: "approved", duplicate: false });
    expect(second).toMatchObject({
      status: "approved",
      duplicate: true,
      applied_entry_id: first.applied_entry_id,
      applied_entry_updated_at: first.applied_entry_updated_at,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(readState(db, "projects/munin-memory", "status")?.content)
      .toBe("Draft durable review inbox");
    expect(listReviewProposalEvents(db, created.id, "owner")
      .filter((event) => event.event_type === "approved")).toHaveLength(1);
    db.close();
  });

  it("rolls the memory mutation back if approval crashes before the transition commits", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    expect(() => approveReviewProposal(
      db,
      created.id,
      "owner",
      () => {
        writeState(
          db,
          "projects/munin-memory",
          "status",
          "must roll back",
          ["active"],
          "owner",
        );
        throw new Error("simulated process failure");
      },
      "2026-07-23T10:05:00.000Z",
    )).toThrow("simulated process failure");

    expect(readState(db, "projects/munin-memory", "status")).toBeNull();
    expect(getReviewProposal(db, created.id, "owner")?.status).toBe("pending");
    expect(listReviewProposalEvents(db, created.id, "owner")
      .map((event) => event.event_type)).toEqual(["created"]);
    db.close();
  });

  it("keeps a stale proposal reviewable and audits the approval conflict", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    const result = approveReviewProposal(
      db,
      created.id,
      "owner",
      () => ({
        outcome: "conflict" as const,
        code: "source_changed",
        detail: "A referenced source changed after extraction.",
      }),
      "2026-07-23T10:05:00.000Z",
    );

    expect(result).toMatchObject({
      status: "pending",
      conflict: true,
      code: "source_changed",
    });
    expect(getReviewProposal(db, created.id, "owner")?.status).toBe("pending");
    expect(listReviewProposalEvents(db, created.id, "owner").at(-1)).toMatchObject({
      event_type: "approval_conflict",
      from_status: "pending",
      to_status: "pending",
    });
    db.close();
  });

  it("records a bounded failed terminal transition when application rejects the proposal", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    const result = approveReviewProposal(
      db,
      created.id,
      "owner",
      () => ({
        outcome: "failed" as const,
        code: "invalid_operation",
        detail: "The operation can no longer be applied.",
      }),
      "2026-07-23T10:05:00.000Z",
    );

    expect(result).toEqual({ status: "failed" });
    expect(getReviewProposal(db, created.id, "owner")).toMatchObject({
      status: "failed",
      terminal_code: "invalid_operation",
    });
    expect(listReviewProposalEvents(db, created.id, "owner").at(-1))
      .toMatchObject({ event_type: "failed", to_status: "failed" });
    db.close();
  });

  it("returns explicit not-found and invalid-transition results", () => {
    const db = initDatabase(":memory:");
    expect(editReviewProposal(
      db,
      "missing",
      "owner",
      writeOperation(),
      "missing",
      CREATED_AT,
    )).toEqual({ status: "not_found" });
    const created = createPending(db);
    declineReviewProposal(
      db,
      created.id,
      "owner",
      "done",
      "2026-07-23T10:05:00.000Z",
    );
    expect(editReviewProposal(
      db,
      created.id,
      "owner",
      writeOperation(),
      "too late",
      "2026-07-23T10:06:00.000Z",
    )).toEqual({
      status: "invalid_transition",
      current_status: "declined",
    });
    expect(approveReviewProposal(
      db,
      created.id,
      "owner",
      () => {
        throw new Error("must not run");
      },
      "2026-07-23T10:06:00.000Z",
    )).toEqual({
      status: "invalid_transition",
      current_status: "declined",
    });
    expect(declineReviewProposal(
      db,
      "missing",
      "owner",
      "missing",
      CREATED_AT,
    )).toEqual({ status: "not_found" });
    expect(approveReviewProposal(
      db,
      "missing",
      "owner",
      () => {
        throw new Error("must not run");
      },
      CREATED_AT,
    )).toEqual({ status: "not_found" });
    expect(createUndoReviewProposal(db, created.id, {
      creatorPrincipalId: "owner",
      operation: writeOperation("undo"),
      classification: "internal",
      confidence: 1,
      reasons: ["reviewed undo"],
      sourceRefs: [],
      sourceExcerpt: "reviewed undo",
      sourceHash: "hash",
      createdAt: "2026-07-23T10:07:00.000Z",
      expiresAt: EXPIRES_AT,
    })).toBeNull();
    db.close();
  });

  it("filters lists by status and expires proposals during edit and approval", () => {
    const db = initDatabase(":memory:");
    const editExpired = createPending(db);
    const approveExpired = createPending(db);
    const declined = createPending(db);
    declineReviewProposal(
      db,
      declined.id,
      "owner",
      "not needed",
      "2026-07-23T10:05:00.000Z",
    );

    expect(listReviewProposals(db, "owner", "declined").map(({ id }) => id))
      .toEqual([declined.id]);
    expect(editReviewProposal(
      db,
      editExpired.id,
      "owner",
      writeOperation("too late"),
      "expired",
      "2026-08-23T10:00:00.000Z",
    )).toEqual({ status: "expired" });
    expect(approveReviewProposal(
      db,
      approveExpired.id,
      "owner",
      () => {
        throw new Error("must not run");
      },
      "2026-08-23T10:00:00.000Z",
    )).toEqual({ status: "expired" });
    expect(getReviewProposal(db, editExpired.id, "owner")?.status).toBe("expired");
    expect(getReviewProposal(db, approveExpired.id, "owner")?.status).toBe("expired");
    db.close();
  });

  it("creates and attributes a reviewed undo proposal before superseding the original", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);
    approveReviewProposal(
      db,
      created.id,
      "owner",
      () => ({
        outcome: "applied" as const,
        entryId: writeState(
          db,
          "projects/munin-memory",
          "status",
          "accepted",
          ["active"],
          "owner",
        ).id!,
        entryUpdatedAt: readState(db, "projects/munin-memory", "status")!.updated_at,
        priorEntrySnapshot: null,
      }),
      "2026-07-23T10:05:00.000Z",
    );
    const undo = createUndoReviewProposal(db, created.id, {
      creatorPrincipalId: "owner",
      operation: {
        action: "memory_log",
        namespace: "projects/munin-memory",
        content: "Correction",
      },
      classification: "internal",
      confidence: 1,
      reasons: ["reviewed undo"],
      sourceRefs: [],
      sourceExcerpt: "reviewed undo",
      sourceHash: "hash",
      createdAt: "2026-07-23T10:06:00.000Z",
      expiresAt: EXPIRES_AT,
    });

    expect(undo).not.toBeNull();
    expect(listReviewProposalEvents(db, created.id, "owner").at(-1))
      .toMatchObject({ event_type: "undo_created", to_status: "approved" });
    expect(markReviewProposalSuperseded(
      db,
      created.id,
      undo!.id,
      "owner",
      "2026-07-23T10:07:00.000Z",
    )).toBe(true);
    expect(getReviewProposal(db, created.id, "owner")?.status).toBe("superseded");
    expect(markReviewProposalSuperseded(
      db,
      created.id,
      undo!.id,
      "owner",
      "2026-07-23T10:08:00.000Z",
    )).toBe(false);
    db.close();
  });
});

describe("review proposal retention", () => {
  it("expires stale actionable proposals and purges old terminal payloads into tombstones", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);

    const expiry = pruneReviewProposals(
      db,
      "2026-08-23T10:00:00.000Z",
      { terminalPayloadDays: 7, approvedUndoDays: 30 },
    );
    expect(expiry.expired).toBe(1);
    expect(getReviewProposal(db, created.id, "owner")?.status).toBe("expired");

    const purge = pruneReviewProposals(
      db,
      "2026-08-31T10:00:00.000Z",
      { terminalPayloadDays: 7, approvedUndoDays: 30 },
    );
    expect(purge.payloads_purged).toBe(1);
    const tombstone = getReviewProposal(db, created.id, "owner");
    expect(tombstone).toMatchObject({
      status: "expired",
      original_operation: null,
      current_operation: null,
      source_excerpt: null,
      source_refs: [],
    });
    expect(tombstone?.payload_purged_at).toBeTruthy();
    expect(listReviewProposalEvents(db, created.id, "owner")
      .map((event) => event.event_type)).toEqual([
      "created",
      "expired",
      "payload_purged",
    ]);
    expect(listReviewProposalEvents(db, created.id, "owner")[1].actor_principal_id)
      .toBe("system:maintenance");
    expect(listReviewProposalEvents(db, created.id, "owner")[2].actor_principal_id)
      .toBe("system:maintenance");
    db.close();
  });

  it("purges approved proposal payloads after the reviewed-undo window", () => {
    const db = initDatabase(":memory:");
    const created = createPending(db);
    approveReviewProposal(
      db,
      created.id,
      "owner",
      () => ({
        outcome: "applied",
        entryId: "entry-id",
        entryUpdatedAt: "2026-07-23T10:05:00.000Z",
        priorEntrySnapshot: {
          content: "sensitive prior truth",
          classification: "client-restricted",
        },
      }),
      "2026-07-23T10:05:00.000Z",
    );

    const pruned = pruneReviewProposals(
      db,
      "2026-08-23T10:06:00.000Z",
      { terminalPayloadDays: 7, approvedUndoDays: 30 },
    );
    const tombstone = getReviewProposal(db, created.id, "owner");

    expect(pruned).toMatchObject({
      payloads_purged: 1,
      undo_snapshots_purged: 1,
    });
    expect(tombstone).toMatchObject({
      status: "approved",
      original_operation: null,
      current_operation: null,
      prior_entry_snapshot: null,
      source_excerpt: null,
      source_refs: [],
    });
    expect(tombstone?.applied_entry_id).toBe("entry-id");
    expect(listReviewProposalEvents(db, created.id, "owner").at(-1))
      .toMatchObject({ event_type: "payload_purged", to_status: "approved" });
    db.close();
  });
});
