# Bilingual evaluation foundation (#369)

This is an offline preparation scaffold. It does not run embeddings, change
retrieval, approve labels, or decide a model release. Every report is
`status: "incomplete"`, `publication_eligible: false`, including perfect smoke
scores. The committed bank has **16 synthetic candidate cases**, four for each
SV/SV, EN/EN, SV/EN and EN/SV direction. Repeated translated concepts are plumbing
fixtures, not independent quality samples or a held-out benchmark. No human
adjudication, live model comparison or hardware measurement has happened here.

Run with existing installed dependencies, without downloads:

```bash
node --import tsx benchmark/bilingual-eval/smoke.ts
npm test -- tests/bilingual-eval.test.ts
```

The smoke prints deterministic JSON to stdout and writes no artifacts. It makes
up perfect ranked IDs for all four modes: lexical, semantic, raw hybrid and
production hybrid. It runs neither these algorithms nor vectors. Those names
exercise record plumbing only; scores are not retrieval quality evidence.

## Version 1 JSON contracts

`parseFixture` and `parseRun` in `index.ts` are the strict runtime contracts;
their exported TypeScript interfaces describe JSON fields. Unknown/missing
fields, invalid enum values, non-finite/out-of-range numbers, dangling labels,
overlapping positive/negative labels, invalid spans, duplicate IDs, incomplete
language coverage and broken hashes fail closed. Four cases per language
direction are a minimal fixture check, not an adequate statistical sample.

Fixture review is explicit: `candidate` requires a null reviewer;
`human_reviewed` requires a named reviewer. A hash or reviewer string proves no
actual human action. Future audited inputs need their reviewed evidence and
held-out protocol in a separate reviewable change. Public/synthetic material
and any separately approved private bank must remain distinct files and runs;
this module reads no private banks or default personal database paths.

Hashes use SHA-256 over UTF-8 canonical JSON: object keys sorted by Unicode
lexical order, array order retained, no whitespace, ordinary JSON scalar
encoding. `sealFixture` implements these exact domains:

- `corpus`: the complete corpus array.
- `queries`: ordered `{id,query,direction,category}` records.
- `labels`: ordered `{id,relevant_ids,hard_negative_ids}` records.
- `evidence`: ordered `{id,evidence}` records.
- `dataset`: the entire fixture body plus the four hashes above, excluding the
  dataset hash itself. This freezes review metadata, thresholds, clock and budget.

Source offsets are half-open **UTF-16 code-unit** positions `[start,end)` in
the exact pinned corpus text. Boundaries cannot split a supplementary Unicode
character. Every relevant entry requires labeled evidence. Recorded retained
spans include exact source text, checked against offsets; context is the
ordered retained strings joined with two newlines. Its deterministic token
estimate is `ceil(UTF-8 bytes / 4)`. This is an estimate, not a model tokenizer.
Headers or delimiters actually shown to a live consumer must fit an explicitly
defined serialization protocol before adapting those live records; this
version scores the declared source-only context and makes no model-input claim.

Recall is the fraction of relevant IDs in the fixed top K. MRR uses the first
relevant ID within that window. Hard-negative rate is the fraction of cases
with any labeled hard negative in the window. Complete-evidence rate requires
**every** labeled span to be fully contained in retained source spans; an entry
ID with truncated evidence is insufficient. All metrics are macro-averages,
reported overall and for every language direction. Gained/lost lists compare
per-case recall. Per-case records retain the remaining deltas for inspection.

Comparisons join exact case IDs, rejecting duplicates, missing and unknown
cases regardless of row order. Fixture hashes, fixed UTC clock, top K and token
budget must agree. Modes and ranker revision must agree. Declare one axis:

- `repeat`: embedding identity and fusion must both match.
- `embedding`: only embedding identity may differ; fusion stays frozen.
- `fusion`: only fusion may differ, only within a hybrid mode; embedding identity
  stays frozen. Production-ranker changes require a later explicit protocol.

Embedding provenance includes model, immutable revision, dtype, dimensions,
pooling, normalization, instructions, truncation and Transformers/ONNX/device
runtime identities. Do not describe a model name or configured dtype as proof
of the loaded artifact. This foundation validates presence, not runtime truth.
Small harmless float changes are not adjudicated by this scorer; #374 owns
embedding compatibility policy. Never alter both embeddings and fusion inside
an embedding comparison and attribute the resulting difference to the model.

Uncertainty uses seeded paired bootstrap over candidate-minus-baseline case
metrics, with the **same sampled case indices** for both sides. Intervals are
95% percentile intervals; positive deltas are worse for hard-negative rate.
Translated duplicate smoke cases do not establish population uncertainty.

Saved comparison reports retain both runs’ validated provenance (everything except
the result list), a canonical SHA-256 digest over each full run including results,
and the fixed clock, top K and budget. Identical metrics from different model
revisions therefore remain distinguishable.

## Threshold proposal and unfinished work

The fixture freezes a proposal **preregistered for review**, not an accepted
go/no-go policy: recall and MRR delta at least -0.02, complete-evidence delta at
least zero, hard-negative case rate at most 0.05. It does not automatically
approve anything. Human review must choose per-language criteria, confidence
bounds, held-out sample size and coverage before real candidate runs. Changes
to this proposal change the dataset hash. Reports always leave threshold review,
hardware measurements and release/rollback decisions pending. Candidate labels,
non-held-out banks and stub acquisition add their own explicit pending items.

Remaining #369 evidence: independently reviewed multilingual labels and hard
negatives; held-out bank; actual pinned baseline/candidate embeddings; fixed
conditions for the four retrieval modes; paired uncertainty and gained/lost
inspection on real cases; authorized target-hardware startup, p50/p95, RAM,
disk and indexing-cost measurements; and an explicit reindex/rollback decision
preserving human memory. This PR references #369 and does not close it.

## Adapting existing runner output

`benchmark/runner.ts` already emits per-query `result_ids`, `search_mode`,
`actual_mode` and query-set lineage; map those to `case_id`, `ranked_ids` and
the matching mode after validating **no fallback**. Use `raw` with lexical,
semantic and hybrid; use `production_ranker` with hybrid for the fourth mode.
Join by stable IDs, never row order. Reuse frozen query/corpus vectors for
offline pipeline tests, explicitly labeled as recorded/stub provenance.

Existing runner reports do not prove the complete embedding identity, corpus
and label/evidence hashes, fixed wall clock or exact retained source spans.
Fill these from separately verified run inputs; never invent or backfill them
from a score. `answer-quality/serialize.ts` can truncate an included entry,
so its `orderedIds` cannot supply complete-evidence labels by itself. A real
adapter needs exact post-budget retained offsets and serialization provenance.
No live adapter or measurement collector is claimed by this scaffold.
