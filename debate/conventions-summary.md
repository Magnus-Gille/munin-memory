# Debate Summary: meta/conventions Improvement

**Date:** 2026-02-16
**Participants:** Claude (Opus 4.6), Codex (GPT-5.3)
**Rounds:** 2
**Topic:** Is the `meta/conventions` memory entry sufficient for cross-environment coherence?

## Concessions accepted by both sides

1. **Split-brain prevention is the #1 precondition** — all environments must connect to the same backend. Without this, no conventions matter. (C08)
2. **Preview safety rule needed** — never act on truncated previews; always fetch full entries before writing or making decisions. (C09)
3. **Document must stay compact** — ~60-80 lines, operational contract not governance manual. (Claude self-review + Codex R1)
4. **Canonical tag vocabulary needed** — suggested list, not enforced, but defined to reduce drift. (C02)
5. **Discoverability guidance needed** — standardized lookup sequence for new sessions. (C04)
6. **Session Handshake is the highest-leverage addition** — consolidates split-brain prevention, discovery, preview safety, and search-mode consistency. (C12)

## Defenses accepted by Codex

1. **Lightweight versioning** — `Last updated: YYYY-MM-DD` in content is sufficient (no formal version number needed). (C06)
2. **Self-review fairness** — Claude distinguished concurrent-write risk (minor) from split-brain config risk (critical); this was a valid distinction.

## Unresolved disagreements

1. **Search-mode pinning** — Codex wants conventions to mandate explicit `search_mode` on every query. Claude argues this is deployment config, not conventions. Codex's Round 2 rebuttal is persuasive: since search mode affects result membership (not just ordering), it belongs in conventions. **Resolution: adopt Codex's position — add to Session Handshake.**
2. **Conflict resolution depth** — Codex wants more than "read before write." Claude maintains this is sufficient for single-user. Both agree split-brain is the real risk. **Resolution: keep read-before-write, add split-brain precondition, defer formal conflict resolution to multi-user future.**

## New issues from Round 2

1. **Factual error** — Claude incorrectly claimed `writeState` uses `ON CONFLICT ... DO UPDATE`. Actual implementation is `SELECT` then `INSERT`/`UPDATE` in transaction. Corrected in understanding; no impact on conventions content. (C14)
2. **Internal inconsistency** — Claude adopted Session Handshake but initially rejected explicit search-mode pinning, which was part of the handshake. Resolved by fully adopting the handshake. (C13)

## Action items

| # | Action | Owner |
|---|--------|-------|
| 1 | Write revised `meta/conventions` entry incorporating debate outcomes | Claude |
| 2 | Add Session Handshake section (verify backend, read conventions, fetch full entries, explicit search_mode) | Claude |
| 3 | Add canonical tag vocabulary (suggested, not enforced) | Claude |
| 4 | Add preview safety rule | Claude |
| 5 | Add delete governance policy | Claude |
| 6 | Remove stale "future" namespace references | Claude |
| 7 | Keep document compact (~60-80 lines) | Claude |

## All debate files

- `debate/conventions-snapshot.md`
- `debate/conventions-claude-draft.md`
- `debate/conventions-claude-self-review.md`
- `debate/conventions-codex-critique.md`
- `debate/conventions-claude-response-1.md`
- `debate/conventions-codex-rebuttal-1.md`
- `debate/conventions-summary.md`
- `debate/conventions-critique-log.json`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.3-codex |
| Codex R2   | ~2m             | gpt-5.3-codex |
