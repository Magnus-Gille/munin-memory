# Feature Wishlist Debate — Summary
Date: 2026-03-27
Participants: Claude (Sonnet 4.6) vs Codex (gpt-5.4)
Rounds: 2

## What was debated

Four candidate features for Munin Memory:
1. `since` filter on `memory_query`
2. Session-aware `memory_orient` diff
3. First-class attention flags / follow-up queue
4. `memory_compact` — namespace log compression

## Concessions accepted by Claude

| Point | Severity |
|-------|----------|
| Feature 1: `since` on `memory_query` is the wrong abstraction — it's a relevance search, not a change feed | Critical |
| Feature 1: `updated_at` index missing — not "zero schema changes" | Major |
| Feature 1: Post-KNN date filtering distorts semantic/hybrid results | Major |
| Feature 2: `agent_id` hardcoded to "default" everywhere — caller identity doesn't exist in the tool layer | Critical |
| Feature 2: HTTP auth context not passed into tool handlers — architectural prerequisite missing | Critical |
| Feature 3: Attention gap is narrower — maintenance suggestions already handle stale/blocked heuristics | Minor |
| Feature 4: In-memory Map token not durable — not safe across restarts | Major |
| Feature 4: Claude quoted a fictional `audit_log` schema with `entry_id` and `content` fields that don't exist | Major |
| `audit_log` table exists with no MCP tool — `memory_history` is the right abstraction for change queries | Critical |

## Defenses accepted by Codex

| Point | Verdict |
|-------|---------|
| Two-phase `memory_compact` design shape is still right (Claude can't LLM-summarize internally) | Accepted |
| Feature 3 surviving use case: explicit follow-up commitments not captured by stale-status heuristics | Accepted |
| `meta/attention` namespace pilot (Option B) is the right starting point, no schema change | Accepted |
| HMAC-signed token is better than in-memory Map (fixes token tampering, process dependency) | Accepted as improvement, not complete solution |
| `memory_history` is the right product surface for change feed queries | Accepted, with caveat |
| Feature 2 is blocked on caller-context plumbing, not just implementation complexity | Accepted |

## Unresolved / caveats

- **HMAC token for compact**: Better, but doesn't fully solve candidate-set drift. A complete solution requires the token to bind `latest_log_id` AND a content hash or candidate count — not just check that the old latest log still exists.
- **`memory_history` vs narrow `since`**: Both may have value but must have explicit, non-overlapping semantics. `memory_history` = mutation timeline. `memory_query` + date filter = content search in stored entries.
- **Caller identity**: The same architectural gap (tool handlers don't receive auth context) limits both `memory_history` attribution and `memory_orient` diff. Must be treated as one problem.
- **`audit_log` enrichment**: Current schema (id, timestamp, agent_id, action, namespace, key, detail) may need `entry_id` linkage before `memory_history` is fully useful. Shipping the MVP will reveal this.

## Revised feature roadmap

| Rank | Feature | Notes |
|------|---------|-------|
| 1 | **`memory_history`** — expose `audit_log` via MCP | New, elevated from Codex critique. Ship MVP against real schema |
| 2 | **Caller context plumbing** — pass auth identity into tool handlers | Architectural prerequisite for #3 and #5 |
| 3 | **Attention flags** — `meta/attention` namespace convention, Option B | No schema change. Pilot first, graduate to table if pain warrants |
| 4 | **`since` filter on lexical log queries only** | Deferred until `memory_history` shipped; may be unnecessary after that |
| 5 | **Session-aware `memory_orient` diff** | Blocked on #2 |
| 6 | **`memory_compact`** with HMAC-signed + candidate-binding token | Low urgency; design improved but not urgent |

## Final verdict (both sides agree)

**Ship `memory_history` first, against the actual `audit_log` schema, with explicit scope limits.**

Rationale (Codex):
> "The moment you specify the output contract against the real schema, you will immediately see what metadata is missing and whether audit enrichment is needed. It derisks the rest of the roadmap."

Rationale (Claude, post-debate):
> `memory_history` is the correct abstraction boundary for "what changed?" queries without distorting relevance semantics. Building it first reveals whether `audit_log` needs enrichment and whether the narrow `since` filter is still needed at all.

## Critique statistics

- Total critique points: 14
- Valid: 14 (100%)
- Caught by self-review: 4/14 (29%)
- Changed Claude's position: 9
- Acknowledged without position change: 5

## All debate files

- `debate/feature-wishlist-claude-draft.md`
- `debate/feature-wishlist-claude-self-review.md`
- `debate/feature-wishlist-codex-critique.md`
- `debate/feature-wishlist-claude-response-1.md`
- `debate/feature-wishlist-codex-rebuttal-1.md`
- `debate/feature-wishlist-critique-log.json`
- `debate/feature-wishlist-summary.md`

## Costs

| Invocation | Wall-clock time | Model |
|------------|-----------------|-------|
| Codex R1   | ~4m             | gpt-5.4 |
| Codex R2   | ~4m             | gpt-5.4 |
