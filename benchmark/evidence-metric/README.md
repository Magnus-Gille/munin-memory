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
embedding generation, corpus population, or download in this offline command. The
snapshot must be a detached, checkpointed copy in DELETE journal mode, with no
WAL, SHM or journal sidecars. Header checks happen before SQLite opens it; all
connections are read-only. This command never converts a snapshot. Input hashes
are checked again after evaluation; large files are hashed in bounded chunks.

The command above remains an offline evaluator. For clean-checkout replay,
`benchmark:evidence:check` downloads and verifies the shared release before
calling that evaluator:

```sh
npm run benchmark:evidence:check -- \
  --artifacts-dir /absolute/path/to/fresh-artifact-directory \
  --output /absolute/path/to/existing-parent/candidate-report.json
```

The published, non-product release is
[`benchmark-evidence-longmemeval-s-20261018`](https://github.com/Magnus-Gille/munin-memory/releases/tag/benchmark-evidence-longmemeval-s-20261018)
from source revision `d018e26`. It is marked as a prerelease and is not the `latest`
product release. Its seven assets include `snapshot.db.gz`,
`queries.jsonl`, `query-vectors.json`, `build-provenance.json`, `manifest.json`,
`shared-artifacts.json`, and `NOTICE.txt`. The lock pins asset sizes and
SHA-256 hashes. The checker validates the lock and per-file provenance before
download/decompression, then checks remote compressed bytes and final files.
`manifest.json` is not treated as its own trust anchor.

The artifact directory's parent and output parent must exist. The artifact
directory may be absent (download) or contain exactly five verified regular
inputs (reuse). Unexpected files, symlinks, SQLite sidecars, and mismatches fail
without changing existing data. The report and `${output}.verification.json`
must be fresh; the receipt records exact pins and whether files were downloaded
or reused. The checker never skips inputs, changes the baseline, or runs model
inference. Exit **0** means unchanged/improved, **1** a reproduced per-question
regression, and **2** invalid or missing inputs; gains do not offset a lost
all-gold question. Corrected bytes require a new versioned release and reviewed
lock update.

## Fixed-budget packing comparison (#342)

The [2026-10-20 measured comparison](comparisons/longmemeval-s-20261020/README.md)
reproduces the 500-question control and reports the candidate's gains, losses,
context-size tradeoff and remaining packing gap.

Add `--packing-comparison skip-oversized` to either command to compare packing
policies at the same **8,192 estimated-token** budget. The offline command also
requires `--baseline`; the shared checker supplies its reviewed baseline.

```sh
npm run benchmark:evidence:check -- \
  --artifacts-dir /absolute/path/to/fresh-artifact-directory \
  --output /absolute/path/to/existing-parent/packing-report.json \
  --packing-comparison skip-oversized
```

The control is the unchanged #341 serializer: preserve retrieval order, truncate
the first block if necessary, and stop at the first overflowing block. The
candidate skips a whole block that does not fit and considers later entries,
without truncating content, changing the retrieved order, or consulting gold
labels. Both use identical headers, separators and the pinned UTF-8 byte
estimator. This is an experiment; it does not select a new default packing policy.

Every control row must reproduce the reviewed baseline, including retrieved and
packed order and budget metadata. A mismatch invalidates the experiment rather
than attributing a retrieval or input change to packing. The frozen baseline's
bytes, configuration and primary regression policy remain unchanged. Future
retrieval changes may therefore require a separately reviewed baseline before
this strict packing comparison can run.

The optional `packing_comparison` section reports all/some/no-gold counts at
three stages: retrieved top 10, legacy packing and candidate packing. Per-query
rows retain candidate IDs and budget, stages, and gained/lost gold IDs.
`gained_question_ids` and `lost_question_ids` report transitions in all-gold
presence; `regression` is true for any lost all-gold question even if the net
count improves. Partial gold-ID losses remain visible in individual rows.

The report's existing `quality_state`, `comparison` and exit status describe the
unchanged control against #341. Experimental candidate losses are reported
separately, so a green control check is not approval to adopt the candidate.
The CI summary displays both stages and gains/losses, and retains the full report.
The legacy first-block ID can count even when only part of its content fits;
candidate whole-block presence does not prove answer correctness or semantic
evidence coverage. No reader or judge model is run.

## Query-based passage comparison (#342)

The optional `query-passages-v1` experiment packs verbatim source slices rather
than whole entries. It uses the same retrieved top 10, frozen query vectors,
clock and **8,192 estimated-token** budget. No model is called. The budget uses
the existing `ceil(UTF-8 bytes / 4)` estimator; it is not a model tokenizer count.

```sh
npm run benchmark:evidence:check -- \
  --artifacts-dir /absolute/path/to/fresh-artifact-directory \
  --output /absolute/path/to/existing-parent/passages-report.json \
  --packing-comparison skip-oversized \
  --passage-comparison query-passages-v1 \
  --gold-turns benchmark/evidence-metric/comparisons/longmemeval-s-passages-20261020/gold-turns.json
```

Both comparison flags are optional and independent. Passage comparison requires
`--gold-turns`; the offline evaluator also requires `--baseline`. Every control
row must reproduce the frozen #341 baseline exactly before a comparison is valid.
The committed annotation artifact makes replay possible without downloading the
large raw dataset. The shared checker pins its reviewed SHA-256 and rejects
changed annotations before evaluation; updating labels requires a reviewed pin
change. CI runs both experiments and retains their full per-query
reports. An experimental loss does not change the legacy control's exit status;
green checks alone do not recommend adopting a candidate.

The algorithm is fixed before measurement. It splits text at line boundaries
into non-overlapping chunks of at most 2,048 UTF-8 bytes, splitting longer lines
only at Unicode code-point boundaries. It ranks chunks by unique query-term
overlap divided by the square root of the number of unique terms in the chunk.
Terms use the existing Unicode term normalization. There is no stopword list,
label-based score or learned component. Ties use retrieval position and source
offset. A single greedy pass accepts each chunk if the fully rendered context
fits, including headers, separators and range labels. Adjacent accepted ranges
are coalesced; display order follows retrieval position and source offset.

The selector receives only the query and retrieved entries. Gold labels, answer
strings and expected IDs are never selection inputs. Half-open UTF-16 source
offsets identify exact content slices; these coordinates differ from the UTF-8
byte budget. The experiment is confined to benchmark serialization and does not
change production retrieval, authorization or the default reader context.

`passage_comparison` distinguishes two measurements:

- **Entry-ID presence** preserves the historical proxy, including its limitation
  that even a small slice can count as a present source.
- **Complete annotated-message coverage** requires every character of each
  upstream `has_answer:true` message to appear in the selected ranges. The
  control is scored from its actual serialized text, including first-entry
  truncation. A question enters the primary denominator only when every
  expected session contains at least one positively annotated message; other
  question IDs are explicitly excluded. This is a conservative message-level
  proxy, not answer-span coverage, judged relevance or reader answer accuracy.

Rows expose selected ranges, budgets and gained/lost message identities, including
partial losses on questions that remain incomplete. Aggregate gains and losses
are paired by question; a net improvement does not conceal individual regressions.

### Reproduce the annotation artifact

The small artifact stores only offsets, IDs and hashes. It derives existing
public dataset labels; it adds no human labels or inferred answer spans. Obtain
the pinned raw LongMemEval-S input described below, then run:

```sh
npm run benchmark:evidence:gold-turns -- \
  --raw /absolute/path/longmemeval_s_cleaned.json \
  --queries /absolute/path/frozen-inputs/queries.jsonl \
  --snapshot /absolute/path/frozen-inputs/snapshot.db \
  --out /absolute/path/to/existing-parent/gold-turns.json
```

Preparation verifies the pinned raw SHA-256, joins original question/session IDs,
requires exact flattened text equality with the frozen snapshot, and calculates
message ranges without searching for answer strings. It refuses output overwrite
and input aliases and opens only a detached read-only snapshot. No network or
inference is involved. Runtime validation checks query/snapshot bindings, entry
content hashes and range structure. It cannot independently prove upstream label
truth without the raw dataset; that is established by reproducible preparation
and the reviewed artifact. Reports bind the annotation artifact and optional
source module by hash and recheck them after evaluation.

## Execution and frozen input contract

The CI workflow definition runs on PRs and pushes to `main`, daily at
`04:23 UTC`, and manual dispatch, using a fresh `ubuntu-24.04` runner with Node
24, read-only permissions, and no data cache. It retains report and receipt
artifacts for 30 days when produced, including failed comparisons. Scheduled runs
use the workflow on the default branch, so the schedule starts only after merge. This lane does not call models;
the separate existing native-runtime smoke still downloads and loads models.

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

## Frozen 500-question baseline

The [2026-10-18 package](baselines/longmemeval-s-20261018/README.md) records a real
new run: **297/500 (59.4%)** all-gold questions, from 23,854 freshly embedded
entries and 500 frozen query vectors. It includes the exact initial report,
portable provenance and upstream model-file verification receipt. The large
snapshot/query/vector inputs are retained in the primary repository's persistent,
Git-ignored `benchmark/generated/evidence-metric/longmemeval-s-20261018` directory.
A versioned public benchmark-data release makes them available to clean
checkouts under the checked-in SHA-256 and size lock; it is separate from product
releases and has no `latest` alias.

All 500 budgets report truncation with retrieved candidates omitted; this does
not establish that each first block's content was truncated. Entry-ID presence
remains a retrieval/packing proxy. This new measurement does **not** reproduce
the historical 296/500 result or establish an attributable improvement. Legacy
artifacts remain unchanged and their model-only metadata is not relabeled.

The separate offline replay exited 0 and matched all 500 rows, bindings and
summary exactly, with no gained or lost all-gold questions. Source and baseline
artifacts passed independent review. Hosted CI verification remains pending. The
workflow schedule becomes active after merge; the lane compares the pinned shared
release and never regenerates or automatically updates this baseline.

## Whole-message and neighboring-context comparison (#342)

`query-message-neighbors-v1` is a separate experimental selector, fixed before
its first 500-question measurement. It scores complete message text using unique
normalized query-term overlap divided by the square root of unique message terms.
Ties use retrieval rank then original message index. Each anchor includes its
immediate previous and next message in the same entry, when present. Overlapping
bundles share messages. A bundle is accepted only when the entire rendered
context fits; an oversized bundle is skipped without truncation or a smaller
fallback. Display preserves retrieval order and original message order. Original
session headers, source-offset labels and all separators count toward the same
8,192 UTF-8-byte-estimated-token limit used by the other policies.

Message boundaries come from every original haystack message, independent of
answer annotations. The committed compact sidecar covers all 23,854 corpus
entries and 246,607 messages, with content hashes and UTF-16 tuples
`[role_start, content_start, content_end]`. `prefix_end` includes the session
header's trailing newline for a nonempty session and equals the first message's
start. No parser guesses boundaries from role-like lines inside message text.
The sidecar contains no message text or answer labels. Its source dataset and
snapshot pins, exact corpus coverage, content hashes and tuple invariants are
checked; the shared checker also pins its reviewed bytes before and after
artifact download. Optional source-module hashes are recorded and rechecked.

To replay all three policies in a clean checkout with shared frozen inputs:

```sh
npm run benchmark:evidence:check -- \
  --artifacts-dir /absolute/fresh/evidence-inputs \
  --output /absolute/existing/results/message-comparison.json \
  --packing-comparison skip-oversized \
  --passage-comparison query-passages-v1 \
  --gold-turns benchmark/evidence-metric/comparisons/longmemeval-s-passages-20261020/gold-turns.json \
  --message-comparison query-message-neighbors-v1 \
  --message-boundaries benchmark/evidence-metric/comparisons/longmemeval-s-message-neighbors-20261021/message-boundaries.json
```

The offline `benchmark:evidence` command accepts the same two new flags alongside
its explicit snapshot, queries, vectors, clock, baseline and passage flags.
Prepare the boundary artifact independently from the pinned raw public dataset
and detached snapshot (all three paths must be absolute; output must be new):

```sh
npm run benchmark:evidence:message-boundaries -- \
  --raw /absolute/longmemeval_s_cleaned.json \
  --snapshot /absolute/snapshot.db \
  --out /absolute/existing/message-boundaries.json
```

The new `message_comparison` report keeps paired `versus_legacy` and
`versus_passages` sections, category counts, gains/losses in individual full
annotated messages, per-question budgets/ranges and selected message indices.
The eligibility rule remains unchanged: all expected sessions must have a
positive annotation for the complete-question metric. Excluded questions and
labels remain explicit. The whole-message conservation diagnostic checks the
selected ranges against source boundaries. Neither this metric nor entry-ID
presence measures reader answer accuracy.

Primary baseline rows, exit codes and regression policy remain unchanged.
Experimental losses are reported even when the legacy baseline gate is green.
The [measured comparison](comparisons/longmemeval-s-message-neighbors-20261021/README.md)
records results against both controls; #342 remains open for further evidence.

## Core-first whole-message comparison (#342)

Add `--core-comparison query-message-cores-v1` to the complete command above
(including its passage, gold, message and boundary flags) to compare a fourth
policy. The offline command accepts the same flag with its explicit baseline.
`core_comparison` reports `versus_legacy`, `versus_passages`, and
`versus_neighbors`; the previous comparisons and baseline gate still run.

The new rule keeps #391's message score and tie order. First it admits whole
positive-score messages individually if the fully rendered context fits. Then
it considers each admitted anchor's predecessor and successor, separately, in
that order. Only the fixed set of first-pass anchors seeds expansion. No partial
message, cascading expansion, or zero-overlap fallback is used; an all-zero
query produces empty context. Headers, source markers and separators count.

This isolates an admission/expansion-policy change, not every scoring problem
found in the prior 29 regressions. Generic query terms, length dilution and
paraphrases remain limitations. The rule was frozen before its first full
measurement, after studying those regressions: it is a development-set iteration,
not a held-out generalization claim. The complete-message metric remains a proxy
and does not measure reader answer quality. Experimental losses do not change
the baseline gate. See the [analysis and comparison](comparisons/longmemeval-s-message-cores-20261021/README.md)
for every recovery and regression.
