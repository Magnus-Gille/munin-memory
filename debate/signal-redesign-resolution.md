# Signal Redesign — Resolution

Date: 2026-04-01
Debate: Claude (Opus 4.6) vs Codex (GPT-5.4)
Status: **Planned — implement after current code overhaul stabilizes**

## Context

Phase 1 outcome-aware retrieval ran for ~5 days. Signals weren't differentiating: opens=0 everywhere, follow-through ≈ lifecycle status, staleness_pressure=0. Claude proposed 7 signal changes; Codex critiqued with 14 points. This resolution captures agreed changes.

## Key debate findings

1. **Orient doesn't flood impressions** — orient logs empty resultIds; `getInsightsByEntry` only counts query/attention events with non-empty result_ids. The "orient noise" diagnosis was based on a misread of the data. (Codex #3, #4)

2. **Reformulation is the one causal signal** — `query_reformulated` (second query within window after zero positive outcomes on first) is genuinely informative. Session-scoped attribution would corrupt it by retroactively making failed queries look successful. (Codex #7)

3. **`memory_read_batch` is uninstrumented** — before concluding opens are dead, fix the instrumentation gap. (Codex #8)

4. **Rank-aware signals are what Phase 2 actually needs** — namespace-level follow-through can't safely inform entry-level reranking. The ingredients for rank-aware signals already exist in the data. (Codex #14)

## Agreed changes (6 items)

### 1. Fix instrumentation gaps

- Add `opened_result` outcome logging to `memory_read_batch`
- Verify orient and attention event payloads — document what they do and don't track
- Re-evaluate "opens are dead" conclusion after instrumentation fix has collected data

### 2. Keep reformulation event-scoped

Do NOT widen the 5-minute window for negative signals (`query_reformulated`). This is the strongest causal signal and must stay tight.

### 3. Extend positive attribution window to 15 minutes

Change `RETRIEVAL_CORRELATION_WINDOW_MS` from 5 minutes to 15 minutes for positive outcomes only (write_in_result_namespace, log_in_result_namespace, opened_result). This is a compromise between "too tight" (current 5min) and "too loose" (full session).

Keep the 5-minute window for reformulation detection (negative signal).

Implementation: split the constant into `POSITIVE_CORRELATION_WINDOW_MS` (15min) and `NEGATIVE_CORRELATION_WINDOW_MS` (5min). `logRetrievalOutcome` uses positive; `logRetrievalEvent`'s reformulation check uses negative.

### 4. Add rank-aware query signals

Store additional metadata on retrieval events and compute rank-aware signals:

- **Top-k success**: was any of the top-3 results in a namespace that got a subsequent write/log?
- **Rank of first acted-on result**: for query events with follow-through, what was the rank of the first result whose namespace was acted on? Lower = better retrieval.
- **Reformulation after exposure**: already tracked, keep as-is.

These are read-time computations over existing data (result_ranks + outcomes). No schema changes needed for storage — just richer `getInsightsByEntry` output.

### 5. Split insights into two levels

Replace the single `getInsightsByEntry` with two views:

- **Query-level insights** (entry-granularity): impressions from `memory_query` only, top-k success, rank of first acted-on, reformulation rate. These can inform Phase 2 reranking.
- **Namespace-level insights** (namespace-granularity): orient/attention follow-through, cross-session activity patterns. These inform dashboard maintenance, not reranking.

The `memory_insights` tool can expose both via a `level` parameter (`entry` or `namespace`, default `entry`).

### 6. Tag query events with selectivity metadata

When logging a `memory_query` retrieval event, include in `detail`:
- `has_free_text: boolean` — did the query have a text search string?
- `has_namespace_filter: boolean`
- `has_tag_filter: boolean`
- `result_count: number`
- `had_injection: boolean` — were results heuristically injected/boosted?

This metadata is stored for future analysis. No immediate behavioral use — just better observability about what kind of queries produce what outcomes.

## Dropped from original proposal

- **Session-scoped attribution** — too loose, corrupts reformulation, schema doesn't support it cleanly
- **Tool-level signal weights** (static strong/weak labels) — too coarse, encodes assumptions
- **query_diversity** — rewards generic/injected entries, feedback loop risk
- **session_productivity as ranking feature** — label leakage (OK as analysis filter only)
- **orient_noise_score as auto-demotion** — orient serves continuity, not just relevance
- **median_age_at_retrieval** — unstable without snapshotting updated_at; not worth the schema change for unclear value

## Implementation order

1. Fix `memory_read_batch` instrumentation (small, independent)
2. Split correlation windows (positive 15min, negative 5min)
3. Add selectivity metadata to query event logging
4. Rework `getInsightsByEntry` → split into query-level and namespace-level
5. Add rank-aware computations to query-level insights
6. Update `memory_insights` tool with `level` parameter

## When to implement

After the current code overhaul stabilizes. This is a Phase 1 refinement — still observe-only, no ranking changes. Let the improved instrumentation collect data for 2-4 weeks before revisiting Phase 2 readiness.
