# Skills in Munin — Debate Summary

**Date:** 2026-03-15
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** Storing Claude Code skills in Munin Memory for cross-platform, cross-model portability

## Outcome

**The original proposal was rejected.** Building a general skill portability system — with auto-indexing, semantic discovery, platform adaptations, and a capability-aware execution layer — is not justified for an 8-skill library where only 2-3 have portable cores.

**A much narrower approach survives:** manually curate 1-2 portable sub-artifacts (e.g., email style profile) for specific cross-environment needs, tested with a concrete consumer before generalizing.

## Concessions accepted by both sides

| Point | Claude conceded | Codex accepted |
|-------|----------------|----------------|
| "Model-agnostic prompt" is a leaky abstraction | Yes — skills are prompt + runtime + tools + references | Yes — portable playbook/derivative is the right framing |
| General system not worth building | Yes — 2-3 portable entries don't justify a pipeline | Yes — curated approach is better |
| "Single source of truth" was false | Yes — local canonical, Munin is cache | Yes |
| `documents/*` is wrong namespace | Yes — different trust/retrieval semantics | Yes |
| No provenance/staleness mechanism | Yes | Yes |

## Defenses accepted by Codex

- The core insight (some laptop-only knowledge should be accessible from mobile/web) is valid
- Codex's own alternatives (A, C, D) are better implementations of the same underlying idea
- At 2-3 curated entries, capability drift and tag rot are manageable
- Name-based retrieval (not semantic discovery) is appropriate for operational content

## Unresolved disagreements

1. **Security severity:** Claude argues agent guardrails provide defense-in-depth; Codex says that's insufficient without a trust model for who publishes, how consumers verify approval, and what "untrusted instruction" means operationally. Neither side fully resolved this.

2. **Whether a new namespace is worth it:** Codex argues 2-3 artifacts don't justify the design overhead of `playbooks/*` conventions. Claude conceded `documents/*` was wrong but didn't address whether any namespace is warranted at this scale.

## New issues from Round 2

- Manual curation shifts the canonical source problem (from sync to editorial divergence)
- The revised proposal bundles dissimilar artifact types (playbooks, sub-artifacts, metadata) without resolving which pattern to use
- Demand from other agents is still assumed, not demonstrated

## Final verdict

| | Position |
|---|---------|
| **Claude** | Retreat to manually curated portable playbooks, extract sub-artifacts, no automation |
| **Codex** | Even the revised proposal is premature as a *system*. Start with one artifact, one consumer, one success criterion. If it works, consider generalizing. |
| **Consensus** | Don't build infrastructure. Write one portable sub-artifact (email style profile) into an existing namespace. See if any non-laptop agent actually uses it. |

## Action items

1. **Experiment:** Write the email style profile as a standalone Munin entry (no new namespace needed). Test retrieval from Claude Desktop/Mobile.
2. **Validate demand:** Does a non-laptop agent actually use the retrieved content to produce better output?
3. **Defer everything else:** No `/index-skills`, no `playbooks/*` namespace, no capability metadata, no provenance system — until the experiment proves value.

## Debate files

- `debate/skills-in-munin-claude-draft.md`
- `debate/skills-in-munin-claude-self-review.md`
- `debate/skills-in-munin-codex-critique.md`
- `debate/skills-in-munin-claude-response-1.md`
- `debate/skills-in-munin-codex-rebuttal-1.md`
- `debate/skills-in-munin-critique-log.json`
- `debate/skills-in-munin-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |
