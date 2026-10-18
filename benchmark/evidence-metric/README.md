# Offline packed-gold entry-ID metric

This lane evaluates **entry-ID presence in packed context**, the historical #341
signal. It is a retrieval/packing proxy, not answer accuracy or complete evidence
span/content coverage. The existing serializer counts the first block's ID even
when its content is truncated. Every row reports that serializer's budget and
`truncated` flag so the limitation remains visible.

```sh
npm run benchmark:evidence -- \
  --snapshot /absolute/path/detached-snapshot.db \
  --queries /absolute/path/questions.jsonl \
  --vectors /absolute/path/frozen-query-vectors.json \
  --as-of 2026-10-01T00:00:00.000Z \
  --output /absolute/path/candidate.json
```

Every input path is explicit. There is no live DB discovery, model initialization,
embedding generation, corpus population, download, or scheduled workflow. The
snapshot must be a detached, checkpointed copy in DELETE journal mode, with no
WAL, SHM or journal sidecars. Header checks happen before SQLite opens it; all
connections are read-only. This command never converts a snapshot. Input hashes
are checked again after evaluation; large files are hashed in bounded chunks.

Each non-comment JSONL record requires a unique nonempty `id`, `query`, explicit
`source` (`manual`, `derived`, or `synthetic`), `search_mode:"hybrid"`, and nonempty
unique `expected_ids`. `category` is optional (defaults to `evidence`). Namespace-only
gold is invalid. Optional `scope_namespace` is preserved through the production
runner. All gold IDs must exist and have generated vectors with matching model,
immutable identity, and dimensions. Vector-bearing current corpus entries in the
queried namespace scopes must also have matching provenance/dimensions. Unembedded
non-gold lexical candidates remain valid.

The vector JSON schema is:

```json
{
  "schema_version": 1,
  "query_set_sha256": "<sha256 of the raw JSONL bytes>",
  "model": "<recorded model name>",
  "identity": "<exact recorded immutable embedding identity>",
  "dimensions": 384,
  "vectors": { "question-id": [0.1, 0.2] }
}
```

The two numbers illustrate the shape; real arrays must have exactly `dimensions`
finite values that remain finite as float32, and every query ID must be covered
exactly. Duplicate query texts require identical vectors. No provenance is inferred
or added to legacy corpus vectors.

Evaluation reuses `runBenchmark` with `production_ranker`, hybrid retrieval,
recency weight 0, top 10, and an always-supplied frozen provider plus exact model
and identity. The existing `serializeContext` packs the retrieved `Entry` objects
in linear order under 8192 estimated tokens using `utf8_bytes_div4_ceil_v1`.
Downgraded modes, missing schema/vector support, and incompatible required
provenance invalidate the evaluation. An explicit `--as-of` freezes Date during
retrieval and packing; the small clock helper follows the unmerged #336 design
and restores Date in `finally`, rejecting nested/overlapping use.

Without `--baseline`, a valid run writes measured rows and `quality_state:
"not_measured"`, then exits **2**. The candidate is available for manual review;
there is no automatic baseline blessing. Supply a previously reviewed report as
`--baseline /absolute/path/baseline.json` to compare. The baseline must match the
schema, input hashes, embedding provenance, clock and configuration (including the
effective semantic distance cutoff). Evaluator and production source hashes plus
Git revision are recorded separately and excluded from comparison bindings so
code changes can be measured against the same inputs.

Rows are paired by query ID, independent of array order. Comparisons report
per-query all-gold booleans, gained/lost gold entry IDs, and gained/lost **question
IDs** for transitions in whether all gold IDs fit. They include both all-gold rates.
The paired guard is stricter than an aggregate score: any lost all-gold question
wins over gains elsewhere. Partial ID changes on questions that remain incomplete
are reported without treating them as a lost all-gold question.

- **0:** valid `unchanged` or `improved` comparison.
- **1:** `regressed`, reproduced by a second identical evaluation. Every per-query
  retrieval/packing result must reproduce, including order and truncation.
- **2:** `invalid` or `not_measured`, including absent arguments, incompatible
  inputs/baseline, inconsistent repeat, or an unwritable report.

Reports are written atomically and cannot overwrite an input or baseline,
including symlink and hardlink aliases. No baseline is committed for synthetic
fixtures.

## Fresh 500-question preparation

Preparation is a separate, explicit command. It never runs during evaluation or
CI, never approves a baseline, and never modifies the retained historical
artifacts. Use the reviewed public LongMemEval-S raw file; its bytes must match
SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
The manifest names the immutable upstream dataset revision.

```sh
npm run benchmark:evidence:prepare -- \
  --input /absolute/path/longmemeval_s_cleaned.json \
  --output-dir /absolute/path/munin-memory/benchmark/generated/evidence-metric/new-run \
  --as-of 2026-10-01T00:00:00.000Z \
  --allow-model-download
```

The output leaf must not exist, must be beneath `benchmark/generated/`, and must
not alias a symlink. Preparation owns only that new directory and refuses resume
or overwrite. Failure preserves its partial outputs and `failure.json`; use a
different new directory for a corrected attempt. Input hash/count mismatches are
rejected before model initialization. No source file is deleted or rewritten.

This cold build pins BGE `Xenova/bge-small-en-v1.5` revision
`ea104dacec62c0de699686887e3f920caeb4f3e3`, fp32, CPU, 384 dimensions, mean pooling
and normalization through the production embedding initializer. The model cache
belongs to the new output directory. Fresh preparation requires explicit
`--allow-model-download`; without it the command rejects before loading the
runtime, building artifacts or creating output. There is no reader/judge call.

Transformers 4.3.1's pipeline discovery ignores revision and local-only options:
it can fetch `main` config and tokenizer-existence metadata before loading the
actual model. Inference separately loads the config, tokenizer and ONNX weights
with the pinned revision. A successful run's pinned inference files must be
verified against upstream immutable metadata; retain a separate verification
receipt for any unversioned discovery config too. This limitation concerns
preparation. The separate evidence evaluator remains offline and never loads
Transformers or initializes a model.

The existing adapter builds all 500 questions and 23,854 session entries with
per-question namespaces. The explicit clock freezes ingestion metadata as well
as the later evaluation; measured preparation duration uses a monotonic clock.
All corpus vectors are generated afresh under one captured active identity;
query vectors share that identity and identical query texts share exact float32
values. Changed model files, source, inputs or active binding invalidate the run.

Successful output includes `snapshot.db`, `queries.jsonl`, `query-vectors.json`,
`build-provenance.json`, `manifest.json`, the working `corpus.db`, and `hf-cache/`.
The snapshot uses SQLite backup, DELETE journal mode, integrity/foreign-key checks
and no sidecars. The manifest records final input/output SHA-256 hashes and sizes,
counts, actual canonical embedding identity, Node/package/platform metadata, full
source Git revision and dirty disclosure, source/lockfile hashes, and hashes of
the pinned cache's model/config/tokenizer files before and after generation.
Model-file hashes describe measured local bytes; verification against upstream
revision file metadata is a separate review step before accepting the artifact.

Then run the existing offline command above with these three generated inputs.
Its first report remains `not_measured` with exit 2 until manually reviewed.
Retain original artifacts unchanged: this is a new measured reproduction and
cannot recover historical generation provenance or independently prove 296/500.

## Remaining #341 acceptance work

The existing local LongMemEval snapshot and 500-question query set are retained,
but the legacy snapshot has model-only embedding metadata and there is no frozen
500-query vector artifact with verified immutable identity. They cannot enter
this strict offline lane as-is. Preparation provides a fresh, provenance-bound
replacement workflow; the real 500-question rerun, upstream model-file review,
durable artifact storage and reviewed published baseline remain open until
performed. Tooling alone does **not** reproduce or substantiate 296/500 and adds
no CI schedule.
