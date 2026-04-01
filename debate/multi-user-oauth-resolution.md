# Multi-User OAuth Auto-Mapping — Debate Resolution

## Participants
- **Claude (Opus 4.6)** — architect
- **Codex (GPT-5.4)** — adversarial reviewer

## Summary

1 round of debate. 10 critiques, 4 missed items. All resolved below.

**Verdict:** Codex's review is exceptionally strong. Critique #1 (bind principal to tokens, not clients) is the single most important insight and fundamentally reshapes the implementation. 8 of 10 critiques change the plan.

---

## Final Decisions

### 1. Bind principal_id to tokens, not just clients — ACCEPTED (plan-changing)

Codex is right that the current `access token → client_id → principal lookup` chain means remapping a client_id retroactively changes the identity of already-issued tokens. This is a security flaw in the multi-user model.

**Fix:** Add `principal_id` column to `oauth_auth_codes` and `oauth_tokens` in migration v6. Set it at consent time (auth code creation) and carry it forward on refresh. In `verifyAccessToken`, return `principal_id` in the `AuthInfo` so `resolveAccessContext` can use it directly when available, falling back to client-based lookup only for pre-migration tokens.

This makes `principal_oauth_clients` a device inventory table (operational metadata) rather than the authority for access control. The token itself carries the binding.

**Impact:** This is the biggest change to the plan. It simplifies `resolveAccessContext` (token already knows its principal), makes device-mapping mutations safe (no retroactive identity change), and eliminates several other critiques (#4, #9) as secondary concerns.

### 2. Separate trusted-proxy proof from identity claim — ACCEPTED (modified)

Codex correctly identifies that `MUNIN_OAUTH_TRUSTED_USER_HEADER`/`VALUE` currently means "request passed through the trusted gate" (a boolean gate), not "this is user X" (an identity claim). The plan overloads this.

**Fix:** Introduce a separate config pair:
- `MUNIN_OAUTH_IDENTITY_HEADER` — header containing the authenticated user's email (e.g., `cf-access-authenticated-user-email`)
- Keep existing `MUNIN_OAUTH_TRUSTED_USER_HEADER`/`VALUE` as the gate check (unchanged)

The consent flow requires BOTH: the gate check passes (trusted proxy) AND the identity header is present. This cleanly separates "is this request trustworthy" from "who is this user."

**Not doing:** JWT verification of `Cf-Access-Jwt-Assertion`. While more robust, it adds a dependency on CF's public key infrastructure and JWKS endpoint. The current threat model has CF Access as the perimeter — if that's compromised, JWT verification inside the same tunnel doesn't add meaningful protection. The Pi only accepts connections from the tunnel anyway. Can revisit if the deployment model changes.

### 3. Bind identity to both GET and POST consent — ACCEPTED

The plan was sloppy here. If principal resolution happens on GET `/authorize` but isn't revalidated on POST `/authorize/approve`, a TOCTOU gap exists.

**Fix:** Store the verified email/subject AND resolved `principal_id` in `PendingAuth`. On POST `/authorize/approve`, re-read the identity header, verify it matches what was stored. Re-resolve the principal and verify it's still active (not revoked/expired since GET). All of this happens in the same DB transaction that creates the auth code and mapping.

### 4. Explicit conflict handling for mappings — ACCEPTED

Codex is right that neither `INSERT OR IGNORE` nor `INSERT OR REPLACE` is safe. With critique #1 accepted (principal bound to tokens), the mapping table becomes operational metadata, but cross-principal conflicts still need explicit handling.

**Fix:**
- `absent` → insert mapping
- `same principal` → no-op (update `mapped_at` for freshness)
- `different principal` → fail with clear error, log security event to `audit_log`, require admin intervention

The mapping table is now advisory (device inventory), not authoritative (access control), so this is a data hygiene concern rather than a security-critical one. But sloppy data leads to operational confusion.

### 5. Email normalization and uniqueness — ACCEPTED (modified)

Codex is right about case sensitivity and ambiguity. The `provider + subject` model is the correct long-term answer, but over-engineering for a system with 2-3 principals.

**Fix for now:**
- Store `email` as-is (display) but add `email_lower` computed column or normalize on write with `LOWER(TRIM(email))`
- Add `UNIQUE` constraint on the normalized email (or enforce uniqueness in application code + migration)
- Use `db.prepare(...).all()` not `.get()` for email lookup, fail closed on `>1` matches
- Document that `email` is the identity anchor for now, to be replaced by `provider + subject` when a second identity provider is needed

**Not doing:** Full `provider + subject` model now. Only CF Access exists as an IdP. Adding columns for a second provider that doesn't exist yet is premature.

### 6. Owner needs a principals row — ACCEPTED

This is correct and was already an open design question. With critique #1 accepted (principal bound to tokens), the owner MUST have a row for OAuth-issued tokens to reference.

**Fix:**
- Migration v6 inserts an owner row: `principal_id = 'owner'`, `principal_type = 'owner'`, `email = <MUNIN_OAUTH_TRUSTED_USER_VALUE>`, `namespace_rules = '[]'`
- `resolveAccessContext` step 1 (`legacy-bearer`) unchanged — still returns `ownerContext()` with no DB hit
- OAuth-issued tokens for the owner carry `principal_id = 'owner'` → resolves to the row → `principalType = 'owner'` → full access

The owner row is created during migration with a well-known principal_id. `munin-admin` should refuse to delete or revoke the owner row.

### 7. Two-phase migration — ACCEPTED

Codex is right that dropping the column in one shot is risky.

**Fix:**
- **Migration v6:** Add `email`, `email_lower` to `principals`. Create `principal_oauth_clients`. Add `principal_id` to `oauth_auth_codes` and `oauth_tokens`. Backfill mappings from existing `oauth_client_id`. Insert owner row. Leave `oauth_client_id` column in place.
- **Code:** Read from `principal_oauth_clients` first, fall back to `principals.oauth_client_id` for pre-migration data. Write to both.
- **Migration v7 (future):** Drop `oauth_client_id` from `principals` after confirming no code reads it. This can wait until all existing tokens have expired and been cleaned up.

### 8. Referential integrity and lifecycle on mapping table — ACCEPTED (modified)

Codex's specific fixes are sound but need moderation for complexity.

**Fix:**
- FK to `principals(id)` (stable row ID) instead of `principal_id` — **REJECTED**. The `principal_id` column has a UNIQUE constraint and is the human-readable identifier used everywhere. Adding another level of indirection for rename safety that we don't need (principal renames aren't a planned operation) adds complexity. Keep `REFERENCES principals(principal_id)`.
- FK to `oauth_clients(client_id) ON DELETE CASCADE` — **ACCEPTED**. Prevents orphan mappings when clients are cleaned up.
- `revoked_at` column — **ACCEPTED** (see critique #4 verdict, and design question #4 below).
- `revoked_by` and `reason` — **DEFERRED**. The audit_log already captures mutation context. Adding reason columns to every table duplicates what audit_log provides.

### 9. Token revocation on device removal — ACCEPTED (simplified by #1)

With critique #1 accepted (principal bound to tokens), removing a mapping from `principal_oauth_clients` does NOT change the identity of existing tokens — they still carry their `principal_id` directly. So this is less critical than Codex suggests.

However, revoking a device SHOULD revoke its tokens for clean session termination.

**Fix:** When `munin-admin oauth-clients remove <client_id>` is called, also `UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?`. This is a convenience, not a security boundary (the token's principal_id is immutable).

### 10. In-memory pending-auth store — ACKNOWLEDGED (no change)

Codex is technically correct that `pendingAuths` is process-local. However:
- The Pi runs a single Node.js process behind systemd
- Consent windows are 10 minutes maximum
- A restart during the consent flow is rare and recoverable (user just re-initiates)
- Persisting pending auth in SQLite adds schema complexity for a problem that doesn't exist in practice

**Decision:** Document the constraint (already implied by single-process systemd deployment). Do not add schema complexity. If multi-instance deployment ever becomes real, revisit.

---

## Design Question Verdicts (from Codex)

### DQ1: Auto-approve for known principals?
**Verdict: No (agree with Codex).** Always show consent UI. The consent page serves as user acknowledgment and will now show "Connecting as [principal_name]" which provides valuable confirmation. Auto-approve can be reconsidered later for explicitly allowlisted first-party clients, but not in v6.

### DQ2: Owner gets a principals row?
**Verdict: Yes (agree with Codex, and required by critique #1).** See resolution #6 above.

### DQ3: INSERT OR IGNORE vs INSERT OR REPLACE?
**Verdict: Neither (agree with Codex).** Explicit conflict detection. See resolution #4 above.

### DQ4: `revoked_at` on `principal_oauth_clients`?
**Verdict: Yes (agree with Codex).** Soft revocation with `revoked_at` timestamp. Enables per-device deactivation without losing the audit trail. Combined with token revocation from resolution #9.

### DQ5: Identity provider abstraction for Pi Zero?
**Verdict: Good enough for now (partially agree).** The separation of gate check (`TRUSTED_USER_HEADER/VALUE`) from identity claim (`IDENTITY_HEADER`) from resolution #2 is a sufficient abstraction layer. The Pi Zero appliance can implement a different identity provider (local auth, Tailscale identity, etc.) by setting different header names. A formal `provider + subject` model is deferred until a second identity provider actually exists.

---

## Missed Items (from Codex)

### Audit trail
**ACCEPTED.** All mapping mutations (create, remove, conflict, owner-fallback) log to `audit_log`. This follows the existing pattern established by `munin-admin` for principal mutations.

### Ambiguous identity handling
**ACCEPTED.** Use `.all()` not `.get()` for email lookups. 0 matches → deny. 1 match → proceed. >1 matches → fail closed, log error. The UNIQUE constraint on `email_lower` should prevent >1 from occurring, but defense in depth.

### Migration tests
**ACCEPTED.** Test cases needed:
- v5→v6 backfill correctness (existing oauth_client_id migrated to mapping table)
- Owner row creation during migration
- Dual-read compatibility (new code, old data)
- Duplicate email rejection
- Revoke-during-pending-auth (TOCTOU check from resolution #3)
- Device removal + token revocation
- Cross-principal conflict detection

### Operational metadata
**PARTIALLY ACCEPTED.** Add `last_used_at` to `principal_oauth_clients` (updated when a token issued for that client is verified). Defer `client_name` snapshot and orphan cleanup to a later iteration — they're nice-to-have, not blocking.

---

## Revised Schema (Migration v6)

```sql
-- 1. Add identity columns to principals
ALTER TABLE principals ADD COLUMN email TEXT;
ALTER TABLE principals ADD COLUMN email_lower TEXT;
CREATE UNIQUE INDEX idx_principals_email_lower ON principals(email_lower) WHERE email_lower IS NOT NULL;

-- 2. Insert owner row (email from env var, set during migration code)
INSERT INTO principals (id, principal_id, principal_type, email, email_lower, namespace_rules, created_at)
  VALUES (?, 'owner', 'owner', ?, ?, '[]', ?);

-- 3. Create mapping table (device inventory)
CREATE TABLE principal_oauth_clients (
  oauth_client_id TEXT PRIMARY KEY REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL REFERENCES principals(principal_id),
  mapped_at       TEXT NOT NULL,
  mapped_by       TEXT NOT NULL DEFAULT 'consent',
  revoked_at      TEXT,
  last_used_at    TEXT
);
CREATE INDEX idx_poc_principal ON principal_oauth_clients(principal_id);

-- 4. Backfill from existing data
INSERT INTO principal_oauth_clients (oauth_client_id, principal_id, mapped_at, mapped_by)
  SELECT oauth_client_id, principal_id, created_at, 'migration'
  FROM principals WHERE oauth_client_id IS NOT NULL;

-- 5. Add principal_id to token tables (THE KEY CHANGE)
ALTER TABLE oauth_auth_codes ADD COLUMN principal_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN principal_id TEXT;

-- 6. Leave principals.oauth_client_id in place (removed in future v7)
```

## Revised resolveAccessContext

```
1. clientId === "legacy-bearer"     → ownerContext() (no DB hit, backward compat)
2. clientId.startsWith("principal:") → lookup by principal_id (unchanged)
3. token has principal_id (new!)    → lookup principals by principal_id from token
4. clientId                         → JOIN principal_oauth_clients → principals (new table)
   FALLBACK: principals.oauth_client_id (pre-v6 compat, until v7)
5. token hash                       → lookup by token_hash (unchanged)
6. not found / revoked / expired    → ZERO_ACCESS
```

Step 3 is the critical addition: when a token carries its own principal_id (set at consent time), we use it directly instead of deriving identity from the client.

---

## Implementation Order

1. Migration v6 (schema changes + backfill + owner row)
2. Update `MuninOAuthProvider` to write `principal_id` into auth codes and tokens
3. Update `verifyAccessToken` to return `principal_id` in `AuthInfo`
4. Update `resolveAccessContext` to prefer token-bound principal_id
5. Update consent flow: identity header, TOCTOU check, mapping insertion
6. Update `munin-admin`: `--email` flag, `oauth-clients` subcommand, token revocation on removal
7. Dual-read compatibility for pre-v6 tokens
8. Tests (migration, consent flow, conflict detection, TOCTOU, device removal)
