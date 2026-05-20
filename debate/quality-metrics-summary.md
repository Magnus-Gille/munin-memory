# Debate Summary: Automatic Quality Metrics for Hill-Climbing Munin

- **Date:** 2026-05-20
- **Participants:** Claude (Opus 4.7), Codex (gpt-5.5, xhigh)
- **Rounds:** 2 (converged)
- **Topic type:** architecture + priority
- **User constraint:** "Actionable concrete stuff to do, not just rejection of the premise. I want a plan, not an anti-plan." — debate framed so every rejection required a counter-proposal; final verdict IS a numbered buildable plan.

## The claim under test

Build an offline evaluation harness producing two independent scorecards
(retrieval quality + consolidation faithfulness) as a hill-climbing fitness
function and merge gate. Human stays the optimizer; no closed-loop automation
(carrying the 2026-04-08 telemetry-debate boundary forward).

## Outcome

The architectural direction survived. **Most of Claude's seven-deliverable
draft was rewritten** based on facts Claude missed: `munin-zero#6` is already
closed by pilot v3c, a benchmark runner already exists in `benchmark/`, and
several plumbing items (MAX-as-p95 labeling, faithfulness-judge controls) were
under-specified. Codex's reworked 9-step plan with a stop checkpoint was
adopted with three refinements verified in Round 2.

### Concessions accepted by both sides

1. **D1 was redundant** — `munin-zero#6` is closed by pilot v3c (commit
   `ad4baff`). The right D1 is a reconciliation manifest, not a fresh label
   project.
2. **D2 was redundant** — `benchmark/runner.ts`, `scorer.ts`, and the
   `MUNIN_BENCHMARK` test path already exist. Extend, don't duplicate.
3. **`retrieval_events` is a candidate-source, not a label-source** — no
   source-class column; filter-only pseudo-queries logged; reformulation rate
   inflated by single-event HTTP sessions until #31/#32 fixed.
4. **D3 needs three variants** (tiebreaker / weighted blend / docs+API
   correction with weight removed), with worst-10 changed-result inspection
   on top of aggregate nDCG.
5. **Two-primaries-never-blended needs schema enforcement**, not prose: lint
   test fails on aggregate scalar fields.
6. **Faithfulness judge plan was not defensible as drafted** — adopt claim-level
   rubric (`supported`/`contradicted`/`not_in_sources`/`overgeneralized`),
   pinned model+prompt checksum, re-audit triggers on input change,
   deterministic coverage/compression/stability/recency separated from judge.
7. **Historical consolidation replay is fragile** — `consolidation_metadata`
   stores cursor/model/duration only. Use hand-built v0 fixtures + #51-style
   exported fixture instead of generalized replay.
8. **`db.ts:2151` labeling bug** — `MAX(response_size_bytes)` is labeled
   `p95_response_size_bytes`. Must be fixed (or renamed) before any scorecard
   uses that field.
9. **Phase 1 cut to retrieval baseline + recency decision only**, with explicit
   stop condition: if PR 4 produces no merged ranking change / docs+API
   correction / documented no-change decision, the project pauses; D6+ do not
   auto-trigger.

### Refinements verified in Round 2

- **R1 (PR 0 for label bug):** valid; scope = compute real p95 OR rename field;
  prereq for live guardrails only, not the offline benchmark (measure per-query
  latency directly).
- **R2 (PR 2 converges with #19):** valid but conditional — the done condition
  must include LongMemEval/LoCoMo running through the same corrected runner
  path; otherwise it's priority rhetoric.
- **R3 (stop condition):** valid and necessary; written into PR 4 decision
  artifact and copied into status.

### Round 2 new findings

- **C10 — "actionable" needs definition** (merged ranking / merged docs+API /
  documented no-change; "no useful signal" pauses).
- **C12 — #19 convergence is load-bearing** — must be a done condition, not
  rhetoric.
- **C13 — 75-second `memory_insights` figure is real but is a tool-call
  telemetry aggregate over tiny N** (3–4 calls), not a p95 and not a retrieval
  guardrail. Treat as performance lead, not benchmark metric. Claude was right
  that the number exists; wrong to treat it as a guardrail threshold.
- **C14 — status/synthesis drift** — status already corrected; synthesis stale.
  Benchmark lineage belongs in source-controlled manifest, not memory entries.

### Unresolved disagreements

None of substance. Convergence was clean.

## Final Agreed Plan

| # | Type | Description | Definition of Done |
|---|---|---|---|
| **PR 0** | Plumbing | Fix tool-call telemetry aggregate labeling | `getToolCallAggregates` computes a real p95 OR field is renamed `max_response_size_bytes`; tests/docs/consumers updated; no scorecard uses the false `p95` label |
| **PR 1** | Reconciliation | Retrieval benchmark lineage manifest | `benchmark/queries/retrieval-v1.manifest.{json,md}` references existing JSONLs + munin-zero v3/v3b/v3c (commit `ad4baff`), source snapshots, target IDs, strata, source class, dedupe policy, known gaps; records `munin-zero#6` as closed by v3c |
| **PR 2** | Harness | Extend `benchmark/runner.ts` for production-ranker + #19 | R@20, nDCG@20, p50/p95 benchmark duration, query-set version/checksum; production-ranker mode with parity tests vs `memory_query`; LongMemEval-S + LoCoMo adapters run through the same corrected path |
| **Artifact 3** | Data | Freeze retrieval v1 baseline | ≥50 deduped human-audited Munin-native cases with relevance grades + source classes (or explicit gap statement); compact current-main baseline report committed; LongMemEval/LoCoMo results stored as proxy annex, not primary gate |
| **PR/Artifact 4** | Decision | Recency-weight decision | `decisions/retrieval-recency-blend.md` compares current tiebreaker / normalized blend / docs+API correction on retrieval v1; aggregate + per-stratum metrics; p95 duration; changed top-20 examples; ranking change merges only if no authority/staleness regressions, otherwise docs+API correction or no-change |
| **Checkpoint** | Gate | Stop or continue deliberately | Status records: merged ranking change, merged docs+API correction, or documented no-change. If "no useful signal" → project pauses; PRs 7–9 do not start without owner decision |
| **PR 5 (cond.)** | Schema | Report-only scorecard schema enforcement | Separate retrieval and consolidation primary fields, no aggregate scalar, lint test fails on blended fields; retrieval comparison runs report-only until thresholds approved |
| **Artifact 6 (cond.)** | Audit | Minimal consolidation audit protocol | `eval/consolidation/v0/`: 12 cases (4 ordinary, 3 planted contradictions, 2 #51-style, 2 sparse, 1 multilingual), 60–80 audited claims (claim-level rubric), Magnus-owned gold labels, `judge-audit.md` with precision/recall |
| **PR 7 (cond.)** | Scorer | Consolidation scorer | Only after Artifact 6 meets recall ≥ 0.90 + precision ≥ 0.80 for unsupported/contradicted detection; deterministic coverage/compression/stability/recency on v0 cases; faithfulness judge pinned by model+prompt checksum; #51 outage as explicit fixture |

## Action items

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | File PR 0 (telemetry labeling fix) | Magnus | proposed |
| 2 | File PR 1 + PR 2 issues on Magnus-Gille/munin-memory | Magnus/Claude | proposed |
| 3 | Update `projects/munin-memory/synthesis` to reflect v3c-closed state | Claude | recommended next session |
| 4 | Add quality-metrics plan reference to status Next Steps | Claude | recommended |

## Debate files

- `quality-metrics-claude-draft.md`
- `quality-metrics-claude-self-review.md`
- `quality-metrics-codex-critique.md`
- `quality-metrics-claude-response-1.md`
- `quality-metrics-codex-rebuttal-1.md`
- `quality-metrics-critique-log.json`
- `quality-metrics-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~7m             | gpt-5.5       |
| Codex R2   | ~6m             | gpt-5.5       |
