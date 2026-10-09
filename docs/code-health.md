# Code-health evidence adapter

`memory_code_health` is the bounded ingestion and export surface for the frozen
Grimnir Code-Health Agent v1 contract. Its validator, schema, and positive and
adversarial fixtures are vendored unchanged from Grimnir revision
`7df005ce952a52816597d9888da977d689a631fd`. Their SHA-256 values are pinned in
`tests/code-health.test.ts`; update them only with an explicitly reviewed
contract revision.

The adapter stores accepted payloads as immutable `memory_log` rows and keeps a
principal-scoped metadata ledger in the same SQLite database. It does not create
a general telemetry store. Every append requires write access to its namespace,
the caller's classification ceiling, and the namespace classification floor.
The record ID and correction references resolve only to records stored by the
same principal in the same namespace. The exact UUID idempotency key and record
ID are principal-scoped. An exact retry returns its prior receipt; a payload
collision fails. A deleted or expired ID cannot be recreated.

Append accepts a v1 `record`, a namespace, a UUID `idempotency_key`, and optional
`classification`. Successful append and replay responses include the persisted
entry `updated_at` token. A correction also requires `expected_updated_at`; it must
replace the current record, keep its repo/task/attempt/record-kind lineage, and
cannot lower classification. The server rejects unknown fields, secret-like
content, records over 16 KiB, unsupported rubric versions, timestamps with
sub-second precision, future observations, and new observations older than 30
days. Exact acknowledged retries remain recoverable through the six-calendar-
month retention boundary.

Export accepts a namespace and optional exact filters for `repo_owner`,
`repo_name`, `task_id`, `since`, `until`, `model` (the observed worker model),
and `rubric_version`. `limit` is 1–100. The caller's own principal is the
default producer; only the owner may explicitly select another producer. This
does not grant that producer append authority. Export applies namespace and row
classification gates before materializing authorized count or page positions.
It returns current records plus authenticated stored context, a deterministic
snapshot watermark, `total_records`, `complete`, and a `retention` array. Each
retention item has `record_id`, `collected_at`, `expires_at`, `updated_at`, and
`classification`, sourced from the exact retained ledger entry and its matching
`entry_id` in the same authenticated producer and namespace. The `updated_at`
value is the compare-and-swap token for that record, including historical
predecessors retained as context; it never falls forward to an unrelated
successor.
The array covers exactly the union of the page's `records` and
`context_records`, with each record ID listed once. A shared context record on
multiple pages carries the same server timestamps on every page. Cursors are
opaque, authenticated, bound to caller, producer, namespace, filters, and
current authorization, and expire after 15 minutes. A server restart,
deletion, expiry, authorization change, or mismatched cursor makes continuation
fail closed. Export does not return ranked or semantic-query totals.

Consumers must enforce each `expires_at` locally even while Munin is
unavailable; do not calculate expiry from the time a consumer first sees a
record. The server's `collected_at` and `expires_at` remain authoritative for
records already stored. Retention metadata lets a consumer expire records
during an outage, while detecting deletions still requires a complete
authorized full-set reconciliation.

Consumers may reconcile removals only after the final page reports
`complete: true` and `reconciliation: "complete-authorized-retained-set"` for
the desired namespace, producer, and filters. Any error, invalidated cursor, or
page with `complete: false` means keep existing consumer rows and restart the
export. The six-month boundary is a maximum retention age from server-side
collection time; maintenance may retire dependent observations and assessments
earlier when their authenticated reference context is deleted or expires.

The adapter excludes managed rows from ordinary retrieval, FTS, embeddings,
embedding retries, consolidation, and automatic derivation. The reserved
evidence tag prevents managed rows from entering the FTS index. Audit events
contain only a static operation label, never evidence excerpts. Normal `memory_delete` applies
to the evidence namespace and uses the normal row deletion path. Deletion clears
the payload and descriptive ledger fields, invalidates export snapshots, and
leaves only a principal-scoped record ID, payload hash, UUID idempotency key,
and original expiry until that expiry, preventing replay from resurrecting the
record. This small deduplication tombstone is the deliberate metadata-erasure
exception. SQLite backups may retain deleted rows until their configured backup
expiry; see `docs/offsite-backup.md` for the backup lifecycle.
