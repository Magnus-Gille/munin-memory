# Debate Summary: MemPalace Research Spike Assessment

**Date:** 2026-04-07
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** Whether the MemPalace research spike's recommendations (Scenario C, three techniques to mine, AAAK dismissal, LongMemEval low priority) are justified

## Concessions Accepted by Both Sides

1. **Scenario C is directionally correct** — reject A (run alongside) and B (replace Munin). MemPalace solves conversation retrieval; Munin solves operational memory. Different problems.

2. **Knowledge graph should NOT be Priority 1** — the roadmap explicitly puts temporal KG out of scope for current phases. The motivating query was hypothetical, not evidence-based. Demoted to design exploration for later.

3. **Benchmark before tuning** — importing search ideas from MemPalace before measuring Munin's own retrieval quality is cargo-cult tuning. Move baseline evaluation ahead of any retrieval imports.

4. **Opportunity cost is real** — every imported idea must pass a roadmap displacement test. The report understated competition with Phase 1-3 work, Sara onboarding, Librarian rollout, and Hugin fixes.

5. **The report missed more thesis-aligned ideas** — layered loading, provenance, extraction patterns are closer to Munin's continuity mission than the architecturally ambitious KG.

## Defenses Accepted by Codex

- The comparative analysis (8 dimensions) is solid and well-grounded.
- The benchmark reading is disciplined and honest.
- The negative case against Scenarios A and B is well-earned.

## Unresolved Disagreements

- **Verbatim storage:** Claude considers it low-cost and worth having eventually. Codex considers it insufficiently justified (no evidence of frequency, operational burden underpriced). Remains a hypothesis, not a next action.
- **AAAK for orient packing:** Both agree it's not for search/storage. Disagree on whether the orient payload problem warrants a packing experiment (Claude: maybe) vs. just reducing low-value content (Codex: fix the obvious thing first).

## New Issues from Round 2

1. **Need a decision framework** — checklist for evaluating any imported idea: which phase does it advance, which pain point does it address (with evidence), what metric would move, what breaks on failure, how easy is rollback.
2. **Munin-native evaluation harness > LongMemEval** — LongMemEval is a proxy with known mismatch. The real measurements are: does retrieval return relevant entries for real Munin queries, does resume reduce manual re-explanation, does first-response usefulness improve.
3. **Coupling and reversibility costs underpriced** — namespace scoring couples quality to namespace hygiene, verbatim couples to transcript retention, packing couples to model parsing. More coupling forecloses Munin remaining a clean operational memory layer.
4. **Silent degradation risk** — proposed imports fail opaquely rather than fast: namespace scoring loses recall silently, verbatim grows storage slowly, packing degrades model-dependently.

## Final Verdict (Both Sides)

**Codex:** The single most important next step is not to pick a MemPalace-inspired feature. It is to create and run a small Munin-native evaluation harness for Phase 1 and Phase 2 questions before any import work is promoted.

**Claude:** Agrees. Revised ordering:
1. Define a thin real-query evaluation set tied to Munin use cases
2. Measure current retrieval and resume behavior
3. Fix obvious compact-payload bloat directly
4. Only then consider bounded experiments (namespace boosting, etc.)
5. KG, verbatim, packing remain design exploration for later phases

## Action Items

| Action | Owner | Priority |
|--------|-------|----------|
| Design Munin-native evaluation harness (real queries, session-start quality, first-response usefulness) | Next sprint | High |
| Run LongMemEval as secondary proxy benchmark (2-3 day adapter) | After harness | Medium |
| Investigate orient compact payload bloat — reduce low-value content before considering packing | Current roadmap | High |
| Create import evaluation checklist (phase fit, pain point evidence, metric, failure mode, rollback) | Immediately | High |
| Monitor MemPalace development for access control / multi-user additions | Ongoing | Low |
| Knowledge graph design exploration | After Phase 2 | Low |

## All Debate Files

- `debate/mempalace-spike-snapshot.md` — frozen copy of the research report
- `debate/mempalace-spike-claude-draft.md` — Claude's initial position
- `debate/mempalace-spike-claude-self-review.md` — Claude's self-critique
- `debate/mempalace-spike-codex-critique.md` — Codex Round 1 critique
- `debate/mempalace-spike-claude-response-1.md` — Claude's response
- `debate/mempalace-spike-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/mempalace-spike-critique-log.json` — structured critique log (13 points)
- `debate/mempalace-spike-summary.md` — this file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1 (attempt 1) | ~3m (failed to write file) | gpt-5.4 |
| Codex R1 (attempt 2) | ~3m | gpt-5.4 |
| Codex R2 | ~3m | gpt-5.4 |
