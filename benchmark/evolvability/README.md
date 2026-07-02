# Memory Evolvability — Outcome Eval (#186)

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
  `VERDICT:` line. A high invalid rate means the model isn't following the
  output contract, not that it's making bad decisions — inspect before
  trusting the flip rates.

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
EVOLVABILITY_MODEL=some-model \
  npx tsx benchmark/evolvability/runner.ts \
  --corpus benchmark/evolvability/corpus/toy.json \
  --arms A,B,C --k 5 \
  --out benchmark/reports/evolvability
  # ^ benchmark/reports/ is already gitignored — reuse it rather than adding
  #   a new ignore rule for this layer specifically.

# Against the M5 (local inference — see the M5 section of the repo owner's
# global instructions for auth/base-URL conventions; this eval defaults to
# the M5 loopback endpoint already):
MUNIN_LLM_BASE_URL=http://127.0.0.1:8091/v1 \
EVOLVABILITY_MODEL=qwen3-coder-next-80b \
  npx tsx benchmark/evolvability/runner.ts \
  --corpus benchmark/evolvability/corpus/toy.json \
  --arms A,B,C --k 10 \
  --out benchmark/reports/evolvability
```

Flags: `--corpus <file>` (default: the toy corpus), `--arms A,B,C` (default:
all three), `--k <n>` (default: 5), `--out <dir>` (**required**), `--model
<name>` (overrides `EVOLVABILITY_MODEL`), `--temperature <n>` (default 0.7),
`--max-retries <n>` (default 1).

Env: `MUNIN_LLM_BASE_URL` (default `http://127.0.0.1:8091/v1` — **note this
differs from the shared `src/internal/openrouter.ts` client's default**,
which points at the OpenRouter API; this eval is built to run local sweeps
by default), `EVOLVABILITY_MODEL` (required — no default, since silently
picking a model would make flip-rate numbers across runs incomparable),
`OPENROUTER_API_KEY` (optional bearer token, omitted entirely when unset).

Requests are sequential with a basic retry (one retry by default) on a 5xx
response or a network-level error; 4xx responses and malformed-JSON bodies
fail immediately. No concurrency in v1 — see Follow-ups.

Output per run: a timestamped JSONL of raw `RunRecord`s, an aggregate JSON
(`AggregateStats[]` plus a `meta` block with model/temperature/k/corpus
lineage), and a compact markdown summary table (one row per world × arm:
should-flip rate, false-flip rate, binary/ternary agreement, invalid count).

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
- **Consolidation pre/post toggle.** Run the same corpus through the
  consolidation worker (`src/consolidation.ts`) before evaluating arm B, to
  test whether synthesis destroys decision-reversal capability — direct
  input to #98 (what must retention preserve?).
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
