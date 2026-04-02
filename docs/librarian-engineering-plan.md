# Librarian Engineering Plan

Status: concrete and repo-adjusted. This document turns the approved Librarian
architecture into an implementation plan for the current `munin-memory`
codebase.

Source architecture:

- `docs/librarian-architecture.md`

This plan is intentionally narrower than the architecture document. It focuses
on implementation order, repo-specific deltas, rollout gates, and acceptance
criteria.

## Goal

Implement transport-aware classification enforcement without destabilizing the
existing multi-principal access model, retrieval tools, or deployed Pi runtime.

At the end of this work:

- every entry has a server-authoritative classification
- every connection resolves to a defensible transport class
- direct-entry tools redact classified content instead of leaking it
- derived tools exclude classified sources before synthesis
- operators can audit, override, and monitor classification behavior
- consumer OAuth and consumer bearer clients can be re-enabled with bounded risk

## Repo-Specific Adjustments

The architecture is sound, but the current repository changes a few details.

### 1. The first Librarian migration is `v11`, not `v7`

Current schema state:

- `v8` added `valid_until`
- `v9` added `commitments`
- `v10` added `owner_principal_id`

So the Librarian schema work must start at `v11` in `src/migrations.ts`.

### 2. `commitments` already exists and is already a live derivative store

`commitments` is not hypothetical in this repo.

- schema lives in `src/migrations.ts`
- writes happen in `syncCommitmentsForEntry` in `src/db.ts`
- reads happen through `listCommitments` in `src/db.ts`
- tool consumers are `memory_commitments`, `memory_patterns`, and
  `memory_handoff` in `src/tools.ts`

The derivative-lifecycle work is therefore mandatory, not optional follow-up.

### 3. Derivative leakage is smaller than the architecture doc assumes, but not gone

Current `commitments` rows persist copied `text`, but `source_excerpt` is joined
live from `entries` at read time rather than stored in the table.

Implication:

- we still need `source_classification`
- we still need propagation on reclassification
- we still need scrubbing when a source becomes `client-restricted`
- we do not need a migration for persisted `source_excerpt`, because it is not a
  stored column today

### 4. Stdio currently bypasses `resolveAccessContext`

HTTP requests call `resolveAccessContext`, but stdio currently constructs an
owner context directly in `src/index.ts`.

Implication:

- transport-aware classification cannot live only in the HTTP path
- stdio needs an explicit `local` owner context with full classification ceiling
- we should avoid duplicating owner-context logic between stdio and HTTP

### 5. Tool enforcement is currently manual and scattered

The direct read/query/list tools in `src/tools.ts` all serialize entries
themselves after namespace access checks.

Implication:

- Librarian logic must be centralized in helper functions
- a CI coverage test is necessary, otherwise the next tool addition will create
  a gap

## Design Decisions For This Repo

These choices make the architecture concrete enough to implement.

### 1. Add an explicit optional `classification` tool parameter

Do not rely only on `classification:*` tags for writes.

Recommended contract:

- `memory_write.classification?: ClassificationLevel`
- `memory_log.classification?: ClassificationLevel`
- `memory_update_status.classification?: ClassificationLevel`

Compatibility rules:

- keep accepting `classification:*` tags on input
- if both param and tag are provided and disagree, reject the write
- always sync the authoritative column back into the tag set

Rationale: this reduces accidental omissions and gives `memory_update_status` a
clean way to classify `projects/*` entries above their namespace floor.

### 2. Treat the `entries.classification` column as authoritative everywhere

Read-time enforcement should never infer classification from tags if the column
exists.

Tags remain:

- for discoverability
- for backward-compatible search
- for human readability

They are not the security boundary.

### 3. Resolve transport type before access-context construction

`verifyAccessToken` should produce enough information for the caller to
distinguish:

- legacy bearer
- DPA bearer
- consumer bearer
- OAuth
- agent token
- stdio

That information should feed a single `resolveAccessContext` path which computes
effective classification ceilings.

### 4. Roll out in three behavior phases

The implementation should ship in this order:

1. schema plus write-path classification, enforcement off
2. transport-aware access context, enforcement still off
3. read-path enforcement and audit logging, then enable the feature flag

This keeps migrations and classification backfills decoupled from user-visible
redaction behavior.

## Workstream A: Schema, Types, and DB Contracts

### Scope

Add the missing schema and data model required by the Librarian.

### Files

- `src/migrations.ts`
- `src/db.ts`
- `src/types.ts`
- `tests/migrations.test.ts`
- `tests/db.test.ts`

### Changes

Add migration `v11` in `src/migrations.ts` with:

- `entries.classification TEXT NOT NULL DEFAULT 'internal'`
- `namespace_classification`
- `principals.max_classification`
- `principals.transport_type`
- `redaction_log`
- `commitments.source_classification`
- classification indexes on `entries`

Backfill rules:

- namespace default backfill from the architecture seed table
- explicit `classification:*` tags override namespace defaults
- existing commitment rows inherit `entries.classification` through
  `source_entry_id`

Extend shared types:

- `ClassificationLevel`
- `TransportType`
- `Entry.classification`
- redacted response shapes for direct-entry and derived-tool outputs

Add DB helpers for:

- resolving namespace floors
- reading and listing classification metadata
- inserting redaction-log rows
- pruning `redaction_log`
- propagating source classification into commitments

### Acceptance Criteria

- a fresh database migrates to `v11`
- a `v10` database upgrades cleanly
- all existing entry reads can select `classification`
- existing commitment rows receive `source_classification`
- no existing tests need ad hoc fixture surgery outside expected schema updates

## Workstream B: `src/librarian.ts`

### Scope

Create a dedicated module for all classification and redaction logic.

### Files

- `src/librarian.ts` (new)
- `src/access.ts`
- `tests/librarian.test.ts` (new)

### Responsibilities

`src/librarian.ts` should own:

- classification rank constants
- `classificationAllowed`
- namespace-floor resolution using longest-prefix match
- principal default ceilings
- transport ceilings
- transport downgrade rule: HTTP can never be `local`
- input parsing for `classification` param and `classification:*` tags
- tag synchronization helpers
- owner-tier and non-owner-tier redaction formatting
- Pattern A `enforceClassification`
- Pattern B `filterSourcesByClassification`
- startup consistency checks

It should not own namespace access control itself. That remains in `src/access.ts`.

### Acceptance Criteria

- the classification logic is testable without going through MCP handlers
- all 16 rank comparisons are covered
- longest-prefix namespace-floor resolution is deterministic
- malformed or missing classification values fail closed
- redacted responses never include content-bearing fields

## Workstream C: Write-Path Classification

### Scope

Ensure every new or updated entry has a valid authoritative classification before
read-time enforcement is enabled.

### Files

- `src/tools.ts`
- `src/db.ts`
- `src/types.ts`
- `tests/tools.test.ts`

### Changes

Update write tools:

- `memory_write`
- `memory_log`
- `memory_update_status`

Behavior:

- resolve requested classification from the explicit parameter or tags
- resolve namespace minimum from `namespace_classification`
- reject below-floor writes unless owner override is explicitly requested
- preserve existing CAS behavior
- sync `classification:*` tags on write
- write `entries.classification`
- update `commitments.source_classification` when a source entry is changed

For `memory_update_status`:

- default to the namespace floor
- allow explicit classification override above floor
- keep lifecycle-tag handling separate from classification handling

### Acceptance Criteria

- every write path sets `entries.classification`
- writes below floor fail cleanly
- owner override is audit-logged
- tracked-status writes can be classified above `projects/*` floor when needed
- no write tool can leave the column and tag out of sync

## Workstream D: Classification Audit Gate

### Scope

Do not enable enforcement until the stored data has been reviewed.

### Files

- `src/admin-cli.ts`
- `docs/librarian-architecture.md`
- `STATUS.md`
- optional one-off audit output under `docs/` or `debate/`

### Deliverables

Add operator-facing commands to export and review:

- entries by namespace and proposed classification
- entries below namespace floor
- entries with explicit classification overrides
- tracked namespaces whose statuses remain on namespace defaults

Required audit focus:

- `projects/*`
- `clients/*`
- `people/*`
- `business/*`
- `meta/*`
- `decisions/*`

Required output:

- which namespaces were reviewed
- which entries were reclassified
- which remaining namespaces are intentionally left on default floors

### Gate

Do not enable `MUNIN_LIBRARIAN_ENABLED=true` until:

- all `projects/*` statuses and high-signal state entries are reviewed
- all namespaces feeding `memory_orient`, `memory_resume`, and query previews are
  reviewed
- existing commitment rows have valid `source_classification`

## Workstream E: Transport Resolution and `AccessContext`

### Scope

Make transport class mechanically defensible and carry it into tool execution.

### Files

- `src/oauth.ts`
- `src/index.ts`
- `src/access.ts`
- `src/types.ts`
- `tests/oauth.test.ts`
- `tests/oauth-integration.test.ts`
- `tests/http-transport.test.ts`
- `tests/access.test.ts`

### Changes

#### 1. Extend bearer verification

Replace the current single-key behavior in `verifyAccessToken` with:

- `MUNIN_API_KEY_DPA`
- `MUNIN_API_KEY_CONSUMER`
- legacy `MUNIN_API_KEY`
- agent token lookup
- OAuth token lookup

Recommended auth return shape:

- keep `AuthInfo`
- attach extra fields via the existing cast pattern already used for `principalId`
- include at least `transportTypeHint` and `authMethod`

#### 2. Extend `AccessContext`

Add:

- `maxClassification`
- `transportType`

Preserve:

- `principalId`
- `principalType`
- `accessibleNamespaces`

#### 3. Refactor resolution

Update `resolveAccessContext` to accept transport input and compute:

- resolved principal
- principal default ceiling or DB override
- transport ceiling
- `min(transport, principal)`

Fail-closed defaults:

- unknown transport -> `consumer`
- bad principal ceiling -> principal-type default
- impossible owner fallback -> `internal`

#### 4. Fix stdio

Stop constructing plain `ownerContext()` in `startStdio`.

Instead:

- create an explicit local owner access context
- either via `resolveAccessContext` with a stdio auth mode or via a dedicated
  `localOwnerContext()` helper that shares the same classification logic

### Acceptance Criteria

- HTTP DPA bearer resolves to `dpa_covered`
- HTTP consumer bearer resolves to `consumer`
- OAuth resolves to `consumer`
- stdio resolves to `local`
- HTTP can never resolve to `local`, even if a principal row says so
- the tool layer sees transport type and effective classification ceiling on every
  request

## Workstream F: Pattern A Enforcement

### Scope

Apply centralized classification enforcement to direct-entry tools after
namespace access checks.

### Files

- `src/tools.ts`
- `src/librarian.ts`
- `tests/tools.test.ts`
- `tests/access-enforcement.test.ts`

### Target Tools

- `memory_read`
- `memory_read_batch`
- `memory_get`
- `memory_query`
- `memory_list`
- `memory_history`

### Implementation Notes

`memory_query` needs special care:

- filter by namespace access first, as today
- then replace disallowed entries with redacted objects rather than dropping them
- never include `content_preview`, snippets, or explain metadata on redacted rows
- `total` should include redacted results that survived namespace access

`memory_history` also needs special care:

- audit `detail` can contain content previews today
- if `entry_id` points at a classified entry, redact the detail field
- if no `entry_id` is available, fall back to namespace-level classification handling

### Acceptance Criteria

- namespace-denied entries remain invisible
- classification-denied entries become redacted, not invisible
- owner and non-owner redaction metadata differs exactly as designed
- `memory_query` explain mode cannot leak ranking metadata for redacted entries
- `memory_history` cannot leak audit detail from classified entries

## Workstream G: Pattern B Enforcement

### Scope

Filter classified sources before any synthesis or aggregation occurs.

### Files

- `src/tools.ts`
- `src/librarian.ts`
- `tests/tools.test.ts`
- `tests/access-enforcement.test.ts`

### Target Tools

- `memory_orient`
- `memory_resume`
- `memory_handoff`
- `memory_commitments`
- `memory_narrative`
- `memory_patterns`
- `memory_attention`

### Implementation Notes

The implementation should group these by data source rather than by final tool.

#### 1. Dashboard and tracked-status family

Apply pre-synthesis filtering to:

- `memory_orient`
- `memory_attention`
- tracked-status helpers they share

Expected behavior:

- inaccessible namespaces remain invisible
- accessible but over-classified statuses become redacted dashboard items
- `memory_orient` adds `librarian_summary`

#### 2. Narrative and resume family

Apply pre-synthesis filtering to:

- `memory_resume`
- `memory_narrative`
- `memory_handoff`

Expected behavior:

- all candidate pools are filtered before ranking or summarization
- outputs surface `redacted_sources` summaries
- owner gets namespace detail in `redacted_sources`
- non-owner gets count-only summaries

#### 3. Commitment and pattern family

Apply pre-synthesis filtering to:

- `memory_commitments`
- `memory_patterns`
- the commitment refresh path they depend on

Expected behavior:

- `memory_commitments` checks `source_classification` before surfacing rows
- `memory_patterns` must not mine terms from classified decision logs on a
  downgraded transport
- `memory_handoff` must not build open loops from filtered commitment rows

### Acceptance Criteria

- derived output never includes text from filtered sources
- partial results are returned when only some sources are filtered out
- `redacted_sources` appears whenever relevant
- all-source-filtered cases return valid but empty or reduced outputs

## Workstream H: Derivative Lifecycle

### Scope

Keep `commitments` consistent with source-entry classification over time.

### Files

- `src/db.ts`
- `src/tools.ts`
- `tests/tools.test.ts`
- `tests/db.test.ts`

### Changes

On source write or patch:

- update `commitments.source_classification` for all rows referencing the entry
- if the source becomes `client-restricted`, delete the derivative rows rather than
  merely relabeling them

On commitment sync:

- do not create new commitment rows from `client-restricted` entries
- persist `source_classification` at insert time

On commitment read:

- filter on `source_classification`, not only namespace access

### Acceptance Criteria

- raising a source entry from `internal` to `client-confidential` immediately
  affects commitment reads
- raising a source entry to `client-restricted` scrubs derivative rows
- no new derivative row is created from a `client-restricted` source

## Workstream I: Admin, Startup Checks, and Monitoring

### Scope

Make the Librarian operable, auditable, and debuggable.

### Files

- `src/admin-cli.ts`
- `src/index.ts`
- `src/db.ts`
- `tests/admin-cli.test.ts`
- `tests/tools.test.ts`

### Changes

Add `munin-admin` support for:

- `principals update --max-classification`
- `principals update --transport-type`
- `classification set-floor`
- `classification list-floors`
- `classification audit`

Add startup checks when `MUNIN_LIBRARIAN_ENABLED=true`:

- column-tag consistency
- entries below floor
- missing tracked-namespace floors
- conflicting equal-length floor matches

Add monitoring surfaces:

- `memory_orient.librarian_summary`
- startup warning when enforcement is disabled
- deprecation warning when legacy `MUNIN_API_KEY` is used
- periodic pruning of `redaction_log`

### Acceptance Criteria

- operators can inspect and change namespace floors without code changes
- operators can inspect principal classification ceilings and transport types
- startup warnings are actionable and non-fatal
- `redaction_log` retention is enforced by the existing cleanup loop

## Testing Plan

Use the existing suite layout instead of creating a parallel test universe.

### Primary Existing Suites To Extend

- `tests/migrations.test.ts`
- `tests/access.test.ts`
- `tests/access-enforcement.test.ts`
- `tests/oauth.test.ts`
- `tests/oauth-integration.test.ts`
- `tests/http-transport.test.ts`
- `tests/tools.test.ts`
- `tests/admin-cli.test.ts`

### New Targeted Suites Worth Adding

- `tests/librarian.test.ts`
  - pure unit tests for `src/librarian.ts`
- `tests/librarian-coverage.test.ts`
  - enumerates content-returning tools and ensures Pattern A or Pattern B
    enforcement is wired

### Critical Matrix

Cover at least these cases end to end:

- owner + stdio + `client-restricted` -> full content
- owner + HTTP DPA + `client-confidential` -> full content
- owner + HTTP DPA + `client-restricted` -> redacted
- owner + consumer + `client-confidential` -> redacted
- family + allowed namespace + `client-confidential` -> redacted
- family + denied namespace + `client-confidential` -> invisible
- agent + DPA + raised ceiling + `client-confidential` -> full content
- external + allowed namespace + `internal` -> redacted
- Librarian disabled -> no classification filtering

Also cover:

- `memory_query` explain-mode redaction
- `memory_history` detail redaction
- `memory_patterns` source filtering
- reclassification propagation into commitments
- HTTP `local` downgrade behavior

## Sprint Demo Evaluation (2026-04-02)

The current worktree was exercised through a live local HTTP/MCP run with:

- `MUNIN_LIBRARIAN_ENABLED=true`
- dedicated DPA bearer credential
- dedicated consumer bearer credential

Validated:

- `memory_status` reports transport-aware ceilings correctly
- DPA bearer can read `client-confidential` content
- consumer bearer is redacted on direct-entry tools (`memory_read`,
  `memory_read_batch`)

Confirmed remaining gap:

- `memory_query` still returns `content_preview` for `client-confidential`
  entries to consumer transport
- `memory_list` still returns `preview` for `client-confidential` state entries
- `memory_history` still returns full audit `detail` for writes touching
  `client-confidential` entries

Implication:

- the current sprint slice is valid as a direct-entry enforcement milestone
- Milestone 4 cannot enable the Librarian for non-test traffic until Pattern A
  is completed for `memory_query`, `memory_list`, and `memory_history`

## Rollout Sequence

### Milestone 1: Non-enforcing schema ship

Ship:

- `v11` migration
- `src/librarian.ts`
- write-path classification
- admin audit commands

Keep:

- `MUNIN_LIBRARIAN_ENABLED=false`

### Milestone 2: Audit and reclassification

Run the classification audit and correct:

- `projects/*`
- any client-bearing `meta/*` and `decisions/*`
- any tracked statuses that need explicit upgrades

Do not proceed until the audit gate is satisfied.

### Milestone 3: Transport cutover

Deploy:

- DPA bearer
- consumer bearer
- transport-aware `AccessContext`

Keep enforcement off for one deploy if possible, so auth and context changes can
be verified independently.

### Milestone 4: Enforcement enablement

Ship:

- Pattern A
- Pattern B
- redaction logging
- startup checks

Then enable:

- `MUNIN_LIBRARIAN_ENABLED=true`

### Milestone 5: Consumer re-enable

Only after production verification:

- re-enable OAuth consumer clients
- optionally re-enable Desktop consumer bearer config

## Definition of Done

The Librarian implementation is done when all of the following are true:

- schema `v11` is live and tested
- all write paths assign authoritative classification
- all content-returning tools have centralized classification handling
- all derived tools filter sources before synthesis
- `commitments` respects source classification lifecycle
- transport resolution is credential-based and test-covered
- startup checks and admin commands exist
- the audit gate has been completed and documented
- consumer clients can access public and internal data without exposing client
  content
