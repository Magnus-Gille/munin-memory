# Benchmarking

This directory holds Munin's retrieval benchmark harness plus the scaffold for public benchmark adapters.

## Goals

- Keep Munin-native regression testing in this repo.
- Make external benchmark inputs reproducible without committing large raw datasets.
- Preserve one report format across native and public benchmark runs.

## Layout

- `runner.ts`, `scorer.ts`, `types.ts` — existing benchmark harness.
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

## Adapter Contract

Adapters should produce query files compatible with `BenchmarkQuery` in `types.ts`.

Expected outputs:

- one or more `.jsonl` files under `benchmark/generated/`
- a small provenance manifest describing source dataset version, download URL, and adapter assumptions

Adapters should prefer:

- `expected_ids` when the source benchmark exposes exact relevant items
- `expected_namespaces` only for coarse smoke tests

## Data Policy

- Commit manifests, docs, and adapter code.
- Do not commit heavyweight raw datasets or generated caches.
- Keep any CI fixture intentionally small and explicitly documented.
