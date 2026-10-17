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

## Remaining #341 acceptance work

The existing local LongMemEval snapshot and 500-question query set are retained,
but the legacy snapshot has model-only embedding metadata and there is no frozen
500-query vector artifact with verified immutable identity. They cannot enter
this strict offline lane as-is. Verified snapshot storage/provenance, matching
frozen query vectors, the real 500-question rerun and reviewed published baseline
remain open under #341. This infrastructure does **not** reproduce or substantiate
296/500, and this PR adds no CI schedule.
