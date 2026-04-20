# Retrieval: `decisions/*` 0% R@20 — debate summary

- **Date:** 2026-04-20
- **Participants:** Claude (Opus 4.7), Codex (gpt-5.4 xhigh)
- **Rounds:** 2
- **Artifact under review:** GitHub issue [#38](https://github.com/Magnus-Gille/munin-memory/issues/38) and Claude's draft conclusion/recommendation.

## Concessions accepted by both sides

- The "across all three pilots" framing is wrong. v2 shows the decisions stratum at 10/12 pooled and Sonnet 4/4 — decision entries are recoverable under topical queries. The 0/6 failure is specifically the v3/v3b prose-weighted decision subset. (C1)
- T29 is `projects/drone-lab`, not `decisions/*`. A decisions-only consolidation fix would not satisfy the benchmark. (C2)
- The failure modes are at least three, not one: meta-intent zero overlap (T9/T10/T35/T47), T49 `entry_type` formulator bug, T47 `namespace: "meta/"` formulator bug in v3 (fixed in v3b). (C4)
- The consolidation worker currently scopes to `projects/*` and `clients/*` log entries. Extending to `decisions/*` is architectural, not a light split. (C5)
- "Close + split" is weaker than "edit #38 in place." Closing loses the audit trail and duplicates a live munin-zero workstream. (C6)
- Acceptance-criterion rewrite must be versioned as a *new* benchmark alongside v3/v3b, not a replacement. Silently swapping the test is a goalpost move. (C7)
- Token-overlap method was directionally right but indexed the wrong fields (used `title`, which FTS doesn't index; omitted `tags`). Headline number survives the correction. (C3)
- A cross-repo munin-zero query-formulation workstream is already active in its status; appending to it beats filing a duplicate issue. (C9)

## Defenses accepted by Codex

- **D1:** For the four v3/v3b zero-overlap cases, no lexical ranking change can rescue them. Codex accepts this as a local diagnostic (not a closure argument).
- **D2:** bm25-first was never the right first move *now*. Codex did not contest "not first"; it only contested "never useful." (C8 partial.)

## Unresolved disagreements

None material on facts. One process disagreement remained and shaped the final verdict:

- **Action plan step 3.** Claude's revised plan was "comment on munin-zero status." Codex held that this is still file-and-forget: no artifact, no owner, no due date, no "done" definition. The concrete move is either to check in a topical-decision benchmark artifact in munin-zero or open an explicitly owned issue for it. A status comment is not equivalent to a versioned benchmark.

## New issues from Round 2

- **R2-01:** Revised #38 title ("fails under v3/v3b meta-intents") still collapses the three-failure-mode taxonomy. T49 is an `entry_type` formulator bug, not a meta-intent miss; the title needs to say "prose-weighted/formulator-generated decision queries" or equivalent to avoid demoting the formulator bug.
- **R2-02:** "Tag v3/v3b as expected failure under lexical" is premature while the benchmark is still mixed (4 hard-lexical + 1 entry_type bug + 1 historical namespace bug). Split strata by cause first.
- **R2-03:** Step 3 must produce an artifact or an owned issue, not a status comment.
- **R2-04:** "Defer bm25/title/expansion" has no re-entry condition. Needs a crisp trigger (e.g., "after topical rerun, if T29/T49-class cases still miss").

## Final verdict

**Codex:** Claude's revised position is substantially better than the draft. Major factual errors are conceded; the two held defenses are mostly fair when kept narrow. But the revised plan still hides one operational dodge — it swaps "close + split" for "edit + comment" while still avoiding the concrete artifact that makes the methodology fix real. Single most important next step: make benchmark versioning concrete now — either check in the new topical-decision benchmark artifact in munin-zero and link it from #38, or open one explicitly owned issue for that artifact with acceptance and due date.

**Claude:** Accepted. The revised action plan in the Round 1 response undercommitted on the methodology-fix deliverable. Next action is to edit #38 in place with a title that preserves the three-failure-mode taxonomy, add a findings comment, and create an owned munin-zero issue for the topical-decision benchmark artifact with acceptance criteria and due date.

## Action items

| # | Action | Owner | Done when |
|---|---|---|---|
| 1 | Edit #38 title and body in place. Title should reference "v3/v3b prose-weighted/formulator-generated decision queries" (not "meta-intents"). Drop "across three pilots." | Magnus | Title/body updated, three-failure-mode taxonomy visible in body. |
| 2 | Post a findings comment on #38 with: v2 contradiction (10/12 pooled, Sonnet 4/4); corrected tokenizer-aware overlap table over `content + namespace + key + tags`; decomposition of three failure modes; T29 scope correction; consolidation worker scope note. | Magnus | Comment posted, links to this debate. |
| 3 | Open an owned issue in the munin-zero repo (or commit the artifact directly) for the topical-decision benchmark subset. Acceptance: versioned benchmark file alongside v3/v3b (do not retire them), with ≥N topical intents for the decision targets. Due date tied to the gate memo cadence. | Magnus | Issue open with acceptance + due, or benchmark file checked in and linked from #38. |
| 4 | When drafting the findings comment, do NOT tag v3/v3b as "expected failure under lexical." Only split strata by cause; tag after the three failure modes are separated into distinct targets. | Magnus | Findings comment avoids premature "expected failure" framing. |
| 5 | Define the re-entry condition for the bm25 / title-indexing / consolidation-expansion defer. Example: "Reassess after the topical-decision benchmark is in place AND rerun shows T29/T49-class partial-overlap cases still miss top-20 lexical." Put this in the #38 body. | Magnus | Re-entry condition stated in #38. |

## Debate files

- `retrieval-decisions-zero-recall-claude-draft.md`
- `retrieval-decisions-zero-recall-claude-self-review.md`
- `retrieval-decisions-zero-recall-codex-critique.md`
- `retrieval-decisions-zero-recall-claude-response-1.md`
- `retrieval-decisions-zero-recall-codex-rebuttal-1.md`
- `retrieval-decisions-zero-recall-critique-log.json`
- `retrieval-decisions-zero-recall-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~4m             | gpt-5.4 xhigh |
| Codex R2   | ~3m             | gpt-5.4 xhigh |
