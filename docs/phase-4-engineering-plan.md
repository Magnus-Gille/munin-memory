# Munin Memory Phase 4 Engineering Plan

Status: provisional. This phase depends on real small-trust multi-user use and on the
current access-control model proving stable in practice.

This document turns Roadmap Phase 4 into an engineering plan.

Phase 4 covers:

- entry ownership and shared-namespace correctness
- operational onboarding for new principals
- explicit cross-agent handoff and continuity

It does **not** broaden Munin into a general team platform.

## Goal

Make Munin practical for a household or a small trusted group of agents without losing
clarity, invisible denial, or owner control.

At the end of Phase 4:

- shared namespaces should behave predictably
- deletion semantics should match the documented model
- onboarding another person or agent should feel supported
- multiple agents should be able to hand off work with less silent context loss

## Current Touchpoints

### Access control

- `src/access.ts`
- `docs/authorization-matrix.md`
- access-enforcement tests

Relevant current behavior:

- namespace-scoped access control exists
- invisible denial is already part of the model
- owner bypass is already explicit

### Provenance and mutation

- `src/db.ts`
  - `writeState`
  - `appendLog`
  - `executeDelete`
- `src/tools.ts`
  - `memory_delete`
  - response provenance builders

Relevant current behavior:

- mutation provenance currently relies on `agent_id`
- `agent_id` tracks the most recent actor, not immutable ownership
- shared-namespace deletion is still mostly managed through coarse owner-only rules

### Operational onboarding

- `src/admin-cli.ts`
- current Pi onboarding notes in `STATUS.md`

Relevant current behavior:

- principal creation and token rotation already exist
- OAuth mapping exists
- the normal onboarding path is still operationally rough

## Design Decisions

### 1. Separate immutable ownership from last-writer provenance

Phase 4 should introduce an explicit immutable owner field for entries.

Recommended column:

- `owner_principal_id`

`agent_id` should remain the mutable "last actor" field for provenance.

Rationale: ownership and last writer are different concepts. Shared deletion and
handoff logic need both.

### 2. Make namespace-wide delete truly ownership-aware

The documented rule is that a namespace delete should affect only entries the caller
owns in mixed-ownership namespaces. Phase 4 should implement that behavior directly.

This should replace ad hoc owner-only special cases where appropriate.

### 3. Keep owner visibility, preserve invisible denial for everyone else

Nothing in Phase 4 should weaken:

- owner's full visibility
- fail-closed access resolution
- invisible denial for unauthorized principals

### 4. Add explicit handoff primitives

Cross-agent continuity should not depend on "the next agent happens to search well."

Phase 4 should add an explicit handoff surface rather than assuming shared memory alone
solves handoff quality.

### 5. Keep onboarding CLI-first

The operational target remains a technically comfortable self-hoster. Improve the CLI
and docs first, not a web admin track.

## Workstream A: Ownership Model

### Schema Change

Add a migration to introduce immutable ownership fields.

Recommended additions:

- `owner_principal_id` on `entries`
- optional index on `(namespace, owner_principal_id)`

Backfill strategy:

- backfill existing entries from current `agent_id`

### Write Semantics

On create:

- set `owner_principal_id = ctx.principalId`
- set `agent_id = ctx.principalId`

On update:

- preserve `owner_principal_id`
- update `agent_id` to the acting principal

On log append:

- set both owner and actor to the writing principal in the first version

### Response Semantics

Consider extending provenance for read/query/list outputs to include:

- `principal_id` as last actor
- optional `owner_principal_id` where appropriate

This should only be exposed where the caller already has read access to the entry.

### Code Touchpoints

- `src/migrations.ts`
- `src/db.ts`
- `src/tools.ts`
- response types in `src/types.ts`

### Test Plan

Add tests that verify:

- existing entries are backfilled with ownership
- updates preserve owner and change actor
- logs record ownership and actor consistently

Primary files:

- `tests/migrations.test.ts`
- `tests/access-enforcement.test.ts`

## Workstream B: Ownership-Aware Delete Semantics

### Behavior

Update delete preview and execution so that:

- non-owner namespace-wide delete only previews caller-owned entries
- execution deletes only caller-owned entries in mixed-ownership namespaces
- owner namespace-wide delete remains global

This should apply to shared namespaces and any other mixed-ownership namespace model
that emerges.

### Code Touchpoints

- `src/db.ts`
  - `previewDelete`
  - `executeDelete`
- `src/tools.ts`
  - `memory_delete`

### Test Plan

Add tests that verify:

- mixed-ownership shared namespaces preview correctly per principal
- non-owner delete only removes owned entries
- owner delete still removes all entries
- invisible denial remains intact for unauthorized callers

Primary file:

- `tests/access-enforcement.test.ts`

## Workstream C: Principal Onboarding Ergonomics

### Scope

Improve the normal path for onboarding a new principal without changing the product
into a hosted admin experience.

Potential additions:

- clearer `munin-admin` output for created principals
- config snippets for bearer, desktop, and OAuth usage
- docs for standard onboarding flows

If code changes are needed, keep them narrow and CLI-centric.

### Suggested CLI Enhancements

Candidate additions:

- `munin-admin principals bootstrap <id>` to print the next-step configuration bundle
- `munin-admin principals show --config` style output for MCP client setup

These are optional, but they are the right shape if ergonomics work is needed.

### Code Touchpoints

- `src/admin-cli.ts`
- onboarding docs

## Workstream D: `memory_handoff`

### Tool Surface

Add a new MCP tool:

- `memory_handoff`

Proposed inputs:

- `namespace: string`
- `since?: string`
- `limit?: number`

Proposed outputs:

- `current_state`
- `recent_decisions`
- `open_loops`
- `recent_actors`
- `recommended_next_actions`

### Data Sources

Use:

- tracked status or state entry in the target namespace
- recent logs
- audit history
- ownership/actor provenance
- commitment signals if Phase 3 is available

### Constraint

This tool should improve continuity across agents without adding private coordination
channels or hidden state. Handoffs should remain inspectable and source-backed.

### Code Touchpoints

- `src/db.ts`
  - audit history and read helpers
- `src/tools.ts`
  - new tool definition and handoff pack assembly

### Test Plan

Add tests that verify:

- handoff returns current state plus recent decisions
- recent actor information is surfaced correctly
- inaccessible namespaces still produce invisible denial

Primary file:

- `tests/access-enforcement.test.ts`
- `tests/tools.test.ts`

## Recommended Implementation Order

Build Phase 4 in this order:

1. immutable ownership model
2. ownership-aware delete semantics
3. onboarding ergonomics
4. `memory_handoff`

That order fixes the data model first, then the behavior that depends on it, then the
operator and handoff surfaces.

## Dependencies and Gates

Before implementing Phase 4, verify:

- Sara or an equivalent second principal has been onboarded
- at least one non-owner shared namespace exists in real use
- current access-control behavior has been exercised beyond tests

Without real use, Phase 4 risks solving imagined problems too specifically.

## Done Criteria

Phase 4 is complete when:

- immutable ownership exists and is enforced in delete behavior
- onboarding one more principal feels documented and repeatable
- agents can perform explicit, source-backed handoffs through a first-class tool
