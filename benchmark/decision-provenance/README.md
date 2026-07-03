# Decision-Provenance Value — Outcome Eval (#186)

This is a separate benchmark layer from the retrieval-quality harness
(`benchmark/` R@k / nDCG / MRR, `benchmark/ci-gate.ts`) and from the RAG
answer-quality eval (`benchmark/answer-quality/`). Those measure whether the
right *content* comes back, or whether an answer is factually correct. This
layer measures something upstream of both: **whether an agent that holds a
decision's PATH (rationale + rejected alternatives) reacts to new
information correctly, versus an agent that holds only the DESTINATION
(what was chosen).**

Munin's two-layer model always stores both a destination (mutable state
entry — "what was chosen") and a path (append-only decision log — "why").
Nothing before this measured whether serving the path actually changes
agent behavior in a way that matters. Two roadmap items are blocked on
exactly this measurement capability: #98 (tiered/windowed consolidation with
raw-source retention — needs an answer to "what must retention preserve?")
and Feature 4 Phase 2 (learned reranking — needs "what should
retrieval surface/bundle?").

## Concept

A `World` is one decision: what was chosen, why, what was rejected and why,
plus the memory that would actually be stored for it (a destination entry
and one or more path-log entries). Each world ships with `Probe`s — short
pieces of "new information" that arrive after the memory is retrieved:

- **`perturbation`** probes legitimately bear on the decision and should
  trigger at least reconsideration.
- **`stasis`** probes are decision-adjacent noise and should trigger nothing.
  These are the control group: without them, an agent that reopens on
  *any* new input would look identical to one that reopens correctly.

**The governing design rule: perturbations must attack the rationale or a
rejected branch, never the decision surface itself.** A probe that says (in
effect) "the chosen option is now known to be bad" would flip an agent that
holds only the destination too — arm A would react identically to arm B, and
the case would measure nothing about path-holding specifically. A probe must
instead undermine *why* the decision was made (rationale) or *why an
alternative was passed over* (rejected branch), so only an agent that
actually has that reasoning available can act on it correctly.

**Behavioral-test vocabulary (CheckList).** The two probe kinds map directly
onto Ribeiro et al.'s CheckList test types, and we adopt that vocabulary for
legibility to the NLP-eval community: a `perturbation` probe is a **Minimum
Functionality Test (MFT)** — a targeted case the agent must get right — and a
`stasis` probe is an **Invariance Test (INV)** — an input that must *not*
change the behavior. A should-reopen-*in-a-specific-direction* probe would be a
**Directional Expectation Test (DIR)**; that third kind is a Follow-up.

**Perturbation-authoring discipline (contrast sets).** Following Gardner et
al.'s contrast-set construction, a perturbation must be a *minimal, targeted*
edit — small enough that it changes only the rationale's or a rejected branch's
validity, not the general readability of the scenario. Author each perturbation
as the smallest change that undermines the specific reasoning, and record its
intent via `Probe.attacks` (`rationale` | `rejected-branch`) so a case that
accidentally attacks the decision surface is caught in review rather than
silently measuring comprehension instead of rationale-dependent revision. Where
a rationale depends on a *chain* of conditions, distinguish single-hop from
multi-hop perturbations (cf. MQuAKE's ripple-effect construction) so the corpus
can report revision recall as a function of reasoning depth.

## Arms

| Arm | Memory payload | Purpose |
|---|---|---|
| A | destination only | Baseline — no rationale, no rejected alternatives. |
| B | destination + full path | The condition being evaluated: does having rationale + rejected alternatives change behavior? |
| C | destination + length-matched neutral filler | Active control. Separates "more context mass" from "the specific path information" as the explanation for any A→B behavior delta. |

Arm C's filler (`arms.ts`) is built deterministically, without any model
call: it draws path-log material from *other* worlds in the corpus, strips
every word (and full rejected-option phrase) that overlaps this world's
rationale/rejected text, and cycles/trims the result to within ±10% of arm
B's path-only payload length. This guarantees arm C never leaks this world's
specific path information while still costing the model roughly the same
amount of context to read.

## Metrics

Grading is **parser-based, not LLM-judge**, on the primary metric. The
output contract is a single strict line (`grade.ts` extracts the *last*
`VERDICT: {...}` JSON object in the response, robust to prose, whitespace,
and markdown fences). A hand-rolled parser over a fixed three-value enum is
both cheaper and more auditable than an LLM judge would be here — there is
no ambiguity-of-phrasing problem for a judge to resolve, just a JSON
contract to parse correctly. An LLM judge is reserved for a possible future
"frontier arm" comparison (see Follow-ups), not the primary flip-rate
numbers.

Two levels of match, per run:

- **Ternary** — exact match against `Probe.expected` (`REOPEN_SWITCH` /
  `REOPEN_HOLD` / `HOLD`).
- **Binary** — `REOPEN_SWITCH` and `REOPEN_HOLD` both count as "reopened";
  compares reopen-vs-hold class only. This is the class flip-rate metrics
  are computed on.

Per (world × arm × probe), aggregated over `k` runs (`runner.ts`):

- **should-flip rate** — for perturbation probes: fraction of runs that
  correctly reopened (binary match). This is *recall* on flips.
- **false-flip rate** — for stasis probes: fraction of runs that incorrectly
  reopened. This is the *precision* counterpart — it catches an
  always-flip agent that would otherwise look great on should-flip alone.
- **binary / ternary agreement rate** — overall correctness at each
  granularity.
- **invalid rate** — fraction of runs whose response had no parseable
  `VERDICT:` line (present but malformed). A high invalid rate means the
  model isn't following the output contract, not that it's making bad
  decisions — inspect before trusting the flip rates.
- **blank rate** — fraction of runs whose response came back HTTP 200 but
  empty/whitespace-only (e.g. a thinking model starved by a too-tight
  `max_tokens`). Distinct from invalid: the call succeeded, the model just
  produced nothing.
- **errored rate** — fraction of runs whose *call itself* failed (HTTP error
  after exhausting retries, or a network error) — infrastructure noise, not a
  model decision. Mutually exclusive with blank/invalid. Should-flip and
  false-flip rates are computed over decided runs only (`k - errored`) and
  are `undefined` (not `0`) when a cell has no decisions at all. If the
  overall errored rate exceeds a threshold (default 20%), the runner prints a
  loud stderr banner and prepends a warning to the markdown summary — a high
  errored rate means the results are not trustworthy, full stop.

Two metric extensions are motivated by the #186 prior-art spike (see
**Prior-art grounding** below) and are tracked as Follow-ups — not yet in
`runner.ts`:

- **dead-end re-proposal rate** — of the runs that reopen on a
  `rejected-branch` perturbation, the fraction that re-propose an option the
  original decision had *already rejected for a reason the perturbation does
  not remove*. A path-holding agent (arm B) should reopen **and** avoid the
  dead end; a destination-only agent (arm A) that reopens has no way to know
  the branch was already walked — so this is the sharpest A-vs-B discriminator.
  It requires extending the VERDICT contract to name the option switched to,
  and marking dead-end options in the corpus. (MemoRepair's cascade-staleness
  framing: source invalidation must not resurrect a stale derived choice.)
- **consolidation transition quality (TrustMem axes)** — when the
  consolidation toggle (Follow-ups) lands, grade the pre/post-synthesis path
  not as a single pass/fail but on TrustMem's three axes: *coverage* (is the
  rationale still present?), *preservation* (is it unchanged?), *faithfulness*
  (does it still support the correct revision?). This distinguishes a
  consolidation that keeps the words but loses the decision-reversal signal
  from one that drops the content outright.

`k >= 5` runs per (world, arm, probe) is the default — a single run per cell
is a coin flip at nonzero temperature (default 0.7, deliberately stochastic:
flip *rates* are the object of study, not single outcomes).

## Corpus format

See `types.ts` for the full `World`/`Probe` shape and `corpus.ts` for
validation (hand-rolled, no schema-validator dependency — clear,
field-specific error messages instead). `corpus/toy.json` is a small,
**fully invented** two-world v1 corpus (generic engineering scenarios — a
message-queue library choice, a sensor-vendor choice) used for scaffold
tests and smoke runs. It contains no real project, client, or decision data
from anywhere.

**Contamination rule:** real mined decisions and eval content must never be
stored in Munin where an evaluated agent could retrieve them. The toy corpus
here is safe by construction (invented); a future real-case corpus (see
Follow-ups) must be handled as an external fixture, never written into a
live Munin instance under test.

## Running

```bash
# Smoke run against the toy corpus, all three arms, k=5 (defaults)
DECISION_PROVENANCE_MODEL=some-model \
  npx tsx benchmark/decision-provenance/runner.ts \
  --corpus benchmark/decision-provenance/corpus/toy.json \
  --arms A,B,C --k 5 \
  --out benchmark/reports/decision-provenance
  # ^ benchmark/reports/ is already gitignored — reuse it rather than adding
  #   a new ignore rule for this layer specifically.

# Against the M5 (local inference — see the M5 section of the repo owner's
# global instructions for auth/base-URL conventions; this eval defaults to
# the M5 loopback endpoint already):
MUNIN_LLM_BASE_URL=http://127.0.0.1:8091/v1 \
DECISION_PROVENANCE_MODEL=qwen3-coder-next-80b \
  npx tsx benchmark/decision-provenance/runner.ts \
  --corpus benchmark/decision-provenance/corpus/toy.json \
  --arms A,B,C --k 10 \
  --out benchmark/reports/decision-provenance
```

Flags: `--corpus <file>` (default: the toy corpus), `--arms A,B,C` (default:
all three), `--k <n>` (default: 5), `--out <dir>` (**required**), `--model
<name>` (overrides `DECISION_PROVENANCE_MODEL`), `--temperature <n>` (default 0.7),
`--max-retries <n>` (default 1).

Env: `MUNIN_LLM_BASE_URL` (default `http://127.0.0.1:8091/v1` — **note this
differs from the shared `src/internal/openrouter.ts` client's default**,
which points at the OpenRouter API; this eval is built to run local sweeps
by default), `DECISION_PROVENANCE_MODEL` (required — no default, since silently
picking a model would make flip-rate numbers across runs incomparable),
`OPENROUTER_API_KEY` (optional bearer token, omitted entirely when unset).

Requests are sequential with retry: a 5xx response or a network-level error
gets one retry by default (`--max-retries`); a **429** gets its own separate
retry budget (up to 4 attempts), honoring the `Retry-After` header (falling
back to a body hint, then a fixed default), capped at 30s per wait so a run
can't hang forever. Other 4xx responses and malformed-JSON bodies fail
immediately — no concurrency in v1 — see Follow-ups.

A run whose call ultimately fails (rate-limited past its retry budget, 5xx,
network) is recorded as `error` on the `RunRecord` and graded as **errored**
— never as a blank or malformed model response, and never counted as a
decision in should-flip/false-flip rates (see Metrics above).

Output per run: a timestamped JSONL of raw `RunRecord`s, an aggregate JSON
(`AggregateStats[]` plus a `meta` block with model/temperature/k/corpus
lineage), and a compact markdown summary table (one row per world × arm:
should-flip rate, false-flip rate, binary/ternary agreement, invalid count,
blank count, errored count). If the overall errored rate is high, the
markdown is prefixed with a loud warning banner and the same warning is
printed to stderr.

## Prior-art grounding & positioning (2026-07-02 spike)

A prior-art / novelty spike (report:
`~/mimir/research/munin/2026-07-02-memory-evolvability-prior-art.md`, task
`20260703-120327-memory-evolvability`) returned a **novel-in-combination**
verdict: no published work combines rationale-vs-outcome ablation,
rationale-attacking perturbations, stasis controls, pre/post-consolidation
comparison, and behavioral (non-QA) decision-revision measurement. Nearest
neighbors to cite and, where runnable, benchmark against:

- **DeMem** — decision-centric memory quality under compression; closest
  conceptual neighbor, grounds *why* rationale preservation matters. (Only the
  abstract was read in the spike — re-check the full paper before finalizing
  the novelty claim; it may contain a closer ablation.)
- **MQuAKE** — the ripple-effect "edit a premise, measure propagation"
  methodology; direct template for multi-hop perturbations.
- **TrustMem** — consolidation transition-quality axes
  (coverage / preservation / faithfulness); reused directly for the
  consolidation arm's grading.
- **MemoRepair** — cascade-update / source-invalidation framing (a repair
  system, so a citation not a runnable baseline); anchor for the dead-end metric.
- **Contrast sets** (Gardner et al.) and **CheckList** (Ribeiro et al.) —
  methodology baselines, adopted in **Concept** above.
- **MemoryArena** — closest existing benchmark to behavioral measurement;
  worth comparing on the action-coupled-memory angle.

**Framing — position as decision-provenance value, not "evolvability."** To
avoid a naming collision with **EvoMemBench** (whose "self-evolving" asks
whether memory helps an agent improve at tasks over time — a *different*
question), position this work as **"measuring the behavioral value of decision
provenance in agent memory."** That framing also connects more cleanly to the
model-editing / belief-revision and case-based-reasoning literatures.
**Case-based reasoning** (Hatalis et al. 2025) is conceptual kin — "adapt a
past solution to a new similar problem" vs. our "revise a past decision when
its assumptions change" — and must be distinguished explicitly in any writeup.

**Claim narrowed.** The spike refuted the broad claim that "no work measures
consolidation-caused decision-quality degradation" (TrustMem does, against
downstream task performance). The surviving, load-bearing claim is narrower:
*no work measures whether consolidation destroys **decision-reversal
capability** specifically* — the ability to correctly revise a prior decision
when its assumptions change. Frame the contribution on that narrower claim.

**Consolidation is not uniformly destructive.** The premise that consolidation
summarization destroys rationale holds only for systems that rewrite memories
in place (A-MEM); additive systems (Zep/Graphiti, HippoRAG) preserve the
rationale but may make it unreachable via retrieval prioritization. Burying
rationale and deleting it are different failure modes with the same behavioral
symptom, so the consolidation toggle must test **both** a destructive and an
additive mode (Follow-ups).

**Open decisions (need a human call before implementation):**

- **4th arm (D = decision + partial rationale, no rejected alternatives)** —
  would isolate the behavioral value of *rejected alternatives* from general
  reasoning provenance, at the cost of a larger corpus. Optional; unresolved.
- **Bayesian-optimal revision labels** alongside golden labels — flagged as
  possibly ill-defined for some perturbation types.
- **Timing / venue** — the spike recommends a preprint by ~Q4 2026 given
  moderate in-flight collision risk (ICLR MemAgents workshop is soliciting
  adjacent work). Urgency-vs-thoroughness is a call for Magnus.

## Follow-ups

- **Pattern library from consensus-surviving real cases.** The gated
  pipeline in issue #186 has a real-case mining step (14 candidate decisions
  → human-reviewed validation sheet) ahead of this scaffold. Once cases
  survive review, distill them into a pattern library (templated, not
  verbatim — see the contamination rule above) to grow the corpus beyond
  the two invented toy worlds here.
- **Server-mode.** Reuse the `ci-gate.ts` pattern (synthetic corpus →
  ephemeral SQLite, nothing binary committed) to run this against the
  *real* Munin server end-to-end: real retrieval, real read-gate
  (`applyUntrustedEnvelope` — does the untrusted-content wrapping tax
  provenance-rich path content? interacts with #154/#183), real
  `memory_write`/`memory_log` validation — instead of hand-assembling the
  arm payload string directly as this v1 scaffold does.
- **Consolidation pre/post toggle — destructive *and* additive modes.** Run
  the same corpus through the consolidation worker (`src/consolidation.ts`)
  before evaluating arm B, to test whether synthesis destroys decision-reversal
  capability — direct input to #98 (what must retention preserve?). Test two
  modes, not one: a **destructive** mode (rationale rewritten in place, A-MEM
  style) and an **additive** mode (rationale retained but deprioritized in
  retrieval, Zep/HippoRAG style) — they are distinct failure modes with the
  same behavioral symptom. Grade the transition on TrustMem's coverage /
  preservation / faithfulness axes rather than a single pass/fail (see Metrics).
- **Read-gate on/off toggle.** Compare arm B with and without the untrusted
  envelope wrapping applied to path-log content, to isolate whether the
  read-gate itself (rather than the underlying content) is the tax.
- **M5 overnight sweep script.** A thin wrapper around `runner.ts` that
  loops over multiple models/temperatures/arms unattended, writing one
  output directory per sweep cell, plus the swap-latency-aware batching
  discipline documented for `mcp__m5__ask` (warm up once, batch same-model
  calls).
- **Frontier arm.** A small-scale run against a frontier model, primarily as
  a transfer check (do small-model flip-rate patterns generalize?), not as
  the primary signal — per the issue's non-goals, this is not a compression
  license: a null result on sampled tasks does not mean the path is
  disposable, only that these tasks didn't exercise it.
- **Path format ablation.** Narrative (current toy corpus format) vs.
  structured counterfactual vs. reproduction-recipe-pointer, to see which
  path representation best preserves revision capability per unit of
  context cost.
- **Dead-end re-proposal metric.** Extend the VERDICT contract to name the
  option the agent switches to, mark already-rejected ("dead-end") options in
  the corpus, and aggregate the dead-end re-proposal rate (see Metrics) — the
  sharpest arm-A-vs-B discriminator.
- **DIR (directional) probes.** A third probe kind beyond MFT-perturbation and
  INV-stasis: cases where reopening is correct *only if it moves in a specified
  direction* (e.g. switch to a named alternative, not just "reconsider").
  Requires the option-naming VERDICT extension above.
- **Retrieval-stage vs decision-stage decomposition.** When a should-flip case
  fails, tag whether the rationale was never retrieved (retrieval failure) vs.
  retrieved but not acted on (reasoning failure) — cf. PrecisionMemBench's
  retrieval/generation split. Only meaningful once the server-mode toggle
  (real retrieval) lands, since the v1 scaffold hand-assembles the payload.
- **4th arm (D = partial rationale).** Optional — see the Open decisions note
  under Prior-art grounding.
