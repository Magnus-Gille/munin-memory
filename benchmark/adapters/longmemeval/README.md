# LongMemEval Adapter

Status: implemented for lexical and hybrid retrieval with per-question haystack isolation

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

## Per-question Haystack Isolation

Each LongMemEval question is scored only against its own haystack, matching the canonical benchmark methodology. This is implemented via:

- **Per-question namespace:** `benchmarks/longmemeval/<split>/q/<question_id>` — each question's sessions are inserted into their own namespace so retrieval can be restricted to exactly that question's corpus.
- **`scope_namespace` on each query:** the generated `.jsonl` sets `scope_namespace` to the question's namespace so the runner restricts FTS5, semantic, and hybrid retrieval to that namespace.
- **Exact namespace-local KNN for scoped semantic/hybrid:** when `scope_namespace` is set, the runner passes `exactNamespaceScan: true` into `queryEntriesSemanticScored`, which computes distances only over the in-namespace vectors via `vec_distance_L2` — correct at any corpus size with no dependence on vec0's k≤4096 KNN ceiling.

Without this isolation, all 500 questions' sessions (~20K entries) compete in a global pool, making the task ~480× harder and producing incomparable numbers vs. the canonical LongMemEval scores.

## Entry ID scheme

Session granularity:

```
longmemeval:<split>:<question_id>:<session_id>
```

Round granularity:

```
longmemeval:<split>:<question_id>:round:<session_id>:<round_index>
```

The `<question_id>` segment is normalized with `normalizeNsSegment` (chars outside `[a-zA-Z0-9_-]` are replaced with `-`). Sessions shared across multiple questions become separate copies with distinct IDs — intentional, as each question must be scored against only its own haystack.

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

LongMemEval remains a proxy benchmark, not the primary truth source. Munin-native queries should remain the baseline regression set.

Numbers from runs prior to per-question isolation (global pool) are not comparable to canonical LongMemEval scores and should be discarded. All new runs use per-question isolation by default.
