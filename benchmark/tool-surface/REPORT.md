# Munin input tokens per question: where they go (MUNIN-434)

Source: Memory Arena v0.7.1 traces (`results-v071/runs`, probe + scale, 96 questions per model), analysed with
`arena-breakdown.mjs`. The memtool arm (same system prompt and questions) is the baseline prefix. Field shares come
from `arena-replay.mjs`, which re-issues every recorded read call against copies of the arena stores. No API calls.

## Breakdown (v0.7.1, tokens per question)

| Model | Input/q | API calls/q | Tool definitions | System + question | Tool results | Assistant turns |
|---|---|---|---|---|---|---|
| Haiku | 41,910 | 2.49 | 27,599 (66%) | 4,857 (12%) | 9,083 (22%) | 371 (1%) |
| Opus | 48,563 | 2.71 | 30,025 (62%) | 5,284 (11%) | 12,937 (27%) | 316 (1%) |
| Sonnet | 50,009 | 2.92 | 32,337 (65%) | 5,690 (11%) | 11,695 (23%) | 288 (1%) |

- Tool definitions cost about 11.1k tokens on every API call (prefix 13,037 vs memtool 1,953). The real ratio is about 2.8 chars/token, not the 3.6 that `measure.ts` assumes.
- Tool results are JSON at about 2.1 chars/token. `memory_query` takes 1.1–1.3 calls/q at about 8.1k chars (3.8k tokens) each. `memory_orient` takes 1.0 call/q at about 4.7k chars (2.1k tokens). Everything else is under 0.5k billed tokens/q.

## Dominant fields

- `memory_query` (8,122 chars/call):
  - `content_preview` 37.5%
  - timestamps 19.8% (`updated_at_local` 5.4%, `created_at`, `updated_at` and `valid_from` 4.8% each)
  - `provenance` 8.2%
  - `tags` 7.2% (including the mirrored `classification:*` tag), plus `classification` 4.1%
  - `id` 5.3%
  - retrieval diagnostics (`retrieval` + `search_meta`) only about 3%
- `memory_orient` (4,651 chars/call):
  - dashboard 51% (`updated_at` + `updated_at_local` about 11%)
  - `maintenance_needed` 21% (boilerplate `suggestion` 13%)
  - `getting_started` 11%
  - `librarian_summary` 4%
  - `response_budget_meta` 3%
- Write acks (ingest):
  - `memory_log`: `intake` is 60% of 921 chars (metadata 36%), and `warnings` repeats the intake flags.
  - `memory_update_status`: echoes the rendered `content` (40%) next to `structured_status` (42%).

## Changes (opt-in; defaults unchanged)

- `MUNIN_TOOL_PROFILE=core` exposes 8 tools (orient, query, read, read_batch, write, update_status, log, attention). The tool list goes from 31,150 to about 15,950 chars. A comma list selects custom tools, and hidden tools return `tool_not_enabled`.
- `MUNIN_RESPONSE_MODE=compact` is a post-processing allowlist that drops fields:
  - On query results: `created_at`, `valid_from`, `updated_at_local`, self-provenance, mirrored classification tags, routine retrieval diagnostics, the `total` alias and the `query` echo.
  - On orient: local timestamps, empty groups, maintenance boilerplate and the unadjusted budget meta.
  - On write acks: intake metadata, duplicate intake warnings and the update_status `content` echo.
  - Kept: content, ids, `updated_at`, and the untrusted flags and envelopes, redaction, expiry, synthesis, degradation (`fallback_reason`, `warning`, `search_mode_actual`), `candidates_truncated`, and `explain` output.
- Guidance: `memory_log` again describes the dated chronological record and its canonical tags. `memory_update_status` now says that `current_work` and `next_steps` hold only what the user stated.

## Offline projection (replay, no model in the loop)

Replay results: query 8,122 → 5,584 chars (−31%), orient 4,651 → 3,347 (−28%), tool list −49%. Applied to the
breakdown, per-question input drops by about 38%:

| Model | v0.7.1 | core only | core + compact |
|---|---|---|---|
| Haiku | 41,910 | 28,494 | 25,907 |
| Opus | 48,563 | 33,967 | 30,315 |
| Sonnet | 50,009 | 34,290 | 31,118 |

This assumes unchanged call patterns. Quality is unverified. The paid arena run (Sonnet + Haiku × 2, about $5,
judged blind with the v0.7.1 cells) awaits owner approval.
