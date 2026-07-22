# Agent-memory scorecard foundation

This directory defines the unpublished Phase A foundation for Munin's
end-to-end LongMemEval-S scorecard. It composes the shipped retrieval and
answer-quality harnesses; it does not implement a competing retrieval or QA
runner.

The committed contract is
[`contracts/longmemeval-s-v1.json`](./contracts/longmemeval-s-v1.json). Its raw
bytes are SHA-256 stamped into each scorecard report. Both profiles are
deliberately `publication_eligible: false`.

## Deterministic smoke

```bash
npm run scorecard:smoke
```

The smoke profile is offline and uses the two-question committed LongMemEval
fixture, lexical/raw retrieval, and fixture-specific deterministic reader and
judge stubs. It proves that adapter ingestion, per-question retrieval,
answer-generation wiring, judging, and combined report persistence still work.
Its reported answer score is a pipeline assertion, **not model quality or
end-to-end accuracy**, and the report is permanently marked
`publication_eligible: false`.

Generated databases, query files, provenance, and reports remain under the
gitignored `benchmark/generated/` and `benchmark/reports/` trees.

## Full on-demand foundation run

```bash
OPENROUTER_API_KEY=... npm run scorecard:longmemeval:s
```

This command downloads LongMemEval-S, builds the isolated 500-question corpus,
and performs a fail-closed preflight before retrieval or paid model calls. The
preflight requires exactly 500 questions, a reference answer for every
question, a dataset-supplied question date, unique IDs, and a per-question
namespace. It then populates corpus embeddings, runs the production-ranker
hybrid retrieval harness, and runs the existing answer-quality reader/judge
harness over the same query bytes. Reader and judge temperature/output-token
settings are pinned by the contract and recorded in the answer-quality report.
The npm command sets `MUNIN_EMBEDDINGS_ENABLED=true` before the scorecard module
loads, because embedding configuration is resolved at process startup. Direct
programmatic callers must likewise start the process with embeddings enabled
for the hybrid full profile; a disabled runtime fails rather than degrading to
lexical.

This command does **not** publish a result. The foundation report stays
`unpublished_foundation` and `publication_eligible: false`, even after a
successful 500-question run. Raw local output alone is not a product claim.

## Known publication blockers

- Context is limited to top-10 entries; a model-appropriate retrieved-token
  budget is not yet enforced or reported.
- Provider model revisions and full execution-environment metadata are not yet
  pinned in the report.
- Stage-separated latency, peak RAM, disk footprint, monetary cost, repeated
  run variance/confidence intervals, and adversarial authorization/poison lanes
  are not yet present.
- No complete 500-question raw report or dated summary is committed here.

Until those gaps close, retrieval `R@K` remains retrieval recall and must never
be described as answer accuracy. Answer-quality results remain separate inside
the combined report so the two layers stay auditable.
