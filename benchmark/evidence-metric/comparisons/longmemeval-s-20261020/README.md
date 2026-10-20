# Fixed-budget packing experiment, 2026-10-20

The `skip-oversized` candidate improves packed all-gold entry-ID presence from
**297/500 (59.4%) to 301/500 (60.2%)**, a **0.8 percentage-point** gain, at the
same **8,192 estimated-token** ceiling. Four questions gain full coverage; none
lose full coverage. Seven questions gain one gold entry ID each, with **zero
gold-ID losses**, including on questions that remain incomplete.

This is a measured comparison against the frozen #341 baseline, not the older
July simulation in #342. All 500 control rows reproduce that baseline exactly,
including retrieval order, packed IDs and budget metadata.

| Stage | All gold | Some gold | No gold |
| --- | ---: | ---: | ---: |
| Retrieved top 10 | 457 | 35 | 8 |
| Legacy packing | 297 | 154 | 49 |
| Skip oversized entries | 301 | 154 | 45 |

The candidate recovers **4 of the 160** questions that lost full coverage during
legacy packing (2.5%). Another **156** questions still have all gold retrieved
but not packed. The experiment supports a small improvement from using spare
space; it does not resolve the main packing loss.

## Paired improvements and regressions

These are all seven questions whose packed gold IDs change. The
[machine-readable results](results.json) include their expected, retrieved and
packed IDs, exact budgets, source hashes and input bindings.

| Question ID | Legacy → candidate | Gold IDs gained | Gold IDs lost |
| --- | --- | ---: | ---: |
| `longmemeval-s-ccb36322` | None → all | 1 | 0 |
| `longmemeval-s-f4f1d8a4` | None → all | 1 | 0 |
| `longmemeval-s-f4f1d8a4_abs` | None → all | 1 | 0 |
| `longmemeval-s-gpt4_a56e767c` | Some → some | 1 | 0 |
| `longmemeval-s-28dc39ac` | Some → some | 1 | 0 |
| `longmemeval-s-gpt4_d31cdae3` | Some → all | 1 | 0 |
| `longmemeval-s-2698e78f_abs` | None → some | 1 | 0 |

Packing changes for 281/500 questions. No question loses a gold entry ID or
exceeds the ceiling, but the candidate supplies more context on average:

| Measure | Legacy | Candidate |
| --- | ---: | ---: |
| Mean estimated tokens | 6,464.184 | 7,489.506 |
| Median estimated tokens | 6,709.5 | 7,619.5 |
| Maximum estimated tokens | 8,186 | 8,190 |
| Mean included entries | 2.068 | 2.792 |
| Empty contexts | 0 | 0 |

The increased mean context size is a tradeoff. Reader accuracy, distraction,
latency and cost were **not measured**. Zero entry-ID regressions does not imply
zero answer-quality regressions. The candidate remains opt-in and the default
serializer and reviewed baseline are unchanged.

## Reproduction and provenance

Use Node 24 and the repository's locked dependencies:

```sh
npm ci
mkdir -p /tmp/munin-packing-results
npm run benchmark:evidence:check -- \
  --artifacts-dir /tmp/munin-packing-inputs \
  --output /tmp/munin-packing-results/report.json \
  --packing-comparison skip-oversized
```

Use fresh paths for a new report. The shared checker verifies and downloads the
pinned public #341 snapshot, queries and query vectors; it never generates
embeddings or calls a reader/judge. The report retains all 500 per-question rows;
this checked-in summary retains the seven with gold-ID changes.

The local measurement used implementation commit
`b3a8fcd99dda733fbe3ad28f874b9160e72ffec8`, Node `v24.22.0`, macOS ARM64,
SQLite `3.53.2` and sqlite-vec `v0.1.9`. Subsequent report/documentation commits
do not change its recorded evaluator/production source hashes. The offline
evaluation exited 0 and an independent row-level calculation verified the
control, candidate subsequences, ceiling, stage counts and paired gains/losses.

| Artifact | SHA-256 |
| --- | --- |
| Frozen baseline | `a705dee0e10c66409bac95404f7b78bed576a7b84facaf77e25c0debb2204e96` |
| Snapshot | `fe48b7a30433f23d487d05608cecd969734b45686a51e29f5f86ba328059036a` |
| Queries | `274f858907c521cca2663c17fbb8bc5f2e198096d129e717c4c26a65c18ff7f1` |
| Frozen query vectors | `8c76c253a4755e590b85556b93400ef124c69f11518e1d19c6c841a07b46780c` |
| Full local report | `09116125694701fa48a7db51a0d64523442a488a7a8fac71e66c8e7b8250189d` |

The full local report hash is recorded in `results.json`; hosted reports carry
their own Git revision and are compared on bindings, source hashes and measured
rows rather than whole-file bytes. CI retains the full report and verification
receipts for 30 days.

## Interpretation limits and next experiment

The estimator is `utf8_bytes_div4_ceil_v1`, not a reader-specific tokenizer.
Both policies preserve retrieval order and use identical headers/separators.
The candidate considers later whole entries after a block does not fit; it
never uses gold labels to select content. The control may truncate the first
block and still count its ID, whereas the candidate skips oversized blocks
entirely. Synthetic tests cover that possible regression even though it did not
occur in this dataset.

Entry-ID presence establishes neither full evidence-span coverage nor answer
correctness. This experiment leaves #342's real-agent context usage and the
choice of an appropriate budget open. A useful next comparison is an
evidence-blind passage/turn selection policy under the same ceiling, followed
by a separately authorized reader evaluation before adopting a new default.
