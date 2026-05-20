# Retrieval benchmark lineage manifest (v1)

Companion to `retrieval-v1.manifest.json`. Use this document to understand
**what the manifest is, what it is not, and how to consume it.** The JSON
file is the source of truth; this markdown explains it.

## 1. Purpose

This manifest reconciles two threads of retrieval benchmark work into a
single, source-controlled index:

- the **munin-native** query JSONLs in this repo
  (`benchmark/queries/{baseline,baseline-claude,example}.jsonl`), and
- the **munin-zero** retrieval pilot artifacts under
  `docs/experiments/retrieval-pilot-2026-04-19/` (pinned at commit
  `ad4baff8b906065679144185af3e02ee632d9d28`).

It is the v1 *source index* — a citation/provenance layer that records
which artifacts exist, what they contain, what they refer to, and how
their evidence chains close issues like `munin-zero#6`.

## 2. What this manifest is NOT

This file is **not**:

- a **runnable benchmark input.** The runner consumes
  `BenchmarkQuery`-shaped JSONLs directly; it does not read this manifest.
- a **deduped retrieval-v1 label set.** Records across sources may overlap
  (e.g. v3b and v3c reuse v3 targets); we deliberately do not collapse
  them here. That work belongs to Artifact 3.
- an **authoritative relevance-grade store.** No human-audited relevance
  grades are introduced by this manifest. Relevance lives in either
  `expected_ids` / `expected_namespaces` on the native JSONLs or in the
  munin-zero target files referenced by `target_path`.
- a **complete catalog of every retrieval-related artifact.** Eight
  sources are indexed; everything else cited but not indexed is listed
  under `omitted_artifacts[]` with an explicit reason.

If you need a runnable label set or relevance grades, do **not** consume
this file — wait for Artifact 3.

## 3. How to consume

### 3.1 Citation format

Every record in this corpus can be referenced as:

```
<source_id>:<record_key>
```

- `source_id` is one of the eight entries in `sources[]`.
- `record_key` is the field named by `record_key_fields[source_id]` on
  the manifest. Examples:
  - `munin-native-baseline:b-001` (key field = `id`)
  - `munin-zero-v3c-intents:9` (key field = `target_num`)
  - `munin-zero-v3c-queries-sonnet:T9` (key field = `target_id`)

### 3.2 Dereferencing target sets

For sources with `ground_truth_kind: "targets_external"`, the relevance
truth lives in a separate file. The manifest records:

- `target_set_id` — stable handle for the target set
- `target_path` — repo-relative path inside `munin-zero`
- `target_sha256` — content pin
- `target_id_field` — which field on the source row points into the
  target file (`target_num` for intents, `target_id` for formulated
  queries that prefix with `T`)
- `target_count` — number of targets for that source
- `target_subset` / `target_uuid_subset` (when the source is a strict
  subset, e.g. v3c uses six of the fifty v3 targets)

### 3.3 Dereferencing result sets

For sources with retrieval runs already on disk, `result_paths[]` lists
each run with:

- `path`, `sha256`, `record_count`
- `search_mode` (`lexical` | `semantic` | `hybrid`)
- `limit` (top-K cutoff used at retrieval time)
- `metric` (`hit@20`, `rank-scored`, …)

The accompanying `evaluation_method` block declares the hit definition
that was used to score the run (binary hit-in-top-K, rank-scored,
snapshot parity, etc.).

## 4. Source repositories

| Name | Role | Pinned commit | Notes |
|---|---|---|---|
| `munin-memory` | primary | `52b3f99…` (manifest commit) | Holds native JSONLs. |
| `munin-zero` | evidence | `ad4baff8b906065679144185af3e02ee632d9d28` | Pilot artifacts at the v3c closure commit. CI does not check out this repo; integrity rests on `sha256` pins. |

## 5. Sources

The v1 freeze contains eight first-class source entries. Full
machine-readable details (sha256, paths, target metadata, strata, gap
references) live in `sources[]` in the JSON. Quick map:

| Source ID | Repo | Tier | Class | Records | Ground truth | Notes |
|---|---|---|---|---|---|---|
| `munin-native-baseline` | munin-memory | primary | manual | 15 | expected_ids | Hand-curated. |
| `munin-native-baseline-claude` | munin-memory | primary | manual | 16 | both | 12 expected_ids + 4 expected_namespaces. `u-001` is an out-of-distribution anecdote (gap-006). |
| `munin-native-example` | munin-memory | evidence | synthetic | 3 | expected_namespaces | Shape verification only. |
| `munin-zero-v2-intents` | munin-zero | evidence | derived | 30 | targets_external | Sonnet intent-writer; v2 pre-relaxed-FTS, stale (gap-004). |
| `munin-zero-v3-intents` | munin-zero | evidence | derived | 50 | targets_external | Sonnet intent-writer; v3 expanded set, full strata populated. |
| `munin-zero-v3b-queries-sonnet` | munin-zero | evidence | derived | 50 | targets_external | Sonnet-formulated queries over v3 targets. |
| `munin-zero-v3c-intents` | munin-zero | primary | manual | 6 | targets_external | Closure intents for `munin-zero#6`. |
| `munin-zero-v3c-queries-sonnet` | munin-zero | primary | derived | 6 | targets_external | Closure queries for `munin-zero#6`. |

Total: 176 records (34 munin-native + 142 munin-zero).

## 6. Strata definitions

See `strata_definitions` in the JSON for the canonical definitions of
`source_class`, `tier`, `entry_type`, `stratum`, `difficulty`,
`language`, `category`, and `search_mode`.

Two non-obvious points:

- **`source_class` is intentionally constrained to `manual | derived | synthetic`**
  to match the existing `BenchmarkQuery.source` enum in
  `benchmark/types.ts`. Editorial role lives in `tier` instead
  (`primary | evidence | deprecated`).
- **`difficulty` and per-stratum breakdowns are only populated where the
  underlying target artifact carries them.** v3 and v3b inherit from
  `pilot-targets-v3.jsonl`; v2 has only `entry_type` / `stratum` /
  `language`; munin-native sources have none today (gap-001, gap-005).

## 7. Dedupe policy

No record-level deduplication is performed inside the manifest. Each
record is uniquely addressable by `(source_id, record_key)`. Cross-source
duplicates (e.g. v3c intents are a subset of v3 by `target_num`) are
documented via `target_subset` fields so consumers can deduplicate by
target UUID if they need to.

## 8. Known gaps

See `known_gaps[]` in the JSON for the authoritative list. Summary:

| ID | Status | Scope |
|---|---|---|
| gap-001 | open | No difficulty stratum on munin-native or v2 sources. |
| gap-002 | documented | T10 tokenization issues (`90/10`, `Mímir`, `WebFetch`). |
| gap-003 | blocked | `retrieval_events` not yet trustworthy as a derived source (#31/#32). |
| gap-004 | documented | v2 baselines pre-date relaxed FTS and the camelCase tokenizer fix. |
| gap-005 | deferred | `entry_type` stratum unpopulated on munin-native. |
| gap-006 | documented | `u-001` is an appended user anecdote, not a retrieval target. |

## 9. Closed issues

### `munin-zero#6` — v3c closure of v3b 0/6 lexical failures

Closed by commit
`ad4baff8b906065679144185af3e02ee632d9d28`
(2026-04-20 22:17:54 +0200). Outcome: **5/6 hit@20 (lexical)** vs the
v3b lexical 0/6 baseline, on the same snapshot as v3b, after the FTS5
camelCase tokenizer fix landed. T10 remained a miss and is tracked as
gap-002.

The closure record pins all evidence artifacts by sha256:

- `pilot-report-v3c.md` (closure report)
- `pilot-intents-v3c.jsonl` (six closure intents)
- `pilot-queries-v3c-sonnet.jsonl` (six Sonnet-formulated queries)
- `pilot-results-v3c-lexical.jsonl` (six retrieval-run results, top-20)
- `pilot-targets-v3.jsonl` (target file holding the six target UUIDs)
- `pilot-report-v3b.md` (baseline report — context for the 0/6 claim)
- `pilot-results-v3b-lexical.jsonl` (baseline lexical results — substantiates the "vs 0/6" comparison)

The six target UUIDs are recorded as
`closed_issues["munin-zero#6"].target_uuid_subset` so a reader can verify
ranks without re-running the experiment.

## 10. How to add a new source

1. Compute `sha256` of the source file (and any companion target/result
   files).
2. Add a new entry to `sources[]` with at minimum `id`, `repo`, `path`,
   `sha256`, `record_count`, `source_class`, `tier`, `shape`,
   `ground_truth_kind`, and `notes`. Add `target_path` / `result_paths[]`
   if the source ships separate target or result files.
3. If the source inherits strata from a parent target set, set
   `strata_breakdown.inherits_from` to the parent `source_id`.
4. Re-run `npm test -- retrieval-manifest` and update
   `derived_*_record_count` totals.
5. Add a row to the table in §5 above.

## 11. Versioning policy

The eight `sources[]` entries are the **v1 freeze**. The validator test
enforces the exact set, so this is mechanically tested, not just
documented.

- Patch (`1.0.x`): metadata-only changes that keep the same set of
  sources, the same record counts, and the same target/result paths
  (e.g. clarifying notes, gap status updates, evidence_paths
  corrections that do not add a new source).
- Minor (`1.x.0`): additive changes that affect the v1 freeze — adding
  a new source, recording new result_paths for an existing source, or
  introducing a new known_gap. The validator's `EXPECTED_V1_SOURCE_IDS`
  list must be updated in the same change.
- Major (`x.0.0`): breaking changes (removing a source, changing
  `source_class` / `ground_truth_kind` semantics, changing
  `record_key_fields` for an existing source, or restructuring the JSON
  schema). Major bumps require a migration note in `CHANGELOG.md` and a
  parallel `retrieval-vN.manifest.json` while consumers move over.

In all cases, update `CHANGELOG.md` and the §5 source table in this
file in the same commit as the JSON change.

## 12. Maintenance

**Owner:** the same person maintaining `benchmark/queries/*.jsonl` and
the munin-zero retrieval pilots (currently Magnus). Three triggers
require touching this manifest:

1. A native JSONL changes (records added, removed, or reordered).
   Re-run `npm test -- retrieval-manifest`; failing sha256 / line-count
   assertions will name the file. Update `sha256`, `record_count`, and
   any affected `strata_breakdown` in the JSON, and the §5 table here.
2. A new munin-zero pilot artifact is produced. Add it to `sources[]`
   if it joins the v1 freeze (and bump the minor version per §11);
   otherwise list it under `omitted_artifacts[]` with a reason.
3. An issue tracked under `closed_issues[]` reopens or its evidence
   path changes. Update the entry and its `evidence_sha256` map.

The JSON file is the single machine source of truth. The markdown
mirrors what the JSON says — when they conflict, the JSON wins and the
markdown gets a follow-up fix.

## 13. Relationship to future work

- **Artifact 3** (≥50 human-audited relevance-graded cases) will sit on
  top of this manifest but will live in its own file. It is **not**
  introduced here.
- **PR 2** (extend `benchmark/runner.ts` for production-ranker + #19)
  consumes the native JSONLs directly; it does not need this manifest at
  runtime. The manifest is for humans and lineage tooling.
