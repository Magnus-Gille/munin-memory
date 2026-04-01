# Multi-Principal Phase 1 — Debate Summary

**Date:** 2026-04-01
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** Implementation plan for server-enforced namespace isolation in Munin Memory

## Concessions accepted by both sides

1. **Aggregate tools need input-level authorization**, not output filtering. memory_orient (7 sources) and memory_attention must authorize each input before computing derived fields like dashboard_meta, maintenance_needed, summary.
2. **memory_query canonical injection must be filtered** — injected owner-only entries (meta/reference-index, people/magnus/profile) must pass access checks.
3. **memory_read/get denial must use a separate clean path** — current not-found includes sibling key hints that would leak namespace contents.
4. **Pattern validation required** — only exact strings, `/*` suffix, or lone `*` are valid. Reject ambiguous patterns like `users/sara*`.
5. **Per-tool scope normalization** — access checks must be aware of each tool's namespace semantics (subtree vs exact).
6. **Delete tokens must be principal-bound** — prevent cross-principal reuse.
7. **OAuth binding via `oauth_client_id` column** on principals table — concrete 1:1 mapping for Phase 1.
8. **Shared-namespace deletes must be owner-only in Phase 1** — entries lack principal ownership, so any-writer delete is unsafe even for single entries.

## Defenses accepted by Codex

1. **Mixed enforcement model is valid** — simple tools can post-filter, aggregate tools pre-authorize inputs. Not contradictory.
2. **Meta-test over TOOL_DEFINITIONS** is a useful regression guard (though not sufficient alone).
3. **Phase 1 scope with narrowing** is honest and coherent.

## Unresolved / remaining items

1. **Agent service-token auth flow** must be fully specified: where verification lives (verifyAccessToken vs resolveAccessContext), what AuthInfo.clientId returns for service tokens, and how revocation/expiry is enforced at auth time.
2. **Spec must be updated** (docs/authorization-matrix.md) to match the revised design before implementation — currently internally inconsistent on shared delete, denial payloads, and principals schema.
3. **Namespace canonicalization** — acknowledged but low severity. Raw inputs should be normalized before matching.

## Key stats

- **18 critique points** across 2 rounds
- **0 caught by self-review** (self-review identified 6 issues, but none overlapped with Codex's critiques)
- **4 critical**, 9 major, 5 minor
- **12 changed**, 2 partially changed, 1 acknowledged, 0 deferred, 0 rejected

## Action items

1. Update `docs/authorization-matrix.md` to match revised design (shared delete = owner-only, add oauth_client_id, reconcile denial payloads)
2. Specify agent service-token auth flow explicitly in the plan
3. Update implementation plan with all concessions
4. Implement

## All debate files

- `debate/multi-principal-p1-snapshot.md`
- `debate/multi-principal-p1-claude-draft.md`
- `debate/multi-principal-p1-claude-self-review.md`
- `debate/multi-principal-p1-codex-critique.md`
- `debate/multi-principal-p1-claude-response-1.md`
- `debate/multi-principal-p1-codex-rebuttal-1.md`
- `debate/multi-principal-p1-critique-log.json`
- `debate/multi-principal-p1-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |
