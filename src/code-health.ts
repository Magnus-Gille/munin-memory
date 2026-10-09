import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccessContext } from "./access.js";
import { canRead, canWrite, getContextMaxClassification } from "./access.js";
import { appendLog, getById, supersedeLog } from "./db.js";
import type { Entry, ClassificationLevel } from "./types.js";
import { CLASSIFICATION_LEVELS, classificationAllowed, resolveNamespaceClassificationFloor } from "./librarian.js";
import { scanForSecrets, validateWriteNamespace } from "./security.js";
import { nowUTC } from "./db.js";
import { validateRecord, validateRecords } from "../scripts/lib/code-health-agent.mjs";

const MAX_RECORD_BYTES = 16 * 1024;
const MAX_CONTEXT_RECORDS = 500;
const EXPORT_SNAPSHOT_BATCH = 500;
const MAX_OBSERVATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EXPORT_TTL_MS = 15 * 60 * 1000;
const CURSOR_KEY = randomBytes(32);
const RECORD_TAG = "code-health:evidence-v1";
const SAFE_AUDIT_DETAIL = "code-health evidence record";

class CodeHealthAccessDenied extends Error {
  constructor() {
    super("Access denied.");
    this.name = "CodeHealthAccessDenied";
  }
}

interface CodeHealthRecord {
  record_id: string;
  record_kind: "observation" | "assessment";
  repo_owner: string;
  repo_name: string;
  task_id: string;
  attempt_id: string;
  observed_at: string;
  rubric_version: string;
  supersedes_record_id: string | null;
  correction_ref: string | null;
  [key: string]: unknown;
}

interface LedgerRow {
  principal_id: string;
  record_id: string;
  namespace: string | null;
  entry_id: string | null;
  payload_hash: string;
  record_kind: string;
  repo_owner: string;
  repo_name: string;
  task_id: string;
  attempt_id: string;
  observed_at: string;
  collected_at: string;
  expires_at: string;
  model: string | null;
  rubric_version: string;
  classification: string;
  supersedes_record_id: string | null;
  correction_ref: string | null;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addCalendarMonths(instant: string, count: number): string {
  const date = new Date(instant);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

function validationTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\dZ$/.test(value)) {
    throw new Error(`${field} must be a whole-second UTC timestamp.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/\.000Z$/, "Z") !== value) {
    throw new Error(`${field} must be a real UTC timestamp.`);
  }
  return value;
}

function payloadOf(entry: Entry): CodeHealthRecord {
  const parsed: unknown = JSON.parse(entry.content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored code-health payload is malformed.");
  }
  return parsed as CodeHealthRecord;
}

function referenceIds(record: CodeHealthRecord): string[] {
  const candidates: unknown[] = [record.source_observation_ref, record.supersedes_record_id];
  if (Array.isArray(record.observation_refs)) candidates.push(...record.observation_refs);
  return [...new Set(candidates.filter((value): value is string => typeof value === "string"))];
}

function assertPrincipalCanReadEntry(
  db: Database.Database,
  ctx: AccessContext,
  entry: Entry,
  principalId: string,
): void {
  if (!canRead(ctx, entry.namespace)) throw new CodeHealthAccessDenied();
  if ((entry.owner_principal_id ?? entry.agent_id) !== principalId) {
    throw new Error("Code-health record principal does not match its authenticated ledger.");
  }
  const ledger = db.prepare(`SELECT namespace, expires_at FROM code_health_records
    WHERE principal_id = ? AND entry_id = ?`).get(principalId, entry.id) as
    { namespace: string; expires_at: string } | undefined;
  if (!ledger || ledger.namespace !== entry.namespace || ledger.expires_at <= nowUTC()) {
    throw new Error("Code-health record is no longer in the retained set.");
  }
  if (!classificationAllowed(entry.classification, getContextMaxClassification(ctx))) {
    throw new CodeHealthAccessDenied();
  }
}

/** Load only authenticated stored reference records; no caller-supplied placeholders. */
function loadContextRecords(
  db: Database.Database,
  ctx: AccessContext,
  namespace: string,
  roots: readonly CodeHealthRecord[],
  principalId: string,
): CodeHealthRecord[] {
  const queue = roots.flatMap(referenceIds);
  const seen = new Set<string>();
  const result: CodeHealthRecord[] = [];
  const visibleLevels = CLASSIFICATION_LEVELS.slice(
    0,
    CLASSIFICATION_LEVELS.indexOf(getContextMaxClassification(ctx)) + 1,
  );
  const find = db.prepare(`
    SELECT * FROM code_health_records
     WHERE principal_id = ? AND record_id = ? AND namespace = ?
       AND entry_id IS NOT NULL AND expires_at > ?
       AND classification IN (${visibleLevels.map(() => "?").join(", ")})
  `);
  const findAny = db.prepare(`
    SELECT namespace, entry_id, expires_at, classification
      FROM code_health_records WHERE principal_id = ? AND record_id = ?
  `);
  while (queue.length > 0) {
    const recordId = queue.shift()!;
    if (seen.has(recordId)) continue;
    const ledger = find.get(principalId, recordId, namespace, nowUTC(), ...visibleLevels) as LedgerRow | undefined;
    if (!ledger) {
      const hidden = findAny.get(principalId, recordId) as {
        namespace: string | null; entry_id: string | null; expires_at: string; classification: string;
      } | undefined;
      if (hidden?.namespace === namespace && hidden.entry_id && hidden.expires_at > nowUTC()
        && !classificationAllowed(hidden.classification as ClassificationLevel, getContextMaxClassification(ctx))) {
        throw new CodeHealthAccessDenied();
      }
      throw new Error(`Code-health reference ${recordId} is not available in this principal and namespace.`);
    }
    seen.add(recordId);
    if (seen.size > MAX_CONTEXT_RECORDS) throw new Error("Code-health reference context exceeds the bounded 500-record limit.");
    const entry = getById(db, ledger.entry_id!);
    if (!entry || entry.entry_type !== "log") throw new Error(`Code-health reference ${recordId} is unavailable.`);
    assertPrincipalCanReadEntry(db, ctx, entry, principalId);
    const payload = payloadOf(entry);
    result.push(payload);
    queue.push(...referenceIds(payload));
  }
  return result;
}

function loadStoredTaskContext(
  db: Database.Database,
  ctx: AccessContext,
  namespace: string,
  principalId: string,
  record: CodeHealthRecord,
): CodeHealthRecord[] {
  const rows = db.prepare(`
    SELECT r.*, e.* FROM code_health_records r
      JOIN entries e ON e.id = r.entry_id
     WHERE r.principal_id = ? AND r.namespace = ?
       AND r.repo_owner = ? AND r.repo_name = ? AND r.task_id = ?
       AND r.classification IN (${CLASSIFICATION_LEVELS.slice(0, CLASSIFICATION_LEVELS.indexOf(getContextMaxClassification(ctx)) + 1).map(() => "?").join(", ")})
       AND r.expires_at > ?
     ORDER BY r.observed_at, r.record_id
     LIMIT ?
  `).all(principalId, namespace, record.repo_owner, record.repo_name, record.task_id,
    ...CLASSIFICATION_LEVELS.slice(0, CLASSIFICATION_LEVELS.indexOf(getContextMaxClassification(ctx)) + 1),
    nowUTC(), MAX_CONTEXT_RECORDS + 1) as Array<LedgerRow & Entry>;
  if (rows.length > MAX_CONTEXT_RECORDS) throw new Error("Task validation context exceeds the bounded 500-record limit.");
  return rows.map((row) => {
    assertPrincipalCanReadEntry(db, ctx, row, principalId);
    return payloadOf(row);
  });
}

function modelValue(record: CodeHealthRecord): string | null {
  const worker = record.actual_worker as Record<string, unknown> | undefined;
  const value = worker?.observed_model;
  return typeof value === "string" ? value : null;
}

function recordByPrincipalAndId(db: Database.Database, principalId: string, recordId: string): LedgerRow | undefined {
  return db.prepare("SELECT * FROM code_health_records WHERE principal_id = ? AND record_id = ?")
    .get(principalId, recordId) as LedgerRow | undefined;
}

export interface CodeHealthAppendInput {
  namespace: string;
  idempotency_key: string;
  record: unknown;
  expected_updated_at?: string;
  classification?: "public" | "internal" | "client-confidential" | "client-restricted";
}

export interface CodeHealthExportInput {
  namespace: string;
  producer_principal_id?: string;
  repo_owner?: string;
  repo_name?: string;
  task_id?: string;
  since?: string;
  until?: string;
  model?: string;
  rubric_version?: string;
  limit?: number;
  cursor?: string;
}

export type CodeHealthResult =
  | { ok: true; action: string; [key: string]: unknown }
  | { ok: false; action: string; error: string; message: string; [key: string]: unknown };

function fail(error: string, message: string): CodeHealthResult {
  return { ok: false, action: "code_health", error, message };
}

function authFingerprint(ctx: AccessContext, namespace: string, producer: string): string {
  return sha256(canonical({
    caller: ctx.principalId,
    principal_type: ctx.principalType,
    namespace,
    producer,
    max_classification: getContextMaxClassification(ctx),
    transport: ctx.transportType ?? null,
    rules: [...ctx.accessibleNamespaces].sort((a, b) => `${a.pattern}:${a.permissions}`.localeCompare(`${b.pattern}:${b.permissions}`)),
  }));
}

function filterShape(input: CodeHealthExportInput): Record<string, unknown> {
  return {
    repo_owner: input.repo_owner ?? null,
    repo_name: input.repo_name ?? null,
    task_id: input.task_id ?? null,
    since: input.since ?? null,
    until: input.until ?? null,
    model: input.model ?? null,
    rubric_version: input.rubric_version ?? null,
  };
}

function signCursor(snapshotId: string, position: number): string {
  const payload = Buffer.from(JSON.stringify({ s: snapshotId, p: position })).toString("base64url");
  const signature = createHmac("sha256", CURSOR_KEY).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readCursor(value: string): { snapshotId: string; position: number } {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error("cursor is invalid or expired; start a new export.");
  const expected = createHmac("sha256", CURSOR_KEY).update(parts[0]).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(parts[1], "base64url"); } catch { throw new Error("cursor is invalid or expired; start a new export."); }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("cursor is invalid or expired; start a new export.");
  }
  let parsed: { s?: unknown; p?: unknown };
  try { parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { s?: unknown; p?: unknown }; }
  catch { throw new Error("cursor is invalid or expired; start a new export."); }
  if (typeof parsed.s !== "string" || !Number.isSafeInteger(parsed.p) || (parsed.p as number) < 0) {
    throw new Error("cursor is invalid or expired; start a new export.");
  }
  return { snapshotId: parsed.s, position: parsed.p as number };
}

export function appendCodeHealthRecord(
  db: Database.Database,
  ctx: AccessContext,
  input: CodeHealthAppendInput,
): CodeHealthResult & { id?: string } {
  try {
    if (!validateWriteNamespace(input.namespace).valid) return fail("validation_error", "namespace is invalid.");
    if (!canWrite(ctx, input.namespace)) return fail("access_denied", "Access denied.");
    if (typeof input.idempotency_key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotency_key)) {
      return fail("validation_error", "idempotency_key must be a UUID.");
    }
    const serialized = canonical(input.record);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) return fail("validation_error", "record exceeds the 16 KiB code-health evidence limit.");
    const security = scanForSecrets(serialized);
    if (!security.valid) return fail("validation_error", security.error ?? "record failed content validation.");
    validateRecord(input.record);
    const record = input.record as CodeHealthRecord;
    const observedAt = validationTime(record.observed_at, "record.observed_at");
    if (record.rubric_version !== "changeability-1.0") return fail("validation_error", "rubric_version is not supported.");
    if (input.classification && !classificationAllowed(input.classification, getContextMaxClassification(ctx))) {
      return fail("access_denied", "Requested classification exceeds the caller's classification access.");
    }
    if (!classificationAllowed(resolveNamespaceClassificationFloor(db, input.namespace), getContextMaxClassification(ctx))) {
      return fail("access_denied", "Namespace classification exceeds the caller's access.");
    }

    const payloadHash = sha256(serialized);
    const prior = recordByPrincipalAndId(db, ctx.principalId, record.record_id);
    if (prior) {
      if (!canRead(ctx, input.namespace)) {
        return fail("access_denied", "Access denied.");
      }
      if (!prior.entry_id || !prior.namespace || prior.expires_at <= nowUTC()) {
        return fail("record_deleted", "This code-health record was deleted or expired and cannot be recreated.");
      }
      if (prior.namespace !== input.namespace || !canRead(ctx, prior.namespace)) {
        return fail("not_found", "Code-health record is unavailable in this principal and namespace.");
      }
      if (!classificationAllowed(prior.classification as ClassificationLevel, getContextMaxClassification(ctx))) {
        return fail("access_denied", "Code-health record exceeds the caller's classification access.");
      }
      if (prior.payload_hash !== payloadHash) return fail("idempotency_conflict", "record_id was already used with different content.");
      const existing = getById(db, prior.entry_id);
      if (!existing) return fail("record_deleted", "This code-health record was deleted or expired and cannot be recreated.");
      assertPrincipalCanReadEntry(db, ctx, existing, ctx.principalId);
      return {
        ok: true, action: "code_health", status: "replayed", id: existing.id,
        record_id: record.record_id, namespace: input.namespace, collected_at: prior.collected_at,
        expires_at: prior.expires_at, updated_at: existing.updated_at, classification: prior.classification,
      };
    }

    // The freshness window applies to new admissions. An acknowledged exact
    // replay above remains recoverable until the record's retention boundary.
    const ageMs = Date.parse(nowUTC()) - Date.parse(observedAt);
    if (ageMs < 0) return fail("validation_error", "record.observed_at cannot be in the future.");
    if (ageMs > MAX_OBSERVATION_AGE_MS) return fail("validation_error", "record.observed_at is older than the 30-day admission window.");

    const targetId = record.supersedes_record_id;
    let predecessor: Entry | null = null;
    if (targetId) {
      const target = recordByPrincipalAndId(db, ctx.principalId, targetId);
      if (!target || target.namespace !== input.namespace || !target.entry_id) {
        return fail("not_found", "Correction target is unavailable in this principal and namespace.");
      }
      if (!classificationAllowed(target.classification as ClassificationLevel, getContextMaxClassification(ctx))) {
        return fail("access_denied", "Access denied.");
      }
      predecessor = getById(db, target.entry_id);
      if (!predecessor || predecessor.is_current !== 1) return fail("conflict", "Correction target is no longer current.");
      if (input.expected_updated_at !== predecessor.updated_at) return fail("conflict", "expected_updated_at must match the current correction target.");
      if (input.classification && !classificationAllowed(predecessor.classification, input.classification)) {
        return fail("validation_error", "A correction cannot lower the classification of its target.");
      }
    } else if (input.expected_updated_at !== undefined) {
      return fail("validation_error", "expected_updated_at is only valid for a correction.");
    }

    const contextRecords = loadStoredTaskContext(db, ctx, input.namespace, ctx.principalId, record);
    validateRecords([record], { contextRecords });

    const classification = input.classification ?? (predecessor?.classification as CodeHealthAppendInput["classification"] | undefined);
    const chosenClassification = classification ?? resolveNamespaceClassificationFloor(db, input.namespace);
    for (const contextRecord of contextRecords) {
      const contextLedger = recordByPrincipalAndId(db, ctx.principalId, contextRecord.record_id);
      if (contextLedger && !classificationAllowed(contextLedger.classification as ClassificationLevel, chosenClassification)) {
        return fail("validation_error", "A new record cannot lower classification relative to its stored reference context.");
      }
    }
    const result = targetId
      ? supersedeLog(db, input.namespace, predecessor!.id, JSON.stringify(input.record), [RECORD_TAG], ctx.principalId,
          input.expected_updated_at!, nowUTC(), { classification }, { auditDetail: SAFE_AUDIT_DETAIL, skipEmbeddings: true })
      : appendLog(db, input.namespace, JSON.stringify(input.record), [RECORD_TAG], ctx.principalId,
          { classification }, { auditDetail: SAFE_AUDIT_DETAIL, skipEmbeddings: true });
    if ("status" in result && result.status !== "superseded") return fail(result.status, result.message);
    const entryId = result.id;
    const entry = getById(db, entryId);
    if (!entry) throw new Error("Code-health append completed without a persisted log entry.");
    const collectedAt = nowUTC();
    const expiresAt = addCalendarMonths(collectedAt, 6);
    const workerModel = modelValue(record);
    db.prepare(`
      INSERT INTO code_health_records (
        principal_id, record_id, namespace, entry_id, payload_hash, record_kind,
        repo_owner, repo_name, task_id, attempt_id, observed_at, collected_at,
        expires_at, model, rubric_version, classification, supersedes_record_id,
        correction_ref, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ctx.principalId, record.record_id, input.namespace, entryId, payloadHash,
      record.record_kind, record.repo_owner, record.repo_name, record.task_id,
      record.attempt_id, observedAt, collectedAt, expiresAt, workerModel,
      record.rubric_version, entry.classification, record.supersedes_record_id,
      record.correction_ref, input.idempotency_key.toLowerCase());
    const insertRef = db.prepare(`
      INSERT INTO code_health_record_refs (principal_id, namespace, record_id, referenced_record_id)
      VALUES (?, ?, ?, ?)
    `);
    for (const referencedId of referenceIds(record)) {
      insertRef.run(ctx.principalId, input.namespace, record.record_id, referencedId);
    }
    return {
      ok: true, action: "code_health", status: targetId ? "corrected" : "stored", id: entryId,
      record_id: record.record_id, namespace: input.namespace, collected_at: collectedAt,
      expires_at: expiresAt, updated_at: entry.updated_at, classification: entry.classification,
      ...(targetId ? { supersedes_record_id: targetId, correction_ref: record.correction_ref } : {}),
    };
  } catch (error) {
    if (error instanceof CodeHealthAccessDenied) return fail("access_denied", error.message);
    return fail("validation_error", error instanceof Error ? error.message : "Code-health record failed validation.");
  }
}

function validateExportInput(input: CodeHealthExportInput): { filters: Record<string, unknown>; limit: number } {
  if (!validateWriteNamespace(input.namespace).valid) throw new Error("namespace is invalid.");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100.");
  for (const [name, value, pattern, max] of [
    ["repo_owner", input.repo_owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 39],
    ["repo_name", input.repo_name, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,97}[A-Za-z0-9])?$/, 99],
    ["task_id", input.task_id, /^[a-z0-9][a-z0-9._-]{0,95}$/, 96],
    ["model", input.model, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, 64],
    ["rubric_version", input.rubric_version, /^changeability-1\.0$/, 32],
  ] as const) {
    if (value !== undefined && (value.length > max || !pattern.test(value))) throw new Error(`${name} is invalid or exceeds its bounded exact-match format.`);
  }
  const filters = filterShape(input);
  if (input.since !== undefined) validationTime(input.since, "since");
  if (input.until !== undefined) validationTime(input.until, "until");
  if (input.since && input.until && input.since > input.until) throw new Error("since must not be later than until.");
  return { filters, limit };
}

function loadExportContext(
  db: Database.Database,
  ctx: AccessContext,
  namespace: string,
  producer: string,
  records: CodeHealthRecord[],
): CodeHealthRecord[] {
  return loadContextRecords(db, ctx, namespace, records, producer);
}

interface CodeHealthRetentionMetadata {
  record_id: string;
  collected_at: string;
  expires_at: string;
  updated_at: string;
  classification: ClassificationLevel;
}

function loadRetentionMetadata(
  db: Database.Database,
  principalId: string,
  namespace: string,
  records: readonly CodeHealthRecord[],
): CodeHealthRetentionMetadata[] {
  const recordIds = [...new Set(records.map((record) => record.record_id))];
  if (recordIds.length === 0) return [];
  const rows = db.prepare(`
    SELECT r.record_id, r.collected_at, r.expires_at, e.updated_at, r.classification
      FROM code_health_records r
      JOIN entries e ON e.id = r.entry_id AND e.namespace = r.namespace
     WHERE r.principal_id = ? AND r.namespace = ?
       AND r.entry_id IS NOT NULL AND r.expires_at > ?
       AND r.record_id IN (${recordIds.map(() => "?").join(", ")})
  `).all(principalId, namespace, nowUTC(), ...recordIds) as CodeHealthRetentionMetadata[];
  const byRecordId = new Map(rows.map((row) => [row.record_id, row]));
  if (byRecordId.size !== recordIds.length) {
    throw new Error("Code-health retention metadata is no longer available in this principal and namespace.");
  }
  return recordIds.map((recordId) => byRecordId.get(recordId)!);
}

export function exportCodeHealthRecords(
  db: Database.Database,
  ctx: AccessContext,
  input: CodeHealthExportInput,
): CodeHealthResult {
  try {
    const { filters, limit } = validateExportInput(input);
    if (!canRead(ctx, input.namespace)) return fail("access_denied", "Access denied.");
    const producer = input.producer_principal_id ?? ctx.principalId;
    if (producer !== ctx.principalId && ctx.principalType !== "owner") return fail("access_denied", "Only the owner may choose another producer principal.");
    if (input.producer_principal_id !== undefined && (input.producer_principal_id.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(input.producer_principal_id))) {
      return fail("validation_error", "producer_principal_id is invalid.");
    }
    const namespaceFloor = resolveNamespaceClassificationFloor(db, input.namespace);
    if (!classificationAllowed(namespaceFloor, getContextMaxClassification(ctx))) return fail("access_denied", "Namespace classification exceeds the caller's access.");
    const filterHash = sha256(canonical({ namespace: input.namespace, producer, filters }));
    const authHash = authFingerprint(ctx, input.namespace, producer);
    let snapshotId: string;
    let position: number;
    let snapshot: { generated_at: string; expires_at: string; total_records: number; invalidated: number };

    if (input.cursor) {
      const cursor = readCursor(input.cursor);
      snapshotId = cursor.snapshotId;
      position = cursor.position;
      const row = db.prepare("SELECT * FROM code_health_export_snapshots WHERE id = ?")
        .get(snapshotId) as typeof snapshot | undefined;
      const extended = row as (typeof snapshot & { caller_principal_id: string; producer_principal_id: string; namespace: string; filter_hash: string; auth_hash: string }) | undefined;
      if (!extended || extended.caller_principal_id !== ctx.principalId || extended.producer_principal_id !== producer
        || extended.namespace !== input.namespace || extended.filter_hash !== filterHash || extended.auth_hash !== authHash
        || extended.expires_at <= nowUTC() || extended.invalidated !== 0) {
        return fail("incomplete_export", "Export snapshot is expired, invalidated, or no longer matches this principal, access, namespace, and filter. Start a new export; do not reconcile consumer data from this cursor.");
      }
      snapshot = extended;
    } else {
      if (input.producer_principal_id !== undefined && input.producer_principal_id !== ctx.principalId && ctx.principalType !== "owner") {
        return fail("access_denied", "Only the owner may choose another producer principal.");
      }
      snapshotId = randomUUID();
      position = 0;
      const generatedAt = nowUTC();
      const expiresAt = new Date(Date.parse(generatedAt) + EXPORT_TTL_MS).toISOString();
      db.transaction(() => {
        db.prepare(`INSERT INTO code_health_export_snapshots
          (id, caller_principal_id, producer_principal_id, namespace, filter_hash, auth_hash, generated_at, expires_at, total_records, invalidated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`)
          .run(snapshotId, ctx.principalId, producer, input.namespace, filterHash, authHash, generatedAt, expiresAt);
        const visibleLevels = CLASSIFICATION_LEVELS.slice(0, CLASSIFICATION_LEVELS.indexOf(getContextMaxClassification(ctx)) + 1);
        const stmt = db.prepare(`
          SELECT r.principal_id, r.record_id, r.entry_id, r.classification, r.observed_at
            FROM code_health_records r JOIN entries e ON e.id = r.entry_id
           WHERE r.principal_id = ? AND r.namespace = ? AND e.namespace = ?
             AND e.entry_type = 'log' AND e.is_current = 1
             AND r.expires_at > ?
             AND (? IS NULL OR r.repo_owner = ?)
             AND (? IS NULL OR r.repo_name = ?)
             AND (? IS NULL OR r.task_id = ?)
             AND (? IS NULL OR r.observed_at >= ?)
             AND (? IS NULL OR r.observed_at <= ?)
             AND (? IS NULL OR r.model = ?)
             AND (? IS NULL OR r.rubric_version = ?)
             AND r.classification IN (${visibleLevels.map(() => "?").join(", ")})
             AND (? IS NULL OR r.observed_at > ? OR (r.observed_at = ? AND r.record_id > ?))
           ORDER BY r.observed_at ASC, r.record_id ASC
           LIMIT ?
        `);
        const args = [producer, input.namespace, input.namespace, generatedAt,
          filters.repo_owner, filters.repo_owner, filters.repo_name, filters.repo_name,
          filters.task_id, filters.task_id, filters.since, filters.since,
          filters.until, filters.until, filters.model, filters.model,
          filters.rubric_version, filters.rubric_version, ...visibleLevels];
        const insert = db.prepare(`INSERT INTO code_health_export_items
          (snapshot_id, position, principal_id, record_id, entry_id) VALUES (?, ?, ?, ?, ?)`);
        let count = 0;
        let afterObservedAt: string | null = null;
        let afterRecordId: string | null = null;
        while (true) {
          const rows = stmt.all(...args, afterObservedAt, afterObservedAt, afterObservedAt, afterRecordId, EXPORT_SNAPSHOT_BATCH) as
            Array<{ principal_id: string; record_id: string; entry_id: string; classification: string; observed_at: string }>;
          for (const row of rows) {
            insert.run(snapshotId, count, row.principal_id, row.record_id, row.entry_id);
            count += 1;
            afterObservedAt = row.observed_at;
            afterRecordId = row.record_id;
          }
          if (rows.length < EXPORT_SNAPSHOT_BATCH) break;
        }
        db.prepare("UPDATE code_health_export_snapshots SET total_records = ? WHERE id = ?").run(count, snapshotId);
      }).immediate();
      snapshot = db.prepare("SELECT generated_at, expires_at, total_records, invalidated FROM code_health_export_snapshots WHERE id = ?")
        .get(snapshotId) as typeof snapshot;
    }

    const pageRows = db.prepare(`
      SELECT i.record_id, i.entry_id, e.*
        FROM code_health_export_items i
        JOIN entries e ON e.id = i.entry_id
       WHERE i.snapshot_id = ? AND i.position >= ?
       ORDER BY i.position ASC LIMIT ?
    `).all(snapshotId, position, limit) as Array<{ record_id: string; entry_id: string } & Entry>;
    for (const row of pageRows) assertPrincipalCanReadEntry(db, ctx, row, producer);
    const records = pageRows.map(payloadOf);
    const contextRecords = loadExportContext(db, ctx, input.namespace, producer, records);
    validateRecords(records, { contextRecords });
    const nextPosition = position + pageRows.length;
    const complete = snapshot.invalidated === 0 && nextPosition >= snapshot.total_records;
    const nextCursor = complete ? null : signCursor(snapshotId, nextPosition);
    return {
      ok: true,
      action: "code_health",
      export_scope: { namespace: input.namespace, producer_principal_id: producer, filter_hash: filterHash },
      generated_at: snapshot.generated_at,
      watermark: snapshot.generated_at,
      expires_at: snapshot.expires_at,
      returned: records.length,
      total_records: snapshot.total_records,
      records,
      context_records: contextRecords,
      retention: loadRetentionMetadata(db, producer, input.namespace, [...records, ...contextRecords]),
      complete,
      next_cursor: nextCursor,
      reconciliation: complete ? "complete-authorized-retained-set" : "incomplete-do-not-remove-consumer-records",
    };
  } catch (error) {
    if (error instanceof CodeHealthAccessDenied) return fail("access_denied", error.message);
    return fail("validation_error", error instanceof Error ? error.message : "Code-health export failed.");
  }
}
