# Durable review inbox

The review inbox turns `memory_extract` output into durable, explicit work without
turning extraction into automatic memory. The invariant is simple:

> Extraction may propose and persist a proposal. Only explicit approval may
> change memory truth.

## First-run flow

```text
memory_extract(persist: true)
  -> memory_review(action: "preview")
  -> memory_review(action: "edit" | "decline" | "approve")
  -> memory_resume or memory_read
```

`memory_extract` keeps its original suggestion-only behavior unless `persist:true`
is supplied. With persistence enabled, each returned suggestion gets a UUID,
creator principal, exact proposed operation, effective classification, confidence
and rationale, bounded source excerpt, source hashes, lifecycle timestamps, and
expiry. The response still states that memory truth was not changed.

`memory_review` actions:

| Action | Effect |
|---|---|
| `list` | Returns only the caller's visible proposals plus scoped status, failed, and stale counts. The default scope is the current server-derived session and principal; exact `namespace` and `operation_type` filters are available. |
| `get` | Returns one proposal and its attributable append-only events. |
| `preview` | Pure-read inspection of current source/target freshness; returns `exact_operation` only while the payload is retained and eligible for display. Never writes. |
| `edit` | Replaces the accepted operation while retaining the original form. Never writes memory. |
| `decline` | Records an attributable terminal transition. |
| `approve` | Revalidates and atomically applies the accepted operation once. |
| `prepare_undo` | Creates another pending proposal for a correction-based inverse. Never writes memory. |

## Security boundary

Proposal creation rejects common credentials and enforces the ordinary content,
namespace, tag, classification-floor, principal, and transport limits before any
proposal row is inserted. Source text is stored as a maximum 500-character excerpt
plus SHA-256 hashes and at most ten authorized entry references; the raw
conversation is not retained. Instruction-shaped text is advisory: it is stored
with untrusted flags and returned as data, never interpreted as policy or commands.

Proposal identity is stricter than namespace access. Every new proposal records a
server-derived creator session/run identifier as well as its creator principal.
Only the current session and principal can list, inspect, or transition a proposal
by default. A known ID from another session receives the same `not_found` response
as an unknown ID, and no proposal payload or event is loaded before that decision.
Pass `scope:"principal"` explicitly when the same principal intentionally needs to
list, inspect, or transition another session's proposals; the principal is always
bound from authenticated context and cannot be expanded by the request. Authorized
list/get responses expose `creator_session_id` so operators can distinguish runs.
Losing target read access or classification visibility makes a proposal invisible
rather than leaking metadata.

The v26 migration adds the nullable session column and an indexed principal/session
lookup path. Existing rows are not guessed or backfilled: a null creator session is
a legacy proposal, excluded from default session scope and available only through
explicit same-principal scope. It remains subject to the existing expiry, terminal
payload retention, event, and approval rules.

Durable capture requires a stable server-derived session. Stdio creates one for the
process; HTTP derives an opaque stored ID from the authenticated principal and a
stable MCP session token under a process-local server secret. HTTP requests without
that token do not get an implicit shared owner/session ID, so `persist:true` fails
closed. A server restart may make the old run unavailable in default scope; explicit
same-principal scope remains the recovery path.

Approval re-runs authorization, secret validation, classification resolution, and
transport visibility. It also verifies every retained source reference by UUID,
current-revision state, `updated_at`, and content hash, then applies the target
CAS/create-if-absent precondition. Source or target changes leave the proposal
reviewable and append an `approval_conflict` event.

The memory mutation, intake metadata, proposal transition, and approval event share
one SQLite transaction. A crash before commit rolls all of them back. Repeating an
already successful approval returns the stored entry UUID/timestamp and cannot
write a duplicate.

## Lifecycle and retention

Proposal states are `pending`, `edited`, `approved`, `declined`, `superseded`,
`expired`, and `failed`. Every transition records actor, previous/new state,
timestamp, and bounded detail in `review_proposal_events`. SQLite triggers reject
updates or deletes from that event table.

Pending and edited proposals expire after 30 days. Declined, failed, and other
non-timeout terminal causes use their actual `terminal_at`. Declined, expired,
and failed payloads are purged seven days after that effective terminal time. A
timeout-expired proposal (`terminal_code: "review_expired"`) becomes terminal at
`expires_at`, so its seven-day retention starts at that expiry time; the minimal
proposal tombstone and append-only events remain. Approved and superseded
proposals retain their payloads and any prior entry snapshot for a 30-day
reviewed-undo window measured from their actual terminal time, after which
maintenance reduces them to the same tombstone.
If a prior entry was more restricted than the accepted replacement, the proposal
inherits that higher classification while the snapshot is retained, and an undo
restores the prior classification.

Maintenance runs at startup, on the normal cleanup interval, and when the queue is
opened. Queue counts are computed only from proposals still visible to the caller,
so operator health signals cannot reveal another principal's sources. `failed_count`
is the visible failed total; `stale_count` is the number of visible pending/edited
proposals whose 30-day expiry is at most three days away.

## Reviewed undo

Undo is itself a proposal and must be previewed and approved. For an overwritten
state entry, the inverse restores the retained prior content through an immutable
correction revision. For an approved log, the inverse appends a corrective
withdrawal that supersedes the reviewed log. The accepted mutation remains in
history, and the original proposal becomes `superseded` only in the same transaction
that approves the undo.

A state entry created where no prior revision existed is not silently deleted:
there is no non-destructive prior truth to restore, so `prepare_undo` returns
`not_undoable`. Normal authorized deletion remains a separate explicit workflow.

## Deliberate non-goals

- No silent/background approval.
- No stored proposal may become executable policy.
- No autonomous destructive preview/token/confirm flow.
- No broad UI in this release. The MCP contract is complete; a thin local UI may
  be added later without changing the persistence or authorization model.
