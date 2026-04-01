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
import { initDatabase, nowUTC, resolveDbPath } from "./db.js";
import {
  validateNamespaceRules,
  canRead,
  canWrite,
  resolveAccessContext,
  namespaceMatchesPattern,
  type NamespaceRule,
  type PrincipalType,
} from "./access.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrincipalSummary {
  principalId: string;
  principalType: PrincipalType;
  rulesCount: number;
  status: "active" | "revoked" | "expired";
  createdAt: string;
}

export interface PrincipalDetail {
  id: string;
  principalId: string;
  principalType: PrincipalType;
  oauthClientId: string | null;
  hasToken: boolean;
  namespaceRules: NamespaceRule[];
  status: "active" | "revoked" | "expired";
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface AddPrincipalOpts {
  principalId: string;
  principalType: PrincipalType;
  rules: NamespaceRule[];
  oauthClientId?: string;
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
  oauthClientId?: string;
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

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface PrincipalDbRow {
  id: string;
  principal_id: string;
  principal_type: string;
  oauth_client_id: string | null;
  token_hash: string | null;
  namespace_rules: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
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
    "INSERT INTO audit_log (timestamp, agent_id, action, namespace, key, detail) VALUES (?, ?, ?, ?, ?, ?)",
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

const VALID_TYPES = new Set<string>(["owner", "family", "agent", "external"]);

// ---------------------------------------------------------------------------
// Core functions (exported, testable)
// ---------------------------------------------------------------------------

export function listPrincipals(db: Database.Database): PrincipalSummary[] {
  const rows = db
    .prepare(
      `SELECT principal_id, principal_type, namespace_rules, created_at, revoked_at, expires_at
       FROM principals ORDER BY created_at DESC`,
    )
    .all() as PrincipalDbRow[];

  return rows.map((row) => ({
    principalId: row.principal_id,
    principalType: row.principal_type as PrincipalType,
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
      `SELECT id, principal_id, principal_type, oauth_client_id, token_hash, namespace_rules, created_at, revoked_at, expires_at
       FROM principals WHERE principal_id = ?`,
    )
    .get(principalId) as PrincipalDbRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    principalId: row.principal_id,
    principalType: row.principal_type as PrincipalType,
    oauthClientId: row.oauth_client_id,
    hasToken: row.token_hash !== null,
    namespaceRules: JSON.parse(row.namespace_rules) as NamespaceRule[],
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

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO principals (id, principal_id, principal_type, oauth_client_id, token_hash, namespace_rules, created_at, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      opts.principalId,
      opts.principalType,
      opts.oauthClientId ?? null,
      tokenHash,
      JSON.stringify(opts.rules),
      nowUTC(),
      opts.expiresAt ?? null,
    );

    auditLog(
      db,
      "principal_add",
      opts.principalId,
      `type=${opts.principalType}, rules=${opts.rules.length}, has_token=${!!token}`,
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

  if (opts.oauthClientId !== undefined) {
    setClauses.push("oauth_client_id = ?");
    params.push(opts.oauthClientId);
  }

  if (opts.expiresAt !== undefined) {
    setClauses.push("expires_at = ?");
    params.push(opts.expiresAt);
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update. Provide --rules, --oauth-client-id, or --expires-at.");
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
    `OAuth Client:    ${detail.oauthClientId ?? "(none)"}`,
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
    "--oauth-client-id",
    "--expires-at",
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
  munin-admin principals add <principal-id> --type <type> --rules <json|@file>
  munin-admin principals revoke <principal-id>
  munin-admin principals update <principal-id> [--rules ...] [--oauth-client-id ...] [--expires-at ...]
  munin-admin principals rotate-token <principal-id>
  munin-admin principals test <principal-id> <namespace>

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

  const headers = ["PRINCIPAL ID", "TYPE", "RULES", "STATUS", "CREATED"];
  const rows = principals.map((p) => [
    p.principalId,
    p.principalType,
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
  const oauthClientId = flags.get("--oauth-client-id");

  const result = addPrincipal(db, {
    principalId,
    principalType: typeStr as PrincipalType,
    rules,
    oauthClientId,
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

  const oauthClientId = flags.get("--oauth-client-id");
  if (oauthClientId !== undefined) {
    opts.oauthClientId = oauthClientId;
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

  if (parsed.resource !== "principals") {
    if (!parsed.resource) {
      console.error("Missing resource. Expected: munin-admin principals <command>");
    } else {
      console.error(`Unknown resource: ${parsed.resource}. Expected: principals`);
    }
    console.error("\nRun 'munin-admin --help' for usage.");
    process.exit(1);
  }

  if (!parsed.command) {
    console.error("Missing command. Expected: list, show, add, revoke, update, rotate-token, test");
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
