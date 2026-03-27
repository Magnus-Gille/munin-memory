# Munin Discoverability — Debate Summary

**Date:** 2026-03-27
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** How to surface important reference entries (soul doc, profile) across all environments

## Outcome

**Agreed design:**

1. **Data-driven reference index** at `meta/reference-index` — JSON content with version, namespace/key pairs, titles, and `when_to_load` hints.
2. **Separate `references` field** in `memory_orient` response — not inside conventions, not inside namespaces.
3. **Conditional loading** — orient returns short headers only. Full content loaded via `memory_read` when the task warrants it.
4. **Any environment can update** — adding/removing references is a Munin write, not a code deploy.
5. **Defensive parsing** — if `meta/reference-index` is missing or malformed, omit `references` rather than failing orient.

**Stored format:**
```json
{
  "version": 1,
  "references": [
    {
      "namespace": "people/magnus",
      "key": "profile",
      "title": "Magnus profile",
      "when_to_load": "Use for collaboration style, background, and user-specific guidance"
    },
    {
      "namespace": "meta",
      "key": "mgc-soul",
      "title": "MGC soul",
      "when_to_load": "Use for proposals, opportunity evaluation, offers, values, and positioning"
    }
  ]
}
```

**Orient response shape:**
```json
{
  "references": {
    "entries": [...],
    "updated_at": "..."
  }
}
```

## Secondary finding: compactConventions() is lying

The function claims to derive a compact version from the full conventions (takes `full` as a parameter, comment says "single source of truth"), but **never uses `full`** — it emits a static hardcoded string. This should be fixed: remove the unused parameter and correct the documentation. Not part of the discoverability fix, but exposed by the debate.

## Key arguments that changed Claude's position

- Hardcoding pointers in `compactConventions()` requires code deploy to update — backwards for cross-environment model
- `memory_orient` already has a pattern for sibling orientation fields (notes, dashboard) — references fits there
- Claude's proposal was unconditional, contradicting user's explicit "pull in when needed" preference
- One extra `readState()` is trivial next to the 5+ reads orient already does

## Debate files

- `debate/munin-discoverability-claude-draft.md`
- `debate/munin-discoverability-claude-self-review.md`
- `debate/munin-discoverability-codex-critique.md`
- `debate/munin-discoverability-claude-response-1.md`
- `debate/munin-discoverability-codex-rebuttal-1.md`
- `debate/munin-discoverability-critique-log.json`
- `debate/munin-discoverability-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |
