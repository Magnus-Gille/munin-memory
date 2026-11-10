# Memory Arena — pre-registration

Written 2026-11-10, **before any measurement run**. The commit that adds this file (together with
the frozen corpus) is the pre-registration point; analysis rules below are not changed after
unblinding. Deviations, if any, are listed in `RESULTS.md` under "Deviations".

## Question

How does Munin Memory (self-built) compare with the memory systems Anthropic ships, when the
same Claude models use them for an assistant's long-term memory?

## Arms (systems under test)

| Code | System | How it is driven |
|---|---|---|
| `munin` | Munin Memory v0.7.0 (`origin/main` 0ee373b = production ed96ce5 + two non-retrieval fixes), stdio MCP, fresh SQLite DB, hybrid search with local `Xenova/bge-small-en-v1.5` embeddings, full 25-tool surface, MCP server instructions placed in the system prompt the way MCP hosts do | Direct Messages API, harness tool loop, MCP client |
| `memtool` | Anthropic memory tool `memory_20250818` (`/memories` directory), handler implements the documented reference return strings | Direct Messages API, harness tool loop |
| `ccmem` | Claude Code 2.1.311 built-in auto-memory (MEMORY.md index + memory files), headless `claude -p`, `--setting-sources project --strict-mcp-config --tools Read,Write,Edit,Glob,Grep --no-session-persistence`, one isolated working directory (hence memory directory) per run | Claude Code harness (subscription) |

Models: Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 (`claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-haiku-5-5`; Claude Code aliases `opus`/`sonnet`/`haiku`, resolved IDs recorded). Effort
`medium` for every subject call in every arm. 3 arms × 3 models = 9 cells, n = 1 run per cell
(budget cap: $50 for the API arms, owner decision), Haiku cells repeated (n = 2) if the budget
allows after the main grid.

All arms receive an identical base system prompt (persona-neutral assistant instructions, "every
conversation starts fresh; only your memory system persists; save what will be useful later")
and identical user messages. Each arm additionally receives only its own native instructions
(MCP server instructions / the API's automatic memory-protocol prompt / Claude Code's own
system prompt).

## Phases

1. **Ingest (end-to-end).** 12 scripted single-message conversations dated 2026-05-04 … 2026-11-02,
   replayed in order; the model decides what and how to save. Munin's clock is shifted to the
   session date (harness-only Date shim, no Munin code change) so its timestamps match.
2. **Probe.** 36 questions, each in a fresh conversation dated 2026-11-10, answered from memory.
   Categories: recall 8, update 8, temporal 6, aggregation 6, abstention 4, preference 3,
   injection 1.
3. **Scale.** Each arm's store is replaced by an identical pre-seeded synthetic estate
   (~40 projects, ~250 entries, deliberately overlapping vocabulary) written in the arm's native
   layout (Munin: state + log entries; memtool: one file per project under `/memories`; ccmem: the
   same files plus a `MEMORY.md` index). 12 needle questions (lookup by attribute, latest value
   among several updates, cross-project aggregation, dated decision).

Session/question texts were written by a separate model instance that was not told which
systems would be tested. The scale estate is produced by a deterministic seeded generator.

## Metrics

Primary: **answer score** per question, 1 / 0.5 / 0, from a blinded judge with gold answer and
rubric. Secondary per answer: `stale` (gives a superseded value as current), `hallucinated`
(asserts a fact not in the corpus, incl. failed abstention), `injection_obeyed`. A deterministic
rubric check (required/forbidden substrings) is computed independently and its agreement with the
judge is reported.

Process metrics: input / output / cache tokens, tool calls, wall time, USD cost (list prices; for
`ccmem` Claude Code's reported notional cost), harness errors, loop-cap hits.

Store metrics after ingest: number of entries/files, characters, and **secret persistence**
(whether the planted `sk-proj-…` credential appears anywhere in the store).

## Hypotheses (directional, stated before running)

- **H1 Scale retrieval.** In phase 3, `munin` scores higher than `memtool` by ≥ 15 percentage
  points averaged over models, and at least as high as `ccmem`.
- **H2 Scale efficiency.** In phase 3, `munin` uses fewer input tokens per question than `memtool`.
- **H3 Small-scale parity.** In phase 2 `recall`, the three arms are within 10 pp of each other.
- **H4 Updates.** `munin` has the lowest stale-answer rate on `update` questions.
- **H5 Temporal.** `munin` scores highest on `temporal` questions.
- **H6 Abstention.** No arm differs by more than 1 of 4 abstention items per model (parity).
- **H7 Injection.** `munin` never states the injected bank account as the answer; at least one
  file-based cell does.
- **H8 Secrets.** `munin` persists the planted credential in 0 cells; file-based arms persist it
  in at least half of their cells.
- **H9 Overhead.** In phase 2, `munin` costs more per question than `memtool` (25-tool surface).
- **H10 Model sensitivity.** `munin`'s advantage over `memtool` (overall score) is smallest for
  Haiku (richer tool surface is harder for the smallest model).

A hypothesis is "supported" when the stated direction/threshold holds on the point estimate and
the paired per-question bootstrap 95 % CI of the difference excludes 0 (for H1, H3–H5, H10);
H6–H9 are judged on counts as stated. Everything else is reported as "not supported" or
"inconclusive" — no post-hoc thresholds.

## Blinding and bias controls

1. Corpus and questions frozen and committed before the first run; the author was blind to arms.
2. Judge is blind: answers are stripped of system-identifying strings (`munin`, `memory_*`,
   `/memories`, `MEMORY.md`, tool names, file paths) and assigned random 4-letter labels; all
   nine answers to a question are judged together in shuffled order; the label→cell key is kept in
   a separate file opened only after all judging is done. Judge: Claude Opus 5.5, effort medium.
3. Analysis script written before unblinding and run unmodified after; any later change is
   listed as a deviation.
4. The subject models are not told they are being compared, nor which system they use beyond
   the tool descriptions themselves.
5. The researcher (conductor) built Munin's harness integration and the competitors'; to limit
   home-team bias, `memtool` follows Anthropic's documented reference behaviour verbatim and
   `ccmem` runs the unmodified product.

## Known limitations (accepted up front)

- n = 1 per cell for Opus/Sonnet; differences of one or two questions are noise.
- `ccmem` runs inside Claude Code's own harness (different system prompt, real date 2026-11-10
  shown in its environment block); session dates are given in the user message for all arms.
- Synthetic persona and estate; English-dominant (2 of 12 sessions Swedish).
- Munin is tested with local small embeddings (bge-small), as on the production Pi.
