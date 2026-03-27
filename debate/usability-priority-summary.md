# Usability Fix Priority — Debate Summary

**Date:** 2026-03-27
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** Which Munin Memory usability fix to prioritize after hybrid search fix

## Outcome

**Agreed priority order:**

1. **#3 Compact orient conventions** — `memory_orient` returns ~2,800 words of conventions unconditionally on every session. This is the largest per-session token tax and affects every environment. Make compact-by-default, full on demand.
2. **#1 Task namespace noise** — ~102 task namespaces out of ~160 total pollute `memory_list` and the `memory_orient` namespaces field. Filter completed tasks from default listings (but keep `tasks/admin`, active tasks visible).
3. **#2 Event-aware staleness** — Entries with near-future dates (events) are not flagged despite potentially stale status. Current 14-day threshold doesn't account for time-sensitive content.
4. **#4 Thin people/magnus profile** — Zero-code content work, do opportunistically alongside any fix. Not an engineering priority.
5. **#5 Cross-referencing** — Most complex, least immediate payoff. Hybrid search + tag filters already cover part of the need.

## Key arguments that changed Claude's position

- `memory_orient` is the mandated start-of-session call, not `memory_list`. The conventions payload is paid every session in every environment — this is the more systemic tax.
- Task namespaces don't corrupt the computed dashboard (which only draws from `projects/*` and `clients/*`). They only pollute the auxiliary namespaces appendix.
- Claude's self-review identified the token economics issue but failed to follow it to the correct conclusion.

## Implementation guidance for #3 (from Codex)

- Change `memory_orient` so full conventions are NOT returned by default
- Return a compact operational summary by default (short rules, `updated_at`, pointer to full doc)
- Full conventions available via `memory_read("meta/conventions", "conventions")` or opt-in argument
- **Critical constraint:** Do NOT create two independently maintained convention documents. The compact version must be a controlled derivative of the single source of truth, not a separate doc that can drift.

## Unresolved minor disagreement

Claude wanted to rank #4 as "tie with #3" since it's zero effort. Codex correctly pushed back: cheap sidecar work is not the same as a co-equal engineering priority. Agreed to treat #4 as opportunistic, not bundled.

## Debate files

- `debate/usability-priority-claude-draft.md`
- `debate/usability-priority-claude-self-review.md`
- `debate/usability-priority-codex-critique.md`
- `debate/usability-priority-claude-response-1.md`
- `debate/usability-priority-codex-rebuttal-1.md`
- `debate/usability-priority-critique-log.json`
- `debate/usability-priority-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |
