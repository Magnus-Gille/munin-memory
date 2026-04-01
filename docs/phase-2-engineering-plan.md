# Munin Memory Phase 2 Engineering Plan

Status: provisional, but concrete enough to guide implementation after Phase 1.

This document turns Roadmap Phase 2 into an engineering plan.

Phase 2 covers:

- suggestion-based capture from conversation text
- targeted resume/context loading
- session-start context packs that feel prepared rather than reconstructed

It does **not** introduce server-side LLM dependencies or automatic writes.

## Goal

Make it easier for an assistant to start in the right place and easier to capture
durable memory from messy conversations.

At the end of Phase 2:

- session start should require less manual steering
- the system should be able to assemble a compact, relevant context pack from a user
  opener or project hint
- memory capture should be lower-friction without becoming autonomous or opaque

## Current Touchpoints

Phase 2 should build on the existing surfaces, not replace them.

### Orientation and retrieval

- `src/tools.ts`
  - `memory_orient`
  - `memory_query`
  - `memory_attention`
  - `memory_read_batch`
- `src/db.ts`
  - retrieval analytics and history helpers

Relevant current behavior:

- `memory_orient` already returns dashboard, maintenance items, and references
- `memory_query` already has heuristics for broad orientation and triage questions
- the system already computes tracked-status assessments and can inject canonical context

### Session continuity signals

- `src/index.ts`
  - session header handling and derived request session IDs
- `src/db.ts`
  - retrieval events, outcomes, and sessions

Relevant current behavior:

- retrieval analytics already correlate queries and outcomes inside a session
- the server can already derive a stable session identity when clients omit an MCP
  session header

### Capture primitives

- `src/tools.ts`
  - `memory_write`
  - `memory_log`
  - `memory_update_status`

Relevant current behavior:

- the write primitives already exist and are structurally sound
- what is missing is a low-friction capture layer above them

## Design Decisions

### 1. Add a dedicated `memory_resume` tool

Do **not** overload `memory_orient` with targeted resume behavior.

`memory_orient` should remain the stable, broad handshake tool. Phase 2 should add a
new `memory_resume` tool for opener-aware, task-aware context loading.

Rationale: broad orientation and targeted resumption are related but different jobs.
Keeping them separate protects the existing handshake contract.

### 2. Keep `memory_extract` suggestion-only and deterministic first

The first version of `memory_extract` should:

- accept raw transcript or notes
- use deterministic heuristics plus existing Munin context
- return proposed writes and logs
- never commit anything automatically

It should **not** depend on:

- an external API
- server-side LLM inference
- opaque auto-writing behavior

Rationale: Phase 2 should reduce friction without violating sovereignty or creating a
silent-write system that is hard to trust.

### 3. Make surfaced context explainable

Every resume/context-pack item should answer:

- what was surfaced
- why it was surfaced
- what the assistant should probably do next

Rationale: context packs are only useful if the caller can quickly judge relevance.

### 4. Prefer on-demand assembly over background jobs

Phase 2 should assemble context packs on demand from:

- tracked status entries
- recent relevant logs
- recent audit/history entries
- retrieval insights where useful

Do not introduce a scheduler or daemonized summarization layer in this phase.

### 5. Keep tool names and outputs compact

The client pressure here is token budget, not completeness. Phase 2 tools should return
compact packets built for immediate use inside an assistant loop.

## Workstream A: `memory_resume`

### Tool Surface

Add a new MCP tool:

- `memory_resume`

Proposed inputs:

- `opener?: string`
- `namespace?: string`
- `project?: string`
- `limit?: number`
- `include_history?: boolean`
- `include_attention?: boolean`

Proposed output shape:

- `summary`
- `items[]`
- `open_loops[]`
- `suggested_reads[]`
- `why_this_set`

Each `items[]` entry should include:

- namespace
- key or entry ID
- preview
- category
- reason
- suggested action

### Selection Logic

`memory_resume` should assemble a pack from:

- tracked statuses in active or blocked lifecycles
- recent decision logs in the relevant namespace
- recent maintenance/attention items
- reference index entries where appropriate
- recent audit history for the target namespace when `include_history` is enabled

If `opener` is present, it should bias ranking using:

- exact namespace matches
- project-name matches
- status/decision heuristics
- any Phase 1 recency-aware retrieval improvements already in place

### Code Touchpoints

- `src/types.ts`
  - new `ResumeParams` and `ResumeResponse`
- `src/tools.ts`
  - new tool definition
  - new context-pack assembly helpers
- `src/db.ts`
  - existing history and insight queries should be reused, not replaced

### Test Plan

Add tests that verify:

- project-scoped resume prioritizes the current status for that project
- opener-driven resume pulls in likely-relevant status and decision context
- blocked or attention-worthy items appear ahead of generic historical noise
- outputs remain compact and ordered deterministically

Primary file:

- `tests/tools.test.ts`

## Workstream B: `memory_extract`

### Tool Surface

Add a new MCP tool:

- `memory_extract`

Proposed inputs:

- `conversation_text: string`
- `namespace_hint?: string`
- `project_hint?: string`
- `max_suggestions?: number`

Proposed output shape:

- `suggestions[]`
- `candidate_namespaces[]`
- `related_entries[]`
- `capture_warnings[]`

Each suggestion should be one of:

- proposed `memory_write`
- proposed `memory_log`
- proposed `memory_update_status`

Each suggestion should include:

- action type
- target namespace
- target key if relevant
- proposed content
- rationale
- confidence

### First-Pass Extraction Strategy

The first version should be heuristic and explicit-source driven.

Capture targets to support:

- explicit decisions
- explicit next steps and action items
- dated commitments
- project status changes
- clear preference statements
- people/profile updates

Signals to use:

- transcript markers such as "decided", "next step", "by Friday", "remember that"
- bullet lists and TODO-like structures
- namespace/project hints from the caller
- existing relevant entries in the hinted namespace

The first version should ignore fuzzy "maybe this matters" inference.

### Context Reuse

Before suggesting writes, `memory_extract` should fetch a small amount of existing
context so it can avoid obvious duplication:

- current project status
- recent decision logs
- recent entries in the hinted namespace

### Design Constraint

`memory_extract` should not attempt to be mem0-style automatic extraction. It is a
reviewable capture planner, not an autonomous memory agent.

### Code Touchpoints

- `src/types.ts`
  - new extract request/response types
- `src/tools.ts`
  - new tool definition
  - extraction heuristics
  - lightweight related-context lookup helpers

### Test Plan

Add tests that verify:

- explicit decisions become proposed log entries
- explicit next steps become proposed status updates or state writes
- a namespace hint meaningfully constrains suggestions
- the tool does not auto-write anything

Primary file:

- `tests/tools.test.ts`

## Workstream C: Shared Context-Pack Scoring

Phase 2 needs a reusable scoring layer rather than duplicating selection logic inside
both `memory_query` and `memory_resume`.

### Scope

Add shared helpers for:

- weighting tracked status higher than generic notes
- preferring recent decisions over old logs
- preferring unresolved blockers and next steps over historical chatter
- explaining why an item was selected

### Inputs

The scoring layer should be able to use:

- lifecycle and tracked-status assessments
- Phase 1 recency signals
- audit/history recency
- retrieval insights where they help break ties

### Constraint

This should remain a tool-layer scoring system. Do not push this into a new generalized
query planner in `db.ts` yet.

## Workstream D: Handshake and Docs Updates

Phase 2 changes the operating model and therefore needs explicit documentation changes.

Update:

- `docs/roadmap.md`
- `docs/usage-model.md` if the new resume/capture split changes the conceptual model
- tool descriptions in `src/tools.ts`

Required doc changes:

- make `memory_orient` the broad handshake
- make `memory_resume` the targeted continuation tool
- describe `memory_extract` as suggestion-only

## Recommended Implementation Order

Build Phase 2 in this order:

1. shared context-pack scoring helpers
2. `memory_resume`
3. `memory_extract`
4. doc and tool-description updates

That order improves session start first, then lowers capture friction.

## Dependencies and Gates

Phase 2 should assume Phase 1 is complete, especially:

- recency-aware retrieval
- explicit expiry handling
- stabilized maintenance/attention semantics

If Phase 1 changes the `memory_query` explainability or ranking contract in a major way,
this plan should be revised before implementation.

## Done Criteria

Phase 2 is complete when:

- targeted resume is available as a first-class tool
- the system can propose durable writes from explicit conversation signals
- session-start context packs are compact, relevant, and explainable
- no server-side LLM dependency has been introduced
