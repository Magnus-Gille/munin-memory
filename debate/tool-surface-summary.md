# Debate Summary: Munin MCP tool surface — too many tools?

- **Date:** 2026-05-18
- **Participants:** Claude (Opus 4.7), Codex (gpt-5.5, xhigh)
- **Rounds:** 2 (converged; no Round 3 needed)
- **Topic type:** architecture + docs

## The claim under test

Munin registers 22 `memory_*` tools while CLAUDE.md documents ~12. Proposal:
consolidate to ~14 by collapsing session-continuity (orient/resume/handoff/
narrative), analytical (attention/patterns/commitments/history), and status
tools, plus folding read_batch into read.

## Outcome: the consolidation proposal is withdrawn

The architecture case did not survive. Both sides agree.

### Concessions accepted by both sides

1. The context-cost premise is **unmeasured and unfalsifiable as stated** —
   the whole architecture argument rests on an unproven assumption. Munin
   already has per-tool telemetry (`memory_status`, `db.ts` call/error/size/
   duration) that should be measured *before* any refactor.
2. The session-continuity merge **contradicts a recorded design decision**
   (`docs/phase-2-engineering-plan.md`: "Do not overload `memory_orient` with
   targeted resume behavior"). Decisive finding — Claude's own draft never
   acknowledged it.
3. The 22-tool surface was **deliberately planned and shipped** (CHANGELOG,
   README, phase plans 2–4, Munin logs). "Sprawl/accretion" framing was wrong.
4. CLAUDE.md actually has **11 tool rows, not 12**, plus a stale "All 12 MCP
   tools" line. Real defect = doc drift with no enforced single source of truth.
5. Param-mode tools are **not capability-preserving** — they collapse per-tool
   authorization/redaction/test contracts behind one schema.
6. Two factual errors in the original pitch: `memory_status` (server capability
   discovery) and `memory_update_status` (structured CAS write path) were both
   miscategorized as redundant "status sugar."

### Defenses accepted by Codex

- The **doc-drift defect is real and actionable** (the one salvageable finding).
- **read_batch → read** is the only plausible consolidation candidate, but
  non-urgent and gated on measurement.

### Codex Round 2 refinements (new issues)

- Claude **over-conceded**: "migration abandoned" should be "do not consolidate
  *now*" — keep curation alive behind measurement, don't kill it permanently.
- The **doc fix can itself become over-engineering**: generating prose from
  `TOOL_DEFINITIONS` (internal constant, template-literal descriptions) is a
  rabbit hole. Correct fix = hand-fix the table + a CI name-consistency test,
  not a documentation generator.
- **read_batch is not behavior-identical to read today**: read adds synthesis
  freshness metadata + logs `opened_result`; read_batch does neither per-result.
  Safer first step is an internal shared `readOne` helper, public tools stable.

### Unresolved disagreements

None of substance. Convergence was clean.

## Final verdict

**Do not consolidate the tool surface.** The single most important next step is
a narrow docs-drift PR:

1. Hand-fix `CLAUDE.md` to list all 22 registered tools; fix the stale
   "All 12 MCP tools enforce access rules" line (`CLAUDE.md:364`).
2. Add a CI test asserting every registered MCP tool name appears exactly once
   in the CLAUDE.md table (name-inventory contract, not prose generation).
3. Do **not** generate prose, do **not** consolidate APIs, do **not** open the
   read_batch migration until per-tool telemetry shows it is worth the
   compatibility cost.

## Action items

| Action | Owner | Status |
|---|---|---|
| Docs-drift PR: list 22 tools + fix stale line + CI name check | Maintainer | proposed (file GitHub issue) |
| read_batch→read: internal `readOne` helper refactor (no public change) | — | deferred, non-urgent |
| Establish per-tool telemetry baseline before any future curation | — | deferred |

## Debate files

- `tool-surface-claude-draft.md`
- `tool-surface-claude-self-review.md`
- `tool-surface-codex-critique.md`
- `tool-surface-claude-response-1.md`
- `tool-surface-codex-rebuttal-1.md`
- `tool-surface-critique-log.json`
- `tool-surface-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~5m             | gpt-5.5       |
| Codex R2   | ~6m             | gpt-5.5       |
