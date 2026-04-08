# Debate Summary: Telemetry and Autonomous Improvement Loop

**Date:** 2026-04-08
**Participants:** Claude Opus 4.6 vs Codex GPT-5.4
**Rounds:** 1 (Round 2 blocked by Codex usage limit)
**Topic:** Whether and how to add telemetry and automated improvement to Munin Memory

## Outcome

The original proposal was **substantially revised**. What started as a 4-layer autonomous improvement system was cut down to a minimal data-collection-only Layer 1 with explicit success and exit criteria.

## Concessions Accepted by Claude

| # | Critique | Impact |
|---|----------|--------|
| C01 | Four separate bets bundled as one architecture | Split into independent go/no-go decisions |
| C02 | Session model broken for HTTP (Layer 2 blocker) | Layer 2 explicitly blocked |
| C07 | Anti-pattern heuristics unsupported | All heuristic detection dropped |
| C04+C07 | Automated issue filing from unvalidated signals | Dropped entirely |
| C10 | No success/exit criteria | Added: <2ms latency, 30-day review, remove if no signal |
| C08 | Operational burden understated | Scope cut to migration + wrapper + status aggregates only |

## Defenses Accepted by Codex (presumed from Round 1 framing)

- Server-side instrumentation is the only complete view across all clients (acknowledged in critique intro)
- Privacy-aware collection (no args/content) is directionally correct (acknowledged)
- The gap in non-retrieval tool observability is real (partially acknowledged — Codex said the claim was "narrower" than stated, not wrong)

## Unresolved (no Round 2)

- Whether minimal Layer 1 is worth the effort vs. just running `/user-test-memory` periodically
- Whether `response_size_bytes` is a useful product metric or just a transport metric
- Whether the 30-day review timeline is appropriate
- Codex's suggested alternative: "improve the existing benchmark and retrieval analytics first"

## Revised Proposal (Post-Debate)

### In scope
1. Migration v7: `tool_calls` table
2. Fire-and-forget wrapper in tool handlers (try/catch, never fails the tool call)
3. Extended `memory_status` with basic aggregates (calls/day, error rate, p95 response size by tool)
4. 90-day retention pruning

### Explicitly out of scope
- Session flow analysis (blocked on session ID fix)
- Automated issue filing
- Weekly/monthly cron reports
- Deploy gates
- Any action automation

### Success criteria
- INSERT adds <2ms p95 to tool call latency
- After 30 days: data answers "which tools are used, which are unused, which have high error rates"
- Decision point at 30 days: continue, expand, or remove

### Exit criteria
- If 30-day review reveals nothing surprising or actionable, drop the table

## Key Debate Insight

Codex's strongest point: **"If you cannot show that your detector is usually right, automating the downstream action is process debt."** This applies beyond telemetry — it's a general principle for any system that generates work items from heuristics.

## Action Items

1. Decide: implement minimal Layer 1, or defer in favor of benchmark/bug work
2. If proceeding: file a single GitHub issue for the minimal Layer 1 scope
3. Layer 2+ is not planned — revisit only after 30-day Layer 1 review AND session ID fix

## All Debate Files

- `debate/telemetry-claude-draft.md` — Original 4-layer proposal
- `debate/telemetry-claude-self-review.md` — Self-critique (caught 5/11 points)
- `debate/telemetry-codex-critique.md` — Codex Round 1 (11 critique points)
- `debate/telemetry-claude-response-1.md` — Response with revised minimal proposal
- `debate/telemetry-codex-rebuttal-1.md` — NOT PRODUCED (Codex usage limit)
- `debate/telemetry-critique-log.json` — Structured critique log
- `debate/telemetry-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | FAILED (limit)  | gpt-5.4       |
