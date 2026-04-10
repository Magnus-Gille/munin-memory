# LongMemEval Adapter

Status: implemented for lexical retrieval

Why it belongs here:

- public benchmark for long-term chat assistant memory
- exposes evidence sessions and turn-level answer labels
- closest external proxy to Munin's retrieval claims

## Source

- Repo: <https://github.com/xiaowu0162/LongMemEval>
- Dataset: <https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned>
- License: MIT

## Intended Mapping

- question text -> `BenchmarkQuery.query`
- question type -> `BenchmarkQuery.category`
- answer session ids -> relevant retrieval targets
- turn-level `has_answer` -> optional future fine-grained diagnostics

## Usage

Download the raw data first:

```bash
./scripts/fetch-benchmark-data.sh longmemeval-s
```

Build the `s` split synthetic benchmark corpus and query file:

```bash
npx tsx benchmark/adapters/longmemeval/build.ts --split s
```

To test alternate corpus granularity:

```bash
npx tsx benchmark/adapters/longmemeval/build.ts --split s --granularity round
```

This emits:

- `benchmark/generated/longmemeval-s.db`
- `benchmark/generated/longmemeval-s.jsonl`
- `benchmark/generated/longmemeval-s.provenance.json`

Or use the one-command workflow:

```bash
npx tsx benchmark/adapters/longmemeval/run.ts --split s
```

That builds the generated artifacts, runs the benchmark, and writes a report under `benchmark/reports/`.

For the round-granularity variant:

```bash
npx tsx benchmark/adapters/longmemeval/run.ts --split s --granularity round
```

For hybrid retrieval:

```bash
npx tsx benchmark/adapters/longmemeval/run.ts --split s --granularity round --search-mode hybrid
```

This will generate corpus embeddings for the synthetic benchmark DB before running the benchmark.

## Notes

The first implementation is intentionally lexical-only. The current runner can evaluate it immediately because the adapter generates a synthetic Munin-style SQLite corpus whose entry IDs match the generated query file.

LongMemEval remains a proxy benchmark, not the primary truth source. Munin-native queries should remain the baseline regression set.
