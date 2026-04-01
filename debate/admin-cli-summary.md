# Debate Summary: munin-admin CLI

**Date:** 2026-04-01
**Participants:** Claude (Opus 4.6) vs Codex
**Rounds:** 2
**Artifact:** Implementation plan for `munin-admin` principal management CLI

## Key Outcomes

### Concessions accepted (changed the plan)

1. **Token rotation command** — Added `principals rotate-token <principal-id>`. The original "revoke and re-add" recovery path was broken by the UNIQUE constraint on `principal_id`. This was the highest-severity finding.
2. **Audit trail** — All mutations (add, revoke, update, rotate-token) write to `audit_log`. Original plan omitted this entirely despite existing audit infrastructure.
3. **Refuse missing DB** — CLI checks `existsSync` before `initDatabase()`. Silent DB creation on typo path was a real footgun. `--init` flag for intentional bootstrap.
4. **`--expires-at` validation** — Strict ISO 8601 format validation (not permissive `new Date()`), normalize to UTC. String-based expiry comparison demands canonical format.
5. **Owner creation guard** — `--type owner` refused without `--force` flag.
6. **`--json` on all commands** — Including mutation commands that emit one-time secrets (add, rotate-token). Originally planned for read-only commands only.
7. **`update` expanded** — Now covers `--rules`, `--oauth-client-id`, and `--expires-at`.
8. **Naming** — `<principal-id>` consistently, never `<id>`.

### Defenses accepted by Codex

1. **Manual argv parsing** — Acceptable if treated with appropriate rigor, not dismissed as trivial.
2. **Single file** — No build-graph or architectural reason to split.
3. **token_hash not UNIQUE** — Collision probability negligible with random 32-byte tokens.

### Unresolved / acknowledged

1. **CLI parser testing** — Codex pushed for automated CLI invocation tests. Claude will add basic parser edge-case tests but not full process-spawn integration tests. Compromise: test the `parseArgs` helper directly.
2. **Revoke semantics** — Revoke is terminal (explicit design choice). No `unrevoke`. Lost access = rotate-token (for credentials) or re-add with new ID (for mistaken revocation). Documented, not changed.
3. **Multiple owners** — Tolerated for recovery, not enforced as invariant. `--force` makes it deliberate.

## Action Items

All items are for the revised implementation plan:

1. Add `rotate-token` command
2. Add audit logging to all mutations
3. Add DB existence check + `--init` flag
4. Add strict `--expires-at` parsing with format validation
5. Add `--force` guard for `--type owner`
6. Add `--json` global flag (all commands)
7. Expand `update` to cover oauth-client-id and expires-at
8. Use `<principal-id>` naming consistently
9. Proper ESM main guard (file URL comparison)
10. Add parser/validation test coverage for rules, expires-at, and owner guard

## Debate Files

- `debate/admin-cli-snapshot.md` — Original plan snapshot
- `debate/admin-cli-claude-draft.md` — Claude's position
- `debate/admin-cli-claude-self-review.md` — Self-review
- `debate/admin-cli-codex-critique.md` — Codex Round 1 critique
- `debate/admin-cli-claude-response-1.md` — Claude's response
- `debate/admin-cli-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/admin-cli-critique-log.json` — Structured critique log (15 points)

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |

## Metrics

- **Critique points:** 15
- **Self-review catch rate:** 3/15 (20%)
- **Changed outcomes:** 10 (67%)
- **Critical findings:** 2 (both changed the plan)
