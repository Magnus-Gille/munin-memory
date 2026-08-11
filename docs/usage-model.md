# Munin Memory — Usage Model

> This document explains the durable design concepts behind Munin Memory.
> It is for humans evaluating or setting up the system.
>
> **Layer precedence:** The runtime conventions stored in Munin (`meta/conventions`,
> surfaced by `memory_orient`) are the canonical operational contract — they take
> precedence over anything here for live session behavior. This document explains
> *why* the system is designed as it is; `meta/conventions` tells Claude *what to do*.

---

## Entry types: state vs. log

Munin has two fundamental entry types, and they model two fundamentally different things.

**State entries** are mutable key-value pairs identified by namespace + key. They represent
current truth. Writing a state entry with the same namespace and key upserts it — the
previous value is replaced. Use state entries for things that have a present state:
project status, a person's current role, a standing decision.

**Log entries** are append-only and have no key. They are timestamped and never modified.
Use log entries for things that happened: a decision made, a milestone reached, an
incident observed. The log accumulates; the state reflects where things stand now.

The practical discipline: **log the event, then update the state**. If a session ends
before the state write, the log still records what happened.

---

## Two data layers

Munin is designed around a two-layer model for project and work context.

**The detail layer** lives in local files, git history, and local Claude context — fast,
reliable, git-tracked, and not subject to network availability. This is where code,
meeting notes, drafts, and working artifacts live. It does not go into Munin.

**The summary layer** lives in Munin — brief status entries, key decisions, cross-cutting
context that needs to be accessible from any environment (laptop, phone, web). A Munin
state entry for a project should read like a handoff note, not a transcript.

The summary layer exists because Claude has no persistent memory across sessions or
environments by default. Munin is what makes the summary portable and current.

---

## Tracked statuses and the project dashboard

Namespaces under `projects/*` and `clients/*` are "tracked." A `status` key in a tracked
namespace feeds the computed project dashboard returned by `memory_orient`.

Tracked statuses serve a specific purpose: **computed orientation across environments**.
When you open a new session — on a different device, in a different client, days after
the last session — `memory_orient` returns a dashboard showing which projects are active,
blocked, completed, or stopped. You do not have to reconstruct this by reading every
namespace individually.

Status entries use lifecycle tags (`active`, `blocked`, `completed`, `stopped`,
`maintenance`, `archived`) so the dashboard can group and filter automatically.
`memory_update_status` can also set or clear `valid_until` to declare when a tracked
status should next be reviewed. Expired statuses remain directly readable, are surfaced
by `memory_attention` when `include_expiring` is enabled, and are hidden from broad search
by default. For sandbox-safe rehearsals, `memory_update_status(validate_only:true)` runs
the same namespace authorization, lifecycle/classification/CAS, and content validation
logic without mutating memory state; that dry-run path may target any namespace the caller
can write, while a real `memory_update_status` mutation remains restricted to tracked roots.
Ordinary content-blind tool-call telemetry remains enabled for observability.

Namespace-scoped retrieval is literal and case-sensitive. In `memory_query`, a bare
namespace such as `projects/munin-memory` matches that namespace and its descendants,
while a trailing-slash filter such as `projects/` matches only descendants under that
literal prefix. Successful query responses echo this as `namespace_scope: "subtree"` or
`namespace_scope: "prefix"`; responses omit `namespace_scope` when no namespace filter
was applied. Multi-page `memory_query` responses persist a server-side snapshot only when
more than one page is needed; the opaque resume cursor is authenticated to the frozen
snapshot id and position, explicit resume overrides must still normalize back to the
stored request shape, and the current access shape must exactly match a versioned
canonical JSON binding with fixed field order and sorted rule objects. The legacy
`access_fingerprint` database column stores this exact binding rather than a digest;
cursor integrity remains independently protected by HMAC-SHA-256 under the snapshot's
random secret. Cursor validity ends exactly 5 minutes after snapshot creation even if
physical deletion has not happened yet. Expired rows are physically pruned at startup
and by periodic maintenance for both HTTP and stdio, so during normal runtime cleanup
may lag logical expiry only until the next maintenance pass (at most the maintenance
interval, currently 1 minute). Semantic/hybrid queries use an indexed-candidate
contract. Semantic `total_matched` is exact over currently
retrievable candidates indexed with the active embedding model; entries without a
compatible embedding are outside that candidate set. Hybrid totals are exact over the
union of lexical matches and those currently retrievable semantic candidates, so a
missing embedding does not prevent an entry from matching lexically. These mode rules
define the retrieval candidate set. Server policy may then inject canonical orientation
entries and blocked/needs-attention statuses before final reranking; those injected rows
become members of the frozen result set and count in final `total_matched`. Snapshot
explanation metadata is frozen from the same scoring inputs as that final order. When
`include_expired` is false, expired state rows are excluded before the 500-candidate
exact-pagination bound is checked; with `include_expired: true`, those expired matches
still count toward the bound. `expired_filtered_count` counts unique candidate IDs across
the bounded retrieval probe (including overlapping hybrid legs), not an unbounded corpus
count. Each returned page is also logged as its
own retrieval event; continuation pages carry a continuation marker instead of
retroactively marking the prior page as a query reformulation.

`memory_history` has two paging directions. Cursorless calls are newest-first browsing
pages: they return `older_cursor` / `has_older` for deeper history plus `sync_cursor`,
the newest visible audit id in that initial feed (or `0` when the feed is empty), for
bootstrapping later forward polling. `older_cursor` calls continue that newest-first
history view but return `sync_cursor: null`; callers retain the initial watermark while
walking backward. `cursor` calls are ascending sync pages: they return rows with `id >
cursor` and advance `next_cursor` (also echoed as `sync_cursor`, or preserved when the
sync page is empty). `cursor` and `older_cursor` are mutually exclusive. For
non-owner callers, namespace visibility is applied in SQL before cursor predicates,
limits, and lookahead, so paging state reflects visible history rather than hidden rows.

`memory_commitments` derives tracked follow-through from canonical tracked-status
`Next Steps`, dated future clauses in visible tracked-status prose, explicit
`memory_log` commitment phrases such as `We agreed to: ...` or
`I commit to: ...`, and future-dated `memory_log` phrases. Generic non-status
state fields are not commitment sources. Legacy plain markdown status blobs with
ad-hoc `Next Steps:` headings remain readable, but they do not become
commitment rows until they are migrated to the canonical structure.
Compatibility note: older derived rows from those legacy plain-status blocks
are retired as non-completions during refresh, and older whole-segment dated
rows are revised to the surviving future clause when that obligation is still
present in the source.

---

## Broad handshake vs. targeted resume

Munin now separates **broad orientation** from **targeted continuation**.

Use `memory_orient` first when a session starts and the host exposes it as callable. It is
the handshake tool: conventions, dashboard, maintenance items, and namespace overview in
one place. If a host or deferred tool-discovery layer does not expose `memory_orient`, use
`memory_status` to inspect available tools or `memory_resume` for targeted context as the
fallback.

For owner callers, `memory_status.telemetry` is calculated from at most the 5,000 most
recent tool calls in its seven-day window so capability discovery remains responsive at
production volume. Read `telemetry_meta` alongside the per-tool rows: it reports the
sampling order and limit, how many calls were sampled, and whether older calls were
truncated. Non-owner callers receive neither telemetry field.

Use `memory_resume` after that when you already have a likely direction — a project
name, a namespace, or a user opener such as "continue grimnir parser rollout." It
returns a compact continuation pack: the most relevant current status, recent decision
logs, open loops, and optionally a small slice of recent namespace history.

This split exists because "what exists?" and "what should I load right now?" are
different jobs. `memory_orient` stays stable and broad; `memory_resume` can be sharper
and more task-aware without destabilizing the base handshake.

---

## State/log discipline

When to use each:

| Situation | Use |
|-----------|-----|
| Something happened (decision, event, milestone) | Log entry (`memory_log`) |
| Current state of a project or engagement | State entry (`memory_write`, key: `status`) |
| A standing decision that governs behavior | State entry in `decisions/*` |
| A person's current context or role | State entry in `people/*` |
| Sequential events you need to reconstruct later | Log entries |
| A value that will be updated frequently | State entry |

The most common mistake is using state entries for things that should be logs — writing
over history instead of appending to it. If you find yourself wondering "what happened,"
you needed log entries. If you find yourself wondering "where does this stand," you needed
a state entry.

### Extract, review, approve, resume

Use the durable review path when raw notes or a conversation may contain several
capture-worthy signals and a human or supervising agent should decide what becomes
memory:

1. Call `memory_extract` with `persist:true`. It returns suggestions and durable
   proposal IDs, but does not change state or append logs.
2. Call `memory_review` with `action:"preview"` for the exact operation, source
   references, freshness/CAS preconditions, and separate preview-vs-approval
   write effects. Successful preview responses are metering-free pure reads:
   they return `preview_wrote_memory:false`, `approval_would_write_memory:true|false`,
   `approval_status` in `would_write | would_conflict | duplicate_noop | not_approvable`,
   optional `approval_error { code, message }`, and optional `persisted_status`
   when Munin is showing a derived effective status such as `expired` without
   mutating the stored row. Request-level preview errors such as
   `validation_error`, `not_found`, and `payload_expired` omit those effect
   fields because no preview payload is available. Preview no longer returns the
   old ambiguous `writes_memory` field. Use `edit` or `decline` while reviewing.
3. Call `memory_review` with `action:"approve"` only after review. Approval
   re-runs the ordinary write gates and applies the operation atomically with the
   proposal transition. Approval remains the only step that can change memory
   truth. When approval rejects without applying, it returns the same
   machine-readable code preview advertised; for example, an expired proposal
   rejects with `ok:false`, `error/code:"review_expired"`, and
   `status:"expired"`. Non-terminal approve-time precondition rejections also
   append a durable `approval_conflict` event that `memory_review get` exposes.
   After an approval, `prepare_undo` can create a second review proposal
   that restores prior state or withdraws a reviewed log without mutating memory
   until that new proposal is approved.
4. Call `memory_resume` or `memory_read` to verify the accepted memory in normal
   retrieval.

The queue is scoped to the current server-derived session and creating principal by
default, even when another session of that principal or another principal knows its
UUID. A known foreign-session ID is intentionally indistinguishable from a missing
ID. Use `scope:"principal"` only when the same principal intentionally needs to
review across sessions; this never expands to another principal. Exact `namespace`
and `operation_type` filters are available on `list`, and authorized list/get
responses expose the creator session. Legacy proposals without a session are
available only through that explicit principal scope. For HTTP, authenticated
OAuth and agent-token callers receive a server-issued, signed `Mcp-Session-Id`
run handle when the request omits one and must echo that handle on subsequent
review actions. The handle is bound to the authenticated principal and
credential; caller-chosen or invalid handles fail closed, and static bearer
callers without a server-issued handle cannot capture durable review proposals.
A changed or superseded source produces a review conflict rather than a stale
write. Duplicate approval returns the stored applied result without writing
twice.

`prepare_undo` never mutates memory. It creates another pending proposal. If that
proposal is approved, Munin uses the correction lineage (`supersedes` plus CAS) to
restore prior state or withdraw a reviewed log while retaining both revisions.
Newly created state has no non-destructive prior revision and is therefore not
undoable through this path.

See [review-inbox.md](review-inbox.md) for lifecycle, retention, and security details.

### Concurrent state writes

The full-content `memory_write` path has three explicit write modes. Patch writes retain
their existing optional `expected_updated_at` CAS contract.

| Intent | Parameters | Result when the key already exists |
|--------|------------|------------------------------------|
| Unconditional upsert | omit both preconditions | Overwrites the current state |
| Update the version you read | `expected_updated_at: "<updated_at>"` | Updates only when the current version matches; otherwise returns `error: "conflict"`, `conflict_reason: "version_mismatch"`, and `current_updated_at` |
| Win the first write | `create_if_absent: true` | Never overwrites; returns `error: "conflict"`, `conflict_reason: "already_exists"`, and `current_updated_at` |

Do not combine `create_if_absent: true` with `expected_updated_at` or `patch`. After a
create-if-absent conflict, read the winner, reconcile it, and use its `updated_at` for a
normal CAS update. The absence check and insert occur in one SQLite transaction, so callers
must not invent a special timestamp to represent an absent entry. For compatibility,
`expected_updated_at` still creates the entry when the key is absent; it is an update-version
guard for an entry you have read, not an assertion that a key exists or is absent.
Soft expiry also does not make a key absent: a state row past `valid_until` remains directly
addressable, so `create_if_absent: true` returns `already_exists` until that row is deleted.

### Advisory intake quality

Successful full `memory_write` and `memory_log` calls include an `intake` object and
human-readable `[intake:*]` warnings when local heuristics find duplicate-key updates,
content overlap, likely consolidation candidates, sparse content, tag-vocabulary drift, or
unusually deep namespaces. The report is advisory: it cannot reject or roll back a valid
write, and an analysis or metadata-persistence failure is surfaced as a warning while the
memory operation still succeeds.

Related-entry analysis is bounded to 100 current entries that the caller was already
authorized to read at the connection's classification ceiling. Write-only callers still
receive intrinsic checks such as sparse-content and namespace-depth warnings, but no
related-entry identifiers, keys, counts, or scores. One versioned `entry_intake` row is
stored per entry for later measurement; mutable state updates replace that entry's prior
advisory row, and deletion cascades to it.

The first implementation deliberately does not add a `memory_audit` MCP tool or a
caller-controlled strict mode. The roadmap requires evidence that another front door
improves outcomes before expanding the tool catalog, and stored content must never become
an autonomous rejection policy.

### Corrections and temporal reads

An ordinary state upsert remains mutable. When the old wording must remain auditable, use an
explicit correction instead: pass its UUID as `supersedes` and its exact `updated_at` as
`expected_updated_at` to `memory_write`. Munin atomically marks that revision historical and
inserts a new UUID for the successor. `memory_log` supports the same correction parameters,
but always appends a new immutable log row; it never edits the original log content or
timestamps.

Default query, list, dashboard, consolidation, commitment, and derived-memory paths expose
only current revisions. `include_expired` changes soft-expiry filtering only—it never brings
superseded revisions back. Historical evidence remains available through `memory_get(id)`.
For state, `memory_read(namespace, key, as_of)` returns the recorded revision valid at that instant when explicit correction lineage covers that time; validity intervals are half-open, so the successor wins exactly at its `valid_from` boundary. Ordinary overwrites and patches rewrite the current row in place and advance that row's own `valid_from` boundary to the mutation time, so earlier instants are intentionally uncovered rather than returning rewritten current content. Legacy rows were backfilled from their last update, so uncovered timestamps return `found:false` with `history_available:false` instead of inventing history when the caller is authorized to know that recorded gap exists.

Corrections require read and write access, ownership of the source entry unless the caller is
the owner principal, an exact CAS match, the same namespace and state key, and a classification
at least as restrictive as the predecessor. One revision can have only one successor, so stale
or branching attempts return a conflict. Explicit backdating is owner-only, cannot precede the
target revision's `valid_from`, and this write path still rejects future `valid_from` values.
The one narrow temporal exception is `memory_read(as_of)`: the exact visible current
`valid_from`/`updated_at` boundary can round-trip even if wall-clock comparison sees it as
narrowly future, but arbitrary or hidden future instants remain rejected. Omitting `valid_from`
uses the server's current time. Deleting a state key removes its complete correction chain
atomically.

`valid_until` remains independent soft expiry. An expired current successor stays current but
is hidden from broad retrieval by default; expiry never resurrects an older revision. Retention,
garbage collection, and legal erasure are separate policies and are not implied by correction.

---

## Namespace categories

Munin uses hierarchical namespaces with `/` as a separator. The five structural categories:

| Namespace | Tracked | Purpose |
|-----------|:-------:|---------|
| `projects/*` | Yes | Project state and history |
| `clients/*` | Yes | Client engagement context |
| `people/*` | No | People profiles and contact context |
| `decisions/*` | No | Cross-cutting decisions |
| `meta/*` | No | System notes, conventions, config |

Namespaces are created implicitly on first write. Additional namespace patterns may exist
in your own Munin instance; the five above are the structural core.

---

## What belongs here vs. in `meta/conventions`

This document covers design rationale — the *why* behind the entry types, layers, and
tracked status model. It does not prescribe session behavior.

The runtime operational contract (session handshake sequence, write thresholds, search
mode guidance, environment-specific branching) lives in Munin itself under `meta/conventions`
and is surfaced at session start by `memory_orient`. That layer is authoritative for
active Claude sessions. It can be updated without a code change, and it stays in sync
with how the system actually behaves.
