#!/usr/bin/env node

/**
 * munin-admin — CLI for managing principals in the munin-memory MCP server.
 *
 * Usage:
 *   munin-admin principals list
 *   munin-admin principals show <principal-id>
 *   munin-admin principals add <principal-id> --type <type> --rules <json|@file>
 *   munin-admin principals revoke <principal-id>
 *   munin-admin principals update <principal-id> [--rules ...] [--oauth-client-id ...] [--expires-at ...]
 *   munin-admin principals rotate-token <principal-id>
 *   munin-admin principals test <principal-id> <namespace>
 *   munin-admin classification list-floors
 *   munin-admin classification set-floor <namespace-pattern> <classification>
 *   munin-admin classification audit [namespace-prefix]
 *
 * Global flags:
 *   --db <path>     Database path (default: ~/.munin-memory/memory.db)
 *   --json          Machine-readable JSON output
 *   --init          Allow creating a new DB if it doesn't exist
 *   --help          Show usage
 */

import Database from "better-sqlite3";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  initDatabase,
  listEntriesBelowNamespaceFloor,
  listNamespaceClassificationFloors,
  nowUTC,
  resolveDbPath,
  setNamespaceClassificationFloor,
} from "./db.js";
import {
  validateNamespaceRules,
  canRead,
  canWrite,
  resolveAccessContext,
  namespaceMatchesPattern,
  type NamespaceRule,
  type PrincipalType,
} from "./access.js";
import {
  CLASSIFICATION_LEVELS,
  isClassificationLevel,
  validateClassificationPattern,
} from "./librarian.js";
import type { ClassificationLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrincipalSummary {
  principalId: string;
  principalType: PrincipalType;
  email: string | null;
  rulesCount: number;
  status: "active" | "revoked" | "expired";
  createdAt: string;
}

export interface OAuthClientMapping {
  oauthClientId: string;
  mappedAt: string;
  mappedBy: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface PrincipalDetail {
  id: string;
  principalId: string;
  principalType: PrincipalType;
  email: string | null;
  oauthClientId: string | null; // legacy column (pre-v6 compat)
  hasToken: boolean;
  namespaceRules: NamespaceRule[];
  oauthClients: OAuthClientMapping[];
  status: "active" | "revoked" | "expired";
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface AddPrincipalOpts {
  principalId: string;
  principalType: PrincipalType;
  rules: NamespaceRule[];
  email?: string;
  expiresAt?: string;
  force?: boolean;
}

export interface AddPrincipalResult {
  id: string;
  principalId: string;
  principalType: PrincipalType;
  token?: string;
}

export interface UpdatePrincipalOpts {
  rules?: NamespaceRule[];
  email?: string | null; // null clears it
  expiresAt?: string | null; // null clears it
}

export interface TestAccessResult {
  principalId: string;
  namespace: string;
  canRead: boolean;
  canWrite: boolean;
  matchingRules: NamespaceRule[];
  status: "active" | "revoked" | "expired";
}

export interface RotateTokenResult {
  principalId: string;
  token: string;
}

export type BearerScope = "owner" | "dpa" | "consumer";

export interface BearerTokenSummary {
  id: string;
  scope: BearerScope;
  status: "active" | "retiring" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface RotateBearerResult {
  id: string;
  token: string;
  scope: BearerScope;
  retiringKeyId: string | null;
  retiringExpiresAt: string | null;
}

export interface ClassificationFloorSummary {
  namespacePattern: string;
  minClassification: ClassificationLevel;
  createdAt: string;
  updatedAt: string;
}

export interface ClassificationAuditItem {
  id: string;
  namespace: string;
  key: string | null;
  entryType: "state" | "log";
  classification: ClassificationLevel;
  namespaceFloor: ClassificationLevel;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface PrincipalDbRow {
  id: string;
  principal_id: string;
  principal_type: string;
  email: string | null;
  email_lower: string | null;
  oauth_client_id: string | null;
  token_hash: string | null;
  namespace_rules: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
}

interface OAuthClientMappingRow {
  oauth_client_id: string;
  mapped_at: string;
  mapped_by: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveStatus(
  row: { revoked_at: string | null; expires_at: string | null },
): "active" | "revoked" | "expired" {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at < nowUTC()) return "expired";
  return "active";
}

function auditLog(
  db: Database.Database,
  action: string,
  principalId: string,
  detail: string | null,
): void {
  db.prepare(
    "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail, entry_id) VALUES (?, ?, ?, ?, ?, ?, NULL)",
  ).run(nowUTC(), "munin-admin", action, "admin/principals", principalId, detail);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseRules(value: string): NamespaceRule[] {
  let json: string;
  if (value.startsWith("@")) {
    const filePath = value.slice(1);
    if (!existsSync(filePath)) {
      throw new Error(`Rules file not found: ${filePath}`);
    }
    json = readFileSync(filePath, "utf-8");
  } else {
    json = value;
  }
  const rules = JSON.parse(json) as NamespaceRule[];
  validateNamespaceRules(rules);
  return rules;
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function parseExpiresAt(value: string): string {
  if (!ISO_8601_RE.test(value)) {
    throw new Error(
      `Invalid --expires-at format: "${value}". Must be ISO 8601 (e.g. 2026-12-31T23:59:59Z).`,
    );
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: "${value}".`);
  }
  return date.toISOString();
}

export function parseClassification(value: string): ClassificationLevel {
  if (!isClassificationLevel(value)) {
    throw new Error(
      `Invalid classification "${value}". Must be one of: ${CLASSIFICATION_LEVELS.join(", ")}.`,
    );
  }
  return value;
}

const VALID_TYPES = new Set<string>(["owner", "family", "agent", "external"]);

// ---------------------------------------------------------------------------
// Core functions (exported, testable)
// ---------------------------------------------------------------------------

export function listPrincipals(db: Database.Database): PrincipalSummary[] {
  const rows = db
    .prepare(
      `SELECT principal_id, principal_type, email, namespace_rules, created_at, revoked_at, expires_at
       FROM principals ORDER BY created_at DESC`,
    )
    .all() as PrincipalDbRow[];

  return rows.map((row) => ({
    principalId: row.principal_id,
    principalType: row.principal_type as PrincipalType,
    email: row.email ?? null,
    rulesCount: (JSON.parse(row.namespace_rules) as NamespaceRule[]).length,
    status: deriveStatus(row),
    createdAt: row.created_at,
  }));
}

export function showPrincipal(
  db: Database.Database,
  principalId: string,
): PrincipalDetail | null {
  const row = db
    .prepare(
      `SELECT id, principal_id, principal_type, email, oauth_client_id, token_hash, namespace_rules, created_at, revoked_at, expires_at
       FROM principals WHERE principal_id = ?`,
    )
    .get(principalId) as PrincipalDbRow | undefined;

  if (!row) return null;

  // Fetch OAuth client mappings (v6+)
  let oauthClients: OAuthClientMapping[] = [];
  try {
    const mappings = db
      .prepare(
        `SELECT oauth_client_id, mapped_at, mapped_by, revoked_at, last_used_at
         FROM principal_oauth_clients WHERE principal_id = ? ORDER BY mapped_at DESC`,
      )
      .all(principalId) as OAuthClientMappingRow[];

    oauthClients = mappings.map((m) => ({
      oauthClientId: m.oauth_client_id,
      mappedAt: m.mapped_at,
      mappedBy: m.mapped_by,
      revokedAt: m.revoked_at,
      lastUsedAt: m.last_used_at,
    }));
  } catch {
    // Table may not exist on pre-v6 databases
  }

  return {
    id: row.id,
    principalId: row.principal_id,
    principalType: row.principal_type as PrincipalType,
    email: row.email ?? null,
    oauthClientId: row.oauth_client_id,
    hasToken: row.token_hash !== null,
    namespaceRules: JSON.parse(row.namespace_rules) as NamespaceRule[],
    oauthClients,
    status: deriveStatus(row),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

export function addPrincipal(
  db: Database.Database,
  opts: AddPrincipalOpts,
): AddPrincipalResult {
  if (!VALID_TYPES.has(opts.principalType)) {
    throw new Error(
      `Invalid principal type: "${opts.principalType}". Must be one of: owner, family, agent, external.`,
    );
  }

  if (opts.principalType === "owner" && !opts.force) {
    throw new Error(
      "Creating an owner principal requires --force. Owner principals have unrestricted access to all namespaces.",
    );
  }

  validateNamespaceRules(opts.rules);

  if (opts.expiresAt) {
    opts.expiresAt = parseExpiresAt(opts.expiresAt);
  }

  const id = randomUUID();
  let token: string | undefined;
  let tokenHash: string | null = null;

  if (opts.principalType === "agent") {
    token = randomBytes(32).toString("hex");
    tokenHash = hashToken(token);
  }

  const emailLower = opts.email ? opts.email.trim().toLowerCase() : null;

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO principals (id, principal_id, principal_type, token_hash, email, email_lower, namespace_rules, created_at, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      opts.principalId,
      opts.principalType,
      tokenHash,
      opts.email ?? null,
      emailLower,
      JSON.stringify(opts.rules),
      nowUTC(),
      opts.expiresAt ?? null,
    );

    auditLog(
      db,
      "principal_add",
      opts.principalId,
      `type=${opts.principalType}, rules=${opts.rules.length}, has_token=${!!token}, email=${opts.email ?? "(none)"}`,
    );
  });

  txn();

  return { id, principalId: opts.principalId, principalType: opts.principalType, token };
}

export function revokePrincipal(
  db: Database.Database,
  principalId: string,
): boolean {
  const now = nowUTC();

  const txn = db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE principals SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
      )
      .run(now, principalId);

    if (result.changes > 0) {
      auditLog(db, "principal_revoke", principalId, null);
    }

    return result.changes > 0;
  });

  return txn();
}

export function updatePrincipal(
  db: Database.Database,
  principalId: string,
  opts: UpdatePrincipalOpts,
): boolean {
  if (opts.rules) {
    validateNamespaceRules(opts.rules);
  }

  if (opts.expiresAt !== undefined && opts.expiresAt !== null) {
    opts.expiresAt = parseExpiresAt(opts.expiresAt);
  }

  const setClauses: string[] = [];
  const params: (string | null)[] = [];

  if (opts.rules !== undefined) {
    setClauses.push("namespace_rules = ?");
    params.push(JSON.stringify(opts.rules));
  }

  if (opts.email !== undefined) {
    setClauses.push("email = ?");
    params.push(opts.email);
    setClauses.push("email_lower = ?");
    params.push(opts.email ? opts.email.trim().toLowerCase() : null);
  }

  if (opts.expiresAt !== undefined) {
    setClauses.push("expires_at = ?");
    params.push(opts.expiresAt);
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update. Provide --rules, --email, or --expires-at.");
  }

  params.push(principalId);

  const txn = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE principals SET ${setClauses.join(", ")} WHERE principal_id = ? AND revoked_at IS NULL`,
      )
      .run(...params);

    if (result.changes > 0) {
      const fields = setClauses.map((c) => c.split(" = ")[0]).join(", ");
      auditLog(db, "principal_update", principalId, `updated: ${fields}`);
    }

    return result.changes > 0;
  });

  return txn();
}

export function rotateToken(
  db: Database.Database,
  principalId: string,
): RotateTokenResult | null {
  const row = db
    .prepare(
      "SELECT principal_type, token_hash, revoked_at FROM principals WHERE principal_id = ?",
    )
    .get(principalId) as
    | { principal_type: string; token_hash: string | null; revoked_at: string | null }
    | undefined;

  if (!row) return null;

  if (row.revoked_at !== null) {
    throw new Error(`Principal "${principalId}" is revoked. Cannot rotate token.`);
  }

  if (row.principal_type !== "agent") {
    throw new Error(
      `Token rotation is only supported for agent principals. "${principalId}" is type "${row.principal_type}".`,
    );
  }

  const token = randomBytes(32).toString("hex");
  const newHash = hashToken(token);

  const txn = db.transaction(() => {
    db.prepare("UPDATE principals SET token_hash = ? WHERE principal_id = ?").run(
      newHash,
      principalId,
    );

    auditLog(db, "principal_rotate_token", principalId, "token rotated");
  });

  txn();

  return { principalId, token };
}

export function testPrincipalAccess(
  db: Database.Database,
  principalId: string,
  namespace: string,
): TestAccessResult | null {
  const row = db
    .prepare(
      `SELECT principal_id, principal_type, namespace_rules, revoked_at, expires_at
       FROM principals WHERE principal_id = ?`,
    )
    .get(principalId) as PrincipalDbRow | undefined;

  if (!row) return null;

  const status = deriveStatus(row);
  const rules = JSON.parse(row.namespace_rules) as NamespaceRule[];

  // Build an AccessContext to test with
  const ctx = resolveAccessContext(db, `principal:${principalId}`);

  const matchingRules = rules.filter(
    (rule) => namespaceMatchesPattern(namespace, rule.pattern),
  );

  return {
    principalId: row.principal_id,
    namespace,
    canRead: canRead(ctx, namespace),
    canWrite: canWrite(ctx, namespace),
    matchingRules,
    status,
  };
}

export function listClassificationFloors(
  db: Database.Database,
): ClassificationFloorSummary[] {
  return listNamespaceClassificationFloors(db).map((row) => ({
    namespacePattern: row.namespace_pattern,
    minClassification: row.min_classification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function setClassificationFloor(
  db: Database.Database,
  namespacePattern: string,
  classification: ClassificationLevel,
): ClassificationFloorSummary {
  validateClassificationPattern(namespacePattern);
  const row = setNamespaceClassificationFloor(db, namespacePattern, classification);
  return {
    namespacePattern: row.namespace_pattern,
    minClassification: row.min_classification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function auditClassification(
  db: Database.Database,
  namespace?: string,
): ClassificationAuditItem[] {
  return listEntriesBelowNamespaceFloor(db, namespace).map((row) => ({
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    entryType: row.entry_type,
    classification: row.classification,
    namespaceFloor: row.namespace_floor,
    tags: JSON.parse(row.tags) as string[],
  }));
}

export function rotateBearerToken(
  db: Database.Database,
  scope: BearerScope,
  graceHours: number,
): RotateBearerResult {
  const now = nowUTC();
  const expiresAt = new Date(Date.now() + graceHours * 3600 * 1000).toISOString();

  // Find current active DB token for this scope
  const existing = db
    .prepare(
      `SELECT id FROM bearer_tokens
       WHERE scope = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(scope, now) as { id: string } | undefined;

  const token = randomBytes(32).toString("hex");
  const newId = randomUUID();

  const run = db.transaction(() => {
    if (existing) {
      db.prepare("UPDATE bearer_tokens SET expires_at = ? WHERE id = ?").run(
        expiresAt,
        existing.id,
      );
    }
    db.prepare(
      "INSERT INTO bearer_tokens (id, token_hash, scope, created_at) VALUES (?, ?, ?, ?)",
    ).run(newId, hashToken(token), scope, now);
    auditLog(
      db,
      "bearer_rotate",
      scope,
      JSON.stringify({ newKeyId: newId, retiringKeyId: existing?.id ?? null, graceHours }),
    );
  });
  run();

  return {
    id: newId,
    token,
    scope,
    retiringKeyId: existing?.id ?? null,
    retiringExpiresAt: existing ? expiresAt : null,
  };
}

export function revokeBearerToken(
  db: Database.Database,
  keyId: string,
): boolean {
  const row = db
    .prepare("SELECT id, scope FROM bearer_tokens WHERE id = ? AND revoked_at IS NULL")
    .get(keyId) as { id: string; scope: string } | undefined;
  if (!row) return false;

  const run = db.transaction(() => {
    db.prepare("UPDATE bearer_tokens SET revoked_at = ? WHERE id = ?").run(nowUTC(), keyId);
    auditLog(db, "bearer_revoke", row.scope, JSON.stringify({ keyId }));
  });
  run();
  return true;
}

export function listBearerTokens(
  db: Database.Database,
  scope?: BearerScope,
): BearerTokenSummary[] {
  const now = nowUTC();
  const rows = (
    scope
      ? db
          .prepare(
            "SELECT id, scope, created_at, expires_at, revoked_at FROM bearer_tokens WHERE scope = ? ORDER BY created_at DESC",
          )
          .all(scope)
      : db
          .prepare(
            "SELECT id, scope, created_at, expires_at, revoked_at FROM bearer_tokens ORDER BY created_at DESC",
          )
          .all()
  ) as Array<{
    id: string;
    scope: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope as BearerScope,
    status:
      r.revoked_at !== null
        ? "revoked"
        : r.expires_at !== null && r.expires_at <= now
          ? "expired"
          : r.expires_at !== null
            ? "retiring"
            : "active",
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

// ---------------------------------------------------------------------------
// CLI output formatting
// ---------------------------------------------------------------------------

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function formatTable(
  headers: string[],
  rows: string[][],
  widths: number[],
): string {
  const headerLine = headers
    .map((h, i) => padRight(h, widths[i]))
    .join("  ");
  const lines = rows.map((row) =>
    row.map((cell, i) => padRight(cell, widths[i])).join("  "),
  );
  return [headerLine, ...lines].join("\n");
}

function formatDetail(detail: PrincipalDetail): string {
  const lines = [
    `Principal ID:    ${detail.principalId}`,
    `Type:            ${detail.principalType}`,
    `Status:          ${detail.status}`,
    `Email:           ${detail.email ?? "(none)"}`,
    `Has Token:       ${detail.hasToken ? "yes" : "no"}`,
    `Created:         ${detail.createdAt}`,
    `Expires:         ${detail.expiresAt ?? "(never)"}`,
    detail.revokedAt ? `Revoked:         ${detail.revokedAt}` : null,
    "",
    "Namespace Rules:",
  ].filter((l) => l !== null);

  if (detail.namespaceRules.length === 0) {
    lines.push("  (none)");
  } else {
    for (let i = 0; i < detail.namespaceRules.length; i++) {
      const r = detail.namespaceRules[i];
      lines.push(`  ${i + 1}. ${r.pattern}  →  ${r.permissions}`);
    }
  }

  if (detail.oauthClients.length > 0) {
    lines.push("");
    lines.push("OAuth Clients:");
    for (const c of detail.oauthClients) {
      const status = c.revokedAt ? " (revoked)" : "";
      lines.push(`  - ${c.oauthClientId}  mapped: ${c.mappedAt}  by: ${c.mappedBy}${status}`);
    }
  }

  return lines.join("\n");
}

function formatTestResult(result: TestAccessResult): string {
  const lines = [
    `Principal:   ${result.principalId}`,
    `Namespace:   ${result.namespace}`,
    `Status:      ${result.status}`,
    `Can Read:    ${result.canRead ? "yes" : "no"}`,
    `Can Write:   ${result.canWrite ? "yes" : "no"}`,
    "",
    "Matching Rules:",
  ];

  if (result.matchingRules.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of result.matchingRules) {
      lines.push(`  - ${r.pattern}  →  ${r.permissions}`);
    }
  }

  return lines.join("\n");
}

function formatClassificationFloors(floors: ClassificationFloorSummary[]): string {
  const headers = ["PATTERN", "MIN CLASSIFICATION", "UPDATED"];
  const rows = floors.map((floor) => [
    floor.namespacePattern,
    floor.minClassification,
    floor.updatedAt,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  return formatTable(headers, rows, widths);
}

function formatClassificationAudit(items: ClassificationAuditItem[]): string {
  const headers = ["NAMESPACE", "KEY", "TYPE", "CLASSIFICATION", "FLOOR"];
  const rows = items.map((item) => [
    item.namespace,
    item.key ?? "(log)",
    item.entryType,
    item.classification,
    item.namespaceFloor,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  return formatTable(headers, rows, widths);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  dbPath?: string;
  json: boolean;
  init: boolean;
  help: boolean;
  force: boolean;
  resource: string | undefined;
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let dbPath: string | undefined;
  let json = false;
  let init = false;
  let help = false;
  let force = false;
  const flags = new Map<string, string>();
  const positionals: string[] = [];

  const flagsWithValues = new Set([
    "--db",
    "--type",
    "--rules",
    "--email",
    "--expires-at",
    "--principal",
    "--scope",
    "--grace-hours",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--init") {
      init = true;
    } else if (arg === "--force") {
      force = true;
    } else if (flagsWithValues.has(arg)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--db") {
        dbPath = next;
      } else {
        flags.set(arg, next);
      }
      i++;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    dbPath,
    json,
    init,
    help,
    force,
    resource: positionals[0],
    command: positionals[1],
    positionals: positionals.slice(2),
    flags,
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `munin-admin — Manage principals in the munin-memory MCP server.

Usage:
  munin-admin principals list
  munin-admin principals show <principal-id>
  munin-admin principals add <principal-id> --type <type> --rules <json|@file> [--email <email>]
  munin-admin principals revoke <principal-id>
  munin-admin principals update <principal-id> [--rules ...] [--email ...] [--expires-at ...]
  munin-admin principals rotate-token <principal-id>
  munin-admin principals test <principal-id> <namespace>
  munin-admin classification list-floors
  munin-admin classification set-floor <namespace-pattern> <classification>
  munin-admin classification audit [namespace-prefix]
  munin-admin oauth-clients list [--principal <principal-id>]
  munin-admin oauth-clients remove <oauth-client-id>
  munin-admin oauth-clients clear <principal-id>
  munin-admin bearer list [--scope=owner|dpa|consumer]
  munin-admin bearer rotate [--scope=owner|dpa|consumer] [--grace-hours=<n>]
  munin-admin bearer revoke <key-id>

Global flags:
  --db <path>     Database path (default: ~/.munin-memory/memory.db)
  --json          Machine-readable JSON output
  --init          Allow creating a new DB if it doesn't exist
  --force         Required for --type owner
  --help          Show this help`;

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function openDb(dbPath: string | undefined, init: boolean): Database.Database {
  const resolved = resolveDbPath(dbPath);
  if (!init && !existsSync(resolved)) {
    throw new Error(
      `Database not found: ${resolved}\nUse --init to create a new database, or --db to specify a different path.`,
    );
  }
  return initDatabase(dbPath);
}

function handleList(
  db: Database.Database,
  jsonOutput: boolean,
): void {
  const principals = listPrincipals(db);

  if (jsonOutput) {
    console.log(JSON.stringify(principals, null, 2));
    return;
  }

  if (principals.length === 0) {
    console.log("No principals found.");
    return;
  }

  const headers = ["PRINCIPAL ID", "TYPE", "EMAIL", "RULES", "STATUS", "CREATED"];
  const rows = principals.map((p) => [
    p.principalId,
    p.principalType,
    p.email ?? "",
    `${p.rulesCount} rule${p.rulesCount !== 1 ? "s" : ""}`,
    p.status,
    p.createdAt,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  console.log(formatTable(headers, rows, widths));
}

function handleShow(
  db: Database.Database,
  principalId: string,
  jsonOutput: boolean,
): void {
  const detail = showPrincipal(db, principalId);
  if (!detail) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: "not_found", principalId }));
    } else {
      console.error(`Principal not found: ${principalId}`);
    }
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(detail, null, 2));
  } else {
    console.log(formatDetail(detail));
  }
}

function handleAdd(
  db: Database.Database,
  principalId: string,
  flags: Map<string, string>,
  force: boolean,
  jsonOutput: boolean,
): void {
  const typeStr = flags.get("--type");
  if (!typeStr) {
    throw new Error("Missing required flag: --type");
  }

  const rulesStr = flags.get("--rules");
  if (!rulesStr) {
    throw new Error("Missing required flag: --rules");
  }

  const rules = parseRules(rulesStr);
  const expiresAt = flags.get("--expires-at");
  const email = flags.get("--email");

  const result = addPrincipal(db, {
    principalId,
    principalType: typeStr as PrincipalType,
    rules,
    email,
    expiresAt,
    force,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Created principal: ${result.principalId} (type: ${result.principalType})`);
    if (result.token) {
      console.error(
        `\nService token (shown once, store securely):\n  ${result.token}\n`,
      );
    }
  }
}

function handleRevoke(
  db: Database.Database,
  principalId: string,
  jsonOutput: boolean,
): void {
  const success = revokePrincipal(db, principalId);

  if (jsonOutput) {
    console.log(JSON.stringify({ principalId, revoked: success }));
  } else if (success) {
    console.log(`Revoked principal: ${principalId}`);
  } else {
    console.error(
      `Could not revoke: ${principalId} (not found or already revoked)`,
    );
    process.exit(1);
  }
}

function handleUpdate(
  db: Database.Database,
  principalId: string,
  flags: Map<string, string>,
  jsonOutput: boolean,
): void {
  const opts: UpdatePrincipalOpts = {};

  const rulesStr = flags.get("--rules");
  if (rulesStr) {
    opts.rules = parseRules(rulesStr);
  }

  const email = flags.get("--email");
  if (email !== undefined) {
    opts.email = email === "" ? null : email;
  }

  const expiresAt = flags.get("--expires-at");
  if (expiresAt !== undefined) {
    opts.expiresAt = expiresAt === "" ? null : expiresAt;
  }

  const success = updatePrincipal(db, principalId, opts);

  if (jsonOutput) {
    console.log(JSON.stringify({ principalId, updated: success }));
  } else if (success) {
    console.log(`Updated principal: ${principalId}`);
  } else {
    console.error(
      `Could not update: ${principalId} (not found or revoked)`,
    );
    process.exit(1);
  }
}

function handleRotateToken(
  db: Database.Database,
  principalId: string,
  jsonOutput: boolean,
): void {
  const result = rotateToken(db, principalId);

  if (!result) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: "not_found", principalId }));
    } else {
      console.error(`Principal not found: ${principalId}`);
    }
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Token rotated for: ${result.principalId}`);
    console.error(
      `\nNew service token (shown once, store securely):\n  ${result.token}\n`,
    );
  }
}

function handleTest(
  db: Database.Database,
  principalId: string,
  namespace: string,
  jsonOutput: boolean,
): void {
  const result = testPrincipalAccess(db, principalId, namespace);

  if (!result) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: "not_found", principalId }));
    } else {
      console.error(`Principal not found: ${principalId}`);
    }
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTestResult(result));
  }
}

// ---------------------------------------------------------------------------
// OAuth client management functions (exported for testing)
// ---------------------------------------------------------------------------

export function listOAuthClients(
  db: Database.Database,
  principalId?: string,
): OAuthClientMapping[] {
  let rows: OAuthClientMappingRow[];
  if (principalId) {
    rows = db
      .prepare(
        `SELECT oauth_client_id, mapped_at, mapped_by, revoked_at, last_used_at
         FROM principal_oauth_clients WHERE principal_id = ? ORDER BY mapped_at DESC`,
      )
      .all(principalId) as OAuthClientMappingRow[];
  } else {
    rows = db
      .prepare(
        `SELECT poc.oauth_client_id, poc.mapped_at, poc.mapped_by, poc.revoked_at, poc.last_used_at
         FROM principal_oauth_clients poc ORDER BY poc.mapped_at DESC`,
      )
      .all() as OAuthClientMappingRow[];
  }

  return rows.map((m) => ({
    oauthClientId: m.oauth_client_id,
    mappedAt: m.mapped_at,
    mappedBy: m.mapped_by,
    revokedAt: m.revoked_at,
    lastUsedAt: m.last_used_at,
  }));
}

export function removeOAuthClient(
  db: Database.Database,
  oauthClientId: string,
): boolean {
  const txn = db.transaction(() => {
    // Revoke all tokens for this client
    db.prepare(
      "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0",
    ).run(oauthClientId);

    const result = db
      .prepare("DELETE FROM principal_oauth_clients WHERE oauth_client_id = ?")
      .run(oauthClientId);

    if (result.changes > 0) {
      auditLog(db, "oauth_client_remove", oauthClientId, "mapping removed, tokens revoked");
    }

    return result.changes > 0;
  });

  return txn();
}

export function clearOAuthClients(
  db: Database.Database,
  principalId: string,
): number {
  const txn = db.transaction(() => {
    // Get all client_ids for this principal
    const mappings = db
      .prepare("SELECT oauth_client_id FROM principal_oauth_clients WHERE principal_id = ?")
      .all(principalId) as Array<{ oauth_client_id: string }>;

    // Revoke tokens for each client
    for (const m of mappings) {
      db.prepare(
        "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0",
      ).run(m.oauth_client_id);
    }

    const result = db
      .prepare("DELETE FROM principal_oauth_clients WHERE principal_id = ?")
      .run(principalId);

    if (result.changes > 0) {
      auditLog(db, "oauth_clients_clear", principalId, `${result.changes} mapping(s) removed, tokens revoked`);
    }

    return result.changes;
  });

  return txn();
}

function handleOAuthClientsList(
  db: Database.Database,
  flags: Map<string, string>,
  jsonOutput: boolean,
): void {
  const principalId = flags.get("--principal");
  const clients = listOAuthClients(db, principalId);

  if (jsonOutput) {
    console.log(JSON.stringify(clients, null, 2));
    return;
  }

  if (clients.length === 0) {
    console.log("No OAuth client mappings found.");
    return;
  }

  const headers = ["OAUTH CLIENT ID", "MAPPED AT", "MAPPED BY", "STATUS"];
  const rows = clients.map((c) => [
    c.oauthClientId,
    c.mappedAt,
    c.mappedBy,
    c.revokedAt ? "revoked" : "active",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  console.log(formatTable(headers, rows, widths));
}

function handleOAuthClientsRemove(
  db: Database.Database,
  oauthClientId: string,
  jsonOutput: boolean,
): void {
  const success = removeOAuthClient(db, oauthClientId);

  if (jsonOutput) {
    console.log(JSON.stringify({ oauthClientId, removed: success }));
  } else if (success) {
    console.log(`Removed OAuth client mapping: ${oauthClientId} (tokens revoked)`);
  } else {
    console.error(`OAuth client mapping not found: ${oauthClientId}`);
    process.exit(1);
  }
}

function handleOAuthClientsClear(
  db: Database.Database,
  principalId: string,
  jsonOutput: boolean,
): void {
  const count = clearOAuthClients(db, principalId);

  if (jsonOutput) {
    console.log(JSON.stringify({ principalId, removed: count }));
  } else if (count > 0) {
    console.log(`Cleared ${count} OAuth client mapping(s) for ${principalId} (tokens revoked)`);
  } else {
    console.log(`No OAuth client mappings found for ${principalId}`);
  }
}

function handleClassificationListFloors(
  db: Database.Database,
  jsonOutput: boolean,
): void {
  const floors = listClassificationFloors(db);
  if (jsonOutput) {
    console.log(JSON.stringify(floors, null, 2));
    return;
  }
  if (floors.length === 0) {
    console.log("No classification floors found.");
    return;
  }
  console.log(formatClassificationFloors(floors));
}

function handleClassificationSetFloor(
  db: Database.Database,
  namespacePattern: string,
  classification: string,
  jsonOutput: boolean,
): void {
  const result = setClassificationFloor(db, namespacePattern, parseClassification(classification));
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Set ${result.namespacePattern} -> ${result.minClassification}`);
}

function handleClassificationAudit(
  db: Database.Database,
  namespace: string | undefined,
  jsonOutput: boolean,
): void {
  const items = auditClassification(db, namespace);
  if (jsonOutput) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log("No entries below their namespace floor.");
    return;
  }
  console.log(formatClassificationAudit(items));
}

function handleBearerList(
  db: Database.Database,
  flags: Map<string, string>,
  json: boolean,
): void {
  const scope = flags.get("--scope") as BearerScope | undefined;
  const tokens = listBearerTokens(db, scope);
  if (json) {
    console.log(JSON.stringify(tokens, null, 2));
    return;
  }
  if (tokens.length === 0) {
    console.log("No DB-managed bearer tokens found.");
    return;
  }
  for (const t of tokens) {
    const expiry = t.expiresAt ? ` expires=${t.expiresAt}` : "";
    const revoked = t.revokedAt ? ` revoked=${t.revokedAt}` : "";
    console.log(`${t.id}  scope=${t.scope}  status=${t.status}  created=${t.createdAt}${expiry}${revoked}`);
  }
}

function handleBearerRotate(
  db: Database.Database,
  flags: Map<string, string>,
  json: boolean,
): void {
  const scope = (flags.get("--scope") ?? "owner") as BearerScope;
  if (!["owner", "dpa", "consumer"].includes(scope)) {
    throw new Error(`Invalid scope "${scope}". Must be: owner, dpa, consumer`);
  }
  const graceHoursStr = flags.get("--grace-hours");
  const graceHours = graceHoursStr !== undefined ? parseInt(graceHoursStr, 10) : 24;
  if (isNaN(graceHours) || graceHours < 0) {
    throw new Error("--grace-hours must be a non-negative integer");
  }

  const result = rotateBearerToken(db, scope, graceHours);

  if (json) {
    console.log(
      JSON.stringify({
        id: result.id,
        token: result.token,
        scope: result.scope,
        retiringKeyId: result.retiringKeyId,
        retiringExpiresAt: result.retiringExpiresAt,
      }),
    );
    return;
  }

  console.log(`New bearer token (scope=${result.scope}):`);
  console.log(`  ID:    ${result.id}`);
  console.log(`  Token: ${result.token}`);
  console.log("");
  console.log("Store this token in your credentials file or MCP client config.");
  console.log("It will NOT be shown again.");
  if (result.retiringKeyId) {
    console.log("");
    console.log(`Previous token (${result.retiringKeyId}) is now retiring.`);
    console.log(`It will stop working after: ${result.retiringExpiresAt}`);
  }
}

function handleBearerRevoke(
  db: Database.Database,
  keyId: string,
  json: boolean,
): void {
  const ok = revokeBearerToken(db, keyId);
  if (json) {
    console.log(JSON.stringify({ revoked: ok, keyId }));
    return;
  }
  if (!ok) {
    throw new Error(`Bearer token not found or already revoked: ${keyId}`);
  }
  console.log(`Revoked: ${keyId}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv);
  } catch (err: unknown) {
    console.error((err as Error).message);
    console.error("\nRun 'munin-admin --help' for usage.");
    process.exit(1);
  }

  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (
    parsed.resource !== "principals"
    && parsed.resource !== "oauth-clients"
    && parsed.resource !== "classification"
    && parsed.resource !== "bearer"
  ) {
    if (!parsed.resource) {
      console.error("Missing resource. Expected: munin-admin principals|classification|oauth-clients|bearer <command>");
    } else {
      console.error(`Unknown resource: ${parsed.resource}. Expected: principals, classification, oauth-clients, or bearer`);
    }
    console.error("\nRun 'munin-admin --help' for usage.");
    process.exit(1);
  }

  if (!parsed.command) {
    const cmds = parsed.resource === "oauth-clients"
      ? "list, remove, clear"
      : parsed.resource === "classification"
        ? "list-floors, set-floor, audit"
        : parsed.resource === "bearer"
          ? "list, rotate, revoke"
          : "list, show, add, revoke, update, rotate-token, test";
    console.error(`Missing command. Expected: ${cmds}`);
    console.error("\nRun 'munin-admin --help' for usage.");
    process.exit(1);
  }

  let db: Database.Database;
  try {
    db = openDb(parsed.dbPath, parsed.init);
  } catch (err: unknown) {
    console.error((err as Error).message);
    process.exit(1);
  }

  try {
    const pid = parsed.positionals[0];

    // Handle oauth-clients resource
    if (parsed.resource === "oauth-clients") {
      switch (parsed.command) {
        case "list":
          handleOAuthClientsList(db, parsed.flags, parsed.json);
          break;
        case "remove":
          if (!pid) throw new Error("Missing <oauth-client-id> argument.");
          handleOAuthClientsRemove(db, pid, parsed.json);
          break;
        case "clear":
          if (!pid) throw new Error("Missing <principal-id> argument.");
          handleOAuthClientsClear(db, pid, parsed.json);
          break;
        default:
          console.error(`Unknown oauth-clients command: ${parsed.command}`);
          console.error("\nRun 'munin-admin --help' for usage.");
          process.exit(1);
      }
      return;
    }

    if (parsed.resource === "bearer") {
      switch (parsed.command) {
        case "list":
          handleBearerList(db, parsed.flags, parsed.json);
          break;
        case "rotate":
          handleBearerRotate(db, parsed.flags, parsed.json);
          break;
        case "revoke": {
          const keyId = parsed.positionals[0];
          if (!keyId) throw new Error("Missing <key-id> argument.");
          handleBearerRevoke(db, keyId, parsed.json);
          break;
        }
        default:
          console.error(`Unknown bearer command: ${parsed.command}`);
          console.error("\nRun 'munin-admin --help' for usage.");
          process.exit(1);
      }
      return;
    }

    if (parsed.resource === "classification") {
      const arg1 = parsed.positionals[0];
      const arg2 = parsed.positionals[1];
      switch (parsed.command) {
        case "list-floors":
          handleClassificationListFloors(db, parsed.json);
          break;
        case "set-floor":
          if (!arg1) throw new Error("Missing <namespace-pattern> argument.");
          if (!arg2) throw new Error("Missing <classification> argument.");
          handleClassificationSetFloor(db, arg1, arg2, parsed.json);
          break;
        case "audit":
          handleClassificationAudit(db, arg1, parsed.json);
          break;
        default:
          console.error(`Unknown classification command: ${parsed.command}`);
          console.error("\nRun 'munin-admin --help' for usage.");
          process.exit(1);
      }
      return;
    }

    switch (parsed.command) {
      case "list":
        handleList(db, parsed.json);
        break;

      case "show":
        if (!pid) throw new Error("Missing <principal-id> argument.");
        handleShow(db, pid, parsed.json);
        break;

      case "add":
        if (!pid) throw new Error("Missing <principal-id> argument.");
        handleAdd(db, pid, parsed.flags, parsed.force, parsed.json);
        break;

      case "revoke":
        if (!pid) throw new Error("Missing <principal-id> argument.");
        handleRevoke(db, pid, parsed.json);
        break;

      case "update":
        if (!pid) throw new Error("Missing <principal-id> argument.");
        handleUpdate(db, pid, parsed.flags, parsed.json);
        break;

      case "rotate-token":
        if (!pid) throw new Error("Missing <principal-id> argument.");
        handleRotateToken(db, pid, parsed.json);
        break;

      case "test": {
        if (!pid) throw new Error("Missing <principal-id> argument.");
        const ns = parsed.positionals[1];
        if (!ns) throw new Error("Missing <namespace> argument.");
        handleTest(db, pid, ns, parsed.json);
        break;
      }

      default:
        console.error(`Unknown command: ${parsed.command}`);
        console.error("\nRun 'munin-admin --help' for usage.");
        process.exit(1);
    }
  } catch (err: unknown) {
    if (parsed.json) {
      console.log(JSON.stringify({ error: (err as Error).message }));
    } else {
      console.error(`Error: ${(err as Error).message}`);
    }
    process.exit(1);
  } finally {
    db.close();
  }
}

// ESM main guard — only run main() when invoked as a script, not when imported
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main();
}
