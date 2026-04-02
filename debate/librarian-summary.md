# Librarian Architecture — Debate Summary

**Date:** 2026-04-02
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Artifact:** `docs/librarian-architecture.md`
**Topic:** Data classification & transport-aware access control for Munin Memory

---

## Concessions Accepted by Claude

1. **Derived tools must filter BEFORE synthesis (C02, critical).** `memory_resume`, `memory_commitments`, `memory_patterns`, `memory_handoff`, and `memory_narrative` cannot post-redact synthesized output — they must exclude over-classified sources from the input. New `filterSourcesByClassification()` helper required.

2. **Namespace classification floors must be data-driven (C04, major).** Hard-coded namespace defaults in application code will drift and fail open for new namespaces. Moved to a `namespace_classification` DB table managed via `munin-admin`.

3. **Mandatory classification audit before enforcement (C08, major).** `projects/*` entries (the most surfaced namespace) default to `internal` but likely contain client references. A full inventory and manual review is required before enabling `MUNIN_LIBRARIAN_ENABLED=true`. This becomes a Phase 1.5 gate.

4. **`local` transport only via stdio (C10, major).** HTTP connections can never claim `local` transport regardless of admin config. `client-restricted` entries are accessible only through stdio. Hard rule in code.

## Concessions Accepted by Codex

1. **Redaction audit log proves blocking, not absence of leakage.** Claude's scoping of the compliance claim is valid — the log evidences that the system actively blocked classified content.

2. **Stripping explain-mode fields from redacted results.** If scoring, ranking, and retrieval metadata are fully stripped from redacted entries, the query side-channel is closed.

## Defenses Accepted

- Audit logging is useful as evidence of blocking (not comprehensive audit)
- Query explain fields stripped from redacted entries closes that side-channel
- `local` only via stdio is adequate for the `client-restricted` bypass

## Unresolved: Transport Attestation (Critical)

**Codex's central objection, maintained across both rounds:** The `dpa_covered` transport boundary is based on "which credential was presented," not "what environment this request came from." The server cannot distinguish Claude Code (DPA) from a hypothetical mcp-remote Desktop connection (consumer) using the same bearer token.

**Claude's partial response:** Separate bearer tokens per transport class (Option A) is the strongest mechanism. Option B (caller-asserted header) was rejected by Codex as self-labeling. Option C (logging + detection) was rejected as after-the-fact.

**Codex's final verdict:** Don't proceed with other work until the server can mechanically answer: *"What proves this HTTP request is allowed to claim `dpa_covered`?"*

**Resolution needed:** Implement Option A (dedicated credentials per transport class) before enabling enforcement.

## New Issues from Round 2

| # | Issue | Severity | Status |
|---|---|---|---|
| C11 | `redacted_sources` in derived tools creates metadata oracle | Major | Deferred — needs metadata policy for owner vs non-owner |
| C12 | Persisted derivative rows (commitments table) not addressed — reclassification doesn't propagate | Critical | Deferred — needs derivative-data lifecycle spec |
| C13 | Mutable `namespace_classification` table is high-value target | Major | Deferred — needs owner-only mutation, audit logging, startup validation |
| C14 | Separate bearer tokens increase operational burden | Minor | Acknowledged — cost accepted |
| C15 | Partial-failure semantics for multi-source derived tools unspecified | Major | Deferred — needs explicit rule per tool family |

## Architecture Changes Required Before Implementation

Based on both rounds, the architecture document must be revised to address:

1. **Transport attestation mechanism** — dedicated credentials per transport class, not auth-method inference
2. **Pre-synthesis classification filtering** — all derived tools filter sources before processing
3. **Derivative data lifecycle** — how persisted copies (commitments, excerpts) inherit and propagate classification changes
4. **Tiered metadata policy** — owner gets full metadata on redaction; non-owner gets minimal (namespace + reason only)
5. **Namespace floor table** — DB-driven, owner-only, audit-logged, startup-validated
6. **Partial-failure rule** — unknown classification in any source → exclude that source (never full-content fallback)
7. **API contract documentation** — `redacted: true` is a new response state; document per tool
8. **Mandatory pre-enforcement audit** — inventory all entries, review `projects/*` for client PII, gate Phase 2

## Key Statistics

- **Critique points:** 15 total (10 in Round 1, 5 in Round 2)
- **Changed the plan:** 4 (27%)
- **Partially changed:** 4 (27%)
- **Acknowledged:** 3 (20%)
- **Deferred:** 4 (27%)
- **Self-review catch rate:** 2/15 (13%) — most critical findings were NOT caught by self-review
- **Critical findings:** 3 (C01: transport attestation, C02: derived tool leakage, C12: persisted derivatives)

## Debate Files

- `debate/librarian-snapshot.md` — frozen architecture document
- `debate/librarian-claude-draft.md` — Claude's position with assumptions/failure modes/alternatives
- `debate/librarian-claude-self-review.md` — Claude's self-critique (security + architecture checklists)
- `debate/librarian-codex-critique.md` — Codex Round 1 critique (10 findings)
- `debate/librarian-claude-response-1.md` — Claude's response with concessions and defenses
- `debate/librarian-codex-rebuttal-1.md` — Codex Round 2 rebuttal (5 new issues)
- `debate/librarian-critique-log.json` — Structured log of all 15 critique points
- `debate/librarian-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~3m             | gpt-5.4       |
