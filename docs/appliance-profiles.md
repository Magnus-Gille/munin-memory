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
| `zero-appliance` | Raspberry Pi Zero 2 W class hardware | Core memory: state/log/orient/list/history/read/query with lexical search | Semantic is out by hardware constraint (see below), not by quality preference. |
| `zero-plus-appliance` | Raspberry Pi 5 2GB class hardware | Core memory + local embeddings/hybrid search in an appliance form factor | New tier. Justified by v3 pilot data showing semantic materially lifts recall on prose-weighted corpora. Previously speculative; now a planned product tier. |
| `full-node` | Raspberry Pi 4/5 4GB+, mini PC, VPS, or stronger x86/ARM hardware | Full public-remote deployment, OAuth, retrieval analytics, and local semantic/hybrid search | This matches the current "Pi 5 on my desk" style deployment most closely. |

## What stays stable

- MCP tool names and core tool behavior
- SQLite as the primary storage layer
- FTS5 lexical search as the baseline search mode
- Database portability between machines

The product can evolve packaging and runtime topology without throwing away the existing storage model.

## Semantic search stance

Semantic search stays a first-class feature for any profile that has the RAM headroom for it. The Munin Zero retrieval pilot (2026-04-19, `munin-zero/docs/experiments/retrieval-pilot-2026-04-19/pilot-report-v3.md`) confirmed that on prose-weighted content — long-form logs, meeting notes, narrative entries — hybrid search lifts R@20 by +14pp overall (+23pp on prose-log, +40pp on prose-state) versus lexical-only. An earlier v2 run on a state-heavy corpus showed no lift; the two experiments do not contradict, they sample different content shapes. Real-world Munin usage contains a lot of prose, so cutting semantic is not a free tradeoff.

Current recommendation:

- `full-node` continues to offer local semantic and hybrid search, enabled by default.
- `zero-plus-appliance` (Pi 5 2GB) is the right home for an appliance-form-factor box that still runs embeddings. This tier exists because v3 showed the recall cost of dropping semantic is real for the persona-A prose-heavy user.
- `zero-appliance` (Pi Zero 2 W) stays lexical-only. The 425MB total RAM / ~310MB available budget cannot host an embedding model plus index — this is a hardware ceiling, not a quality judgement. Acceptance on Zero relies on the appliance UX being tolerant of imperfect recall (model asks a clarifying question instead of failing).
- Lexical is not uniformly worse. On structured-vocabulary content (research notes, short state entries) lexical ties or beats hybrid. A possible future direction is content-shape-aware routing, but N=50 single-model data is too thin to justify that complexity today.

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

1. `zero-appliance` is viable for core memory only — users who want semantic move up to `zero-plus-appliance`.
2. `zero-appliance` is viable for core memory and some form of constrained semantic search (e.g. smaller model, offloaded embedding path).
3. Raspberry Pi Zero 2 W is not a good appliance target; collapse into `zero-plus-appliance` as the entry tier and raise the hardware floor.

Independent of which of these lands, retrieval-quality work on both Zero and full Munin should prioritize **query-formulation guidance** over retrieval-engine changes. The pilot identified tight namespace filters, bare-`OR` FTS5 syntax, and abstract paraphrase as the dominant failure modes — all addressable through `memory_query` tool-description guidance and applicable to every profile.

## Practical product direction

The intended user experience remains simple:

- one box
- one product
- core memory works by default
- semantic search is an enhancement, not a dependency

The implementation may use multiple internal services later, but the product should not force extra hardware or complicated user-managed software just to deliver the core memory experience.
