# Munin Memory Roadmap

Status: current planning baseline as of 2026-07-22.

This roadmap prioritizes work against Munin's product standard:

> Starting a new session in any supported client should feel like the assistant
> has enough of the right context to continue useful work without making the
> human reconstruct it.

The original four implementation phases are substantially shipped. Their
engineering plans remain useful design records, but they are no longer the
active sequence. Current strategy is informed by
[`vision.md`](vision.md) and the
[July 2026 competitive analysis](competitive-analysis-2026-07.md).

## Product thesis

Munin is sovereign operational memory for one person or a small trusted group:
current truth, immutable decision history, least-privilege sharing, and reliable
cross-client resumption from a database the user owns.

The project should compound its distinctive strengths:

- mutable state and append-only logs as separate first-class concepts;
- source-backed orientation, resume, handoff, commitments, and narrative;
- explicit correction/supersession rather than silent history rewriting;
- MCP-first provider portability and a small SQLite/ARM deployment;
- CAS, provenance, classification, scoped principals, and stored-content
  injection defenses;
- graceful lexical operation when semantic infrastructure is unavailable.

## Current baseline

Munin v0.5 already includes:

- lexical, semantic, and hybrid retrieval with recency and expiry handling;
- `valid_until`, correction chains, `valid_from`, lineage, and as-of reads;
- suggestion-only extraction plus orient, resume, handoff, narrative,
  commitment, pattern, attention, and health tools;
- Bearer and OAuth access, multi-principal namespace authorization, transport
  classification, and pre-synthesis source filtering;
- retrieval analytics, benchmark harnesses, hardware profiles, encrypted
  offsite backup, and a live ARM64 deployment.

The main gap is no longer another retrieval primitive. It is proof,
productization, and a complete human-controlled capture workflow.

## Phase 0: Re-baseline and remove ambiguity

Goal: start the productization cycle from a trustworthy backlog and current
documentation.

- Audit draft PR #187 against current main; salvage the decision-provenance
  benchmark only after its security finding and M5 signal gate are resolved.
- Retire PR #206 as an obsolete implementation branch; preserve #170 as a
  deliberate v21+ port if multi-worker SQLite becomes a supported path.
- Reconcile #4 against production Librarian evidence and close it when the
  rollout record is complete.
- Patch compatible dependency advisories and track upstream-blocked Hono/Sharp
  remediation in #236.
- Mark the original phase plans as historical and keep this file as the active
  implementation sequence.

Exit criteria:

- no stale PR is mistaken for merge-ready work;
- every residual dependency advisory is fixed or has a documented reachability
  decision and tracking issue;
- roadmap and issue state describe the deployed product accurately.

## Phase 1: Make Munin easy and provable

Goal: demonstrate that Munin works end to end and that a new operator can reach
first success without learning the architecture first.

1. **#225 — five-minute install and first-success flow**
   - one canonical macOS/Linux path;
   - preflight for runtime, SQLite, paths, permissions, ports, auth, and profile;
   - generated secret-safe client configuration;
   - verified health -> write/log -> orient/resume loop;
   - automated clean-environment smoke test and safe upgrade/rollback guidance.

2. **#227 — publishable end-to-end scorecard**
   - complete the 500-question LongMemEval-S Phase A run;
   - enforce and report a retrieved-token budget;
   - pin model/provider/environment metadata;
   - report answer quality, stage latency, tokens, RAM, disk, and cost;
   - add repetition/variance and adversarial authorization/poison lanes;
   - publish raw artifacts, limitations, and a dated summary.

3. **#222 — privacy-safe dogfood and TCO case study**
   - versioned redacted evidence export;
   - operational scale, latency, reliability, backup/restore, and upgrade data;
   - operator-time and realistic hosted/local cost scenarios;
   - outcome examples without memory text, private identities, or topology.

Exit criteria:

- a clean supported machine reaches first write-to-resume success in five
  minutes;
- Munin has a reproducible end-to-end result rather than only retrieval recall;
- product claims link to dated, privacy-reviewed evidence.

## Phase 2: Complete human-controlled capture

Goal: turn suggestion-only extraction into a durable, reviewable workflow
without allowing stored content or models to mutate truth autonomously.

1. **#181 — write-time intake quality gate**
   - recover the useful LLM-free advisory core from the archived work;
   - detect redundancy, duplicate overwrite, tag drift, namespace problems, and
     likely consolidation candidates;
   - keep the first implementation internal/advisory; add another MCP tool only
     if measured use justifies it.

2. **#223 — durable review inbox**
   - persist principal-scoped proposals with bounded/redacted source references;
   - validate secrets, classification, transport, size, and instruction-shaped
     content before durable storage;
   - support approve, decline, edit, expire, fail, and supersede transitions with
     append-only audit events;
   - apply through existing auth, CAS, and correction semantics;
   - implement undo as a reviewed corrective operation, never history deletion.

3. **#5 — real household onboarding pilot**
   - validate the principal/profile path with a real second user;
   - exercise personal and shared namespaces, consumer transport, review
     ownership, and cross-client resumption.

Exit criteria:

- extract -> review/edit -> approve -> resume is durable and auditable;
- no approval or undo path bypasses ordinary write controls;
- a real second principal can use the system without owner-shaped conventions.

## Phase 3: Deliver context and portability

Goal: reduce agent/tool friction and make user-owned data inspectable and
movable without creating a second source of truth.

1. **#226 — measured context-pack/receipt contract**
   - establish a wrong-tool/unnecessary-call baseline against the existing tools;
   - add at most one composite front door unless evidence proves distinct needs;
   - enforce explicit token budgets and return source, ranking, freshness,
     provenance, scope, truncation, and degraded-mode receipts.

2. **#228 — versioned portable interchange**
   - preserve state, logs, audit history, classifications, provenance, validity,
     supersession, ownership, identifiers, and references;
   - exclude credentials, encrypted OAuth material, sensitive operational data,
     and disallowed analytics;
   - provide authorized scoped export plus dry-run, collision handling, and an
     atomic or resumable idempotent import.

3. **Thin clients and inspection surface, only after contracts stabilize**
   - TypeScript/Python wrappers over MCP/HTTP rather than a parallel semantic API;
   - a replaceable local surface for search, history, proposal review,
     correction, sharing inspection, retrieval explanation, and export;
   - no general chat or document-management product.

Exit criteria:

- agents use less context and fewer unnecessary calls without losing provenance;
- authorized users can inspect and transfer their data safely;
- expert tools remain available for compatibility and debugging.

## Phase 4: Evidence-driven intelligence

Goal: add richer behavior only when evaluation demonstrates that it improves
decisions or continuity.

- **#186 — decision-provenance/evolvability benchmark.** First validate the
  three-arm toy signal on M5, then test the real server, read gate, and
  consolidation behavior. Do not merge a large scaffold without the signal.
- **#97 — binary completion criteria.** Add lightweight human-authored,
  checkable criteria to tracked status and commitment views; do not build an
  autonomous verification engine.
- **#224 — per-principal retrieval preferences.** Explicit versioned preferences
  may ship first. Learned candidates remain gated on #227/#186 evidence,
  shadow-mode non-regression, expiry, audit, and owner approval.
- **#98 — tiered/windowed consolidation.** Preserve raw logs and add summaries
  only if #186 establishes which path information must remain retrievable and
  which synthesis formats preserve decision revision.

Exit criteria:

- each adaptive or consolidating feature names the evidence that justified it;
- no learned system weakens deterministic authorization, classification,
  validity, or untrusted-content rules;
- raw historical evidence remains available alongside derived summaries.

## Parallel trust and platform track

These are continuous obligations, not a separate product destination:

- close #4 only from documented production audit evidence;
- keep #170 low priority while production remains one worker per database;
- track upstream dependency remediation in #236;
- validate cold start, SD wear, power interruption, Wi-Fi loss, upgrade,
  rollback, backup restoration, and recovery time on real appliance profiles;
- complete the reachable-history and hosting-artifact review described in
  `PUBLICATION.md` before making stronger public-release claims;
- retain independent review for auth, schema, worker, and data-integrity changes.

## Default 90-day target

A realistic productization cycle delivers:

1. five-minute first success (#225);
2. a publishable Munin end-to-end scorecard (#227);
3. a privacy-safe dogfood/TCO case study (#222);
4. a validated durable review inbox (#181 + #223);
5. measurement/specification—not necessarily full implementation—for #226 and
   #228.

The outcome gate is practical: can a fresh client resume real work faster, with
fewer corrections and no trust-boundary regression? If not, more retrieval
machinery is unlikely to fix the product.

## Explicit non-goals

Defer unless evidence changes the product thesis:

- a full temporal knowledge graph;
- broad document connectors or multimodal ingestion;
- automatic server-side truth, prompt, skill, or policy mutation;
- a full agent runtime or context-window owner;
- managed SaaS;
- more retrieval micro-tuning before end-to-end evidence;
- more MCP tools without measured tool-choice failure;
- a broad general-purpose web UI.

## Planning discipline

- GitHub Issues own executable backlog work; this file owns ordering and gates.
- Local state files own branch, commit, blocker, and exact-next-step detail.
- Munin project status owns the brief cross-environment current summary.
- Update this roadmap when a phase outcome or dependency changes, not after every
  merged PR.
