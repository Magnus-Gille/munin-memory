# Benchmarking

This directory holds Munin's retrieval benchmark harness plus the scaffold for public benchmark adapters.

## Goals

- Keep Munin-native regression testing in this repo.
- Make external benchmark inputs reproducible without committing large raw datasets.
- Preserve one report format across native and public benchmark runs.

## Layout

- `runner.ts`, `scorer.ts`, `types.ts` — existing benchmark harness.
- `ci-gate.ts`, `ci-gate-policy.ts`, `ci-gate/` — the deterministic CI regression gate (see below).
- `experiment-matrix.md` — current benchmark progression and what each next variant is meant to test.
- `queries/` — query sets in Munin's JSONL format.
- `adapters/` — public benchmark manifests and adapter notes.
- `data/` — local benchmark downloads and caches. Raw downloads are gitignored.
- `generated/` — generated adapter outputs such as converted query JSONL files. Gitignored except for this README.
- `fixtures/` — local snapshot databases for Munin-native runs. Gitignored.
- `reports/` — benchmark reports. Gitignored.
- `scorecard/` — versioned end-to-end scorecard contracts and the thin
  retrieval + answer-quality orchestrator.

## Recommended Sequence

1. Start with a Munin-native query set tied to real use cases.
2. Add a thin adapter for `LongMemEval`.
3. Add `LoCoMo` as a second memory-specific proxy.
4. Add a small `BEIR` subset for generic retrieval regression.

See [experiment-matrix.md](./experiment-matrix.md) for the current ordered experiment plan.

## CI Regression Gate

The CI gate turns the harness from "runnable" into "automatically catches a bad
ranking change". Unlike the snapshot-based benchmark (which needs a private,
gitignored DB), the gate is fully self-contained and deterministic, so it runs
on every CI build with no secrets and no network.

```bash
npm run benchmark:ci-gate                        # run the gate; exit 1 on regression
npm run benchmark:ci-gate -- --update-baseline   # re-bless the baseline after an intentional change
npm run benchmark:ci-gate -- --tolerance 0.01    # override the FP tolerance (default 1e-6)
```

How it works:

1. Builds the committed synthetic corpus (`ci-gate/corpus.json`, 26 entries with
   deliberately overlapping vocabulary) into an ephemeral SQLite DB. Nothing
   binary is committed.
2. Runs the benchmark in **`raw` + `lexical`** mode against the committed query
   set (`ci-gate/queries.jsonl`, 15 queries with single-entry ground truth).
   bm25 over a fixed corpus is deterministic across machines.
3. Compares the aggregate scores (R@1, R@5, R@10, nDCG@5, MRR) against
   `ci-gate/baseline.json`. Any metric dropping below baseline beyond a tiny
   floating-point tolerance fails the gate. Improvements always pass.

Files:

- `ci-gate/corpus.json` — synthetic entries (the only "source of truth" data).
- `ci-gate/queries.jsonl` — queries + `expected_ids` ground truth.
- `ci-gate/baseline.json` — blessed scores + corpus/query-set hashes for lineage.
- `ci-gate-policy.ts` — pure, unit-tested pass/fail comparison.
- `ci-gate.ts` — fixture builder + runner + CLI.

The gate is also enforced inside the normal `npm test` run via
`tests/ci-gate.test.ts`, which fails if the committed corpus or query set drifts
from the baseline without a re-bless.

**Scope.** The gate covers the retrieval-recall + lexical-ranking (`raw`) layer.
The production reranker is intentionally *not* gated here: its freshness and
attention inputs are time-relative and would rot a committed baseline.
Raw-vs-production parity is guarded separately by `tests/runner-parity.test.ts`.
Extending the gate to a time-frozen `production_ranker` run is future work.

## End-to-end scorecard

The Phase A scorecard composes the existing LongMemEval adapter, retrieval
runner, and answer-quality harness under a versioned contract. Run the
deterministic offline wiring check with:

```bash
npm run scorecard:smoke
```

The paid 500-question publication-candidate command and publication validator
are documented in [`scorecard/README.md`](./scorecard/README.md). The smoke is
never publication eligible. A full run is eligible only after it records the
complete raw result, enforced context budget, provider identity/cost,
environment lineage, stage/resource evidence, uncertainty, and passing trust
lanes. Retrieval `R@K` remains retrieval recall, never end-to-end answer
accuracy.

## Ground-Truth Query Pipeline

Hand-curating every benchmark query doesn't scale. This pipeline grows the query
sets from two structural sources — what users actually did, and what the corpus
structure makes likely to break — and keeps a human in the loop before anything
becomes ground truth. All three tools live in `scripts/` and operate on a real
(private) memory DB, so their output lands under `benchmark/queries/`, which is
gitignored except `example.jsonl`.

```bash
# 1. Mine real usage → reviewable candidates
npm run benchmark:derive -- --db ~/.munin-memory/memory.db --out benchmark/queries/derived.candidates.jsonl
# 2. Probe corpus structure for edge cases → reviewable candidates
npm run benchmark:synthesize -- --db ~/.munin-memory/memory.db --out benchmark/queries/synthetic.candidates.jsonl
# 3. Bless candidates into a real query set (interactive, or --accept-all)
npm run benchmark:curate -- benchmark/queries/derived.candidates.jsonl --out benchmark/queries/derived.jsonl
```

**`derive-benchmark-queries.ts`** mines the passive analytics tables
(`retrieval_events` / `retrieval_outcomes` / `retrieval_feedback`) into
`source: "derived"` candidates:

- `opened_result` → the opened entry is relevant (`expected_ids`).
- `write_in_result_namespace` / `log_in_result_namespace` /
  `opened_namespace_context` → that namespace is relevant (`expected_namespaces`).
- `good_results` feedback confirms the shown results; corrective feedback
  (`missing_result` / `bad_results` / `wrong_order`) with an `expected_entry_id`
  supplies ground truth and turns the shown-but-wrong results into `negatives`.
- `query_reformulated` marks the shown results as `negatives`. A query with only
  negative signal and no positive ground truth is dropped (`--min-support`,
  `--max-negatives`, `--since` tune the thresholds).

**`generate-synthetic-queries.ts`** builds `source: "synthetic"` edge cases from
corpus structure, deterministically: rare-term disambiguation (a query of terms
unique to one entry, anchored by a shared distractor term), tag search, and
namespace orientation. No usage history required.

**`curate-benchmark-query.ts`** walks candidates (`[a]ccept / [e]dit / [s]kip /
[q]uit`), strips the provenance tail (`support`, `signals`), and appends the
blessed `BenchmarkQuery` lines to a target set — idempotent on re-run (skips ids
already present). `--accept-all` blesses non-interactively for scripted use.

The pure cores (`deriveQueries`, `generateSyntheticQueries`, `blessCandidate`,
`mergeIntoQuerySet`) are unit-tested in `tests/{derive,generate-synthetic,curate}-*.test.ts`.

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

Answer-quality reports use a separate schema family. Version 3 adds an enforced
retrieved-context budget record per question, retrieval/serialization/reader/
judge stage timing, actual response-model/provider/generation identity, and
provider-reported cost alongside native token usage. It deliberately remains
separate from retrieval reports so answer accuracy cannot be confused with
`R@K`.

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
`src/internal/reranker.ts`. Issue #59 extracted the reranker pipeline out
of `src/tools.ts` into that dedicated module.

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
