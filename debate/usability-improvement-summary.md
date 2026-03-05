# Munin Memory Usability Improvement Plan

**Date:** 2026-03-05
**Primary evaluator:** Codex (GPT-5)
**Agreement basis:** Current Codex evaluation plus prior Claude/Codex debate outcomes in `workbench-summary.md`, `conventions-summary.md`, and `memory-conventions-summary.md`

## Scope

This document captures the agreed next improvements after evaluating Munin from Codex for one of the first times.

It is not a fresh live two-party debate transcript. A new Claude CLI round was attempted from this repo, but the local `claude` CLI was not authenticated (`Not logged in · Please run /login`). The plan below is therefore constrained by:

1. Current Codex hands-on evaluation of the live memory contents and tool ergonomics
2. Claude positions already recorded in prior debate summaries in this repo

## What both sides already support

The existing debate record already converges on several principles that matter here:

1. Keep operational conventions compact and explicit
2. Prefer structured write discipline over freeform memory growth
3. Treat the workbench as a rebuildable cache, not source of truth
4. Improve browseability and discovery before adding heavier coordination machinery
5. Defer optimistic concurrency and richer structured formats unless real usage proves they are needed

## Agreed priorities

### 1. Add first-class recent-log browsing

**Type:** Product
**Priority:** High

The biggest practical gap is log inspection. `memory_list(namespace)` shows counts but not the recent log entries themselves, which pushes the user toward guess-based `memory_query` calls. Semantic retrieval works, but operational browsing is weaker than it should be.

**Recommended direction:**
- Add `memory_tail(namespace, limit)` for append-only logs
- Or extend `memory_list(namespace)` to include the latest 3 log previews

### 2. Enforce a compact `status` contract

**Type:** Conventions + content hygiene
**Priority:** High

Some `status` entries are crisp resumability summaries; others are effectively mini-READMEs. That makes the system useful for archival reading but less reliable for fast orientation across agents.

**Recommended contract:**
- `Phase`
- `Current work`
- `Blockers`
- `Next`

Longer material should move into separate keys such as `architecture`, `workflow`, `validation`, or `research`.

### 3. Add namespace-level key discovery

**Type:** Conventions first, product later if needed
**Priority:** Medium

Key discovery is still guessy outside the most disciplined project namespaces. A conventional `index` or `about` key per namespace would reduce dependence on memory of key names and make new agents more effective.

**Recommended direction:**
- Define `index` as the canonical entry listing important keys and their purpose
- Add it first to active `projects/*`, `people/*`, and `clients/*` namespaces

### 4. Surface workbench drift explicitly

**Type:** Product
**Priority:** High

The workbench is intentionally non-authoritative, but drift is too easy to miss. The current memory already shows a stale workbench summary relative to fresher project status.

**Recommended direction:**
- When listing or reading workbench-oriented data, surface namespaces whose `status.updated_at` is newer than the workbench snapshot date
- Keep this observational only; do not mutate on read

### 5. Separate live and demo data in default orientation flows

**Type:** Product
**Priority:** Medium

`demo/*` namespaces are useful, but mixing them into default listings adds noise during real work.

**Recommended direction:**
- Add a filter or scope parameter to `memory_list()`
- If no filter is provided, hide `demo/*` by default or return them in a separate section

### 6. Tighten tag governance

**Type:** Conventions + content hygiene
**Priority:** Medium

Tags are already drifting toward one-off local labels. That will weaken query quality and long-term consistency.

**Recommended direction:**
- Keep a small canonical vocabulary for lifecycle, category, and ticket type
- Allow one optional freeform tag only when it clearly improves retrieval

### 7. Make conventions and docs agent-neutral

**Type:** Documentation + content hygiene
**Priority:** Medium

Much of the current memory reflects Claude Code as the primary writer. The content quality is good, but the framing is writer-shaped around Claude rather than tool-shaped for any capable agent.

**Recommended direction:**
- Rewrite environment ownership language so Claude Code is not treated as the only canonical bridge
- Keep environment-specific instructions where necessary, but make the core conventions neutral across Codex and Claude

## Explicit non-priorities

These should stay deferred unless real usage proves otherwise:

1. Structured JSON status/workbench entries
2. Optimistic concurrency or CAS writes
3. Heavy multi-user conflict resolution machinery

The current bottleneck is browseability and write discipline, not transactional sophistication.

## Suggested implementation order

### Now

1. Add a ticket for recent-log browsing
2. Tighten `status` conventions and clean the worst oversized entries
3. Add a ticket for workbench drift visibility

### Next

1. Add namespace `index` conventions
2. Add live/demo filtering
3. Normalize tags on new writes

### Later

1. Revisit JSON formatting if markdown parsing becomes a real cross-agent failure mode
2. Revisit concurrency only if multi-agent write collisions happen in practice
