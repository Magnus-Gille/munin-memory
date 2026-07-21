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
`memory_update_status` can also set or clear `valid_until` to declare when a tracked
status should next be reviewed. Expired statuses remain directly readable, are surfaced
by `memory_attention` when `include_expiring` is enabled, and are hidden from broad search
by default.

---

## Broad handshake vs. targeted resume

Munin now separates **broad orientation** from **targeted continuation**.

Use `memory_orient` first when a session starts and the host exposes it as callable. It is
the handshake tool: conventions, dashboard, maintenance items, and namespace overview in
one place. If a host or deferred tool-discovery layer does not expose `memory_orient`, use
`memory_status` to inspect available tools or `memory_resume` for targeted context as the
fallback.

Use `memory_resume` after that when you already have a likely direction — a project
name, a namespace, or a user opener such as "continue grimnir parser rollout." It
returns a compact continuation pack: the most relevant current status, recent decision
logs, open loops, and optionally a small slice of recent namespace history.

This split exists because "what exists?" and "what should I load right now?" are
different jobs. `memory_orient` stays stable and broad; `memory_resume` can be sharper
and more task-aware without destabilizing the base handshake.

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

### Concurrent state writes

The full-content `memory_write` path has three explicit write modes. Patch writes retain
their existing optional `expected_updated_at` CAS contract.

| Intent | Parameters | Result when the key already exists |
|--------|------------|------------------------------------|
| Unconditional upsert | omit both preconditions | Overwrites the current state |
| Update the version you read | `expected_updated_at: "<updated_at>"` | Updates only when the current version matches; otherwise returns `error: "conflict"`, `conflict_reason: "version_mismatch"`, and `current_updated_at` |
| Win the first write | `create_if_absent: true` | Never overwrites; returns `error: "conflict"`, `conflict_reason: "already_exists"`, and `current_updated_at` |

Do not combine `create_if_absent: true` with `expected_updated_at` or `patch`. After a
create-if-absent conflict, read the winner, reconcile it, and use its `updated_at` for a
normal CAS update. The absence check and insert occur in one SQLite transaction, so callers
must not invent a special timestamp to represent an absent entry. For compatibility,
`expected_updated_at` still creates the entry when the key is absent; it is an update-version
guard for an entry you have read, not an assertion that a key exists or is absent.
Soft expiry also does not make a key absent: a state row past `valid_until` remains directly
addressable, so `create_if_absent: true` returns `already_exists` until that row is deleted.

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
