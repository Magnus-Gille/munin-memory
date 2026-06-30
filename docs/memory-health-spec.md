# `memory_health` payload contract (schema_version 2)

Owner-only MCP tool returning a read-only memory-engine health snapshot for operator
dashboards (e.g. Heimdall). **munin-memory is the canonical owner of this schema** —
downstream consumers conform to it. The machine-readable contract is
[`memory-health.schema.json`](./memory-health.schema.json) (JSON Schema draft 2020-12);
this document is the human-readable companion.

Non-owner principals never see a payload: agents get `{ ok: false, error: "access_denied" }`,
all other non-owner principals get an invisible `{ ok: true, found: false }`.

## Envelope

| Field | Type | Notes |
|---|---|---|
| `ok` | `true` | Always true for an owner response. |
| `action` | `"health"` | |
| `partial` | boolean | `true` when **any** section failed (`ok: false`). |
| `schema_version` | `2` | Bumped from 1 when the payload was conformed to this contract. |
| `generated_at` | string (ISO 8601 UTC) | |
| `sections` | object | The seven sections below. |

## Per-section degradation

Each section is computed independently. On a sub-query failure the section collapses to:

```json
{ "ok": false, "error": "section_unavailable" }
```

and the top-level `partial` becomes `true`. The raw error is logged to stderr (secrets
redacted) and **never** returned in the payload. `additionalProperties` is `true`
everywhere, so additive fields are non-breaking.

## Sections

### `embedding`
| Field | Type | Required | Notes |
|---|---|:--:|---|
| `ok` | boolean | yes | |
| `model` | string \| null | yes | Active embedding model id. |
| `dtype` | string \| null | yes | Resolved ONNX weight precision (profile defaults applied); `null` when unset. |
| `counts` | object | yes | `{ pending, processing, generated, failed, total }` — all integers. |
| `coverage_pct` | number \| null | yes | Percent of entries with a generated embedding (0–100). **`null` when `counts.total == 0`** — distinguishes "nothing to cover" from "0% covered". |
| `reembed_in_progress` | boolean | yes | `true` when there is a re-embedding backlog (`generated_stale + generated_null + pending > 0`). |
| `stuck` | integer | yes | `generated_stale + generated_null`: entries marked `generated` but **not** against the active model identity (stale-model or null-model). Model-identity-based only — there is no `embedding_claimed_at` column for time-based stuck detection. |
| `stuck_note` | string | no | Documents the `stuck` definition (additive). |
| `circuit_breaker` | `"healthy"` \| `"tripped"` | yes | Embedding circuit-breaker state (distinct from model-not-loaded, which shows in `embedding_available`). |
| `embedding_available` | boolean | yes | Additive. Whether the model is loaded and usable. |
| `status_reason` | string | yes | Additive. Human-readable availability reason. |

### `size`
| Field | Type | Required | Notes |
|---|---|:--:|---|
| `ok` | boolean | yes | |
| `entries_total` | integer | yes | All entries. |
| `entries_state` | integer | yes | State entries. |
| `entries_log` | integer | yes | Log entries. |
| `namespace_count` | integer | yes | Distinct namespaces. |

### `retrieval`
| Field | Type | Required | Notes |
|---|---|:--:|---|
| `ok` | boolean | yes | |
| `query_volume_7d` | integer | yes | `memory_query` events in the last 7 days. |
| `query_volume_30d` | integer | yes | …last 30 days. |
| `mode_mix` | object | yes | `{ lexical, semantic, hybrid }` as **fractions** of `query_volume_7d` (each in `[0, 1]`). All `0` when `query_volume_7d == 0` (no divide-by-zero). Sums to **~1**: events with no recorded `actual_mode` are excluded from the numerators, so the sum can be slightly below 1. |
| `latency_p50_ms` | number \| null | yes | Nearest-rank p50 of `memory_query` wall-clock latency (ms) over the last 7 days. **`null`** when no timed query events exist in the window. SQLite has no `PERCENTILE_CONT`; computed as the value at `OFFSET CAST(0.5*(n-1) AS INT)` over the ascending-ordered `duration_ms`. |
| `latency_p95_ms` | number \| null | yes | As `latency_p50_ms`, at `OFFSET CAST(0.95*(n-1) AS INT)`. |
| `unused_surface_count` | integer | yes | Entries surfaced ≥5× over 30d with zero follow-through. **Uncapped** COUNT(\*) — accurate even when the unused backlog exceeds any display limit. |

### `classification`
| Field | Type | Required | Notes |
|---|---|:--:|---|
| `ok` | boolean | yes | |
| `by_level` | object | yes | Entry counts keyed by classification level: `public`, `internal`, `client-confidential`, `client-restricted` (all integers). |
| `access_denied_7d` | integer | yes | Count of access-denied security events (`audit_log` action = `access_denied`) over the last 7 days. Recorded by the central tool-gate denial helpers whenever a non-owner principal is denied. |

### `maintenance`
Flat (no `counts` nesting). All integers, all required when `ok: true`.

| Field | Notes |
|---|---|
| `ok` | boolean |
| `active_but_stale` | Tracked active statuses not updated in >14 days. |
| `missing_status` | Tracked namespaces with entries but no `status` key. |
| `temporal_stale` | Active statuses referencing a now-past forward-looking date. |
| `consolidation_backlog` | Namespaces with drainable unincorporated logs (0 when the worker is unavailable). |
| `retrieved_unused` | Same signal as `retrieval.unused_surface_count`. |

### `consolidation`
| Field | Type | Required | Notes |
|---|---|:--:|---|
| `ok` | boolean | yes | |
| `worker` | `"available"` \| `"unavailable"` \| `"disabled"` | yes | `disabled` = config off; `available` = enabled + ready; `unavailable` = enabled but missing key / circuit-broken. |
| `circuit_breaker` | `"healthy"` \| `"tripped"` | yes | |
| `failures` | integer | yes | Consecutive failure count. |
| `max_failures` | integer | yes | Circuit-breaker threshold. |
| `min_logs` | integer | yes | Worker threshold: namespaces need ≥ this many unincorporated logs to drain. |
| `last_synthesis_at` | string \| null | yes | `MAX(last_consolidated_at)` across namespaces; `null` if never run. |
| `avg_latency_ms` | number \| null | yes | `AVG(run_duration_ms)` (rounded), excluding null durations; `null` if none recorded. |
| `backlog_complete` | boolean | yes | Always `true` — the backlog query applies no cap. |
| `backlog_namespace_count` | integer | yes | Count of namespaces in `backlog` (equals `backlog.length` since the backlog is complete). |
| `api_key_present` | boolean | yes | |
| `last_error` | string \| null | yes | Secret-redacted. |
| `last_error_at` | string \| null | yes | |
| `backlog` | array | yes | `[{ namespace: string, unincorporated: integer }]`. |

### `security_events`
| Field | Type | Required | Notes |
|---|---|:--:|---|
| `ok` | boolean | yes | |
| `redaction_events_7d` | integer | yes | |
| `redaction_events_30d` | integer | yes | |
| `cross_zone_blocks_7d` | integer | yes | |
| `cross_zone_blocks_30d` | integer | yes | |

## Deferred (not yet emitted)

All previously-deferred fields are now emitted (#161):

- `retrieval.latency_p50_ms` / `retrieval.latency_p95_ms` — backed by migration v19
  (`retrieval_events.duration_ms`), `memory_query` instrumentation, and
  `getRetrievalLatencyPercentiles`.
- `classification.access_denied_7d` — backed by the `access_denied` audit action written from
  the central tool-gate denial helpers, counted by `getAccessDeniedCount7d`.

There are currently no deferred fields.
