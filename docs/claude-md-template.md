# Claude CLAUDE.md template — Munin Memory

> **This is an opinionated starting point**, not a generic product companion.
> It reflects one way to configure a project's CLAUDE.md when using Munin Memory.
> Adapt or discard any part that does not fit your setup.

---

## Memory orientation

At the start of any session with substantial scope:

```
memory_orient
```

This returns the project dashboard, curated notes, and active conventions.
For the full conventions guide, pass `include_full_conventions: true`.

---

## Entry type guidance

Use **state entries** (`memory_write`) for current truth: project status, standing
decisions, a person's current role. These are overwritten on update.

Use **log entries** (`memory_log`) for events: decisions made, milestones, incidents.
These are permanent and append-only.

Default: log the event first, then update the state. If you only have time for one,
prefer the log — it preserves what happened even if the state never gets updated.

---

## Namespace conventions

```
projects/<name>    — tracked; status key feeds dashboard
clients/<name>     — tracked; status key feeds dashboard
people/<name>      — not tracked; profiles and contact context
decisions/<topic>  — not tracked; cross-cutting decisions
meta/<topic>       — not tracked; system notes and conventions
```

Status entries in `projects/*` and `clients/*` use lifecycle tags:
`active`, `blocked`, `completed`, `stopped`, `maintenance`, `archived`

---

## Write discipline

Before updating a status entry that another environment may have written, read it first:

```
memory_read namespace:<ns> key:status
```

Check `updated_at`. If it is newer than expected, read and reconcile before writing.
Use `memory_write` with `expected_updated_at` for compare-and-swap protection.

---

## Session close

At the end of a session where code was committed or a decision was made:

1. Log significant decisions to the relevant namespace (`memory_log`)
2. Update status entries that have changed (`memory_write`)
3. Note anything that should carry forward into the next session

Skip Munin writes for pure Q&A or exploratory sessions with no committed output.

---

## What not to put in Munin

- Code, diffs, or file contents (use local files and git)
- Meeting transcripts (summarize the outcome instead)
- Anything containing credentials, tokens, or API keys (writes are rejected by the server)
- Redundant copies of things already in git
