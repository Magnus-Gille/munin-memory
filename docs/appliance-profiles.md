# Munin Memory Appliance Profiles

## Why this exists

Munin Memory already runs well on stronger Raspberry Pi hardware such as a Pi 5, but a Raspberry Pi Zero 2 W changes the product constraints. The current stack can fit on ARM64 Linux, but "fits" is not the same as "feels like a polished appliance."

The main pressure points are not SQLite or the MCP tool contract. The pressure points are optional heavier features such as local embedding generation, semantic indexing backlog, public-remote auth surface, and the operational expectations that come with a plug-and-play internet-facing box.

That means the right first move is **not** a full rewrite of the codebase. The right first move is to define explicit hardware/runtime profiles, keep the database and MCP contract stable, and validate the constrained profile on real hardware before promising more.

## Recommendation

- Do **not** start with a full rewrite.
- Keep the current SQLite-backed MCP design and split the runtime into clearer profile boundaries over time.
- Treat Raspberry Pi Zero 2 W as a **constrained appliance profile** until real hardware proves otherwise.
- Treat stronger hardware as the **full-feature profile** for public-remote access and local semantic features.

## Profiles

| Profile | Target hardware | Default capabilities | Notes |
|---------|-----------------|----------------------|-------|
| `zero-appliance` | Raspberry Pi Zero 2 W class hardware | Core memory: state/log/orient/list/history/read/query with lexical search | Semantic search is not ruled out, but it is not assumed in the default Zero experience. |
| `full-node` | Raspberry Pi 4/5, mini PC, VPS, or stronger x86/ARM hardware | Full public-remote deployment, OAuth, retrieval analytics, and local semantic/hybrid search | This matches the current "Pi 5 on my desk" style deployment most closely. |

## What stays stable

- MCP tool names and core tool behavior
- SQLite as the primary storage layer
- FTS5 lexical search as the baseline search mode
- Database portability between machines

The product can evolve packaging and runtime topology without throwing away the existing storage model.

## Semantic search stance

Semantic search is **not** strictly out of the question on Raspberry Pi Zero 2 W. What is out of scope for the default Zero profile is assuming the current local embedding path will feel smooth there without proof.

Current recommendation:

- `full-node` can continue to offer local semantic and hybrid search.
- `zero-appliance` should ship as a great lexical/core-memory box first.
- Semantic search on `zero-appliance` is a second-phase validation item, not a default promise.

## Sidecar stance

A sidecar process can run on the same device. That is useful for:

- isolating the heavy embedding path from the main memory service
- making semantic features optional and restartable
- allowing different runtime choices for embeddings later

But a same-device sidecar is mainly an **isolation and packaging choice**, not a free performance win. On a Pi Zero 2 W, it does not create extra CPU or RAM. It only makes the system easier to structure and degrade safely.

That is why "same-device sidecar" is compatible with the plan, but not sufficient on its own to justify promising semantic search on Zero.

## Real-hardware spike plan

The hardware spike should happen before deeper architecture or rewrite work.

### Phase 1: Zero baseline

- Target: real Raspberry Pi Zero 2 W
- Scope: core-only baseline first
- Start with semantic features disabled
- Run the closest realistic appliance deployment shape possible

The question for Phase 1 is:

> Can `zero-appliance` feel reliable and pleasant for core memory use?

### Phase 2: Local semantic follow-up

Only run this if Phase 1 passes with headroom.

- Try local semantic search as a separate follow-up
- Prefer isolation behind a local-only embedding backend boundary
- Keep semantic failure from harming core memory behavior

The question for Phase 2 is:

> Can Zero support semantic search without making the core experience worse?

## Acceptance criteria

`zero-appliance` should only advance if the hardware spike shows:

- core tools stay responsive in normal use
- the device is stable at idle and under light sustained usage
- lexical search remains useful enough that the product is compelling even without semantic search
- service restarts and recovery remain clean
- storage and checkpoint behavior do not create long, frequent pauses

If those conditions are not met, the recommendation changes to raising the hardware floor rather than forcing a rewrite around wishful assumptions.

## Likely next outcomes

After the Zero hardware spike, the project should make one of three explicit calls:

1. `zero-appliance` is viable for core memory only
2. `zero-appliance` is viable for core memory and experimental local semantic search
3. Raspberry Pi Zero 2 W is not a good appliance target; raise the hardware floor

## Practical product direction

The intended user experience remains simple:

- one box
- one product
- core memory works by default
- semantic search is an enhancement, not a dependency

The implementation may use multiple internal services later, but the product should not force extra hardware or complicated user-managed software just to deliver the core memory experience.
