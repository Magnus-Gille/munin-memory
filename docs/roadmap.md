# Munin Memory Roadmap

This document turns the product vision into an implementation plan.

It is intentionally opinionated. The goal is not to list everything Munin could
eventually do. The goal is to define what should be built next, in what order, and
what should be refused for now.

## Planning Assumptions

The roadmap assumes the product thesis in [vision.md](vision.md):

- Munin is a self-hosted, MCP-native memory layer
- the target user is one person or a small trusted group
- the main value is cross-environment continuity, not general-purpose knowledge
  management
- SQLite and the MCP contract remain stable
- new capabilities should not require a permanent external API dependency

## Current Baseline

Munin already has a stronger baseline than a generic "early memory project" framing
would suggest.

Today the product already includes:

- state and log as separate first-class memory types
- tracked project status with computed orientation via `memory_orient`
- lexical, semantic, and hybrid retrieval
- retrieval analytics and per-entry insights
- Bearer and OAuth access for local and remote clients
- principal-based access control and an admin CLI
- explicit hardware profile thinking for constrained and full-node deployments

The roadmap should build on that shape, not reset it.

## Product Goal

The practical product goal is:

> Starting a new session in any supported client should feel like the assistant has
> enough of the right context to continue useful work without making the human
> reconstruct everything.

Everything below is prioritized against that standard.

## Phase 1: Sharpen Retrieval and Time Awareness

This is the next build phase.

Detailed engineering plan: [phase-1-engineering-plan.md](phase-1-engineering-plan.md)

### Goal

Reduce stale retrieval and make time-bounded context behave correctly.

### Deliverables

- Add recency-aware ranking to `memory_query`
- Add temporal validity to state entries
- Surface expired and expiring context in orientation and attention tools
- Tighten documentation so the roadmap reflects the product as it exists now

### Concrete Scope

1. **Recency-aware ranking**

- add a configurable time-decay multiplier to retrieval scoring
- make the effect visible in `memory_query` response metadata
- keep the default conservative so new ranking does not destabilize obvious exact-match
  searches

2. **Temporal validity**

- add `valid_until` to state entries
- optionally add `valid_from` if it improves symmetry and query clarity
- exclude expired entries from default retrieval
- allow explicit inclusion of expired entries in queries and reads where needed

3. **Orientation and attention**

- flag entries that are about to expire
- flag projects whose next steps or deadlines are stale
- distinguish "old but still current" from "expired and should not surface by default"

4. **Doc cleanup**

- align `docs/competitive-analysis.md` with the actual product state
- remove already-completed items from "missing features" and roadmap references

### Exit Criteria

- a query for a topic is less likely to return stale entries ahead of current ones
- temporary context can expire without manual deletion
- orientation surfaces time risk before the human has to rediscover it

## Phase 2: Make Resume and Capture Feel Proactive

This phase turns Munin from a passive store into a better session-start system.

Detailed engineering plan: [phase-2-engineering-plan.md](phase-2-engineering-plan.md)

### Goal

Make the right context easier to surface and the right memories easier to capture.

### Deliverables

- add suggestion-based memory extraction from conversation text
- add intent-aware resume/context loading
- improve first-response continuity from a user's opening message

### Concrete Scope

1. **`memory_extract`**

- accept raw conversation text or notes
- return proposed `memory_write` and `memory_log` operations
- keep the tool suggestion-only; do not auto-commit writes
- avoid external API dependence in the server itself

2. **Intent-aware resume**

- extend `memory_orient` or add a dedicated resume tool
- accept an optional hint such as project, topic, or user opener
- return the most relevant active work, recent decisions, blockers, and open loops

3. **Session-start context packs**

- bias toward active tracked work, recent decisions, and unresolved blockers
- include why an item was surfaced, not only that it was surfaced
- keep outputs compact enough for real use in clients with token pressure

### Exit Criteria

- session startup requires less manual "go read these three things" prompting
- memory capture is easier in long or messy conversations
- the system feels more like a prepared handoff than a searchable notebook

## Phase 3: Add Narrative Memory

This is where Munin should become better at work continuity over time, not just memory
retrieval.

Detailed engineering plan: [phase-3-engineering-plan.md](phase-3-engineering-plan.md)

### Goal

Represent arcs, churn, and dropped commitments instead of only snapshots.

### Deliverables

- derive narrative signals from logs, statuses, and timestamps
- surface stuck work, repeated reversals, and aging blockers
- compress recurring patterns into reusable heuristics

### Concrete Scope

1. **Project-arc signals**

- time in current phase
- blocker age
- repeated status reversals
- frequent reopen cycles

2. **Commitment nudges**

- detect commitments that were written down but not followed through
- prioritize explicit user commitments and project next steps over vague prose
- surface nudges in `memory_attention` or a dedicated commitment view

3. **Compressed wisdom**

- summarize recurring evaluation patterns and operating heuristics
- prefer derived summaries over more raw storage
- keep summaries reviewable and attributable to source entries

### Exit Criteria

- Munin can answer "what is drifting?" and "what keeps happening?" without the human
  reconstructing the history manually
- the product becomes better at continuity of judgment, not only continuity of facts

## Phase 4: Strengthen Small-Trust Multi-User and Multi-Agent Use

This phase deepens the existing access-control direction without changing the product's
scope.

Detailed engineering plan: [phase-4-engineering-plan.md](phase-4-engineering-plan.md)

### Goal

Make shared use practical for a household or small trusted set of agents.

### Deliverables

- finish rough edges in principal ownership and shared-namespace behavior
- improve onboarding flows and docs for new principals
- make cross-agent handoff and continuity more deliberate

### Concrete Scope

1. **Shared-namespace ownership**

- finish entry-level ownership semantics where needed
- make deletion and mutation behavior clear and predictable

2. **Onboarding**

- tighten principal provisioning docs around the existing admin CLI
- document the normal path for bearer, desktop, and OAuth clients

3. **Cross-agent coherence**

- improve provenance and handoff conventions
- make it easier for multiple agents to continue the same thread without silent
  context loss

### Exit Criteria

- bringing in one more family member or one more agent feels supported, not incidental
- cross-agent continuity improves without turning Munin into a broad team platform

## Parallel Platform Track: Constrained Hardware Validation

This track runs alongside the product phases. It should inform feature boundaries, not
dictate the product thesis.

Detailed validation plan: [platform-validation-plan.md](platform-validation-plan.md)

### Goal

Keep Munin strong on modest self-hosted hardware and prove the constrained appliance
story with real measurements.

### Deliverables

- validate `zero-appliance` on real hardware
- define performance budgets for core operations
- ensure graceful degradation when semantic features are unavailable

### Rules

- core memory must remain useful without local semantic search
- semantic features are enhancements, not dependencies
- product packaging can evolve, but SQLite and the tool contract should remain stable

## Explicit Non-Goals For Now

The following are intentionally out of scope until the phases above are done and proven:

- full temporal knowledge graph work
- heavyweight entity-relationship traversal as a primary architecture
- web UI as a major product track
- broad document ingestion and research workflows
- managed cloud or SaaS positioning
- emotional or tonal memory as a first-class feature
- automatic server-side memory writing through an external LLM dependency

These ideas are not forbidden forever. They are off-strategy relative to the current
thesis and should not displace the core continuity work.

## Sequencing Summary

If there is only enough time for a few major moves, build in this order:

1. recency-aware retrieval
2. temporal validity on state entries
3. proactive resume and suggestion-based capture
4. narrative and commitment-aware signals
5. small-trust multi-user polish

That order reinforces the existing wedge instead of diluting it.
