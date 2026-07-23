import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ClassificationLevel, EntryType } from "./types.js";

export const REVIEW_PROPOSAL_TTL_DAYS = 30;
export const REVIEW_TERMINAL_PAYLOAD_RETENTION_DAYS = 7;
export const REVIEW_APPROVED_UNDO_RETENTION_DAYS = 30;
export const REVIEW_SOURCE_EXCERPT_MAX_CHARS = 500;
export const REVIEW_SOURCE_REF_MAX_COUNT = 10;
export const REVIEW_REASON_MAX_COUNT = 10;

export type ReviewProposalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "edited"
  | "superseded"
  | "expired"
  | "failed";

export type ReviewOperation =
  | {
      action: "memory_write";
      namespace: string;
      key: string;
      content: string;
      tags?: string[];
      valid_until?: string | null;
      expected_updated_at?: string;
      create_if_absent?: boolean;
      classification?: ClassificationLevel;
      supersedes?: string;
      valid_from?: string;
    }
  | {
      action: "memory_log";
      namespace: string;
      content: string;
      tags?: string[];
      classification?: ClassificationLevel;
      supersedes?: string;
      expected_updated_at?: string;
      valid_from?: string;
    }
  | {
      action: "memory_update_status";
      namespace: string;
      status_patch: {
        phase?: string;
        current_work?: string;
        blockers?: string;
        next_steps?: string[];
        notes?: string;
        lifecycle?: "active" | "blocked" | "completed" | "stopped" | "maintenance" | "archived";
        valid_until?: string | null;
      };
      expected_updated_at?: string;
      create_if_absent?: boolean;
      classification?: ClassificationLevel;
    };

export interface ReviewSourceRef {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: EntryType;
  updated_at: string;
  content_hash: string;
  excerpt?: string;
  untrusted_content?: boolean;
}

interface ReviewProposalRow {
  id: string;
  creator_principal_id: string;
  operation_type: ReviewOperation["action"];
  target_namespace: string;
  target_key: string | null;
  classification: ClassificationLevel;
  confidence: number;
  reasons: string;
  source_refs: string;
  source_excerpt: string | null;
  source_hash: string | null;
  source_untrusted: number;
  injection_flags: string;
  original_operation: string | null;
  current_operation: string | null;
  status: ReviewProposalStatus;
  applied_entry_id: string | null;
  applied_entry_updated_at: string | null;
  prior_entry_snapshot: string | null;
  undo_of_proposal_id: string | null;
  terminal_code: string | null;
  terminal_detail: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  terminal_at: string | null;
  payload_purged_at: string | null;
}

export interface ReviewProposal
  extends Omit<
    ReviewProposalRow,
    "reasons" | "source_refs" | "original_operation" | "current_operation" | "prior_entry_snapshot"
    | "injection_flags" | "source_untrusted"
  > {
  reasons: string[];
  source_refs: ReviewSourceRef[];
  source_untrusted: boolean;
  injection_flags: string[];
  original_operation: ReviewOperation | null;
  current_operation: ReviewOperation | null;
  prior_entry_snapshot: Record<string, unknown> | null;
}

export interface ReviewProposalEvent {
  id: number;
  proposal_id: string;
  actor_principal_id: string;
  event_type:
    | "created"
    | "edited"
    | "approved"
    | "declined"
    | "expired"
    | "failed"
    | "superseded"
    | "undo_created"
    | "payload_purged"
    | "approval_conflict";
  from_status: ReviewProposalStatus | null;
  to_status: ReviewProposalStatus;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface CreateReviewProposalInput {
  creatorPrincipalId: string;
  operation: ReviewOperation;
  classification: ClassificationLevel;
  confidence: number;
  reasons: string[];
  sourceRefs: ReviewSourceRef[];
  sourceExcerpt: string;
  sourceHash: string;
  injectionFlags?: string[];
  createdAt: string;
  expiresAt: string;
  undoOfProposalId?: string;
}

export type ReviewApplyResult =
  | {
      outcome: "applied";
      entryId: string;
      entryUpdatedAt: string;
      priorEntrySnapshot: Record<string, unknown> | null;
    }
  | {
      outcome: "conflict";
      code: string;
      detail: string;
    }
  | {
      outcome: "failed";
      code: string;
      detail: string;
    };

type ReviewTransitionResult =
  | {
      status: ReviewProposalStatus;
      duplicate?: boolean;
      applied_entry_id?: string | null;
      applied_entry_updated_at?: string | null;
    }
  | {
      status: "pending" | "edited";
      conflict: true;
      code: string;
      detail: string;
    }
  | {
      status: "not_found";
    }
  | {
      status: "invalid_transition";
      current_status: ReviewProposalStatus;
    };

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function parseProposal(row: ReviewProposalRow): ReviewProposal {
  return {
    ...row,
    reasons: parseJson<string[]>(row.reasons),
    source_refs: parseJson<ReviewSourceRef[]>(row.source_refs),
    source_untrusted: row.source_untrusted === 1,
    injection_flags: parseJson<string[]>(row.injection_flags),
    original_operation: row.original_operation
      ? parseJson<ReviewOperation>(row.original_operation)
      : null,
    current_operation: row.current_operation
      ? parseJson<ReviewOperation>(row.current_operation)
      : null,
    prior_entry_snapshot: row.prior_entry_snapshot
      ? parseJson<Record<string, unknown>>(row.prior_entry_snapshot)
      : null,
  };
}

function getOwnedProposalRow(
  db: Database.Database,
  id: string,
  principalId: string,
): ReviewProposalRow | null {
  return (db.prepare(
    "SELECT * FROM review_proposals WHERE id = ? AND creator_principal_id = ?",
  ).get(id, principalId) as ReviewProposalRow | undefined) ?? null;
}

function operationTarget(operation: ReviewOperation): {
  operationType: ReviewOperation["action"];
  namespace: string;
  key: string | null;
} {
  return {
    operationType: operation.action,
    namespace: operation.namespace,
    key: operation.action === "memory_log"
      ? null
      : operation.action === "memory_update_status"
        ? "status"
        : operation.key,
  };
}

function validateCreateInput(input: CreateReviewProposalInput): void {
  if (!input.creatorPrincipalId) {
    throw new Error("Review proposal creator principal is required.");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("Review proposal confidence must be between 0 and 1.");
  }
  if (input.sourceExcerpt.length > REVIEW_SOURCE_EXCERPT_MAX_CHARS) {
    throw new Error(
      `Review proposal source excerpt exceeds ${REVIEW_SOURCE_EXCERPT_MAX_CHARS} characters.`,
    );
  }
  if (input.sourceRefs.length > REVIEW_SOURCE_REF_MAX_COUNT) {
    throw new Error(
      `Review proposal source references exceed the maximum of ${REVIEW_SOURCE_REF_MAX_COUNT}.`,
    );
  }
  if (input.reasons.length > REVIEW_REASON_MAX_COUNT) {
    throw new Error(
      `Review proposal reasons exceed the maximum of ${REVIEW_REASON_MAX_COUNT}.`,
    );
  }
  if (input.expiresAt <= input.createdAt) {
    throw new Error("Review proposal expiry must be later than creation.");
  }
}

function boundedDetail(detail: Record<string, unknown>): string {
  const serialized = JSON.stringify(detail);
  if (serialized.length > 2_000) {
    throw new Error("Review proposal event detail exceeds 2000 characters.");
  }
  return serialized;
}

function insertEvent(
  db: Database.Database,
  proposalId: string,
  actorPrincipalId: string,
  eventType: ReviewProposalEvent["event_type"],
  fromStatus: ReviewProposalStatus | null,
  toStatus: ReviewProposalStatus,
  detail: Record<string, unknown>,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO review_proposal_events
       (proposal_id, actor_principal_id, event_type, from_status, to_status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    proposalId,
    actorPrincipalId,
    eventType,
    fromStatus,
    toStatus,
    boundedDetail(detail),
    createdAt,
  );
}

export function createReviewProposal(
  db: Database.Database,
  input: CreateReviewProposalInput,
): { id: string; status: "pending"; created_at: string; expires_at: string } {
  validateCreateInput(input);
  const id = randomUUID();
  const target = operationTarget(input.operation);
  const operationJson = JSON.stringify(input.operation);
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO review_proposals
         (id, creator_principal_id, operation_type, target_namespace, target_key,
          classification, confidence, reasons, source_refs, source_excerpt,
          source_hash, source_untrusted, injection_flags,
          original_operation, current_operation, status,
          undo_of_proposal_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      id,
      input.creatorPrincipalId,
      target.operationType,
      target.namespace,
      target.key,
      input.classification,
      input.confidence,
      JSON.stringify(input.reasons),
      JSON.stringify(input.sourceRefs),
      input.sourceExcerpt,
      input.sourceHash,
      (input.injectionFlags?.length ?? 0) > 0 ? 1 : 0,
      JSON.stringify(input.injectionFlags ?? []),
      operationJson,
      operationJson,
      input.undoOfProposalId ?? null,
      input.createdAt,
      input.createdAt,
      input.expiresAt,
    );
    insertEvent(
      db,
      id,
      input.creatorPrincipalId,
      "created",
      null,
      "pending",
      { operation_type: target.operationType },
      input.createdAt,
    );
  });
  txn.immediate();
  return {
    id,
    status: "pending",
    created_at: input.createdAt,
    expires_at: input.expiresAt,
  };
}

export function getReviewProposal(
  db: Database.Database,
  id: string,
  principalId: string,
): ReviewProposal | null {
  const row = getOwnedProposalRow(db, id, principalId);
  return row ? parseProposal(row) : null;
}

export function listReviewProposals(
  db: Database.Database,
  principalId: string,
  status?: ReviewProposalStatus,
  limit = 50,
): ReviewProposal[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = status
    ? db.prepare(
        `SELECT * FROM review_proposals
         WHERE creator_principal_id = ? AND status = ?
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
      ).all(principalId, status, boundedLimit)
    : db.prepare(
        `SELECT * FROM review_proposals
         WHERE creator_principal_id = ?
         ORDER BY updated_at DESC, id ASC LIMIT ?`,
      ).all(principalId, boundedLimit);
  return (rows as ReviewProposalRow[]).map(parseProposal);
}

export function getReviewProposalQueueHealthRows(
  db: Database.Database,
  principalId: string,
  staleBefore: string,
): Array<{
  status: ReviewProposalStatus;
  target_namespace: string;
  classification: ClassificationLevel;
  count: number;
  stale_count: number;
}> {
  return db.prepare(
    `SELECT status, target_namespace, classification,
            COUNT(*) AS count,
            SUM(
              CASE
                WHEN status IN ('pending', 'edited') AND expires_at <= ? THEN 1
                ELSE 0
              END
            ) AS stale_count
     FROM review_proposals
     WHERE creator_principal_id = ?
     GROUP BY status, target_namespace, classification`,
  ).all(staleBefore, principalId) as Array<{
    status: ReviewProposalStatus;
    target_namespace: string;
    classification: ClassificationLevel;
    count: number;
    stale_count: number;
  }>;
}

export function listReviewProposalEvents(
  db: Database.Database,
  proposalId: string,
  principalId: string,
): ReviewProposalEvent[] {
  if (!getOwnedProposalRow(db, proposalId, principalId)) return [];
  const rows = db.prepare(
    `SELECT * FROM review_proposal_events
     WHERE proposal_id = ? ORDER BY created_at, id`,
  ).all(proposalId) as Array<Omit<ReviewProposalEvent, "detail"> & { detail: string }>;
  return rows.map((row) => ({ ...row, detail: parseJson<Record<string, unknown>>(row.detail) }));
}

export function editReviewProposal(
  db: Database.Database,
  id: string,
  principalId: string,
  operation: ReviewOperation,
  reason: string,
  now: string,
  metadata?: { classification?: ClassificationLevel; injectionFlags?: string[] },
): ReviewTransitionResult {
  const txn = db.transaction((): ReviewTransitionResult => {
    const row = getOwnedProposalRow(db, id, principalId);
    if (!row) return { status: "not_found" };
    if (row.status !== "pending" && row.status !== "edited") {
      return { status: "invalid_transition", current_status: row.status };
    }
    if (row.expires_at <= now) {
      expireProposal(db, row, now, principalId);
      return { status: "expired" };
    }
    const target = operationTarget(operation);
    const injectionFlags = [...new Set([
      ...parseJson<string[]>(row.injection_flags),
      ...(metadata?.injectionFlags ?? []),
    ])];
    db.prepare(
      `UPDATE review_proposals
       SET operation_type = ?, target_namespace = ?, target_key = ?,
           current_operation = ?, classification = COALESCE(?, classification),
           injection_flags = ?,
           source_untrusted = CASE WHEN source_untrusted = 1 OR ? = 1 THEN 1 ELSE 0 END,
           status = 'edited', updated_at = ?
       WHERE id = ?`,
    ).run(
      target.operationType,
      target.namespace,
      target.key,
      JSON.stringify(operation),
      metadata?.classification ?? null,
      JSON.stringify(injectionFlags),
      injectionFlags.length > 0 ? 1 : 0,
      now,
      id,
    );
    insertEvent(
      db,
      id,
      principalId,
      "edited",
      row.status,
      "edited",
      { reason: reason.slice(0, 500) },
      now,
    );
    return { status: "edited" };
  });
  return txn.immediate();
}

export function createUndoReviewProposal(
  db: Database.Database,
  originalProposalId: string,
  input: CreateReviewProposalInput,
): { id: string; status: "pending"; created_at: string; expires_at: string } | null {
  const txn = db.transaction(() => {
    const original = getOwnedProposalRow(
      db,
      originalProposalId,
      input.creatorPrincipalId,
    );
    if (!original || original.status !== "approved") return null;
    const created = createReviewProposal(db, {
      ...input,
      undoOfProposalId: originalProposalId,
    });
    insertEvent(
      db,
      originalProposalId,
      input.creatorPrincipalId,
      "undo_created",
      "approved",
      "approved",
      { undo_proposal_id: created.id },
      input.createdAt,
    );
    return created;
  });
  return txn.immediate();
}

export function markReviewProposalSuperseded(
  db: Database.Database,
  originalProposalId: string,
  undoProposalId: string,
  principalId: string,
  now: string,
): boolean {
  const original = getOwnedProposalRow(db, originalProposalId, principalId);
  const undo = getOwnedProposalRow(db, undoProposalId, principalId);
  if (
    !original ||
    !undo ||
    original.status !== "approved" ||
    undo.status !== "pending" && undo.status !== "edited" ||
    undo.undo_of_proposal_id !== originalProposalId
  ) {
    return false;
  }
  db.prepare(
    `UPDATE review_proposals
     SET status = 'superseded', updated_at = ?, terminal_at = ?
     WHERE id = ?`,
  ).run(now, now, originalProposalId);
  insertEvent(
    db,
    originalProposalId,
    principalId,
    "superseded",
    "approved",
    "superseded",
    { undo_proposal_id: undoProposalId },
    now,
  );
  return true;
}

export function declineReviewProposal(
  db: Database.Database,
  id: string,
  principalId: string,
  reason: string,
  now: string,
): ReviewTransitionResult {
  const txn = db.transaction((): ReviewTransitionResult => {
    const row = getOwnedProposalRow(db, id, principalId);
    if (!row) return { status: "not_found" };
    if (row.status === "declined") return { status: "declined", duplicate: true };
    if (row.status !== "pending" && row.status !== "edited") {
      return { status: "invalid_transition", current_status: row.status };
    }
    db.prepare(
      `UPDATE review_proposals
       SET status = 'declined', updated_at = ?, terminal_at = ?,
           terminal_code = 'reviewer_declined', terminal_detail = ?
       WHERE id = ?`,
    ).run(now, now, reason.slice(0, 500), id);
    insertEvent(
      db,
      id,
      principalId,
      "declined",
      row.status,
      "declined",
      { reason: reason.slice(0, 500) },
      now,
    );
    return { status: "declined", duplicate: false };
  });
  return txn.immediate();
}

function expireProposal(
  db: Database.Database,
  row: ReviewProposalRow,
  now: string,
  actorPrincipalId: string,
): void {
  db.prepare(
    `UPDATE review_proposals
     SET status = 'expired', updated_at = ?, terminal_at = ?,
         terminal_code = 'review_expired', terminal_detail = 'Proposal expired before review.'
     WHERE id = ?`,
  ).run(now, now, row.id);
  insertEvent(
    db,
    row.id,
    actorPrincipalId,
    "expired",
    row.status,
    "expired",
    {},
    now,
  );
}

export function approveReviewProposal(
  db: Database.Database,
  id: string,
  principalId: string,
  apply: (proposal: ReviewProposal) => ReviewApplyResult,
  now: string,
): ReviewTransitionResult {
  const txn = db.transaction((): ReviewTransitionResult => {
    const row = getOwnedProposalRow(db, id, principalId);
    if (!row) return { status: "not_found" };
    if (row.status === "approved") {
      return {
        status: "approved",
        duplicate: true,
        applied_entry_id: row.applied_entry_id,
        applied_entry_updated_at: row.applied_entry_updated_at,
      };
    }
    if (row.status !== "pending" && row.status !== "edited") {
      return { status: "invalid_transition", current_status: row.status };
    }
    if (row.expires_at <= now) {
      expireProposal(db, row, now, principalId);
      return { status: "expired" };
    }

    const result = apply(parseProposal(row));
    if (result.outcome === "conflict") {
      insertEvent(
        db,
        id,
        principalId,
        "approval_conflict",
        row.status,
        row.status,
        { code: result.code, detail: result.detail.slice(0, 500) },
        now,
      );
      return {
        status: row.status,
        conflict: true,
        code: result.code,
        detail: result.detail,
      };
    }
    if (result.outcome === "failed") {
      db.prepare(
        `UPDATE review_proposals
         SET status = 'failed', updated_at = ?, terminal_at = ?,
             terminal_code = ?, terminal_detail = ?
         WHERE id = ?`,
      ).run(now, now, result.code, result.detail.slice(0, 500), id);
      insertEvent(
        db,
        id,
        principalId,
        "failed",
        row.status,
        "failed",
        { code: result.code, detail: result.detail.slice(0, 500) },
        now,
      );
      return { status: "failed" };
    }

    db.prepare(
      `UPDATE review_proposals
       SET status = 'approved', updated_at = ?, terminal_at = ?,
           applied_entry_id = ?, applied_entry_updated_at = ?,
           prior_entry_snapshot = ?, terminal_code = NULL, terminal_detail = NULL
       WHERE id = ?`,
    ).run(
      now,
      now,
      result.entryId,
      result.entryUpdatedAt,
      result.priorEntrySnapshot ? JSON.stringify(result.priorEntrySnapshot) : null,
      id,
    );
    insertEvent(
      db,
      id,
      principalId,
      "approved",
      row.status,
      "approved",
      { applied_entry_id: result.entryId },
      now,
    );
    return {
      status: "approved",
      duplicate: false,
      applied_entry_id: result.entryId,
      applied_entry_updated_at: result.entryUpdatedAt,
    };
  });
  return txn.immediate();
}

function subtractDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function pruneReviewProposals(
  db: Database.Database,
  now: string,
  retention: {
    terminalPayloadDays?: number;
    approvedUndoDays?: number;
  } = {},
): { expired: number; payloads_purged: number; undo_snapshots_purged: number } {
  const terminalPayloadDays =
    retention.terminalPayloadDays ?? REVIEW_TERMINAL_PAYLOAD_RETENTION_DAYS;
  const approvedUndoDays =
    retention.approvedUndoDays ?? REVIEW_APPROVED_UNDO_RETENTION_DAYS;
  const terminalCutoff = subtractDays(now, terminalPayloadDays);
  const undoCutoff = subtractDays(now, approvedUndoDays);

  const txn = db.transaction(() => {
    const expiring = db.prepare(
      `SELECT * FROM review_proposals
       WHERE status IN ('pending', 'edited') AND expires_at <= ?
       ORDER BY expires_at, id`,
    ).all(now) as ReviewProposalRow[];
    for (const row of expiring) {
      expireProposal(db, row, now, "system:maintenance");
    }

    const purgeable = db.prepare(
      `SELECT * FROM review_proposals
       WHERE status IN ('declined', 'expired', 'failed')
         AND terminal_at <= ? AND payload_purged_at IS NULL
       ORDER BY terminal_at, id`,
    ).all(terminalCutoff) as ReviewProposalRow[];
    for (const row of purgeable) {
      db.prepare(
        `UPDATE review_proposals
         SET reasons = '[]', source_refs = '[]', source_excerpt = NULL,
             source_hash = NULL, source_untrusted = 0, original_operation = NULL,
             current_operation = NULL, prior_entry_snapshot = NULL,
             injection_flags = '[]',
             terminal_detail = NULL, payload_purged_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(now, now, row.id);
      insertEvent(
        db,
        row.id,
        "system:maintenance",
        "payload_purged",
        row.status,
        row.status,
        {},
        now,
      );
    }

    const undoPurge = db.prepare(
      `UPDATE review_proposals
       SET prior_entry_snapshot = NULL, updated_at = ?
       WHERE status IN ('approved', 'superseded')
         AND terminal_at <= ? AND prior_entry_snapshot IS NOT NULL`,
    ).run(now, undoCutoff);

    return {
      expired: expiring.length,
      payloads_purged: purgeable.length,
      undo_snapshots_purged: undoPurge.changes,
    };
  });
  return txn.immediate();
}
