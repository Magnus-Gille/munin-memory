# Debate Summary: Session Orientation & Workbench

**Date:** 2026-02-25
**Participants:** Claude (Opus 4.6), Codex (GPT-5.3)
**Rounds:** 2
**Topic:** How should Claude orient itself at session start? Convention-only workbench vs server-side tools.

## Concessions accepted by both sides

1. **Workbench is a rebuildable cache, not authoritative.** The project list and activity status must be verifiable against actual namespace data. Human-curated annotations (descriptions, blocking reasons) add value but are supplementary. (C01)

2. **`listNamespaces()` must include timestamps.** The current API returns only counts. Without `last_activity_at` per namespace, staleness detection is impossible. This is a prerequisite, not a "future optional." (C02)

3. **Handshake must be read-only.** Staleness detection produces observations ("project X hasn't been touched in 9 days"), not automatic workbench mutations. Write-on-read is race-prone and surprising. (C04)

4. **Workbench needs cross-validation.** It should never be trusted in isolation. Claude cross-checks against `memory_list()` timestamps, treating it as a "best-effort cache" with a visible `Last updated` date. (C05)

5. **Tier 3 triggers must be data-derived.** Claude has no persistent cross-session state. The conventions version comparison (workbench field vs `meta/conventions` `updated_at`) is the correct deterministic trigger. (C07)

6. **Simplify to two tiers.** Drop Tier 1 — the savings of one read aren't worth the classification complexity. Default is Tier 2 (workbench + last-session). Tier 3 adds conventions re-read + full namespace survey. (C07)

7. **`last-session` downgraded to opportunistic.** Not mandatory, not in default Tier 2 expectations. Written when a natural closing moment exists, skipped otherwise. Server-derived session metadata is the correct long-term solution. (C09, Codex R2)

## Defenses accepted by Codex

1. **`MAX(updated_at)` is sufficient for MVP staleness.** Codex pushed for `last_delete_at` from audit_log, but Claude's argument that delete activity doesn't indicate project liveness is reasonable for a single-user system. (C03 — partially, see unresolved)

2. **Convention-only Phase 1 is zero-risk to try.** The debate outcomes improve the design but don't block an initial rollout with the workbench entry. (C08)

3. **Arbitrary thresholds are acceptable for MVP.** 14 days stale, 300-word workbench — ship and adjust. (C11)

## Unresolved disagreements

1. **C03: Activity tracking depth.** Codex wants `last_delete_at` + `activity_source` for explainable staleness decisions. Claude argues single `last_activity_at` covers >95% of cases. **Resolution: implement `last_activity_at` from `MAX(updated_at)` for now. If staleness decisions prove confusing in practice, add `activity_source` later. Don't add `last_delete_at` — the audit_log JOIN is expensive and the use case is marginal.**

2. **C06: Optimistic concurrency for `memory_write`.** Codex argues CAS is a small change; Claude argues it's disproportionate for single-user. **Resolution: defer to v2 multi-agent support. The single-user race window (two tabs updating workbench simultaneously) is real but extremely narrow. Document the risk; don't build CAS infrastructure for one convention entry.**

3. **C08: Framing as replacement vs interim.** Codex argues the convention approach should be explicitly framed as an interim hybrid, not a replacement of session lifecycle tools. **Resolution: accept Codex's framing. The expansion plan's session tools (Feature 3) are deferred, not cancelled. The convention + `memory_list()` enhancement is the interim solution.**

4. **C10: Structured vs markdown workbench format.** Codex insists on typed JSON fields; Claude proposes strict markdown template. **Resolution: use strict markdown template for Phase 1 (consistent headers, list format, no freeform text). If cross-agent parsing failures emerge, migrate to structured JSON in Phase 2. The current memory system is markdown-first and introducing JSON entries is a precedent change that should be evaluated separately.**

## New issues from Round 2

1. **Strict template dropped `Conventions version`.** The template in Claude's response omitted the conventions version field, which breaks the Tier 3 trigger. **Fix: add `Conventions version: YYYY-MM-DD` to the template header.**

2. **Ad-hoc 7-day workbench staleness trigger.** Claude introduced a ">7 days" full-handshake trigger while deferring threshold policy in C11. **Fix: remove the 7-day trigger. Tier 3 is triggered only by conventions version mismatch, not by workbench age. Workbench age is an observation, not a tier escalation.**

## Action items

| # | Action | Severity | Owner |
|---|--------|----------|-------|
| 1 | Extend `listNamespaces()` SQL to include `MAX(updated_at) as last_activity_at` | critical | Server code |
| 2 | Update `NamespaceCount` interface and `memory_list` handler to return `last_activity_at` | critical | Server code |
| 3 | Create `meta/workbench` entry with strict template (includes `Conventions version`) | major | Convention |
| 4 | Make handshake read-only — staleness observations only, no auto-mutation | major | Convention |
| 5 | Define two-tier handshake: Normal (workbench) and Full (+ conventions + list) | major | Convention |
| 6 | Downgrade `last-session` to opportunistic (not in default handshake) | moderate | Convention |
| 7 | Frame session tools (Feature 3) as deferred, not cancelled | moderate | Documentation |
| 8 | Update conventions to document workbench maintenance rules and cross-validation | moderate | Convention |
| 9 | Add tests for `last_activity_at` in `listNamespaces()` | minor | Server code |

## Implementation plan (post-debate)

### Phase 1: Server change (small)
- Add `MAX(updated_at) as last_activity_at` to `listNamespaces()` SQL
- Update `NamespaceCount` interface
- Update `memory_list` handler to include `last_activity_at` in response
- Add tests

### Phase 2: Convention entries
- Create `meta/workbench` with strict template
- Update `meta/conventions` with workbench rules, two-tier handshake, cross-validation
- Optionally create `meta/last-session` if appropriate

### Phase 3: Deferred (v2)
- Server-side session telemetry (heartbeat, disconnect detection)
- Optimistic concurrency on `memory_write`
- Structured JSON workbench format (if markdown parsing fails in practice)

## All debate files

- `debate/workbench-claude-draft.md`
- `debate/workbench-claude-self-review.md`
- `debate/workbench-review-brief.md`
- `debate/workbench-codex-critique.md`
- `debate/workbench-claude-response-1.md`
- `debate/workbench-codex-rebuttal-1.md`
- `debate/workbench-summary.md`
- `debate/workbench-critique-log.json`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.3-codex |
| Codex R2   | ~1m             | gpt-5.3-codex |
