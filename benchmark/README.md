# Benchmarking

This directory holds Munin's retrieval benchmark harness plus the scaffold for public benchmark adapters.

## Goals

- Keep Munin-native regression testing in this repo.
- Make external benchmark inputs reproducible without committing large raw datasets.
- Preserve one report format across native and public benchmark runs.

## Layout

- `runner.ts`, `scorer.ts`, `types.ts` — existing benchmark harness.
- `experiment-matrix.md` — current benchmark progression and what each next variant is meant to test.
- `queries/` — query sets in Munin's JSONL format.
- `adapters/` — public benchmark manifests and adapter notes.
- `data/` — local benchmark downloads and caches. Raw downloads are gitignored.
- `generated/` — generated adapter outputs such as converted query JSONL files. Gitignored except for this README.
- `fixtures/` — local snapshot databases for Munin-native runs. Gitignored.
- `reports/` — benchmark reports. Gitignored.

## Recommended Sequence

1. Start with a Munin-native query set tied to real use cases.
2. Add a thin adapter for `LongMemEval`.
3. Add `LoCoMo` as a second memory-specific proxy.
4. Add a small `BEIR` subset for generic retrieval regression.

See [experiment-matrix.md](./experiment-matrix.md) for the current ordered experiment plan.

## Adapter Contract

Adapters should produce query files compatible with `BenchmarkQuery` in `types.ts`.

Expected outputs:

- one or more `.jsonl` files under `benchmark/generated/`
- a small provenance manifest describing source dataset version, download URL, and adapter assumptions
- when needed, a synthetic benchmark DB whose entry IDs match `expected_ids` in the generated query set

Adapters should prefer:

- `expected_ids` when the source benchmark exposes exact relevant items
- `expected_namespaces` only for coarse smoke tests

## First Working Public Adapter

`LongMemEval` is implemented as a lexical adapter that generates:

- a synthetic SQLite benchmark corpus
- a matching query JSONL file
- a provenance manifest

Build it with:

```bash
./scripts/fetch-benchmark-data.sh longmemeval-s
npx tsx benchmark/adapters/longmemeval/run.ts --split s
```

## Data Policy

- Commit manifests, docs, and adapter code.
- Do not commit heavyweight raw datasets or generated caches.
- Keep any CI fixture intentionally small and explicitly documented.

## Report Schema

Reports under `reports/` follow the shape defined in `types.ts` as
`BenchmarkReport`. The `report_schema_version` field tags additive
revisions; consumers should branch on it before reading new fields.

### v3 changes (#58)

- `report_schema_version: 3` — pin for the current revision. The
  deprecated `schema_version` alias (a one-release mirror of
  `snapshot_schema_version`) has been removed. Read
  `snapshot_schema_version` for the snapshot DB migration version.

### v2 additions (PR 2a)

- `report_schema_version: 2` — pin for this revision. Implicit `1` for
  any pre-PR-2a report.
- `snapshot_schema_version` — DB migration version of the snapshot used
  for the run.
- `runner_mode` — which runner code path actually produced the numbers.
  `"raw"` calls `src/db.ts` query functions directly (faster, no rerank,
  no injectors). `"production_ranker"` (PR 2b) over-fetches per source
  by `QUERY_RERANK_OVERFETCH_MULTIPLIER` and runs results through the
  same canonical/attention injectors + `rerankQueryResults` +
  completed-task filter that `memory_query` uses, then slices to the
  requested limit. Select via `runnerMode` on `runBenchmark` or
  `--runner-mode` on the adapter CLIs.
- `runner_mode_requested` (PR 2b) — what the caller asked for. Equal to
  `runner_mode` for non-degraded runs. When they differ, the runner
  downgraded — `warnings[]` carries the reason.
- `search_recency_weight` (PR 2b) — recency weight applied during
  reranking. Number for `production_ranker` (default `0.2`); `null` for
  `raw` because the reranker is skipped entirely.
- `principal_id` (PR 2b) — always `"owner"` today. Benchmarks run with
  full owner access and skip `filterByAccess`. Reserved so a future
  multi-principal benchmarking mode can change this without a schema
  bump.
- `query_set_sources` — per-file lineage: path, filename, record_count,
  raw-bytes SHA-256, byte size, optional `manifest_source_id`, and
  `manifest_match` outcome (`matched` | `filename_match_sha_mismatch` |
  `unmatched` | `manifest_not_provided`). Populate by loading queries
  with `loadQueriesWithSource`/`loadQueriesFromDirWithSources` and
  passing the source(s) through `RunBenchmarkOptions.querySetSources`.
- `query_set_checksum` — SHA-256 over the sorted `(filename, sha256)`
  pairs of all sources. Same checksum ⇒ same query bytes, independent
  of load order.
- `overall_duration`, `by_search_mode_duration`, and
  `CategoryResult.duration` — `{ p50_ms, p95_ms, total_ms }` summaries.
  Percentiles use the same nearest-rank algorithm as
  `src/db.ts:computeP95` (`idx = clamp(0, n-1, ceil(p * n) - 1)`).
  `by_search_mode_duration` buckets are keyed on the **requested** mode
  (mirroring `by_search_mode`), not `actual_mode`, so a downgraded
  semantic→lexical query still lands in the `semantic` bucket.
- `QueryBenchmarkResult.duration_ms` — per-query wall-time captured
  with `performance.now()` and rounded to 0.01 ms.
- `ScoringResult.recallAt20` and `ndcgAt20` — top-20 cutoffs added to
  the existing scoring fields. Aggregations and per-category breakdowns
  include them automatically.

### Manifest cross-check

`runBenchmark` accepts `RunBenchmarkOptions.manifestPath`:

- `string` — explicit path to a `retrieval-v1.manifest.json` to compare
  against.
- omitted — auto-detects `retrieval-v1.manifest.json` sitting next to
  the first loaded query file.
- `null` — disables cross-check entirely (even auto-detect).

SHA mismatch is recorded as a `warnings[]` entry and reflected in
`manifest_match: "filename_match_sha_mismatch"`. It is not an error —
local edits during ablations are expected. The load-bearing guardrail
is the separate manifest CI test in `tests/retrieval-manifest.test.ts`.

### `production_ranker` prereqs and fallback

`production_ranker` mode reads columns added in schema v5
(`entries.owner_principal_id`, `classification`, `valid_until`). Running
against an older snapshot is **fail-loud** by default — `runBenchmark`
throws with the missing-prereq reason. To opt into a silent downgrade
that emits a `warnings[]` entry and falls back to `runner_mode: "raw"`,
pass `fallbackRunnerMode: "raw"`. In both cases `runner_mode_requested`
preserves the original ask, so post-hoc consumers can detect the
degraded run by comparing the two fields.

The benchmark-import-boundary test (`tests/benchmark-import-boundary.test.ts`)
pins the small curated surface the benchmark is allowed to import from
`src/tools.ts`. Issue #59 tracks the planned extraction of that surface
into `src/internal/reranker.ts`.

### Line endings

`.gitattributes` enforces `eol=lf` for `.jsonl`/`.json`/`.md`/`.ts`/`.sh`
so the on-disk SHA of query files is stable across macOS, Linux, and
Windows checkouts. The benchmark checksum machinery relies on this —
without LF normalization the same file would produce different SHAs on
different OSes.

## Retrieval Benchmark Lineage Manifest

`queries/retrieval-v1.manifest.{json,md}` is a curated source index that
reconciles the munin-native query JSONLs with the sibling munin-zero
retrieval pilot artifacts (v2/v3/v3b/v3c, pinned at commit `ad4baff`).
It is a **citation/provenance index, not a runner input** — the runner
still consumes the native JSONLs directly. Start with the markdown
companion (`retrieval-v1.manifest.md`) for orientation; the JSON file
holds the machine-checkable schema. See `tests/retrieval-manifest.test.ts`
for the invariants the manifest is expected to hold.
