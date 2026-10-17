# Proposal evaluation foundation

Run the offline synthetic evaluation with `npm run proposal-eval:smoke`. It invokes the deterministic `memory_extract` baseline against ephemeral synthetic state and checks that the run leaves durable memory tables unchanged. It does not call a model or network service.

The checked-in dataset is synthetic, its candidate labels are unreviewed, and human review is pending. Exact detail coverage, structural checks, source-span attribution, contradiction flags, and injection/canary echoes are mechanical diagnostics; they do not establish factual precision or recall. Human factual precision, recall, and correction effort remain unmeasured. The protocol thresholds are proposals pending review, so smoke output is not a quality claim or publication result; every envelope remains `publication_eligible: false`.

Contradiction flags use fixture-curated exact substrings for specific withdrawn alternatives. They are diagnostic controls, not general negation or contradiction understanding. For partial recorded runs, top-level status remains `not_run` while any case is unrun (unless an error takes precedence). `case_coverage` reports supplied envelopes, executed/recorded cases, metric-bearing cases, the full dataset denominator, and `not_run_case_ids`, so aggregate metrics from a subset are not presented as full-dataset coverage.

Actual general-model and Hy-Memory results are not run by this smoke command. Their recorded-result formats remain available for later evaluation, but model revisions, prompt hashes, runtimes, and hardware results are pending until such runs are performed and recorded. The current labels also remain pending human review before they can support quality claims.

## Completing the experiment

This PR references #370 and does not close it. Before a model recommendation:

1. Have a human review the synthetic labels, exact negative controls and proposed
   thresholds; freeze the approved corpus separately from the smoke fixtures.
2. Select an authorized inference target and pin both the general baseline and
   [Tencent Hy-Memory](https://huggingface.co/tencent/Hy-Memory-30B-A3B) model/runtime
   revisions, prompt/schema hashes and sampling settings. Record Swedish and
   English results separately. Model-provided English/Chinese evidence does not
   establish Swedish quality.
3. Run both writers with identical conversations and prior-state context. Import
   their proposals as data only through the recorded-output CLI below; never
   approve or execute them. This foundation provides no inference process.
4. Adjudicate factual precision/recall, contradiction, over-storage, source support,
   exact details and correction effort blind to the writer. Measure latency/RAM
   and compare downstream retrieval with its retrieval/answer settings held fixed.
5. Record a go/no-go decision with limitations and operational costs. The current
   smoke cannot produce that decision, even if every mechanical diagnostic passes.

## Offline recorded writers and frozen prompts

The recorded adapter provides explicit CLI ingestion of saved proposals.
It never invokes inference, tools, memory approval or persistence. Generate the exact
shared prompt manifest on stdout:

```bash
node --import tsx benchmark/proposal-eval/recorded.ts --prompts
```

For each case, supply `writer_instruction` as the writer instruction and that case's
exact `source_json` as the source message. Use the identical messages for both the
general model and Hy-Memory. The source contains the full conversation and public
synthetic prior state; candidate labels and forbidden-answer controls are withheld.
The source is inert, untrusted data. The instruction requests proposal JSON using
only the scorer's existing `memory_log`, `memory_write` and `memory_update_status`
shapes; those operation names never authorize execution.

`prompt_sha256` hashes UTF-8 `JSON.stringify` of the manifest fields preceding the
hash, in their emitted order: prompt version, dataset ID/version, exact dataset and
schema hashes, writer instruction, and the ordered case IDs/source JSON strings.
Preserve the instruction and source strings exactly. A prompt or corpus/schema
change requires a fresh manifest and new recordings, including for partial runs.
Keep the actual immutable model revision and runtime configuration (including
sampling settings) with the recording; the importer cannot verify provenance or
measure hardware performance.

Create a JSON file with exactly these top-level fields: `schema_version: 1`,
`source` (`general_model_recorded` or `hy_memory_recorded`), nonempty
`model_revision` and `runtime`, `data_sha256`, `schema_sha256`, `prompt_sha256`
(copied from the manifest), and `cases`. Each case has `case_id` and `status`:

- `ok`: also provide `output`, the raw parsed writer JSON object with `suggestions`
  and `candidate_namespaces` arrays. The importer computes all metrics itself.
- `error`: omit `output`; the report uses a fixed provider failure message. Keep
  provider diagnostics outside the recording instead of importing raw exceptions.
- `not_run`: omit `output`; case metrics remain null.

Include every case explicitly; missing, duplicate or unknown case IDs produce report
errors. Extra metadata, case fields and caller-provided metrics are rejected.
Malformed raw writer output produces an explicit scored-case error. Read the chosen
regular JSON file (maximum 8 MiB) and print the report on stdout:

```bash
node --import tsx benchmark/proposal-eval/recorded.ts --input /absolute/path/recorded-run.json
```

The CLI has no default input, output files, database or network calls. Unsupported
arguments and invalid recordings fail with a nonzero exit code; valid recordings
can still yield a report with `status: error` for failed or malformed cases. Partial
runs retain the full dataset denominator and null metrics for unrun cases. Every
report keeps human review pending, factual precision/recall and correction effort
unmeasured, hardware results not run, and `publication_eligible: false`.
