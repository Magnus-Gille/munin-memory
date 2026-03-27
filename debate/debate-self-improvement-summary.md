# Debate Summary: Self-Improvement Mechanisms for /debate-codex

**Date:** 2026-03-27
**Participants:** Claude (Sonnet 4.6) vs Codex (gpt-5.4)
**Rounds:** 2
**Critique points:** 13

---

## What was debated

Whether and how to make the `/debate-codex` skill self-improving — feeding signal from past debates back into future ones. Claude proposed four mechanisms: retrospective validation (Step 12), blind spot accumulation in Munin, a critique specificity score, and false positive rate tracking.

---

## Concessions accepted by Claude

- **Retrospective validation is structurally broken as proposed.** No trigger, no session continuity, gitignored artifacts. Only viable if open items are written to Munin at debate close (but that creates a new dependency not currently in the skill).
- **Specificity score dropped entirely.** Gameable, incentivizes wrong behavior, measures form not quality.
- **Catch rate is unsafe for longitudinal comparison.** The denominator moves with Codex exhaustiveness, not just self-review quality.
- **False positive rate is conceptually muddled.** "Not validated in implementation" conflates avoided failures, design changes, and latent risks with actual false alarms.
- **Blind spot accumulation collapses into the simpler alternative.** Once made mandatory and topic-specific, it's just a topic-specific checklist — which is what Codex proposed independently.
- **The `impact` field already exists and was missed entirely.** The draft proposed four new mechanisms without first analyzing the signal already captured in 17 existing critique logs.

## Concessions accepted by Codex

- **The revised priority order is materially better than the original.** Shifts from speculative post-hoc calibration to immediate behavior change.
- **Topic variance doesn't kill coarse topic-specific checklists.** The global blind-spot critique doesn't rule out partitioned checklists by debate type.

## Defenses that held

- **Stronger draft structure (mandatory sections) is the highest-leverage mechanism.** Both sides agree: mandatory `assumptions`, `failure modes`, `alternatives rejected`, `unknowns` sections in every draft improve the substrate before self-review and before Codex critique. Higher leverage than retrospective machinery.
- **The core problem statement is right.** The skill accumulates data but doesn't feed it back. The INDEX proves this — 19 debates, ~25% average catch rate, no mechanism that acts on it.

## Unresolved

- Whether retrospective validation is worth the Munin coupling it now requires. Codex notes this is a new architecture dependency; the question is whether it's worth it.
- Whether the `impact` field should be schema-normalized across existing logs before being used as a metric (Codex: yes; Claude: acknowledged but not addressed).

## New issues surfaced in Round 2

- **New Munin coupling.** Claude's revised retrospective proposal (write open items to Munin → surfaces in `memory_orient`) introduces a dependency that doesn't currently exist in the skill.
- **Schema drift in impact field.** Existing logs contain `deferred`, `partially_changed`, `reframed` values beyond the three specified in the skill. Normalization needed before metric use.

---

## Final verdict

**Both sides agree:** The single most important change to `/debate-codex` is to harden the pre-Codex baseline — not add retrospective telemetry.

Concretely:
1. **Mandatory draft sections:** Every draft must include `assumptions`, `failure modes`, `alternatives rejected`, and `unknowns` before self-review runs.
2. **Topic-specific Step 2 checklist:** Replace the freeform self-review with a mandatory checklist partitioned by debate type (security, architecture, protocol, docs/process, priority).
3. **Use existing `impact` data:** Analyze the 17 existing critique logs using the `impact` field before adding new instrumentation. Normalize the schema first.

Items 4–6 from Claude's revised priority (Munin trigger, precision proxy, false positive rate) are either unproven or create new dependencies. Leave them until the top 3 show results.

---

## Action items

| Item | Owner | Notes |
|------|-------|-------|
| Add mandatory sections to draft template in skill | Claude | `assumptions`, `failure modes`, `alternatives rejected`, `unknowns` |
| Add topic-specific Step 2 checklist to skill | Claude | Coarse buckets: security, architecture, protocol, docs/process, priority |
| Normalize `impact` field schema in existing critique logs | Claude | Add `deferred`, `partially_changed`, `reframed` as valid values OR map to original three |
| Analyze `impact` field across 17 existing logs | Claude | Before adding new metrics |

---

## Debate files

- `debate/debate-self-improvement-claude-draft.md`
- `debate/debate-self-improvement-claude-self-review.md`
- `debate/debate-self-improvement-codex-critique.md`
- `debate/debate-self-improvement-claude-response-1.md`
- `debate/debate-self-improvement-codex-rebuttal-1.md`
- `debate/debate-self-improvement-critique-log.json`
- `debate/debate-self-improvement-summary.md` (this file)

---

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~4m             | gpt-5.4       |
| Codex R2   | ~3m             | gpt-5.4       |
