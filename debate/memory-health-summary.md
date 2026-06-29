# Debate summary — `memory_health` MCP tool design (issue #156)

- **Date:** 2026-06-29
- **Participants:** Claude (Opus 4.8) vs Reviewer: **codex / gpt-5.5** (xhigh effort)
- **Rounds:** 1 (closed early — near-total concession; residual items are code-verification, not disagreement)
- **Self-review catch rate:** 6/11 (55%)

## Outcome: design materially revised before any code written

Codex produced 4 high + 5 medium findings and reversed the draft's headline call.

### Concessions accepted (all 11 points valid)
1. **Maintenance counts: Option A → Option B.** Do NOT extract `computeMaintenanceItems`
   from the hot `memory_orient` path. Compute read-only counts in `memory_health` instead,
   and control drift with a **parity test** asserting equality vs `memory_orient(detail:"full")`.
   (Snapshot test can't catch latency/access-control/detail-mode regressions on the busiest tool.)
2. **Auth boundary precision:** tool is **owner-only** (`ctx.principalType === "owner"`),
   documented as not implying local-only. Deployed Heimdall (owner-scoped client @127.0.0.1:3030)
   satisfies it; a service/agent principal would get nothing.
3. **Per-section graceful degradation:** total auth gate → `ok`, `partial`, `sections.<name>.ok`
   + sanitized per-section errors. A health tool must not 500 when one sub-query fails.
4. **Embedding metrics:** add **model-relative** counts (`generated_current/stale/null`,
   `reembedding_backlog`) + worker telemetry; no time-based "stuck" without a real claim timestamp.
   (Raw status counts hid the 16 stale-model entries that motivated #156.)
5. **Defense-in-depth:** new aggregate helpers take `ctx`/owner scope (not just handler gate).
6. **Drop `audit_log` access-denied count** (unsupported) → use `cross_zone_blocks` + `redaction_events`.
7. **Bounded SQL aggregates** for retrieval metrics, not O(N) `getInsightsByEntry` iteration.
8. **Denial semantics** match local idiom (mirror `memory_status` non-owner path), not a bespoke error.
9. **Add `schema_version` + `generated_at`**, sections as add-only stable contract.
10. **Sanitize section errors** like consolidation `last_error` (tests/tools.test.ts:6248–6284).

### Defenses accepted by reviewer (unchallenged)
- Single MCP tool (not a `GET /metrics` endpoint).
- Defer daily-snapshot persistence for sparklines.
- Separate tool, not folded into `memory_status`.

### Unresolved disagreements
None of substance. Two items are **code-verification**, not debate: exact representation of
owner-only-vs-local, and whether an `embedding_claimed_at`-type timestamp exists (decides
time-based vs model-identity "stuck").

## Final verdict
Both sides converge: **build Option B**, owner-only + documented, per-section degradation,
model-relative embedding metrics, bounded aggregates, sanitized errors, versioned contract.
Codex's single most important next step: switch off Option A and define the auth boundary
precisely before writing code. Adopted.

## Action items
- [ ] Implement `memory_health` per revised design on `feat/memory-health-metrics` (owner, Claude).
- [ ] Parity test: `memory_health` maintenance counts == `memory_orient(detail:full)`.
- [ ] Verify `embedding_claimed_at` existence → finalize stuck definition.
- [ ] Non-owner test proving zero metadata leakage.

## Files
- memory-health-claude-draft.md
- memory-health-claude-self-review.md
- memory-health-codex-critique.md
- memory-health-claude-response-1.md
- memory-health-critique-log.json
- memory-health-summary.md

## Costs
| Invocation   | Wall-clock time | Model    |
|--------------|-----------------|----------|
| codex R1     | ~3 min          | gpt-5.5  |
