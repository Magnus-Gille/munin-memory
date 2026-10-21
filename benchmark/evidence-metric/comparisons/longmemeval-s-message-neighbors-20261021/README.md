# Complete messages and neighboring context at 8,192 estimated tokens

**Keep this candidate experimental.** Preserving full messages and their immediate
neighbors gives complete annotated-message coverage on 313 questions, compared
with 282 for the #341 baseline and 311 for #390. Against #390, 31 questions improve
and 29 regress; the candidate retains 22 fewer individual annotated messages.
The small net question gain does not establish a better default or better reader
answers. Production and default packing remain unchanged.

This is the first measured `query-message-neighbors-v1` candidate. Its rule was
frozen before measurement: rank complete messages by unique query-term overlap
divided by the square root of their unique term count, then greedily admit each
anchor and its immediate previous/next messages as an indivisible bundle. Ties
use retrieval rank and original message index. Overlapping bundles are united;
selected messages render in original source order. An oversized bundle is
skipped, never shortened. Headers, offset labels and separators all count toward
the same `utf8_bytes_div4_ceil_v1` budget used by the controls.

All 500 #341 control rows and the entire #390 passage comparison reproduce
exactly, apart from explicit source provenance. The frozen snapshot, query
vectors, top-10 hybrid retrieval, clock and maximum context budget are unchanged.
One retrieval result feeds all methods. There are no model calls, new vectors,
inferred labels, or policy tuning after seeing the results.

## Measured results

| Measurement | #341 baseline | #390 passages | Complete messages + neighbors |
| --- | ---: | ---: | ---: |
| All expected entry IDs, 500 questions | 297 (59.4%) | 434 (86.8%) | 395 (79.0%) |
| All annotated messages, 438 eligible questions | 282 (64.38%) | 311 (71.00%) | 313 (71.46%) |
| Individual complete annotated messages, 896 messages | 620 (69.20%) | 672 (75.00%) | 650 (72.54%) |
| Mean estimated context tokens | 6,464.184 | 8,135.322 | 8,176.968 |

| Paired change for the new candidate | Against baseline | Against #390 |
| --- | ---: | ---: |
| Questions gaining / losing all annotated messages | 76 / 45 | 31 / 29 |
| Individual annotated messages gained / lost | 138 / 108 | 61 / 83 |
| Questions gaining / losing all expected entry IDs | 117 / 19 | 13 / 52 |

The complete-question metric improves by 31 questions / 7.08 percentage points
against the baseline, and by 2 questions / 0.46 percentage points against #390.
Individual regressions remain visible despite these net gains. All **14,383**
selected original messages are complete: **zero partial messages**. Every query
stays within 8,192 estimated tokens; observed estimates range from 8,006 to 8,192.
This is a byte-based token estimate, not a model-specific tokenizer count.

## Category improvements and regressions

Each count uses only questions with a positive annotation in every expected
session. Gains/losses are paired per question, not inferred from net changes.

| Category | Eligible | Baseline complete | #390 complete | New complete | Gains / losses vs baseline | Gains / losses vs #390 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| User information, single session | 64 | 54 | 61 | 60 | 8 / 2 | 2 / 3 |
| Multiple sessions | 111 | 50 | 52 | 53 | 17 / 14 | 11 / 10 |
| Preferences, single session | 30 | 21 | 11 | 14 | 5 / 12 | 6 / 3 |
| Temporal reasoning | 107 | 57 | 75 | 79 | 28 / 6 | 9 / 5 |
| Knowledge updates | 70 | 44 | 59 | 58 | 18 / 4 | 2 / 3 |
| Assistant information, single session | 56 | 56 | 53 | 49 | 0 / 7 | 1 / 5 |

Preserving neighbors recovers some preference coverage versus #390, but remains
below the baseline. Temporal questions improve most versus #390; assistant
information loses four complete questions on net. These are descriptive results
for this frozen candidate. They do not isolate causality or justify selecting a
new policy from aggregate score alone.

## Boundaries, labels and limitations

The label-free boundary artifact covers **all 23,854 snapshot entries and
246,607 original messages**. Boundaries come from the pinned upstream message
arrays and are checked against the exact flattened snapshot content; apparent
`user:` or `assistant:` lines inside a message cannot create false boundaries.
The artifact stores UTF-16 positions and hashes, with no source text or answer
labels. Selection receives only the query text, retrieved entries and these
boundaries. Gold annotations enter only the subsequent comparison.

The existing upstream positive annotations cover 896 messages in 854 of the
948 expected entries. The remaining 94 expected entries lack positive labels,
so 62 questions remain excluded from the all-annotated-message question metric.
Their IDs and known message-level changes remain reported. Nothing is inferred
about missing labels. Full original-message coverage is a conservative proxy;
it neither scores exact answer spans nor measures reader answer accuracy.

## Retained artifacts and replay

- [results.json](results.json): paired aggregate/category results, all gained,
  lost and excluded question IDs, input/source hashes and full-report digest.
- [query-changes.jsonl](query-changes.jsonl): all 500 questions with both paired
  message gains/losses, budgets, selected original message indices and exact
  candidate UTF-16 source ranges; no source content.
- [message-boundaries.json](message-boundaries.json): reviewed all-corpus
  boundaries, pinned to the original raw dataset and detached snapshot.

Follow the [message comparison instructions](../../README.md#whole-message-and-neighboring-context-comparison-342)
for a clean-checkout replay using the shared frozen inputs, or to regenerate
the boundary artifact from the pinned raw dataset. The hosted workflow runs the
baseline, #390 and this candidate together on a fresh Linux runner and retains
the full report and input-verification receipt for 30 days. Experimental losses
remain informational; the existing baseline regression gate is unchanged.

An independent Python replay matched all 500 anchor selections, rendered ranges,
byte budgets and paired coverage/category calculations. A separate source audit
matched all boundary records to the raw arrays and snapshot. Local repository
gates passed before publication; hosted verification is recorded on the PR.

First measured source revision: `c944ba04fdaa7424eb9a2260363d075ba9937c33`.
Full local report SHA-256:
`8f0e749014575ae586014b3d219508440a14e487e123c2cf460d9731eee84fe6`.
The shared checker's later correction preserves expected-ID order when validating
multi-gold deltas; it changes no selection rule, metric, input or measured value.
