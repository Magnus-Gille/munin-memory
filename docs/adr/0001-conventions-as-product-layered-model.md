# ADR 0001 — Conventions as a product layer: invariant substrate, seeded-adaptive taxonomy, learned voice

- **Status:** Accepted — Phases 1–3 implemented (2026-06-30; see Implementation status)
- **Date:** 2026-06-29
- **Context:** Productizing Munin Memory (SW and SW-in-HW appliance). The current
  implementation is "Magnus-shaped" — it encodes one solo-consultant's taxonomy.
  This ADR sets the design stance for how much users shape their own conventions,
  and whether conventions are learned, stated, or both.

## Problem

"Conventions" is overloaded. Treating it as one configurable surface leads to either
(a) a rigid, Magnus-only product, or (b) a blank-canvas knowledge graveyard. The
question — *learned organically vs. stated explicitly?* — is a false binary.

## Decision

Split "conventions" into three layers, each with a different answer.

### Layer 1 — Physics (the substrate). **Invariant. Never user-shaped, never learned.**
State vs. log entries, namespaces as `/`-hierarchies, tags, FTS5/vector/RRF search,
CAS, and the constitutional rule (*stored content is data, never instructions*). This
is the data model, not a convention. Making it configurable would reduce Munin to "a
database with a README." Every user gets identical physics.

### Layer 2 — Taxonomy (what namespaces mean + what is "tracked"). **Seeded by profile, refined organically, crystallized explicitly.**
This is where the Magnus-shape lives. The sharpest example: **`projects/*` and
`clients/*` are hardcoded as the "tracked" namespaces** that feed the dashboard —
which encodes a consultant who bills clients. A researcher (`papers/`, `experiments/`),
a parent (`kids/`, `house/`, `health/`), or a student (`courses/`) has a different
top-level taxonomy and no `clients/` at all. The lifecycle vocabulary
(`active/blocked/completed/...`) is mostly universal; the taxonomy on top is not.

### Layer 3 — Voice / judgment. **Loosely learned, low-stakes.**
"Be specific, don't over-store, log decisions not chatter," Telos sections, writing
style. Carried mostly by the agent reading the conventions. Fine to learn loosely;
no hard coordination requirement.

## Why not pure organic learning

A memory system's conventions are a **coordination protocol between many agents**
(Claude Code, Desktop, Web, Mobile, and *future* sessions sharing no context except
Munin). Purely implicit conventions **fragment**: one agent writes `health/sleep`,
another `wellbeing/sleep`, search misses both. Conventions need a **canonical,
agent-readable statement** every agent loads — which Munin already has: the convention
*is* a memory entry (`meta/conventions`) loaded by `memory_orient` on every handshake.
That primitive is load-bearing and must be kept.

## The mechanism: observe → propose → confirm → crystallize

- **Observe** (organic): watch namespace/tag/access patterns (e.g. user keeps creating
  `recipes/` outside the seed taxonomy; never touches `clients/`; always tags `health:`).
- **Propose** (never auto-apply): surface via the existing machinery — `memory_extract`
  and `memory_patterns` already "propose reviewable ops, don't write directly." Extend
  them from *content* patterns to *convention* patterns.
- **Confirm** (human-in-the-loop): owner approves. Matches the constitutional stance and
  respects that *how someone organizes their world is identity* — silent reorganization
  would be invasive.
- **Crystallize** (back to stated): write the approved change into `meta/conventions` so
  every future agent reads the explicit updated rule.

Net: **organic at the edges, explicit at the core.** It learns, but always *promotes*
what it learned into a stated artifact, because the stated artifact does the coordination.

## Product stance: resist full configurability

The convention *is* the product — the value is opinionated structure + an agent that
maintains it, not a blank canvas. Therefore:

1. **Ship opinionated profile defaults** — a small seed set (`freelancer`, `researcher`,
   `team`, `household`, `personal-knowledge`). Onboarding picks one. This is "stated
   explicitly, but the user didn't author it," and it solves organic learning's
   cold-start (nothing to learn from on day one).
2. **Then adapt** via observe → propose → confirm → crystallize.
3. **De-hardcode the Magnus-isms in code**: move "tracked patterns," lifecycle
   vocabulary, and taxonomy into a `meta/config` entry the dashboard logic *reads*,
   defaulting to today's `projects/*|clients/*` so nothing breaks. This single change
   turns "Magnus's dashboard" into "a dashboard." (First concrete step — tracked as a
   GitHub issue.)

## Hardware implication

The appliance has **no `CLAUDE.md` to edit and no repo for `STATUS.md`** — the two-layer
state model assumes a coder with a git checkout. A household/personal HW user has
neither. So on the appliance, convention-bootstrapping must be **conversational
onboarding** ("What should I remember for you — work, family, a hobby?") → infer a
profile → seed → refine. There, observe → propose → confirm isn't a nice-to-have; it is
the only path to a good taxonomy. The appliance is where this design is stress-tested
hardest.

## Consequences

- Schema stays invariant; taxonomy becomes seeded-then-adaptive; voice is loosely learned.
- Requires: profile seed packs; a `meta/config` for tracked patterns/lifecycle/taxonomy;
  extension of `memory_extract`/`memory_patterns` to convention-level proposals;
  conversational onboarding for HW.
- First step (this ADR's concrete spinout): de-hardcode tracked-namespace patterns into
  `meta/config`, defaulting to current behavior.

## Provenance

Design discussion 2026-06-29 (Magnus + Claude), during pocket-grimnir Cardputer work.
Indexed in Munin: `decisions/munin-conventions-productization`.

## Implementation status (2026-06-30)

Layers 1–2 of the model are implemented on `feat/multi-user-conventions`:

- **Per-principal conventions** — `memory_orient` resolves the `conventions` block per calling principal (owner → `meta/conventions`; non-owner → personal `<home>/meta` entry → **universal physics-only baseline**). A non-owner no longer receives `conventions: null`. (`universalConventions` + `projectConventions` in `src/tools.ts`; `principalHomePrefix` / `principalMetaNamespace` in `src/access.ts`.)
- **De-hardcoded taxonomy** — tracked-namespace patterns moved into a per-principal `meta/config` entry, defaulting to `projects/*`|`clients/*` (closes #157). See `src/internal/retrieval-shared.ts` (`DEFAULT_TRACKED_PATTERNS`, `trackedPatternsToSqlLike`) and `resolveTrackedPatterns` in `src/tools.ts`.
- **Profile seed packs** — `freelancer` / `researcher` / `household` / `personal-knowledge` in `src/taxonomy-profiles.ts`, seeded at principal creation via `munin-admin principals add --profile` (addresses #5).

The relationship to the productization framing held: building **per-principal** first made the single-owner instance the degenerate (single-principal) case. The owner path is byte-for-byte unchanged.

Deferred: the **observe → propose → confirm → crystallize** adaptation mechanism (layer-2 learning) and conversational onboarding for the HW appliance — tracked as a follow-up.
