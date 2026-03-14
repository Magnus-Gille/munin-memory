# Debate Summary: Computed Dashboard Architecture

**Date:** 2026-03-12
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** Replacing the manually-maintained workbench with a computed dashboard in Munin Memory

## Outcome

The debate produced a significantly revised plan. 10 of 16 critique points resulted in changes. The most impactful outcomes:

### Concessions accepted by both sides

1. **"Never stale" → "eliminates cache drift"** — the dashboard removes workbench cache staleness but doesn't solve status entry staleness. Honest framing. (CD-C01)

2. **Auto-log dropped entirely** — the weakest part of the original plan. Low-signal prefix snapshots would pollute search and crowd out meaningful logs. Intentional logging stays intentional. (CD-C02)

3. **Hybrid model adopted** — computed dashboard (primary) + curated `meta/workbench-notes` (supplementary, non-authoritative) for freeform obligations and cross-cutting items. Preserves the genuinely useful human-authored layer. (CD-C09, CD-C14)

4. **Tag aliasing/canonicalization required** — `paused` → `maintenance`, `done` → `completed`. Server accepts old vocabulary and maps it, with warnings on normalization. Published mapping table. (CD-C04, CD-C15)

5. **Staged rollout** replaces "no migration" — data cleanup → deploy alongside legacy → update conventions → retire old path. (CD-C08)

6. **Overwrite protection for tracked status writes** — the single most important issue from Round 2. The plan simplifies write protocol by removing "read before write" but doesn't replace it with server-side protection. An `expected_updated_at` parameter on `memory_write` for tracked status entries provides compare-and-swap semantics. (CD-C13 — **critical severity**)

### Defenses accepted by Codex

1. **Soft validation is appropriate for transition** — hard rejection of lifecycle tag violations would break existing workflows. Soft warnings + canonicalization first, enforcement later. (CD-C11)

2. **Scheduled maintenance rejected** — write-path/read-path derivation is better than background jobs in this ephemeral-server architecture. (Alternative E)

3. **Structured JSON dashboard > derived markdown workbench** — a computed structured response is more reliable than trying to auto-generate editable markdown. (Alternative A)

### Unresolved disagreements

1. **"First matching lifecycle tag" for conflicting tags** — Claude says it's deterministic, Codex says deterministic misclassification is still misclassification. Pragmatically: canonicalization + soft validation should make conflicting tags rare enough that this doesn't matter in practice.

2. **Timing of hard enforcement** — Codex wants it sooner, Claude wants it after stabilization. Both positions are reasonable; the difference is risk appetite.

### New issues from Round 2

1. **`meta/workbench-notes` must be explicitly non-authoritative** — otherwise it reintroduces the staleness problem in a smaller box. Scoping: supplementary context only, no lifecycle grouping, no primary dashboard data. (CD-C14)

2. **"Session window" for missing-log detection is undefined** — dropped along with auto-log. Not relevant to revised plan. (CD-C16)

## Action Items

| # | Action | Owner |
|---|--------|-------|
| 1 | Add `expected_updated_at` compare-and-swap to `writeState()` for tracked status writes | Implementation |
| 2 | Add tag canonicalization with published mapping table | Implementation |
| 3 | Build computed dashboard in `memory_orient` with `substr()` summaries | Implementation |
| 4 | Add `meta/workbench-notes` support (non-authoritative curated overlay) | Implementation |
| 5 | Add `maintenance_needed` array to orient response | Implementation |
| 6 | Add lifecycle tag soft validation on tracked status writes | Implementation |
| 7 | Inventory + fix existing lifecycle tags (one-off data cleanup) | Post-deploy |
| 8 | Update tool descriptions and `meta/conventions` | Post-deploy |
| 9 | Retire legacy workbench path after validation | Post-deploy |

## Debate Files

- `debate/computed-dashboard-snapshot.md` — Original plan snapshot
- `debate/computed-dashboard-claude-draft.md` — Claude's position
- `debate/computed-dashboard-claude-self-review.md` — Self-review
- `debate/computed-dashboard-codex-critique.md` — Codex Round 1 critique
- `debate/computed-dashboard-claude-response-1.md` — Claude's response
- `debate/computed-dashboard-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/computed-dashboard-critique-log.json` — Structured critique log
- `debate/computed-dashboard-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |
