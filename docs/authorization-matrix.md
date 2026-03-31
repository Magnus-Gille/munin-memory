# Multi-Principal Munin — Authorization Matrix

**Version:** 1.0
**Date:** 2026-03-31
**Source:** decisions/multi-principal-munin in Munin

## Principals

| Principal | Type | Namespaces owned | Notes |
|-----------|------|-----------------|-------|
| **Magnus** | Owner | `*` (all) | Full access. Existing behavior. |
| **Sara** | Family | `users/sara/*` | Non-technical. System must be invisible/fool-proof. |
| **Agents** | Service | Per-token scope | Skuld, Hugin, etc. Scoped to specific namespaces. |
| **Third-party** | External | `orgs/<name>/*` only | Must not know other users/namespaces exist. |

## Namespace access rules

| Namespace pattern | Owner | Family (Sara) | Third-party | Notes |
|-------------------|-------|---------------|-------------|-------|
| `projects/*` | RW | — | — | Owner-only |
| `clients/*` | RW | — | — | Owner-only |
| `decisions/*` | RW | — | — | Owner-only |
| `people/*` | RW | — | — | Owner-only |
| `meta/*` | RW | — | — | Owner-only |
| `business/*` | RW | — | — | Owner-only |
| `documents/*` | RW | — | — | Owner-only |
| `briefings/*` | RW | — | — | Owner-only |
| `rituals/*` | RW | — | — | Owner-only |
| `tasks/*` | RW | — | — | Owner-only |
| `demo/*` | RW | — | — | Owner-only |
| `users/<id>/*` | RW | RW (own only) | — | Principal sees only own `users/<id>/*` |
| `shared/family/*` | RW | RW | — | Shared family namespace |
| `shared/<group>/*` | RW | Per-group | — | Future: group-based sharing |
| `orgs/<name>/*` | RW | — | RW (own org only) | Third-party isolation |

**Legend:** RW = read + write, — = invisible (not denied, not found)

## Denial semantics

| Caller type | Unauthorized read | Unauthorized write | Unauthorized delete |
|-------------|-------------------|-------------------|-------------------|
| **Human** (Sara, third-party) | `"not found"` — identical to non-existent entry | `"not found"` — identical to non-existent namespace | `"not found"` |
| **Agent** (service token) | Machine-readable denial: `{"error": "access_denied", "namespace": "<redacted>"}` | Same | Same |
| **Owner** | N/A (full access) | N/A | N/A |

Invisible denial is critical: non-owner principals must not be able to distinguish "namespace doesn't exist" from "namespace exists but I can't see it."

## Tool-by-tool authorization

### memory_orient

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Dashboard** | Filtered to caller's accessible namespaces only |
| **Namespace overview** | Filtered to caller's accessible namespaces only |
| **Conventions** | Owner sees full conventions. Non-owner sees a minimal subset (usage guide, no internal architecture). |
| **Maintenance suggestions** | Scoped to caller's namespaces |

### memory_write

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Namespace check** | Caller must have write access to the target namespace |
| **Unauthorized** | Invisible denial (same response as writing to a read-only or non-existent namespace would produce) |
| **compare-and-swap** | `expected_updated_at` works normally within accessible namespaces |

### memory_read

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Namespace check** | Caller must have read access to the target namespace |
| **Unauthorized** | `{"found": false}` — identical to non-existent entry |

### memory_read_batch

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Per-item check** | Each `{namespace, key}` pair checked independently |
| **Unauthorized items** | Return `{"found": false}` per item — no indication of access denial |

### memory_get

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **ID lookup** | After resolving the entry's namespace, check caller access |
| **Unauthorized** | `{"found": false}` — cannot distinguish from deleted entry |

### memory_query

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Result filtering** | Results filtered post-query to caller's accessible namespaces |
| **namespace param** | If caller specifies a namespace they can't access, return empty results (not an error) |
| **Result count** | `total` reflects only accessible results (don't leak hidden count) |

### memory_attention

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Scope** | Only surfaces attention items from caller's accessible namespaces |
| **namespace_prefix** | Intersected with caller's access — no error if prefix is inaccessible |

### memory_log

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Namespace check** | Caller must have write access to the target namespace |
| **Unauthorized** | Invisible denial |

### memory_list

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Without namespace** | Returns only namespaces the caller can access |
| **With namespace** | If caller can't access, return as if namespace doesn't exist |

### memory_history

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Namespace filter** | Only returns audit entries for caller's accessible namespaces |
| **Without namespace** | Returns history across all accessible namespaces only |
| **Unauthorized namespace** | Empty result set (not an error) |

### memory_delete

| Field | Rule |
|-------|------|
| **Who can call** | All principals |
| **Namespace check** | Caller must have write access to the target namespace |
| **Unauthorized** | Preview returns `{"found": false}` — no indication of hidden entries |
| **Cross-namespace** | A namespace delete only affects entries the caller owns. If namespace has entries from multiple principals, only caller's entries are deleted. |

### memory_insights

| Field | Rule |
|-------|------|
| **Who can call** | Owner only |
| **Non-owner** | Return empty results (not an error). Insights expose retrieval patterns that could leak information about hidden namespaces. |

### memory_history (admin view)

| Field | Rule |
|-------|------|
| **Who can call** | Owner only for cross-namespace audit |
| **Non-owner** | Scoped to own namespaces only |

## Direct SQLite readers

These services bypass the MCP layer and read Munin's SQLite database directly.

| Service | Access pattern | Authorization rule |
|---------|---------------|-------------------|
| **Skuld** | Read-only: `projects/*`, `clients/*`, `rituals/*`, `briefings/*`, `business/*` | Owner-only (runs on Pi as magnus). No change needed — already scoped by queries. |
| **Heimdall** | Read-only: `briefings/latest`, system metrics | Owner-only (runs on Pi as magnus). No change needed. |

**Rule:** Direct SQLite readers are classified as owner-only. If a non-owner service needs Munin data, it must go through the MCP API with a scoped token.

## AccessContext structure

```typescript
interface AccessContext {
  principalId: string;        // e.g. "magnus", "sara", "org:acme"
  principalType: "owner" | "family" | "agent" | "external";
  accessibleNamespaces: NamespaceRule[];
}

interface NamespaceRule {
  pattern: string;            // glob-like: "users/sara/*", "shared/family/*"
  permissions: "read" | "write" | "rw";
}
```

**Resolution order:**
1. If `principalType === "owner"` → allow everything, skip checks.
2. Match target namespace against `accessibleNamespaces` patterns.
3. No match → invisible denial.

## Token → Principal mapping

| Auth method | Principal resolution |
|-------------|---------------------|
| Legacy bearer (MUNIN_API_KEY) | → owner (Magnus). Single shared key = owner access. |
| OAuth token | → lookup `client_id` in token table → map to principal via `principals` table. |
| Agent service token | → lookup hashed token in `principals` table → scoped AccessContext. |

**New table:** `principals`

```sql
CREATE TABLE principals (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL UNIQUE,  -- "magnus", "sara", "agent:skuld"
  principal_type TEXT NOT NULL,        -- "owner", "family", "agent", "external"
  token_hash    TEXT,                  -- SHA-256 of bearer token (nullable for OAuth-mapped)
  namespace_rules TEXT NOT NULL,       -- JSON: [{"pattern": "users/sara/*", "permissions": "rw"}, ...]
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,                  -- non-null = revoked
  expires_at    TEXT                   -- optional expiry
);
```

## Implementation order

1. **Add `principals` table + migration**
2. **Implement `resolveAccessContext(token)`** — returns AccessContext from token
3. **Thread AccessContext through `registerTools(server, db, sessionId, accessContext)`**
4. **Add `filterByAccess(entries, ctx)` helper** — used by all read/list/query tools
5. **Add `checkWriteAccess(namespace, ctx)` helper** — used by write/log/delete tools
6. **Implement invisible denial responses** per tool
7. **Write fail-closed tests** — every tool tested with owner, family, and unauthorized principal
8. **Add `munin-admin` CLI** — `principals list/add/revoke/preview`
9. **Migrate existing services** — assign tokens to Skuld, Hugin, Heimdall
10. **Remove legacy unauth path** — all access requires a valid token
11. **Onboard Sara** — create principal, assign token, test inbox flow

## Test matrix (fail-closed)

Every tool must have tests for these scenarios:

| Scenario | Expected |
|----------|----------|
| Owner reads any namespace | Allow |
| Owner writes any namespace | Allow |
| Family reads own `users/<id>/*` | Allow |
| Family reads `shared/family/*` | Allow |
| Family reads `projects/*` | Not found |
| Family writes own `users/<id>/*` | Allow |
| Family writes `projects/*` | Invisible denial |
| Family queries with no namespace filter | Results from accessible namespaces only |
| Family calls memory_list (no namespace) | Only sees accessible namespaces |
| Family calls memory_orient | Dashboard/namespaces filtered |
| Family calls memory_insights | Empty results |
| External reads own `orgs/<name>/*` | Allow |
| External reads `users/*` | Not found |
| External reads `projects/*` | Not found |
| External queries across all namespaces | Only own org results |
| Revoked token | Rejected at auth layer (401) |
| Expired token | Rejected at auth layer (401) |
