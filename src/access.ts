/**
 * Access control module for multi-principal namespace isolation.
 *
 * Provides rule-based namespace access checks for non-owner principals.
 * Owner access bypasses all rule checks. All other principals are checked
 * against their accessibleNamespaces rules.
 *
 * Fail-closed: any error in resolveAccessContext returns zero-access context.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { nowUTC } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrincipalType = "owner" | "family" | "agent" | "external";

export interface NamespaceRule {
  pattern: string; // exact string, "/*" suffix (prefix match), or lone "*" (match all)
  permissions: "read" | "write" | "rw";
}

export interface AccessContext {
  principalId: string; // "magnus", "sara", "agent:skuld"
  principalType: PrincipalType;
  accessibleNamespaces: NamespaceRule[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZERO_ACCESS: AccessContext = {
  principalId: "anonymous",
  principalType: "external",
  accessibleNamespaces: [],
};

// ---------------------------------------------------------------------------
// ownerContext
// ---------------------------------------------------------------------------

/**
 * Returns the owner access context. Owner is checked by type, not rules —
 * the accessibleNamespaces array is intentionally empty.
 */
export function ownerContext(): AccessContext {
  return {
    principalId: "owner",
    principalType: "owner",
    accessibleNamespaces: [],
  };
}

// ---------------------------------------------------------------------------
// validateNamespaceRules
// ---------------------------------------------------------------------------

/**
 * Throws if any rule in the array is invalid.
 *
 * Valid patterns:
 *   - "*"               — match everything
 *   - "some/path/*"     — prefix match (must end with exactly "/*)
 *   - "some/path/key"   — exact match (no "*" anywhere)
 *
 * Invalid patterns:
 *   - "users/sara*"     — ambiguous (missing "/" before "*")
 *   - "*foo"            — wildcard not in trailing position
 *   - anything with "*" in the middle
 */
export function validateNamespaceRules(rules: NamespaceRule[]): void {
  const validPermissions = new Set(["read", "write", "rw"]);

  for (const rule of rules) {
    const { pattern, permissions } = rule;

    if (!validPermissions.has(permissions)) {
      throw new Error(
        `Invalid permissions "${permissions}" in rule for pattern "${pattern}". ` +
          `Must be one of: "read", "write", "rw".`
      );
    }

    if (pattern === "*") {
      // lone wildcard — always valid
      continue;
    }

    if (pattern.includes("*")) {
      // Any pattern containing "*" must end with exactly "/*"
      if (!pattern.endsWith("/*")) {
        throw new Error(
          `Invalid namespace pattern "${pattern}". ` +
            `Patterns containing "*" must either be the lone wildcard "*" or end with "/*" ` +
            `(e.g. "users/sara/*"). Ambiguous patterns like "users/sara*" are rejected.`
        );
      }

      // The "*" must appear only once, as the final character
      const withoutTrailingWildcard = pattern.slice(0, -1); // remove "*"
      if (withoutTrailingWildcard.includes("*")) {
        throw new Error(
          `Invalid namespace pattern "${pattern}". ` +
            `Only a single trailing "*" is allowed (after "/").`
        );
      }
    }

    // Exact patterns: no further validation needed beyond the * checks above
  }
}

// ---------------------------------------------------------------------------
// namespaceMatchesPattern
// ---------------------------------------------------------------------------

/**
 * Returns true if the given namespace matches the pattern.
 *
 *   "*"           — always matches
 *   "prefix/*"    — matches if namespace starts with "prefix/"
 *   "exact/path"  — matches only if namespace === pattern
 */
export function namespaceMatchesPattern(
  namespace: string,
  pattern: string
): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // "prefix/" (drop the "*")
    return namespace.startsWith(prefix);
  }

  // Exact match
  return namespace === pattern;
}

// ---------------------------------------------------------------------------
// canRead / canWrite
// ---------------------------------------------------------------------------

/**
 * Returns true if the context permits reading the given namespace.
 * Owner always has read access.
 */
export function canRead(ctx: AccessContext, namespace: string): boolean {
  if (ctx.principalType === "owner") {
    return true;
  }
  return ctx.accessibleNamespaces.some(
    (rule) =>
      namespaceMatchesPattern(namespace, rule.pattern) &&
      (rule.permissions === "read" || rule.permissions === "rw")
  );
}

/**
 * Returns true if the context permits writing to the given namespace.
 * Owner always has write access.
 */
export function canWrite(ctx: AccessContext, namespace: string): boolean {
  if (ctx.principalType === "owner") {
    return true;
  }
  return ctx.accessibleNamespaces.some(
    (rule) =>
      namespaceMatchesPattern(namespace, rule.pattern) &&
      (rule.permissions === "write" || rule.permissions === "rw")
  );
}

// ---------------------------------------------------------------------------
// canReadSubtree
// ---------------------------------------------------------------------------

/**
 * Returns true if the context permits reading anything under namespacePrefix.
 *
 * Used by tools that treat namespace as a subtree selector (e.g. memory_query
 * with a trailing "/"). A rule "overlaps" with the prefix if:
 *   - the rule matches the entire prefix (rule covers the prefix), OR
 *   - the prefix starts with the rule's prefix (prefix is within the rule's scope)
 *
 * In practice this means:
 *   rule "*"             — always overlaps with any prefix
 *   rule "users/sara/*"  — overlaps with "users/" (rule is within it)
 *                        — overlaps with "users/sara/inbox/" (prefix is within rule)
 *   rule "users/sara/*"  — does NOT overlap with "projects/" (disjoint)
 *
 * Owner always returns true.
 */
export function canReadSubtree(
  ctx: AccessContext,
  namespacePrefix: string
): boolean {
  if (ctx.principalType === "owner") {
    return true;
  }

  return ctx.accessibleNamespaces.some((rule) => {
    if (rule.permissions !== "read" && rule.permissions !== "rw") {
      return false;
    }

    if (rule.pattern === "*") {
      return true;
    }

    if (rule.pattern.endsWith("/*")) {
      const rulePrefix = rule.pattern.slice(0, -1); // e.g. "users/sara/"
      // The rule's subtree overlaps with the query prefix if:
      // 1. the query prefix starts with the rule prefix (prefix is within rule scope), OR
      // 2. the rule prefix starts with the query prefix (rule is within queried scope)
      return (
        namespacePrefix.startsWith(rulePrefix) ||
        rulePrefix.startsWith(namespacePrefix)
      );
    }

    // Exact-pattern rule: overlaps if the exact namespace starts with the prefix
    return rule.pattern.startsWith(namespacePrefix);
  });
}

// ---------------------------------------------------------------------------
// filterByAccess
// ---------------------------------------------------------------------------

/**
 * Filters an array of entries to only those the context can read.
 * Owner receives the array unchanged.
 */
export function filterByAccess<T extends { namespace: string }>(
  ctx: AccessContext,
  entries: T[]
): T[] {
  if (ctx.principalType === "owner") {
    return entries;
  }
  return entries.filter((entry) => canRead(ctx, entry.namespace));
}

// ---------------------------------------------------------------------------
// resolveAccessContext
// ---------------------------------------------------------------------------

/**
 * Resolves an AccessContext from the database for the given OAuth client ID.
 *
 * Resolution order:
 *   1. "legacy-bearer"     → ownerContext() immediately
 *   2. "principal:<id>"    → direct lookup by principal_id
 *   3. tokenPrincipalId    → token carries its own principal_id (v6+, set at consent time)
 *   4. clientId            → JOIN principal_oauth_clients → principals (v6+)
 *      FALLBACK:             principals.oauth_client_id (pre-v6 compat)
 *   5. token (if provided) → lookup by SHA-256 hash of token
 *   6. not found / error   → ZERO_ACCESS (fail-closed)
 *
 * Revoked or expired principals also return ZERO_ACCESS.
 */
export function resolveAccessContext(
  db: Database.Database,
  clientId: string,
  token?: string,
  tokenPrincipalId?: string,
): AccessContext {
  try {
    // 1. Legacy bearer token clients are always owner
    if (clientId === "legacy-bearer") {
      return ownerContext();
    }

    let row: PrincipalRow | undefined;

    // 2. Direct principal_id lookup (for internal/agent principals)
    if (clientId.startsWith("principal:")) {
      const principalId = clientId.slice("principal:".length);
      row = db
        .prepare(
          `SELECT principal_id, principal_type, namespace_rules, revoked_at, expires_at
           FROM principals
           WHERE principal_id = ?`
        )
        .get(principalId) as PrincipalRow | undefined;
    }

    // 3. Token-bound principal (v6+): token carries its own principal_id
    if (row === undefined && tokenPrincipalId) {
      row = db
        .prepare(
          `SELECT principal_id, principal_type, namespace_rules, revoked_at, expires_at
           FROM principals
           WHERE principal_id = ?`
        )
        .get(tokenPrincipalId) as PrincipalRow | undefined;
    }

    // 4. Lookup via principal_oauth_clients mapping table (v6+)
    if (row === undefined && !clientId.startsWith("principal:")) {
      row = db
        .prepare(
          `SELECT p.principal_id, p.principal_type, p.namespace_rules, p.revoked_at, p.expires_at
           FROM principal_oauth_clients poc
           JOIN principals p ON poc.principal_id = p.principal_id
           WHERE poc.oauth_client_id = ? AND poc.revoked_at IS NULL`
        )
        .get(clientId) as PrincipalRow | undefined;

      // Fallback: legacy oauth_client_id column (pre-v6 compat, until v7)
      if (row === undefined) {
        row = db
          .prepare(
            `SELECT principal_id, principal_type, namespace_rules, revoked_at, expires_at
             FROM principals
             WHERE oauth_client_id = ?`
          )
          .get(clientId) as PrincipalRow | undefined;
      }
    }

    // 5. Fallback: lookup by token hash (agent service tokens)
    if (row === undefined && token !== undefined) {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      row = db
        .prepare(
          `SELECT principal_id, principal_type, namespace_rules, revoked_at, expires_at
           FROM principals
           WHERE token_hash = ?`
        )
        .get(tokenHash) as PrincipalRow | undefined;
    }

    // 6. Not found → zero access
    if (row === undefined) {
      return { ...ZERO_ACCESS };
    }

    // Revoked
    if (row.revoked_at !== null) {
      return { ...ZERO_ACCESS };
    }

    // Expired
    if (row.expires_at !== null && row.expires_at < nowUTC()) {
      return { ...ZERO_ACCESS };
    }

    // Parse namespace rules
    let rules: NamespaceRule[];
    try {
      rules = JSON.parse(row.namespace_rules) as NamespaceRule[];
    } catch {
      // Malformed rules in DB → fail-closed
      return { ...ZERO_ACCESS };
    }

    return {
      principalId: row.principal_id,
      principalType: row.principal_type as PrincipalType,
      accessibleNamespaces: rules,
    };
  } catch {
    // Any unexpected error → fail-closed
    return { ...ZERO_ACCESS };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PrincipalRow {
  principal_id: string;
  principal_type: string;
  namespace_rules: string; // JSON string
  revoked_at: string | null;
  expires_at: string | null;
}
