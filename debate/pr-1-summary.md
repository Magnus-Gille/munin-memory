# PR 1 debate summary — retrieval benchmark lineage manifest

- **Date:** 2026-05-20
- **Participants:** Claude (Opus 4.7), Codex (gpt-5.5 xhigh)
- **Rounds:** 2 (plan critique + PR review with one revision round each)
- **Outcome:** Merged as PR #56.

## Concessions accepted by both sides

Plan-stage (debate/pr-1-codex-critique.md):

- `source_class` constrained to `manual|derived|synthetic` to match the
  existing `BenchmarkQuery.source` enum; editorial role moved to a
  separate `tier` field (`primary|evidence|deprecated`).
- Closure record for `munin-zero#6` expanded with `target_set_id`,
  `target_path`, `target_id_field`, `target_count`, `result_paths[]`
  (with `search_mode`, `limit`, `metric`, `record_count`),
  `evaluation_method`, and the six target UUIDs inline.
- Per-source `strata_breakdown` / `difficulty_breakdown` populated from
  the v3 targets file rather than claiming the data is absent.
- Eight-source list framed as the **v1 freeze** with
  `omitted_artifacts[]` enumerating cited-but-not-indexed files.
- Validator strengthened: exact v1 freeze enforced, sha256 pins on
  every source, native JSONLs parsed against `BenchmarkQuery` shape,
  `ground_truth_kind` cross-checked against actual `expected_ids` /
  `expected_namespaces` usage, plus seven negative tests.
- Explicit "NOT a label store" framing in both JSON `purpose` and
  markdown §2; `citation_format` + `record_key_fields` for
  dereferencing.

PR-review-stage (debate/pr-1-codex-pr-review.md, rebuttal):

- `munin-zero-v2-intents` and `munin-zero-v3-intents` reclassified as
  `derived` (Sonnet intent-writer per the pilot reports). Added
  `source_origin` field naming the model + report.
- `closed_issues["munin-zero#6"]` evidence now includes the v3b
  baseline (`pilot-report-v3b.md` + `pilot-results-v3b-lexical.jsonl`)
  to substantiate the "5/6 vs 0/6" claim.
- Versioning policy rewritten as patch/minor/major tiers consistent
  with the validator-enforced freeze. Adding a source requires a
  minor bump plus updating `EXPECTED_V1_SOURCE_IDS`.
- Maintenance section added to the markdown (owner, three update
  triggers, JSON-vs-markdown conflict rule).
- Test comment no longer claims to be the "single source of truth"
  (the JSON is); CHANGELOG no longer overclaims "Strong validator";
  external munin-zero CI caveat made explicit.

## Defenses accepted by Codex

- `munin-zero-v3c-intents` kept as `source_class: manual`. The v3c
  pilot report says intents were "rewritten as topical user questions"
  without naming a model, in contrast to v3 which names the Sonnet
  intent-writer. Added `source_origin` documenting the human-rewrite
  interpretation. Codex accepted.
- No CI checkout of the sibling `munin-zero` repo. Integrity rests on
  sha256 pins; verifying external artifact availability is out of
  scope per the original plan. Codex acknowledged this is a
  reasonable tradeoff.

## Unresolved disagreements

None at merge time.

## New issues from later rounds

- One doc-vs-JSON drift in the §5 quick-map table that survived the
  first revision (still listed v2/v3 intents as `manual`). Caught by
  Codex round-2 review and fixed in commit 010efa2.

## Final verdict

Both sides agreed PR #56 was ready to merge after the markdown table
fix. Merged 2026-05-20.

## Action items

None. PR 1 ships the manifest; the quality-metrics loop continues with
PR 2 (extend `benchmark/runner.ts` for production-ranker + #19).

## Files

- `debate/pr-1-plan.md` — original plan (revised inline after R1)
- `debate/pr-1-codex-critique.md` — R1 plan critique
- `debate/pr-1-codex-pr-review.md` — R1 PR review
- `debate/pr-1-claude-response-1.md` — Claude's R1 response
- `debate/pr-1-codex-rebuttal-1.md` — R2 rebuttal
- `debate/pr-1-summary.md` — this file
- `debate/pr-1-critique-log.json` — structured critique log

## Costs

| Invocation | Wall-clock time | Model version |
|---|---|---|
| Codex R1 (plan)   | ~3m | gpt-5.5 |
| Codex R1 (PR)     | ~3m | gpt-5.5 |
| Codex R2 rebuttal | ~2m | gpt-5.5 |
