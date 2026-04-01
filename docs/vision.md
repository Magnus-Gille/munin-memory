# Munin Memory Vision

## Product Thesis

Munin Memory is a self-hosted, MCP-native memory layer for AI assistants that need
continuity across conversations, devices, and clients without giving up user control.

The project exists to solve a specific problem:

- local files and git history contain the detailed truth, but they are not available in
  every AI environment
- hosted AI memory features are convenient, but they are provider-owned and
  provider-shaped
- assistants need a portable summary layer that survives session boundaries and works
  across CLI, desktop, web, and mobile clients

Munin is that summary layer.

## What Munin Is

Munin is an operational memory system for a person or a small trusted group.

It is designed around a few core ideas:

- **Sovereign memory:** the user owns the database, controls the deployment, and can
  move providers without losing memory
- **MCP-native access:** memory is exposed as a tool protocol for assistants, not as an
  afterthought adapter
- **Cross-environment continuity:** the same memory should be available from local code
  sessions, desktop clients, browser clients, and mobile clients
- **Summary over transcript:** Munin stores durable, portable context, not every raw
  artifact or conversation turn
- **Operational memory, not just recall:** project state, decisions, commitments,
  chronological history, and orientation matter as much as semantic search

## The Core Product Shape

Munin is strongest when it acts as the bridge between two layers:

- **Detail layer:** local files, git history, drafts, notes, and working artifacts
- **Summary layer:** portable state, logs, and cross-cutting context that an assistant
  can retrieve from anywhere

This is why the state/log split matters.

- **State entries** capture current truth
- **Log entries** capture what happened and why

The goal is not to store everything. The goal is to preserve the right context so a new
session can resume with continuity instead of reconstruction.

## Target User

Munin is for:

- technically comfortable individuals who use AI seriously across multiple environments
- small trusted groups such as family members or tightly scoped collaborators
- people who care about long-term continuity, auditability, and provider portability

Munin is not optimized for:

- enterprise compliance buyers
- mass-market consumer note-taking
- teams that want a polished hosted SaaS with zero self-hosting effort

## Differentiators

Munin's differentiation is not "vector search, but self-hosted." That is not enough.

The real differentiators are the combination of:

- **state and log as first-class memory types**
- **tracked project status and computed orientation across environments**
- **SQLite-backed, zero-ops deployment on modest hardware**
- **real remote access via OAuth and bearer auth, not only local CLI usage**
- **an opinionated workflow for durable, portable operational memory**

If Munin wins anywhere, it wins as the memory layer for people who want their assistant
to feel continuous across time and clients while keeping the system understandable and
under their control.

## What Munin Is Not

Munin should not try to become all memory products at once.

It is not:

- a general-purpose cloud agent platform
- a document-ingestion and research product in the style of Khoj
- a full temporal knowledge graph platform in the style of Zep/Graphiti
- a managed enterprise memory API in the style of mem0
- a replacement for local project files or git history

These systems are solving different problems and are backed by different constraints.

## Product Standard

The quality bar is simple:

> Starting a new session in any supported client should feel like the assistant has
> enough of the right context to continue the work without making the human reconstruct
> it from scratch.

That means Munin should get better at:

- surfacing the right context early
- distinguishing current truth from historical narrative
- noticing stale or dropped commitments
- preserving decision rationale, not just facts
- degrading gracefully on constrained hardware

## Strategic Direction

Near-term product work should reinforce the current thesis rather than dilute it.

Good directions:

- recency- and staleness-aware retrieval
- temporal validity for state entries
- narrative and commitment-aware orientation
- low-friction memory capture that suggests writes without forcing external APIs
- stronger cross-agent and cross-user continuity within a small-trust model

Bad directions:

- chasing feature parity with every high-star memory project
- building a broad hosted platform
- turning Munin into a giant document warehouse
- adding heavyweight graph machinery before the simpler operational gaps are solved

## Decision Filter

A new feature is on-strategy when it clearly improves one or more of these:

- continuity across environments
- quality of operational context
- user control and provider portability
- reliability on modest self-hosted hardware
- the assistant's ability to resume work with less reconstruction

If a feature mainly adds surface area without improving those outcomes, it is probably
off-strategy.
