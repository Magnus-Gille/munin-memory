# Munin Memory Phase 3 Engineering Plan

Status: provisional. This phase depends on what Phase 1 and 2 reveal in real use.

This document turns Roadmap Phase 3 into an engineering plan.

Phase 3 covers:

- narrative memory across time
- commitment nudges
- compressed heuristics and recurring-pattern summaries

It does **not** attempt a graph database, a scheduler-first architecture, or hidden
autonomous coaching.

## Goal

Shift Munin from snapshot retrieval toward continuity of judgment.

At the end of Phase 3:

- Munin should be able to describe a project arc, not only return entries
- dropped commitments should be visible as a first-class problem
- repeated decision patterns should be compressible into reviewable heuristics

## Current Touchpoints

### Historical and narrative sources

- `memory_log`
- `memory_update_status`
- `memory_history`
- tracked status assessments

Relevant current behavior:

- logs already preserve chronological decisions and milestones
- tracked statuses already encode current phase and lifecycle
- audit history already gives a durable change feed

### Existing derived signals

- `memory_attention`
- `memory_insights`

Relevant current behavior:

- attention already surfaces stale and blocked work
- insights already surface retrieval follow-through patterns
- there is no unified narrative layer above those signals yet

## Design Decisions

### 1. Derive from existing primitives first

Phase 3 should derive narrative signals from:

- state entries
- log entries
- audit history
- retrieval insights

Do **not** start with a new foundational store.

### 2. Make every narrative claim attributable

Every derived narrative signal should point back to source material:

- source entry IDs
- source audit IDs
- source namespaces

Rationale: "This project is stuck" is only useful if the caller can inspect why the
system believes that.

### 3. Add a lightweight commitment model

Commitment nudges need a more explicit representation than generic prose search.

This phase should introduce a lightweight derived commitment layer for:

- tracked `next_steps`
- explicit dated commitments in logs or state
- capture suggestions confirmed through Phase 2 flows

### 4. Prefer on-demand derivation, optional cached summaries later

Narrative outputs should be computable on demand first.

If caching becomes necessary, store derived summaries in explicit namespaces such as:

- `signals/*`
- `digests/*`

Do not start with hidden background materialization.

### 5. Keep wisdom summaries reviewable and revisable

Compressed heuristics should never become invisible policy. They should be surfaced as
derived summaries that can be inspected, corrected, or ignored.

## Workstream A: `memory_narrative`

### Tool Surface

Add a new MCP tool:

- `memory_narrative`

Proposed inputs:

- `namespace: string`
- `since?: string`
- `limit?: number`
- `include_sources?: boolean`

Proposed output shape:

- `summary`
- `signals[]`
- `timeline[]`
- `sources[]`

Signals to derive:

- time in current phase
- blocker age
- recent reopen/reversal patterns
- decision churn
- long gaps without meaningful updates

### Signal Computation

The first version should use:

- current tracked status
- recent status changes from audit history
- relevant logs in the namespace

It should avoid requiring any new foundational table.

### Code Touchpoints

- `src/db.ts`
  - audit history helpers
- `src/tools.ts`
  - new tool definition
  - narrative signal derivation helpers

### Test Plan

Add tests that verify:

- repeated status reversals are surfaced
- old blockers are surfaced
- stale but maintenance-tagged projects are not mislabeled as "stuck"
- the response includes source references when requested

Primary file:

- `tests/tools.test.ts`

## Workstream B: Commitment Registry and Nudges

### Data Model

Add a lightweight derived table for commitments.

Proposed table:

- `commitments`

Proposed fields:

- `id`
- `namespace`
- `source_entry_id`
- `source_type`
- `text`
- `due_at`
- `status` (`open`, `done`, `cancelled`)
- `confidence`
- `created_at`
- `updated_at`
- `resolved_at`

This table should be populated only from explicit, attributable sources.

### Sources

Initial commitment sources:

- tracked `next_steps`
- explicit dated commitments in state or logs
- confirmed outputs from Phase 2 `memory_extract`

### Tool Surface

Add either:

- a dedicated `memory_commitments` tool, or
- a stronger commitment mode inside `memory_attention`

Recommended first move:

- add `memory_commitments`

Proposed outputs:

- `open[]`
- `at_risk[]`
- `overdue[]`
- `completed_recently[]`

### Constraint

Do not try to infer emotional obligation or implied promises. This phase should stick to
explicit commitments and attributable next steps.

### Code Touchpoints

- `src/migrations.ts`
- `src/db.ts`
- `src/tools.ts`

### Test Plan

Add tests that verify:

- tracked `next_steps` become commitments when appropriate
- overdue commitments surface correctly
- completing or clearing a tracked next step resolves the matching commitment
- callers can inspect source attribution for each commitment

Primary files:

- `tests/migrations.test.ts`
- `tests/tools.test.ts`

## Workstream C: `memory_patterns` / Compressed Wisdom

### Tool Surface

Add a new MCP tool:

- `memory_patterns`

Proposed inputs:

- `namespace?: string`
- `topic?: string`
- `since?: string`
- `limit?: number`

Proposed outputs:

- `patterns[]`
- `heuristics[]`
- `supporting_sources[]`

### Pattern Sources

Pattern derivation should use:

- decision logs
- tracked status histories
- retrieval insights
- commitment outcomes

Examples of intended outputs:

- "Evaluation work repeatedly references ARM64 and single-maintainer risk."
- "Projects reopen when next steps are vague and undated."

### Storage Choice

Do not create a large new pattern store in the first iteration.

First pass:

- derive on demand
- optionally cache reviewable summaries in `digests/*` if repeated computation proves
  useful

### Test Plan

Add tests that verify:

- repeated signals across multiple source entries become a surfaced pattern
- patterns cite source entries
- one-off events do not get overstated as heuristics

Primary file:

- `tests/tools.test.ts`

## Recommended Implementation Order

Build Phase 3 in this order:

1. `memory_narrative`
2. commitment registry and `memory_commitments`
3. `memory_patterns`

That order moves from explainable project arcs to explicit obligations and only then to
compressed heuristics.

## Dependencies and Gates

Phase 3 should be revisited after:

- Phase 2 `memory_extract` design is implemented
- at least some real use exists for `memory_resume`
- the project has accumulated more real multi-session logs and tracked statuses

This phase is the first one where implementation learnings should materially change the
plan before coding begins.

## Done Criteria

Phase 3 is complete when:

- Munin can explain project arcs with source attribution
- explicit commitments can be surfaced and triaged as first-class objects
- recurring decision patterns can be summarized without becoming opaque policy
