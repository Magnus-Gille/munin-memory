# Core-first complete-message packing at 8,192 estimated tokens

Prioritizing complete query-matched messages before optional neighbors recovers
**26 of the 29** regressions introduced by #391 against #390. On all 500 queries,
full annotated-message coverage reaches **385/438 eligible questions (87.90%)**,
compared with 311 for #390 and 313 for #391. Against #390 there are **80 gains and
6 losses**: three old losses remain and three new losses appear. Keep this an
experiment: these are development-set coverage results, not held-out validation
or reader answer accuracy. Default and production packing are unchanged.

## What caused the prior 29 regressions

An independent replay reproduced every prior selected range and token estimate
for the 29 questions, encompassing 33 lost annotated messages. Every lost message
had its anchor bundle rejected for budget. In 16 cases the complete message alone
would have fit at that moment but its mandatory neighbor bundle would not; in
17 cases even the message alone no longer fit. Eighteen lost messages belonged
to entries that were still selected elsewhere. None of the 33 messages was at
least 4 KiB: oversized gold text was not the primary mechanism in this cohort.

The selected contexts contained 422 neighbor-only messages, totaling 753,070
payload bytes across those 29 questions (role text included, context headers and
range markers excluded). This is diagnostic evidence of expansion cost, not a
claim that all neighbors were irrelevant. Short generic messages can also outrank
longer relevant messages under the shared lexical score; paraphrases and facts
that depend on more distant turns remain limitations.

## Frozen rule and comparison controls

The [frozen rule](frozen-rule.txt) was recorded before implementation and the first
measurement. It retains #391's score (unique normalized query-term overlap divided
by the square root of unique message terms) and ties (retrieval rank, then message
index). First admit each positive-score whole message independently if the fully
rendered context fits. Then consider predecessor and successor separately for
each admitted first-pass anchor, in that order. Only those fixed anchors seed
expansion; there is no cascading or zero-score fallback. An all-zero-overlap query
produces empty context.

The change therefore tests an admission/expansion policy, including priority for
later positive anchors over earlier neighbors; it is not merely a smaller-bundle
fallback. Scoring remains unchanged. Every original message is complete, and
retrieval/source display order, headers, range labels and separators are counted.
The maximum is 8,192 using `utf8_bytes_div4_ceil_v1`, not a model tokenizer count.

The #341 snapshot, vectors, clock and top-10 hybrid retrieval are fixed. One
retrieval feeds all four policies. No model calls, new vectors, invented labels,
parameter sweep, or post-result policy tuning occurred. The original control
outputs are checked against their saved reports, apart from source provenance.

## Full comparison

| Measurement | #341 baseline | #390 passages | #391 neighbors | Core first |
| --- | ---: | ---: | ---: | ---: |
| All expected entry IDs / 500 | 297 | 434 | 395 | 457 |
| All annotated messages / 438 eligible | 282 | 311 | 313 | 385 |
| Individual complete annotated messages / 896 | 620 | 672 | 650 | 814 |
| Mean estimated tokens | 6,464.184 | 8,135.322 | 8,176.968 | 8,181.804 |

| Paired core-first change | Against #341 | Against #390 | Against #391 |
| --- | ---: | ---: | ---: |
| Complete-question gains / losses | 111 / 8 | 80 / 6 | 79 / 7 |
| Individual-message gains / losses | 208 / 14 | 158 / 16 | 175 / 11 |
| All-entry-ID question gains / losses | 160 / 0 | 23 / 0 | 62 / 0 |

All 26,136 selected messages are complete; zero partial messages were found.
Observed budgets range from 8,074 to 8,192 estimated tokens. The new candidate
covers 74 more complete questions (+16.89 percentage points) than #390, and 72
more (+16.44 points) than #391, while retaining the paired losses above.

The 62 questions without a positive annotation in every expected entry remain
excluded only from the all-message question rate. Individual message counts use
all 896 known annotations; missing labels are never inferred. Entry-ID presence
has a separate, less strict denominator of 500.

## Categories

| Category | Eligible | #341 | #390 | #391 | Core first | Gains / losses vs #390 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| knowledge-update | 70 | 44 | 59 | 58 | 67 | 8 / 0 |
| multi-session | 111 | 50 | 52 | 53 | 85 | 37 / 4 |
| single-session-assistant | 56 | 56 | 53 | 49 | 53 | 1 / 1 |
| single-session-preference | 30 | 21 | 11 | 14 | 25 | 14 / 0 |
| single-session-user | 64 | 54 | 61 | 60 | 61 | 1 / 1 |
| temporal-reasoning | 107 | 57 | 75 | 79 | 94 | 19 / 0 |

## Every prior regression

“Fits alone” counts lost messages whose one-message addition fit at their original #391 rejection. Recovery means all annotated messages are present in the new context, including any that #391 retained.

| Query ID | Category | Lost messages | Fits alone | Core result |
| --- | --- | ---: | ---: | --- |
| longmemeval-s-25e5aa4f | single-session-user | 1 | 0 | Recovered |
| longmemeval-s-ccb36322 | single-session-user | 1 | 1 | Recovered |
| longmemeval-s-c14c00dd | single-session-user | 1 | 1 | Recovered |
| longmemeval-s-0a995998 | multi-session | 1 | 0 | Recovered |
| longmemeval-s-60bf93ed | multi-session | 1 | 1 | Recovered |
| longmemeval-s-a9f6b44c | multi-session | 3 | 1 | Still lost |
| longmemeval-s-5a7937c8 | multi-session | 1 | 1 | Recovered |
| longmemeval-s-gpt4_372c3eed | multi-session | 1 | 0 | Recovered |
| longmemeval-s-06878be2 | single-session-preference | 2 | 1 | Recovered |
| longmemeval-s-afdc33df | single-session-preference | 1 | 1 | Recovered |
| longmemeval-s-38146c39 | single-session-preference | 1 | 1 | Recovered |
| longmemeval-s-2311e44b | multi-session | 1 | 1 | Recovered |
| longmemeval-s-d905b33f | multi-session | 1 | 1 | Recovered |
| longmemeval-s-67e0d0f2 | multi-session | 1 | 0 | Still lost |
| longmemeval-s-c18a7dc8 | multi-session | 2 | 1 | Still lost |
| longmemeval-s-37f165cf | multi-session | 1 | 0 | Recovered |
| longmemeval-s-5e1b23de | temporal-reasoning | 1 | 1 | Recovered |
| longmemeval-s-gpt4_0b2f1d21 | temporal-reasoning | 1 | 0 | Recovered |
| longmemeval-s-gpt4_93159ced | temporal-reasoning | 1 | 0 | Recovered |
| longmemeval-s-gpt4_65aabe59 | temporal-reasoning | 1 | 0 | Recovered |
| longmemeval-s-gpt4_c27434e8 | temporal-reasoning | 1 | 1 | Recovered |
| longmemeval-s-cf22b7bf | knowledge-update | 1 | 1 | Recovered |
| longmemeval-s-a2f3aa27 | knowledge-update | 1 | 0 | Recovered |
| longmemeval-s-9bbe84a2 | knowledge-update | 1 | 1 | Recovered |
| longmemeval-s-7e00a6cb | single-session-assistant | 1 | 0 | Recovered |
| longmemeval-s-58470ed2 | single-session-assistant | 1 | 0 | Recovered |
| longmemeval-s-1568498a | single-session-assistant | 1 | 0 | Recovered |
| longmemeval-s-d596882b | single-session-assistant | 1 | 1 | Recovered |
| longmemeval-s-4388e9dd | single-session-assistant | 1 | 0 | Recovered |

## Remaining and new losses against #390

| Query ID | Old / new | Lost / gained individual messages vs #390 |
| --- | --- | ---: |
| longmemeval-s-75499fd8 | New | 1 / 0 |
| longmemeval-s-a9f6b44c | Old | 1 / 0 |
| longmemeval-s-67e0d0f2 | Old | 1 / 0 |
| longmemeval-s-c18a7dc8 | Old | 1 / 0 |
| longmemeval-s-078150f1 | New | 1 / 0 |
| longmemeval-s-1903aded | New | 1 / 0 |

All gains and losses against each reference, including cases where complete-question
coverage is unchanged but individual messages move, are retained in the artifacts.
Improved aggregate coverage does not remove regressions or establish a safe default.
This candidate was informed by the same dataset's errors; independent queries and
reader evaluation are needed before a production packing decision.

## Reproduction and retained evidence

Follow the [shared-input replay](../../README.md#core-first-whole-message-comparison-342)
with `--core-comparison query-message-cores-v1`. A fresh Linux workflow downloads
all five pinned #341 assets, validates the annotation/boundary pins, and runs all
500 queries. Baseline exit policy remains unchanged; experimental losses stay
visible and informational.

- [results.json](results.json): aggregates, categories, all gain/loss IDs, cohort
  classification, input/source hashes and full-report digest.
- [queries.jsonl](queries.jsonl): all 500 paired outcomes, selected indices, source
  ranges and budgets, without source content or answers.
- [regression-analysis.json](regression-analysis.json): all 29 original cases,
  exact lost-message ranks/sizes and rejection costs, plus candidate recoveries.
- [analyze-regressions.py](analyze-regressions.py): standard-library, immutable
  read-only replay of the 29 cases and verification of their saved core selections.

To regenerate the diagnostic artifact from the full new report (which contains
both the unchanged #391 control and the core candidate):

```sh
python3 benchmark/evidence-metric/comparisons/longmemeval-s-message-cores-20261021/analyze-regressions.py \
  --prior-report /absolute/results/report.json \
  --candidate-report /absolute/results/report.json \
  --snapshot /absolute/evidence-inputs/snapshot.db \
  --queries /absolute/evidence-inputs/queries.jsonl \
  --boundaries benchmark/evidence-metric/comparisons/longmemeval-s-message-neighbors-20261021/message-boundaries.json \
  --gold benchmark/evidence-metric/comparisons/longmemeval-s-passages-20261020/gold-turns.json \
  --prior-source-root "$PWD" \
  --output /absolute/existing/results/regression-analysis.json
```

The output must be new. Source inputs are hashed before and after; no SQLite
sidecars or input writes are used. Full reports and verification receipts are
retained by CI for 30 days. Committed compact artifacts preserve the result after
that retention period.

First measured source revision: `6ec4d2ece9df9c28b101be81c04d9768a2e578c6`.
Full local report SHA-256: `822d839ebce4056695d4b607d0772fe94bae623c2050515688f22d43e244d50a`.

Independent Python reconstruction matched every selection, rendered range, budget,
paired aggregate and category across all 500 queries. The prior control outputs
reproduce exactly apart from explicit source provenance. Local required gates
passed: 3,460 tests and coverage floors, both typechecks, lint, build, lexical and
required-vector hybrid gates, and quickstart smoke. Hosted verification is reported
on the PR. The broader #342 acceptance remains open.
