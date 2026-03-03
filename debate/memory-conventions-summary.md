# Debate Summary: Memory Conventions & Two-Layer State Model

**Date:** 2026-02-26
**Participants:** Claude (Opus 4.6, proponent) vs Codex (GPT-5.3, adversarial reviewer)
**Rounds:** 2
**Topic:** Redesign of Munin Memory conventions to support cross-environment consistency

## Concessions Accepted

1. **Layer framing clarified** — "Two-layer" renamed to "two data layers + dashboard index" for accuracy.
2. **Update threshold tightened** — Changed from "always update Munin" to "update when code was committed or decision was made; skip pure Q&A." Aligns global CLAUDE.md with /close skill.
3. **Concurrent write risk acknowledged** — Added read-before-write discipline to conventions. Log decisions before writing status updates.
4. **Staleness check added** — Project status entries older than 14 days flagged as potentially stale on read.

## Defenses Accepted by Codex

1. **Reject single-layer collapse** — Local files provide speed, reliability, git-tracking, and interoperability that Munin-only can't match. Codex accepted this as a "strong defense."
2. **Environment-specific handshake branches justified** — Capability asymmetry across environments makes branching unavoidable.
3. **Tool descriptions as guidance, not enforcement** — Defense-in-depth approach acknowledged as correct framing.
4. **Security scoping** — Out of scope for this design debate; stays on roadmap.

## Unresolved Disagreements

1. **Convention staleness checking on Mobile/Web** — Codex wants deterministic checks; Claude argues cost exceeds risk for quarterly-changing conventions. Claude's position: maintain current approach.
2. **Mobile project creation determinism** — Codex wants a compensating interaction pattern; Claude argues this is a model behavior issue, not a system design gap. Claude's position: tool descriptions + conventions are sufficient; will monitor in practice.
3. **Write quality consistency** — Codex argues status update quality will degrade across sessions/models; Claude argues a specific template ("1-3 sentences: phase, what changed, blockers") mitigates this. Partially resolved by the structured write protocol.

## Codex's Recommended Next Step (Accepted)

**Implement a deterministic status write protocol with three steps:**
1. **Read-before-write** — Always `memory_read` the current status before writing. If `updated_at` is newer than expected, warn instead of overwriting.
2. **Structured status template** — Define required fields for the brief Munin summary (phase, current work, blockers).
3. **Log-first discipline** — Log decisions before updating status, so the append-only record survives any overwrite.

## Claude's Overrides (as primary user)

- **MC-C06 (convention staleness):** Rejected. Conventions change rarely; the universal channel (tool descriptions) carries stable patterns. Full convention reads are optional deep-dives.
- **MC-C07 (single-layer collapse):** Rejected. Local files are faster, more reliable, and more interoperable.
- **MC-C14 (mobile capture determinism):** Rejected as a system design change. Accepted as something to monitor operationally.

## Action Items

| # | Action | Owner | Priority |
|---|--------|-------|----------|
| 1 | Add read-before-write + conflict warning to `/close` step 7 and `meta/conventions` | Claude | Now |
| 2 | Define structured Munin status template (required fields) in conventions | Claude | Now |
| 3 | Add log-first discipline to end-of-session conventions | Claude | Now |
| 4 | Align update threshold wording across global CLAUDE.md and /close | Claude | Now |

## All Debate Files

- `debate/memory-conventions-brief.md` — Change description
- `debate/memory-conventions-claude-draft.md` — Claude's position
- `debate/memory-conventions-claude-self-review.md` — Self-critique
- `debate/memory-conventions-codex-critique.md` — Codex Round 1
- `debate/memory-conventions-claude-response-1.md` — Claude's response
- `debate/memory-conventions-codex-rebuttal-1.md` — Codex Round 2
- `debate/memory-conventions-critique-log.json` — Structured critique log
- `debate/memory-conventions-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1 | ~2m | gpt-5.3-codex |
| Codex R2 | ~1m | gpt-5.3-codex |
