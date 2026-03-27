# Munin Memory — Usage Model

> This document explains the durable design concepts behind Munin Memory.
> It is for humans evaluating or setting up the system.
>
> **Layer precedence:** The runtime conventions stored in Munin (`meta/conventions`,
> surfaced by `memory_orient`) are the canonical operational contract — they take
> precedence over anything here for live session behavior. This document explains
> *why* the system is designed as it is; `meta/conventions` tells Claude *what to do*.

---

## Entry types: state vs. log

Munin has two fundamental entry types, and they model two fundamentally different things.

**State entries** are mutable key-value pairs identified by namespace + key. They represent
current truth. Writing a state entry with the same namespace and key upserts it — the
previous value is replaced. Use state entries for things that have a present state:
project status, a person's current role, a standing decision.

**Log entries** are append-only and have no key. They are timestamped and never modified.
Use log entries for things that happened: a decision made, a milestone reached, an
incident observed. The log accumulates; the state reflects where things stand now.

The practical discipline: **log the event, then update the state**. If a session ends
before the state write, the log still records what happened.

---

## Two data layers

Munin is designed around a two-layer model for project and work context.

**The detail layer** lives in local files, git history, and local Claude context — fast,
reliable, git-tracked, and not subject to network availability. This is where code,
meeting notes, drafts, and working artifacts live. It does not go into Munin.

**The summary layer** lives in Munin — brief status entries, key decisions, cross-cutting
context that needs to be accessible from any environment (laptop, phone, web). A Munin
state entry for a project should read like a handoff note, not a transcript.

The summary layer exists because Claude has no persistent memory across sessions or
environments by default. Munin is what makes the summary portable and current.

---

## Tracked statuses and the project dashboard

Namespaces under `projects/*` and `clients/*` are "tracked." A `status` key in a tracked
namespace feeds the computed project dashboard returned by `memory_orient`.

Tracked statuses serve a specific purpose: **computed orientation across environments**.
When you open a new session — on a different device, in a different client, days after
the last session — `memory_orient` returns a dashboard showing which projects are active,
blocked, completed, or stopped. You do not have to reconstruct this by reading every
namespace individually.

Status entries use lifecycle tags (`active`, `blocked`, `completed`, `stopped`,
`maintenance`, `archived`) so the dashboard can group and filter automatically.

---

## State/log discipline

When to use each:

| Situation | Use |
|-----------|-----|
| Something happened (decision, event, milestone) | Log entry (`memory_log`) |
| Current state of a project or engagement | State entry (`memory_write`, key: `status`) |
| A standing decision that governs behavior | State entry in `decisions/*` |
| A person's current context or role | State entry in `people/*` |
| Sequential events you need to reconstruct later | Log entries |
| A value that will be updated frequently | State entry |

The most common mistake is using state entries for things that should be logs — writing
over history instead of appending to it. If you find yourself wondering "what happened,"
you needed log entries. If you find yourself wondering "where does this stand," you needed
a state entry.

---

## Namespace categories

Munin uses hierarchical namespaces with `/` as a separator. The five structural categories:

| Namespace | Tracked | Purpose |
|-----------|:-------:|---------|
| `projects/*` | Yes | Project state and history |
| `clients/*` | Yes | Client engagement context |
| `people/*` | No | People profiles and contact context |
| `decisions/*` | No | Cross-cutting decisions |
| `meta/*` | No | System notes, conventions, config |

Namespaces are created implicitly on first write. Additional namespace patterns may exist
in your own Munin instance; the five above are the structural core.

---

## What belongs here vs. in `meta/conventions`

This document covers design rationale — the *why* behind the entry types, layers, and
tracked status model. It does not prescribe session behavior.

The runtime operational contract (session handshake sequence, write thresholds, search
mode guidance, environment-specific branching) lives in Munin itself under `meta/conventions`
and is surfaced at session start by `memory_orient`. That layer is authoritative for
active Claude sessions. It can be updated without a code change, and it stays in sync
with how the system actually behaves.
