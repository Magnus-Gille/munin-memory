# Debate Summary: OAuth 2.1 Security Review

**Date:** 2026-02-25
**Participants:** Claude (Opus 4.6), Codex (GPT-5.3)
**Rounds:** 2
**Topic:** Security of Munin Memory OAuth 2.1 implementation + Cloudflare Access configuration

## Key outcome

The OAuth implementation has solid cryptographic primitives (PKCE, high-entropy tokens, refresh rotation) but has **approval-flow trust boundary gaps** that need fixing before production reliance.

## Concessions accepted by both sides

1. **`redirect_uri` must be re-validated** in both `/authorize/approve` handler (approval and deny paths) and in `exchangeAuthorizationCode` (RFC 6749 4.1.3 compliance)
2. **Auth code and refresh token consumption must be atomic** — use `UPDATE ... WHERE used=0` / `WHERE revoked=0` with `changes === 1` check
3. **`/register` rate limiting must be re-enabled** — was accidentally disabled during debugging
4. **Timing-safe comparison for legacy API key** — `crypto.timingSafeEqual()`
5. **Explicit `action === "approve"` check** — fail-closed behavior, not default-approve
6. **Debug logging should be removed** for production
7. **Server-side authorization transaction binding** — the approval handler should not trust hidden form fields for security-critical parameters; bind them server-side

## Defenses accepted by Codex

- `/authorize/approve` IS protected by CF Access (verified with curl) — not a critical bypass
- Client secret hashing is low priority for single-user personal server
- Per-client rate limiting is nice-to-have, not critical for single-user

## Unresolved disagreements

- **CSRF on consent form:** Claude argues CF Access cookie provides sufficient protection; Codex wants app-layer CSRF/Origin check regardless. Both agree it's low severity but disagree on priority.
- **Full nonce-based transaction binding vs lighter validation:** Codex pushes for server-side nonce storing all authorization params; Claude proposes lighter re-validation. Codex's approach is more robust but adds complexity. **Resolution: implement server-side binding using the existing `oauth_auth_codes` table — store a pending auth request keyed by a nonce, validate on approval.**

## New issues from Round 2

- Deny path also uses caller-supplied `redirect_uri` — needs same validation as approve path
- Over-reliance on CF Access policy correctness — app-layer should not depend on edge policy remaining unchanged

## Final action items

| Priority | Action | Owner | Severity |
|----------|--------|-------|----------|
| 1 | Server-side authorization transaction binding: store pending auth in `oauth_auth_codes` on `/authorize`, validate nonce on `/authorize/approve`, require `action === "approve"` | Claude | Major |
| 2 | Validate `redirect_uri` in both approve and deny paths against registered client URIs | Claude | Major |
| 3 | Validate `redirect_uri` in `exchangeAuthorizationCode` against stored auth code | Claude | Major |
| 4 | Atomic auth code exchange: `UPDATE ... WHERE used=0`, check `changes === 1` | Claude | Major |
| 5 | Atomic refresh token rotation: same pattern | Claude | Major |
| 6 | Re-enable `/register` rate limiting (remove `rateLimit: false`) | Claude | Minor |
| 7 | Timing-safe legacy API key comparison (`crypto.timingSafeEqual`) | Claude | Minor |
| 8 | Remove debug logging (or gate behind `MUNIN_LOG_OAUTH_DEBUG`) | Claude | Minor |
| 9 | Add CSP header on consent page | Claude | Minor |

## Debate files

- `debate/oauth-security-snapshot/` — source file snapshots
- `debate/oauth-security-claude-draft.md` — initial security assessment
- `debate/oauth-security-claude-self-review.md` — self-critique
- `debate/oauth-security-codex-critique.md` — Codex Round 1 critique
- `debate/oauth-security-claude-response-1.md` — Claude's response
- `debate/oauth-security-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/oauth-security-critique-log.json` — structured critique log
- `debate/oauth-security-summary.md` — this file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.3-codex |
| Codex R2   | ~1m             | gpt-5.3-codex |
