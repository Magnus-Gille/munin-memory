# Debate Summary: Claude Information Handoffs

**Date:** 2026-03-06  
**Participants:** Codex and Claude Sonnet 4.6  
**Rounds:** 2

## Question

What is the best and most effective way to give information to Claude, given Magnus's mix of repo-local files, skills, `inbox/` experiments, and Munin memory?

## Concessions accepted by both sides

- `inbox/` should not be treated as the default architectural layer unless it has real naming, lifecycle, and cleanup conventions.
- Discovery must be explicit outside `CLAUDE.md`; when a handoff file exists, the invoking prompt or task description must point Claude to it.
- `ask-claude` and `handoff-claude` are different skills serving different problems.
- Munin must be part of the handoff design for cross-device continuity, not just a place for abstract summaries.

## Defenses accepted by Claude

- The layered model is still the right top-level frame if it is turned into an explicit decision procedure rather than left as a channel taxonomy.
- A generic `inform-claude` skill is still too vague as a default abstraction; skills should correspond to repeated workflows rather than the abstract act of "sending information."

## Unresolved disagreements

No major unresolved disagreement remained after Round 2. The main residual clarification was wording: the final recommendation needed to state the handoff-file discovery rule explicitly.

## Final verdict

The best practical default is:

1. Use `CLAUDE.md` for what Claude should always know.
2. Use Munin `projects/<name>/status` (and related summary entries) for current task state and decisions that must survive environment switches.
3. Use a structured handoff file only when the payload is too large or too structured for Munin, and explicitly point Claude to that file in the invoking prompt.
4. Treat `inbox/` as an optional convention for such handoff files, not as architecture by default.
5. If adding one new skill first, build `ask-claude`, not `inform-claude` or `command-claude`.

## Recommended next step

Create an `ask-claude` skill first. It has immediate value because it can encode reliable headless Claude invocation, auth checks, stdin prompting, and the zero-MCP fallback. Revisit a `handoff-claude` skill only if structured handoff files become a repeated operational pain point.

## Action items

- Magnus/Codex: treat `CLAUDE.md` + Munin as the default pair for informing Claude.
- Magnus/Codex: only formalize an `inbox/` convention if repeated handoff volume justifies lifecycle rules.
- Codex: when designing the future `ask-claude` skill, include the headless-Claude findings from this session.

## Debate files

- `debate/claude-information-handoffs-snapshot.md`
- `debate/claude-information-handoffs-codex-draft.md`
- `debate/claude-information-handoffs-codex-self-review.md`
- `debate/claude-information-handoffs-claude-critique.md`
- `debate/claude-information-handoffs-codex-response-1.md`
- `debate/claude-information-handoffs-claude-rebuttal-1.md`
- `debate/claude-information-handoffs-critique-log.json`
- `debate/claude-information-handoffs-summary.md`

## Costs
| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Claude R1  | ~1m             | claude-sonnet-4-6 |
| Claude R2  | ~1m             | claude-sonnet-4-6 |
