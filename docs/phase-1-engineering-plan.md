# Munin Memory Phase 1 Engineering Plan

This document turns Phase 1 of the roadmap into a concrete implementation plan.

Phase 1 covers:

- recency-aware retrieval
- temporal validity for state entries
- expiring/expired signals in orientation and attention flows
- documentation cleanup around the now-current product shape

It does **not** try to solve proactive capture, narrative memory, or graph modeling.

## Goal

Improve the quality of what Munin surfaces by default.

At the end of Phase 1:

- stale entries should be less likely to outrank current ones
- temporary state should be able to expire without manual cleanup
- tracked work should surface expiry risk instead of silently drifting
- the product docs should match the implemented product

## Current Touchpoints

The current implementation already gives Phase 1 a clear set of boundaries.

### Storage and migrations

- `src/migrations.ts`
- `src/db.ts`

Relevant current behavior:

- all entries live in the `entries` table
- state and log share the same table and differ by `entry_type`
- `updated_at` already exists and is available everywhere
- there is no validity window on entries today

### Query and ranking

- `src/db.ts`
  - `queryEntriesLexicalScored`
  - `queryEntriesSemanticScored`
  - `queryEntriesHybridScored`
  - `queryEntriesByFilter`
- `src/tools.ts`
  - `memory_query`
  - `rerankQueryResults`
  - `getQueryHeuristicScore`

Relevant current behavior:

- candidate generation happens in `db.ts`
- final result ordering is already adjusted in `rerankQueryResults`
- broad orientation and triage queries already receive heuristic boosts and injected
  entries

### Orientation and attention

- `src/tools.ts`
  - `assessTrackedStatus`
  - `getTrackedStatusAssessments`
  - `memory_orient`
  - `memory_attention`

Relevant current behavior:

- tracked statuses already produce maintenance items
- current maintenance signals are about staleness, missing status, and lifecycle issues
- there is no notion of expiring or expired context today

### API contracts

- `src/types.ts`
- tool schemas in `src/tools.ts`

Relevant current behavior:

- `memory_write` has no validity metadata
- `memory_query` supports `since` and `until`, but not expiration-aware behavior
- `memory_read`/`memory_get` can mark entries as stale, but not expired

## Design Decisions

These are the implementation choices for Phase 1.

### 1. Use `valid_until`, not full temporal history

Phase 1 adds **soft expiry**, not historical truth reconstruction.

- add `valid_until` to state entries
- do **not** add `valid_from` in this phase
- do **not** attempt "what was true on date X?" queries yet

Rationale: this solves the operational problem of stale temporary context without
turning the storage model into a temporal knowledge graph.

### 2. Keep direct reads precise, keep searches conservative

Expired state entries should be:

- hidden from default search and filter browsing
- still retrievable by direct read/get
- explicitly marked as expired when returned

Rationale: broad retrieval should bias toward current context, but a precise
namespace/key or ID lookup should not silently hide data.

### 3. Apply recency in the final reranker first

Recency-aware ordering should be implemented in the **tool-layer reranker** before
rewriting the lower-level SQL ranking model.

- use existing candidate generation in `db.ts`
- add recency-aware tie-breaking or conservative reranking in `rerankQueryResults`
- keep the first version intentionally conservative

Rationale: this keeps behavior consistent across lexical, semantic, and hybrid modes,
and avoids destabilizing the current search stack too early.

### 4. Do not let expiring tracked statuses disappear from the dashboard

Tracked status entries should continue to appear in orientation even if they are
expired, so that expiry becomes visible as a maintenance issue.

Rationale: hiding a tracked project because its status expired would be operationally
worse than surfacing it with a warning.

### 5. Do not extend `memory_update_status` with validity metadata yet

Phase 1 should add `valid_until` to `memory_write`, but **not** to
`memory_update_status`.

Rationale: tracked status entries represent current project truth and lifecycle, not
normally temporary context. Expiring tracked statuses is an edge case and should remain
possible only via explicit `memory_write` for now.

## Workstream A: Recency-Aware Retrieval

### Contract Change

Add an optional `search_recency_weight` parameter to `memory_query`.

Proposed semantics:

- type: number
- range: `0` to `1`
- default: conservative non-zero default, for example `0.2`
- `0` disables recency influence

This parameter only matters when a `query` string is present. It has no effect in
filter-only mode.

### Response Metadata

Extend `memory_query` response metadata to expose recency behavior.

Proposed additions under `retrieval`:

- `recency_applied: boolean`
- `search_recency_weight: number`
- `expired_filtered_count: number`

Keep the existing `reranked`, `relaxed_lexical`, and `fallback_reason` fields.

### Implementation Shape

Update `rerankQueryResults` in `src/tools.ts` so it incorporates:

- current heuristic score
- current candidate order
- a freshness score derived from `updated_at`

Recommended first-pass formula:

- `freshness = exp(-ln(2) * days_since_updated / half_life_days)`
- use `half_life_days = 30` as the initial default
- apply recency conservatively as a secondary ranking influence, not as a wholesale
  replacement of lexical/semantic relevance

Recommended sort order for the first implementation:

1. heuristic score descending
2. freshness score descending
3. original candidate order ascending

That keeps the current intent-based ranking model intact and only improves freshness
within those buckets.

### Code Touchpoints

- `src/types.ts`
  - `QueryParams`
  - `QueryResponse`
  - `QueryResult["match"]` if freshness explainability is added
- `src/tools.ts`
  - `memory_query`
  - `rerankQueryResults`
  - `getQueryExplainReasons`

### Test Plan

Add tool tests that verify:

- a fresher state entry outranks an older equivalent entry when heuristics are equal
- `search_recency_weight: 0` preserves the previous ordering
- a strong tracked-status heuristic still beats generic fresh noise
- query responses include the new retrieval metadata

Primary file:

- `tests/tools.test.ts`

## Workstream B: Temporal Validity for State Entries

### Schema Change

Add a new migration in `src/migrations.ts`.

Proposed migration:

- version `8`
- `ALTER TABLE entries ADD COLUMN valid_until TEXT`
- add an index for state-entry expiry lookups

Recommended index:

- `idx_entries_state_valid_until` on `valid_until`
- partial index where `entry_type = 'state' AND valid_until IS NOT NULL`

### Data Model

Extend `Entry` and parsed response shapes to include:

- `valid_until?: string | null`
- `expired?: boolean` on read/get style responses where relevant

Do not add expiry metadata to log entries beyond `null`.

### Write Path

Extend `memory_write` to accept:

- `valid_until?: string`

Validation rules:

- ISO 8601 timestamp required
- only valid for state entries
- omit or `null` means "does not expire"

Implementation touchpoints:

- `src/types.ts`
  - `WriteParams`
  - read/get/list/query response shapes as needed
- `src/tools.ts`
  - `memory_write` schema
  - `memory_read`
  - `memory_read_batch`
  - `memory_get`
- `src/db.ts`
  - `writeState`
  - `readState`
  - `getById`

### Query Behavior

Default `memory_query` behavior:

- exclude expired state entries
- continue including log entries
- continue including non-expiring state entries

Add an opt-in query parameter:

- `include_expired?: boolean`

Recommended behavior:

- `include_expired: false` or omitted:
  - expired states are filtered out
- `include_expired: true`:
  - expired states are included and marked in results

This filter must be applied consistently in:

- `queryEntriesLexicalScored`
- `queryEntriesSemanticScored`
- `queryEntriesHybridScored`
- `queryEntriesByFilter`

### Direct Read Behavior

`memory_read`, `memory_read_batch`, and `memory_get` should:

- still return expired entries
- annotate them with `expired: true`
- include `valid_until` in the response

Rationale: precise lookup should not hide state.

### Deliberate Deferral

Do **not** extend `patchState` with metadata patching in Phase 1.

If a caller needs to change `valid_until`, the supported path in this phase is a normal
`memory_write` overwrite.

This keeps the patch contract simple while validity behavior settles.

### Test Plan

Add tests that verify:

- migration adds the new column and index cleanly
- `memory_write` accepts valid ISO timestamps and rejects invalid ones
- expired state entries are excluded from default query results
- `include_expired: true` returns expired entries
- direct reads return expired entries with `expired: true`
- non-expired entries remain unaffected

Primary files:

- `tests/migrations.test.ts`
- `tests/tools.test.ts`

## Workstream C: Expiry Signals in Orientation and Attention

### New Maintenance Signals

Add two new maintenance issue types:

- `expiring_soon`
- `expired`

Recommended threshold:

- `EXPIRES_SOON_DAYS = 7`

### Behavior

For tracked status entries only:

- if `valid_until` is within 7 days, surface `expiring_soon`
- if `valid_until` is in the past, surface `expired`
- continue to show the tracked namespace in the dashboard instead of hiding it

Severity recommendation:

- `expired` = high
- `expiring_soon` = medium

### Tool Surface

Update:

- `memory_orient`
  - include these items in `maintenance_needed`
- `memory_attention`
  - include these items in deterministic triage output

Optional parameter addition:

- `include_expiring?: boolean` on `memory_attention`, default `true`

This should be treated similarly to existing stale/upcoming-event toggles.

### Code Touchpoints

- `src/types.ts`
  - `MaintenanceItem`
  - `AttentionItem`
  - `AttentionParams`
- `src/tools.ts`
  - `assessTrackedStatus`
  - `getAttentionSeverity`
  - `buildAttentionItem`
  - `memory_attention`
  - `memory_orient`

### Test Plan

Add tests that verify:

- expiring tracked statuses appear in `memory_orient`
- expired tracked statuses appear in `memory_orient`
- `memory_attention` surfaces the same issues in the correct severity band
- recently written, non-expiring statuses are unaffected

Primary file:

- `tests/tools.test.ts`

## Workstream D: Documentation Cleanup

The product docs should stop describing already-completed work as missing.

Update:

- `docs/competitive-analysis.md`

Required cleanup:

- remove or amend claims that the admin CLI is missing
- move already-shipped capabilities from "missing" to "current baseline" where
  appropriate
- keep the analysis strategic, but make it factually aligned with the current repo

## Recommended Implementation Order

Build Phase 1 in this order:

1. migration + data model plumbing for `valid_until`
2. write/read/get support for validity metadata
3. default expired-entry filtering in query/filter paths
4. recency-aware reranking in `memory_query`
5. expiring/expired maintenance signals in orient and attention
6. docs cleanup

This order keeps the data model stable before changing retrieval behavior.

## Rollout Notes

### Backward compatibility

This phase should remain backward-compatible for existing clients:

- new parameters are optional
- new response fields are additive
- default behavior becomes more conservative, but not structurally incompatible

### Risk areas

The main implementation risks are:

- over-weighting freshness and hurting exact-match relevance
- silently hiding useful temporary state due to expiry filtering
- making tracked projects disappear because of expired status entries

The plan above is designed to avoid those risks.

## Done Criteria

Phase 1 is complete when:

- the schema supports expiring state entries
- default retrieval suppresses expired state and improves freshness ordering
- direct reads can still retrieve expired entries explicitly
- orient and attention surface expiring and expired tracked work
- the competitive-analysis doc no longer describes already-built features as missing
