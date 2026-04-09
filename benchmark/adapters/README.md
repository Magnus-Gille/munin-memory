# Public Benchmark Adapters

Each subdirectory describes one public benchmark we may adapt into Munin's retrieval harness.

The adapter pattern is intentionally thin:

1. Download the public source dataset into `benchmark/data/raw/<dataset>/`
2. Convert relevant items into Munin-compatible benchmark query files under `benchmark/generated/`
3. Record provenance so benchmark results are reproducible

This repo does not need a second evaluation framework. The job of an adapter is to map public benchmark structure onto Munin's existing query schema.

## Current Shortlist

- `longmemeval/` — strongest public fit for long-term chat memory
- `locomo/` — smaller conversation-memory benchmark with evidence annotations
- `beir/` — generic IR regression benchmark; use a small subset only
