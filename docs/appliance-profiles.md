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

For installation, start with the lexical-first
[five-minute quick start](quickstart.md), pass the intended profile to preflight,
and enable its semantic defaults after the first write-to-resume check. This
keeps model download latency out of onboarding without changing the profile's
steady-state recommendation below.

| Profile (`MUNIN_PROFILE`) | Target hardware | Default capabilities | Notes |
|---------|-----------------|----------------------|-------|
| `zero-appliance` | Raspberry Pi 3A+ / Pi Zero 2 W (512 MB-class) — the cheapest, primary target (both sourceable to Jan 2030) | Core memory **+ q8 semantic/hybrid search** | **Updated 2026-06-18:** the 2026-06-18 on-hardware RAM-fit sweep proved q8 MiniLM semantic fits a 128 MB cgroup cap (peak anon ≈ 74–99 MB across query/write/concurrent; ≈ 91–94 MB under sustained burst at appliance caps), so this tier ships semantic ON via q8, not lexical-only. See "Validated RAM-fit findings" below. |
| `zero-plus` | Raspberry Pi 5 2 GB-class hardware | Core memory + q8 local embeddings/hybrid search, batch 4 + larger page cache | Pilot data (v3) shows semantic materially lifts recall on prose-weighted corpora; tonight's sweep confirms the memory cost is small (peak anon ≈ 85–99 MB). |
| `full-node` | Raspberry Pi 4/5 4GB+, mini PC, VPS, or stronger x86/ARM hardware | Full public-remote deployment, OAuth, retrieval analytics, and **full-fidelity fp32 semantic/hybrid search** | Matches the reference Pi 5 deployment. No memory clamps; fp32 gives the best recall and fits with ~800 MB free at 1 GB. |

> **`MUNIN_PROFILE` precedence.** A profile sets *default* knob values. An
> explicit env var always wins, then the profile default, then the hard-coded
> default. With `MUNIN_PROFILE` unset, behavior is byte-for-byte unchanged.
> Resolver: `src/profiles.ts` (wired into `src/embeddings.ts` and `src/db.ts`).
> The doc's earlier `zero-plus-appliance` label is now canonically `zero-plus`.

## What stays stable

- MCP tool names and core tool behavior
- SQLite as the primary storage layer
- FTS5 lexical search as the baseline search mode
- Database portability between machines

The product can evolve packaging and runtime topology without throwing away the existing storage model.

## Semantic search stance

Semantic search stays a first-class feature for any profile that has the RAM headroom for it. The Munin Zero retrieval pilot (2026-04-19, `munin-zero/docs/experiments/retrieval-pilot-2026-04-19/pilot-report-v3.md`) confirmed that on prose-weighted content — long-form logs, meeting notes, narrative entries — hybrid search lifts R@20 by +14pp overall (+23pp on prose-log, +40pp on prose-state) versus lexical-only. An earlier v2 run on a state-heavy corpus showed no lift; the two experiments do not contradict, they sample different content shapes. Real-world Munin usage contains a lot of prose, so cutting semantic is not a free tradeoff.

Current recommendation (revised 2026-06-18 after the on-hardware RAM-fit sweep):

- `full-node` offers full-fidelity fp32 local semantic and hybrid search, enabled by default.
- `zero-plus` (Pi 5 2GB) runs q8 semantic with more headroom (batch 4, larger page cache). This tier exists because v3 showed the recall cost of dropping semantic is real for the persona-A prose-heavy user.
- `zero-appliance` (Pi 3A+ / Pi Zero 2 W, 512 MB-class) **now runs q8 semantic too** — this reverses the earlier lexical-only stance. The earlier "425 MB total / ~310 MB available cannot host an embedding model plus index" was an *unmeasured estimate*. Measured: q8 MiniLM holds a peak working set (un-reclaimable `anon + shmem`) of ≈ 74–99 MB across query/write/concurrent (≈ 91–94 MB under sustained burst at appliance caps), fitting a **128 MB** cgroup cap with `MemorySwapMax=0`. The recall cost of q8 vs fp32 is small (R@10 and R@20 are identical on the goldset; only R@5 dips ≈ 6 pp). Lexical-only remains available as a fallback (`MUNIN_EMBEDDINGS_ENABLED=false`, ~13 MB anon) for the most constrained deployments, but it is no longer the *default* for this tier.
- Lexical is not uniformly worse. On structured-vocabulary content (research notes, short state entries) lexical ties or beats hybrid. A possible future direction is content-shape-aware routing, but N=50 single-model data is too thin to justify that complexity today.

### Validated RAM-fit findings (2026-06-18)

Validated on an aarch64 / 8 GB Linux board (cgroup v2) under `systemd-run --user
--scope -p MemoryMax=<cap> -p MemorySwapMax=0`, against the pristine 1.34 GB reference
production DB snapshot. The must-fit metric is peak **`anon + shmem`** (the
un-reclaimable working set; `memory.current` is dominated by reclaimable file
cache and is informational only). The dispositive fit signal is the absence of a
cgroup OOM-kill. Full results and methodology: `benchmark/ramfit/FINDINGS.md`.

| Tier | dtype | semantic | Peak anon (sustained burst) | Fits cap | Goldset R@5 / R@20 |
|---|---|---|---|---|---|
| `full-node` (1 GB) | fp32 MiniLM | ON | ≈ 230 MB | 1024 MB (huge headroom) | 0.58 / 0.65 |
| `zero-plus` (Pi 5 2 GB) | q8 MiniLM | ON | ≈ 99 MB | 320 MB+ | 0.52 / 0.65 |
| `zero-appliance` (512 MB) | q8 MiniLM | ON | ≈ 91–94 MB | down to 128 MB | 0.52 / 0.65 |
| (fallback, any tier) | none (lexical) | OFF | ≈ 13 MB | down to 64 MB | n/a |

fp16 MiniLM is **not** an option on this onnxruntime build (it fails to
initialise with an `InsertedPrecisionFreeCast` graph error). Use q8 or int8 for
quantised tiers.

## Sidecar stance

A sidecar process can run on the same device. That is useful for:

- isolating the heavy embedding path from the main memory service
- making semantic features optional and restartable
- allowing different runtime choices for embeddings later

But a same-device sidecar is mainly an **isolation and packaging choice**, not a free performance win. On a Pi Zero 2 W, it does not create extra CPU or RAM. It only makes the system easier to structure and degrade safely.

The 2026-06-18 RAM-fit sweep settled the semantic-on-Zero question on measured data; the sidecar framing remains valid as an isolation/packaging option but is no longer a prerequisite for semantic search on this tier.

## Real-hardware spike plan

> **Superseded by the 2026-06-18 RAM-fit sweep — see "Validated RAM-fit findings" above.**
>
> The sweep settled whether q8 semantic fits on a 512 MB-class board: it does
> (peak anon ≈ 74–99 MB; fits a 128 MB cgroup cap). The open questions are now
> hardware/UX/provisioning, not whether semantic is possible on this tier.

The hardware spike should happen before deeper architecture or rewrite work.

### Phase 1: Zero baseline + q8 semantic

- Target: real Raspberry Pi Zero 2 W (or Pi 3A+)
- Scope: full `zero-appliance` profile — q8 semantic ON by default
- Run `MUNIN_PROFILE=zero-appliance` against a realistic deployment shape

The question for Phase 1 is:

> Does `zero-appliance` feel reliable and pleasant for core memory use, with q8
> semantic enabled? Are startup time, latency, and idle behaviour acceptable?

### Phase 2: Broader validation and UX polish

- Validate against the broader goldset (beyond the 31-query IR fixture)
- Evaluate whether bge-small q8 (higher recall, ~25 MB more anon) is worth
  promoting to the `zero-appliance` default
- Ensure graceful degradation (`MUNIN_EMBEDDINGS_ENABLED=false`) still works
  as a fallback for the most constrained deployments

The question for Phase 2 is:

> Is the q8 semantic experience good enough to ship as the default, or should
> we promote bge-small q8 / add content-shape-aware routing?

## Acceptance criteria

`zero-appliance` should only advance if the hardware spike shows:

- core tools stay responsive in normal use
- the device is stable at idle and under light sustained usage
- q8 semantic search (the default) is reliable and does not destabilise core memory
- service restarts and recovery remain clean
- storage and checkpoint behavior do not create long, frequent pauses

If those conditions are not met, the recommendation changes to raising the hardware floor rather than forcing a rewrite around wishful assumptions. Lexical-only fallback (`MUNIN_EMBEDDINGS_ENABLED=false`) remains available but is no longer the advancement gate.

## Likely next outcomes

> **Superseded by the 2026-06-18 RAM-fit sweep — see "Validated RAM-fit findings" above.**
>
> The semantic-on-Zero question is settled. The three-way call below was the
> pre-sweep framing; it is preserved here for historical context only.

After the Zero hardware spike, the project should make one of three explicit calls:

1. `zero-appliance` ships q8 semantic ON by default — the RAM-fit sweep confirms this is viable (the expected outcome).
2. `zero-appliance` ships semantic ON with bge-small q8 as the default model (higher recall, ~25 MB more anon).
3. Raspberry Pi Zero 2 W is not a good appliance target; collapse into `zero-plus` as the entry tier and raise the hardware floor.

Independent of which of these lands, retrieval-quality work on both Zero and full Munin should prioritize **query-formulation guidance** over retrieval-engine changes. The pilot identified tight namespace filters, bare-`OR` FTS5 syntax, and abstract paraphrase as the dominant failure modes — all addressable through `memory_query` tool-description guidance and applicable to every profile.

## Practical product direction

The intended user experience remains simple:

- one box
- one product
- core memory works by default
- semantic search is an enhancement, not a dependency

The implementation may use multiple internal services later, but the product should not force extra hardware or complicated user-managed software just to deliver the core memory experience.
