# Agent-memory scorecard

This directory defines Munin's Phase A end-to-end LongMemEval-S scorecard. It
composes the shipped adapter, retrieval runner, and answer-quality harness; it
does not implement a second retrieval or QA stack.

The current contract is
[`contracts/longmemeval-s-v2.json`](./contracts/longmemeval-s-v2.json). Its raw
bytes are SHA-256 stamped into every report. The original unpublished
foundation remains frozen as
[`contracts/longmemeval-s-v1.json`](./contracts/longmemeval-s-v1.json).

## Deterministic smoke

```bash
npm run scorecard:smoke
```

The smoke profile is offline and uses the two-question committed LongMemEval
fixture, lexical/raw retrieval, and fixture-specific deterministic reader and
judge stubs. It proves adapter ingestion, per-question retrieval,
budgeted-context serialization, answer generation, judging, trust probes,
uncertainty, and combined report persistence. Its answer score is a pipeline
assertion—not model quality—and it is always `publication_eligible: false`.

Generated databases and unpublished reports remain under gitignored
`benchmark/generated/` and `benchmark/reports/`.

## Full on-demand run

```bash
OPENROUTER_API_KEY=... npm run scorecard:longmemeval:s
```

The command downloads LongMemEval-S and fails closed before the paid suite
unless all of the following hold:

- exactly 500 unique, dated, per-question-scoped questions have references;
- hybrid embeddings and the production ranker are available without fallback;
- the evaluation runs from a clean, identified Git commit;
- the OpenRouter key preflight succeeds and no custom gateway overrides the
  pinned provider policy;
- deterministic namespace/classification and instruction-boundary probes pass;
- a live poison challenge returns the stored fact instead of the attacker value.

The v2 contract pins the OpenRouter model slugs, temperature, output ceilings,
top K, an 8,192 estimated-token retrieved-context budget, and a deterministic
bootstrap policy. Every provider response must return its actual model,
provider, native token counts, and charged cost. The report includes all 500 raw
retrieval and answer results, stage latency, peak process RSS, generated disk
footprint, provider cost, environment and Git lineage, trust-lane evidence, and
95% bootstrap intervals.

The paid caller uses bounded exponential retry for explicit OpenRouter 429/503
responses and the two narrow Node fetch transport failures observed during the
full run (`fetch failed` and `terminated`). Every retry is recorded in the
report and dated publication summary. Other errors remain fail-closed.
OpenRouter notes that upstream prompt processing can sometimes be charged when
no response is returned, so a report with transport retries includes that
account-level cost limitation while continuing to reconcile every successful
raw call against provider-reported cost.

The pre-call context estimator is `ceil(UTF-8 bytes / 4)`. Anthropic does not
publish its tokenizer, so the report clearly separates that conservative
enforcement estimate from provider-native prompt tokens used for billing.

## Publish a completed run

```bash
npm run scorecard:publish -- \
  --report benchmark/reports/scorecard/<generated-report>.json
```

Publication validates the complete 500-question report again, rejects dirty or
missing Git lineage, missing provider identity/cost, failed trust lanes,
over-budget contexts, machine-local absolute paths, and secret-shaped content.
It then writes a raw report plus dated Markdown summary under
`benchmark/scorecard/results/<run-date>/`, ready for review and commit.

The result remains a Munin Phase A result, not an apples-to-apples competitor
claim. Retrieval recall and final-answer accuracy remain separate nested
reports. See
[`COMPETITOR-NEUTRALITY.md`](./COMPETITOR-NEUTRALITY.md) for the optional
Phase B policy.
