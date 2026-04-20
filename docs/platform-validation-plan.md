# Munin Memory Platform Validation Plan

Status: concrete experiment plan, not a product-feature implementation plan.

This document turns the parallel platform track into an engineering validation plan.

The goal is to decide what hardware/runtime profile Munin can honestly support, not to
force the product to fit wishful assumptions.

## Goal

Validate Munin on constrained hardware and define a realistic support floor.

At the end of this plan:

- the Zero-class deployment story should be backed by measurement
- performance budgets should exist for core operations
- semantic search should be clearly classified as core, optional, or unsupported for the
  constrained profile

## Guiding Rules

- do not rewrite first
- measure the real product shape, not a stripped-down toy
- validate core memory before semantic search
- keep SQLite and the MCP contract stable unless the measurements force a different
  conclusion

## Current Touchpoints

- [docs/appliance-profiles.md](docs/appliance-profiles.md)
- current runtime flags for semantic/hybrid search
- deploy/service scripts already used for Pi-class hardware

Relevant current behavior:

- `full-node` is already a real deployment shape
- `zero-appliance` is still a product hypothesis
- semantic search is already optional and can be disabled

## Design Decisions

### 1. Core-only validation comes first

The first real-hardware pass should disable semantic and hybrid features and validate:

- state/log read and write
- `memory_orient`
- lexical query
- history/list/read/get

### 2. Measure representative workflows, not microbenchmarks only

The benchmark workload should reflect actual use:

- opening a new session
- reading a project status
- querying active work
- appending logs
- writing or updating project state

### 3. Capture both latency and operational stability

Latency alone is not enough. The platform track should measure:

- p50/p95 latency
- idle memory footprint
- CPU spikes
- restart behavior
- WAL/checkpoint behavior
- failure recovery

### 4. Treat semantic search as a separate gate

If core memory is good but local semantics are not, the result should still count as a
successful `zero-appliance` outcome.

## Workstream A: Benchmark Harness and Dataset

### Deliverables

- a repeatable benchmark script or harness
- a representative seed dataset
- a standard results format

### Dataset Shape

Seed the system with:

- tracked project statuses
- decision logs
- people/profile entries
- enough history to make `memory_orient`, `memory_query`, and `memory_attention`
  realistic

The dataset should be large enough to be meaningful, but still representative of the
intended personal/small-trust use case.

### Metrics

For each run, capture:

- p50 and p95 latency for `memory_orient`
- p50 and p95 latency for lexical `memory_query`
- p50 and p95 latency for `memory_write`
- p50 and p95 latency for `memory_read`
- process RSS
- CPU utilization during steady-state and burst phases
- DB file size and WAL growth

### Output

Store benchmark results in a simple, diffable format such as JSON or Markdown under a
local-only benchmark directory or `tmp/`.

## Workstream B: Zero Baseline Validation

### Target

- Raspberry Pi Zero 2 W class hardware

### Runtime Shape

- semantic features disabled
- realistic service configuration
- realistic reverse-proxy assumptions where relevant

### Scenarios

Validate:

- cold start
- warm query and orient flows
- light sustained interactive use
- restart and recovery
- overnight idle stability if feasible

### Acceptance Criteria

The baseline passes if:

- core tools remain responsive under normal use
- the process is stable at idle and under light sustained interaction
- restarts are clean
- lexical search remains compelling enough that the product is still useful

## Workstream C: Semantic Follow-Up

Only run this after the Zero baseline passes with headroom.

### Goal

Determine whether local semantic search can exist as an optional enhancement without
damaging the core experience.

### Scenarios

- local embedding generation
- semantic query latency
- backlog behavior for new/updated entries
- impact on core read/write/orient latency

### Decision Rule

If semantic behavior meaningfully harms core memory quality, semantic search does not
ship as a default capability on the constrained profile.

## Workstream D: Packaging and Runtime Boundary Review

This workstream only happens after baseline measurements exist.

### Questions

- does the main process remain simple enough as-is?
- would a same-device sidecar meaningfully improve fault isolation?
- are current runtime flags sufficient for profile separation?

### Constraint

Do not split the architecture merely because it sounds cleaner. Runtime boundaries
should be justified by measured isolation or operability wins.

## Recommended Implementation Order

Run the platform validation track in this order:

1. benchmark harness and representative dataset
2. Zero baseline core-only validation
3. semantic follow-up if the baseline passes
4. runtime-boundary review and packaging decisions

## Decision Outcomes

At the end of the platform track, explicitly choose one of:

1. `zero-appliance` is viable for core memory only — users who want semantic move up to `zero-plus-appliance` (Pi 5 2GB).
2. `zero-appliance` is viable for core memory plus some form of constrained semantic search (e.g. smaller model, offloaded embedding path).
3. Zero-class hardware is not a good product target; collapse into `zero-plus-appliance` as the entry tier and raise the hardware floor.

See [appliance-profiles.md](appliance-profiles.md) for the full profile matrix including `zero-plus-appliance`.

## Done Criteria

The platform validation track is complete when:

- benchmark data exists for the constrained profile
- performance budgets are written down
- the project can make an honest support statement about Zero-class hardware
