# Passage packing at the frozen 8,192-token budget

**Keep this candidate experimental.** Query-based passage packing improves total
coverage, but loses complete annotated-message coverage on 42 questions that the
baseline covered. The much larger improvement in entry-ID presence overstates
the improvement in retained evidence. No default or production behavior changes.

This is the first measured `query-passages-v1` candidate, with its rule fixed
before the run. All 500 #341 control rows reproduce exactly, including retrieval
order and budgets. The snapshot, query vectors, top 10 hybrid retrieval, frozen
clock and maximum budget are unchanged. Budget means the existing UTF-8 byte
estimate, not an exact tokenizer count. There is no reader or judge model run.

## Measured results

| Measurement | Baseline | Passage candidate | Paired gains / losses |
| --- | ---: | ---: | ---: |
| All expected entry IDs, 500 questions | 297 (59.4%) | 434 (86.8%) | 148 / 11 |
| All original annotated messages, 438 eligible questions | 282 (64.38%) | 311 (71.00%) | 71 / 42 |
| Complete individual annotated messages, 896 messages | 620 (69.20%) | 672 (75.00%) | 144 / 92 |
| Mean estimated context tokens | 6,464.184 | 8,135.322 | Same maximum: 8,192 |
| Mean distinct entries in context | 2.068 | 7.840 | More sources, shorter excerpts |

Complete question coverage improves by **29 questions / 6.62 percentage points**
on the eligible subset. Of the 42 question regressions, **32 still contain every
expected entry ID**: an entry-presence-only report would hide those content losses.
The retrieved top 10 contain all original annotated messages for 409/438 eligible
questions, leaving 98 of those questions incomplete after candidate packing.
The previous whole-entry skip experiment achieved 301/500 on entry-ID presence;
its message coverage was not measured in that experiment.

The full dataset has 948 expected source entries. Existing `has_answer:true`
annotations identify 896 messages in 854 of those entries. The remaining 94
entries have no positive annotation. This excludes 62 questions from the
complete-question content metric; their IDs and per-message diagnostics remain
in the results. No missing labels are inferred. Full original message coverage
is conservative: losing unrelated words within a long answer-bearing message
can count as a loss even if the answer span remains. It does not measure reader
answer accuracy or validate exact answer spans.

## Improvements and regressions by question category

Counts below use only questions with a positive annotation in every expected
session. A net gain never cancels an individual regression.

| Category | Eligible | Baseline complete | Candidate complete | Gains | Losses |
| --- | ---: | ---: | ---: | ---: | ---: |
| User information, single session | 64 | 54 | 61 | 8 | 1 |
| Multiple sessions | 111 | 50 | 52 | 16 | 14 |
| Preferences, single session | 30 | 21 | 11 | 2 | 12 |
| Temporal reasoning | 107 | 57 | 75 | 25 | 7 |
| Knowledge updates | 70 | 44 | 59 | 20 | 5 |
| Assistant information, single session | 56 | 56 | 53 | 0 | 3 |

The largest net gains are temporal reasoning (+18) and knowledge updates (+15).
Preference questions regress sharply (21 → 11 complete). This supports testing
whether preserving complete conversation turns or neighboring context can reduce
losses in a separately defined candidate; it does not establish the cause of
every reader-level failure. Do not promote this lexical chunk heuristic solely
because its aggregate entry-ID score is high.

## Artifacts and reproduction

- [results.json](results.json): aggregates, all gained/lost/excluded question IDs,
  category counts, input/source hashes and full-report digest.
- [query-changes.jsonl](query-changes.jsonl): all 500 paired budgets, entry-ID
  gains/losses, message counts and exact gained/lost message ranges.
- [gold-turns.json](gold-turns.json): upstream annotation offsets and entry hashes,
  derived without copying source text or inventing labels.

The [evidence lane instructions](../../README.md#query-based-passage-comparison-342)
show both clean-checkout replay and annotation preparation. The existing hosted
workflow downloads the frozen shared inputs on a fresh Linux runner, runs both
packing comparisons, and retains the complete report with every selected source
range and verification receipt for 30 days. Regeneration does not need model
inference. The compact committed results preserve the comparison after that
retention period; exact source ranges can be regenerated from the pinned inputs.

Measured source revision: `10e92d27833c12a7bf83089d5d32ab2d809097f6`.
Full local report SHA-256:
`47a754b0ddc7fca745f1d85ec62bc56862f8266fb1d9afaf363c4e4fe4f0d187`.
Annotation artifact SHA-256:
`47dc2a2e8bdd1af0fb1b3d5aa39e68a4716548b8ad11d5587f06a7eac61a55db`.

Independent Python reconstruction matched all 948 expected snapshot entries and
all 896 message offsets; a separate legacy serializer reproduced all 500 frozen
control rows before computing message coverage. The TypeScript preparation CLI
then reproduced the annotation artifact byte for byte. These checks establish
the annotation mapping and control measurement; they are not new human labels
or an evaluation of the reader model.

#342 remains open for a safer packing policy, budget choice and real-agent usage
evidence. #341 baseline bytes and primary regression policy are unchanged.
