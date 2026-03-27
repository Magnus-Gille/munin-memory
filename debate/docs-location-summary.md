# Debate Summary: Where should "way of working" documentation live?

**Date:** 2026-03-27
**Participants:** Claude (Sonnet 4.6) vs Codex (gpt-5.4)
**Rounds:** 2

---

## Question debated

Should Munin Memory's "way of working" (session handshake protocol, two-layer state model, namespace conventions, writing principles) live in the repo as `docs/usage-patterns.md` + CLAUDE.md template? Or elsewhere?

---

## What Claude conceded

### C1 — Session choreography does NOT belong in a static repo doc

The draft's handshake description already referenced `meta/workbench`, which was deleted before the debate started. This is direct evidence that session choreography (exact handshake sequence, environment-specific branching, update thresholds, write protocol steps) is too volatile for a static file. It belongs in `meta/conventions`, surfaced at runtime by `memory_orient`.

### C2 — Single-doc approach fails the two-audience test

"Cloner/self-hoster evaluating Munin" and "active Claude session needing an operational contract" need fundamentally different content. One static `docs/usage-patterns.md` trying to serve both collapses into either "too abstract to drive behavior" or "too volatile to be reliable."

### C3 — The 3-layer structure is better than the original proposal

Codex proposed: README framing → repo concepts doc → Munin runtime conventions. This directly routes each audience to the right surface and is materially different from (and better than) a single repo doc carrying everything.

---

## What Codex accepted

### D1 — Some repo-level documentation is justified

`memory_orient` is the right runtime surface but not the only documentation surface needed. A human evaluating, installing, or adapting Munin needs an explanatory layer outside the live memory payload. Repo docs serve install-time and evaluation; Munin serves runtime. These are complementary, not competing.

### D2 — `docs/claude-md-template.md` can exist with proper framing

Permissible if explicitly labeled as an opinionated Magnus-style workflow starter, not a generic product companion. Must not be linked prominently enough to imply normative status.

---

## Final verdict

**Yes to the 3-layer structure, conditionally.**

The revised position holds as the right overall shape. Conditions from Codex:
1. **Layer 2 (`docs/usage-model.md`) needs a hard inclusion test** before being written. A statement belongs in Layer 2 only if it survives tool renames, protocol revisions, and ecosystem changes — i.e., it's a design principle, not an operational rule.
2. **Layer precedence must be explicit:** Layer 3 (Munin conventions) wins for live operational behavior. Layer 2 explains why the system is designed as it is. Layer 1 (README) summarizes.
3. **Namespace taxonomy is a smuggling risk:** `documents/*`, `signals/*`, `digests/*`, `reading/*` are Magnus's ecosystem, not Munin's core semantics. If namespace taxonomy appears in Layer 2, restrict it to the five structural categories (`projects/*`, `clients/*`, `people/*`, `meta/*`, `decisions/*`).

---

## Recommended Layer 2 inclusion test

**Include in `docs/usage-model.md`:**
- State entries vs. log entries (mutable current truth vs. append-only history)
- The concept of two data layers (local execution detail vs. shared summary)
- What tracked statuses are for (computed orientation across environments)
- The state/log discipline (when to use each)

**Exclude from `docs/usage-model.md`:**
- Any session sequence, threshold, or environment branch (→ Layer 3)
- Named runtime artifacts beyond the most fundamental (`memory_orient`, `memory_write`, `memory_log`)
- Freshness thresholds and maintenance triggers (→ Layer 3)
- Full namespace inventory (→ Layer 3 or not at all)
- Mimir URL conventions, Hugin patterns, or other ecosystem-specific content

---

## Unresolved issues

None blocking. The new issues Codex raised (N1–N3) are input constraints for writing Layer 2, not reasons to reject the structure.

---

## Action items

- [ ] Add "Opinionated workflow" section to README (3–5 sentences, link to docs/usage-model.md)
- [ ] Write `docs/usage-model.md` using the inclusion test above — durable concepts only
- [ ] Optionally add `docs/claude-md-template.md` with explicit "opinionated example" framing
- [ ] Keep `meta/conventions` in Munin as the canonical runtime contract (already live)

---

## Debate files

- `debate/docs-location-claude-draft.md`
- `debate/docs-location-claude-self-review.md`
- `debate/docs-location-codex-critique.md`
- `debate/docs-location-claude-response-1.md`
- `debate/docs-location-codex-rebuttal-1.md`
- `debate/docs-location-critique-log.json`
- `debate/docs-location-summary.md` (this file)

---

## Costs

| Invocation | Model |
|------------|-------|
| Codex R1   | gpt-5.4 |
| Codex R2   | gpt-5.4 |
