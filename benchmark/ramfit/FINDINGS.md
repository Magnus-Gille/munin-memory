# Munin Memory — RAM-fit sweep findings (2026-06-18)

Validated on real hardware: an **aarch64, 6-core, 8 GB** Linux board (kernel
5.15, cgroup v2 with the `memory` controller delegated to the user slice). Every
configuration ran under a `systemd-run --user --scope` with `MemoryMax=<cap>` and
`MemorySwapMax=0`, against the **pristine 1.34 GB production DB snapshot**
(opened read-only for query mode; a writable `/tmp` copy for write/concurrent
mode). Quality (recall) was measured separately by re-embedding the 2 975-entry
fixture under each model+dtype and running the IR goldset (31 queries:
`baseline.jsonl` + `baseline-claude.jsonl`).

---

## Bottom line

### 1 GB target — full fidelity, zero compromise

**Run full-fp32 MiniLM semantic + hybrid. It fits a 1 GB box with enormous
headroom — peak working set ≈ 175 MB at rest, ≈ 230 MB under a sustained
concurrent burst (query flood + embedding backlog at once).** There is no reason
to quantise or drop semantic at 1 GB; full-precision embeddings give the best
recall (R@5 0.58 / R@20 0.65 on the goldset) and still leave ~800 MB free.

> **Best 1 GB config:** MiniLM **fp32**, batch 4, semantic+hybrid ON.
> **Peak anon (the must-fit metric):** **≈ 230 MB** under the heaviest sustained
> burst (25 queries + 100-entry embed backlog). Fits 512 MB and even 320 MB
> without OOM; 1 GB is luxurious.

### 512 MB target — quantise to q8, keep semantic ON

**Run q8 MiniLM. Semantic + hybrid search fits a 512 MB box (and a 320 MB, and a
128 MB box) with a peak working set of ≈ 85–94 MB — roughly one-third of fp32.**
q8 quantisation of all-MiniLM-L6-v2 is near-lossless for retrieval, so the recall
cost of fitting 512 MB is small. The headline reverses the previous appliance
doctrine: **a 512 MB-class board does NOT need to drop to lexical-only.**

> **Best 512 MB config:** MiniLM **q8**, batch 1, `MUNIN_SQLITE_CACHE_KIB=1024`,
> `MUNIN_SQLITE_MMAP_BYTES=0`, semantic+hybrid ON.
> **Peak anon:** **≈ 93 MB** under sustained concurrent load (≈ 91 MB on the
> heavy 25/100 burst).
> **Recall loss vs full fp32:** small — **R@10 and R@20 are identical** (0.6452);
> only R@5 dips ~6.5 pp (0.5806 → 0.5161), MRR −0.9 pp, nDCG@20 −0.8 pp. The
> meaningful comparison is against the *alternative* — dropping to lexical-only
> would cost **−16 pp at R@20** (0.6452 → 0.4839). Keeping semantic via q8 is
> nearly free; dropping it is not. (See Quality section.)

---

## What "fit" means here (methodology — read this before trusting any MB)

Two earlier baseline runs walked into traps that this sweep corrects:

1. **No `memory.peak` on kernel 5.15.** The sampler polls `memory.current` /
   `memory.stat` every ~50 ms and records the max.
2. **`memory.current` is dominated by reclaimable FILE CACHE, not demand.** A
   baseline write run showed a "1.7 GB" `memory.current` peak that was purely
   page cache from copying the 1.34 GB DB to `/tmp` (ext4) — nothing OOM'd at
   320 MB, and host `memory.stat` showed `file=2.0 GB` vs `anon=7.5 MB`. So
   `memory.current` is reported here only as **cache-inflated / informational**
   (it pins to the cap in write/concurrent mode and tells you nothing).

**The primary must-fit metric is `peak_anon_mb` = max over time of cgroup
`memory.stat` `anon + shmem`** — the un-reclaimable working set. **The dispositive
fit signal is the OOM-kill: no cgroup OOM-kill under `MemoryMax` with
`MemorySwapMax=0` means it fit.** An OOM-kill (process killed, no JSON emitted,
exit 137) is recorded as a valid "did not fit", not a harness failure.

Both paths were measured per config: **(i) QUERY** (15 semantic+hybrid queries
over the goldset, snapshot read-only) and **(ii) WRITE** (insert ~50 entries,
drive the embedding worker through a full batch on a writable copy). Finalists
additionally got **(iii) CONCURRENT** — a sustained burst firing a query flood
**and** an embedding backlog at the same time, including a heavy 25-query /
100-entry variant, because that is where anon peaks (model forward pass + KNN +
query embeds coincide). A 15/50 burst can understate the peak, so the heavy
variant is the one the bottom-line numbers above quote.

---

## Results — concurrent (sustained burst): the anon-peak window

This is the table that decides the appliance budget. `cur` (memory.current) is
cache-inflated and pins to the cap; ignore it. `anon` is the verdict.

| Config | dtype | model | cap | fit | **peak_anon_mb** | cur (info) | sem p50 | hyb p50 | burst |
|---|---|---|---|---|---|---|---|---|---|
| CONC-fp32 | fp32 | MiniLM | 1024M | yes | **230** | 1024 | 12 ms | 28 ms | 15q/50 |
| CONC-fp32 | fp32 | MiniLM | 512M | yes | **222** | 512 | 12 ms | 32 ms | 15q/50 |
| CONC-fp32 | fp32 | MiniLM | 320M | yes | **226** | 320 | 13 ms | 35 ms | 15q/50 |
| CONC-fp32-heavy | fp32 | MiniLM | 512M | yes | **224** | 512 | 12 ms | 33 ms | 25q/100 |
| CONC-fp32-heavy | fp32 | MiniLM | 320M | yes | **221** | 320 | 13 ms | 33 ms | 25q/100 |
| CONC-q8 | q8 | MiniLM | 1024M | yes | **99** | 1024 | 12 ms | 28 ms | 15q/50 |
| CONC-q8 | q8 | MiniLM | 512M | yes | **93** | 512 | 12 ms | 33 ms | 15q/50 |
| CONC-q8 | q8 | MiniLM | 320M | yes | **94** | 320 | 12 ms | 33 ms | 15q/50 |
| CONC-q8-heavy | q8 | MiniLM | 512M | yes | **91** | 512 | 12 ms | 32 ms | 25q/100 |
| CONC-q8-heavy | q8 | MiniLM | 320M | yes | **91** | 320 | 12 ms | 33 ms | 25q/100 |
| CONC-static | q8 | bge-small | 1024M | yes | **124** | 1024 | 11 ms | 28 ms | 15q/50 |
| CONC-static | q8 | bge-small | 512M | yes | **115** | 512 | 11 ms | 31 ms | 15q/50 |
| CONC-static | q8 | bge-small | 320M | yes | **116** | 320 | 13 ms | 32 ms | 15q/50 |

**Reading it:** under the worst sustained load tested, fp32 MiniLM holds ≈ 221–230 MB
anon and q8 MiniLM holds ≈ 91–99 MB anon. Both fit 320 MB; q8 fits with ~3.5×
headroom. bge-small (q8, a stronger static-quality model) sits at ≈ 115–124 MB —
a viable middle option if its recall justifies the extra ~25 MB.

## Results — query path (snapshot read-only)

| Config | dtype | model | cap | fit | peak_anon_mb | sem p50 | hyb p50 |
|---|---|---|---|---|---|---|---|
| A1 | fp32 | MiniLM | 512M | yes | 143 | — | — |
| A1 | fp32 | MiniLM | 320M | yes | 140 | — | — |
| A2 | q8 | MiniLM | 512M | yes | 82 | — | — |
| A2 | q8 | MiniLM | 320M | yes | 77 | — | — |
| A5 | int8 | MiniLM | 512M | yes | 74 | — | — |
| A5 | int8 | MiniLM | 320M | yes | 76 | — | — |
| B3 | q8 | bge-small | 512M | yes | 97 | — | — |
| B5 (lexical) | — | (no model) | 512M | yes | **14** | n/a | n/a |
| FLOOR-fp32 | fp32 | MiniLM | 256M | yes | 145 | 15 ms | 38 ms |
| FLOOR-fp32 | fp32 | MiniLM | 192M | yes | 141 | 10 ms | 25 ms |
| **FLOOR-fp32** | fp32 | MiniLM | **160M** | **OOM** | — | — | — |
| FLOOR-q8 | q8 | MiniLM | 256M | yes | 78 | — | — |
| FLOOR-q8 | q8 | MiniLM | 192M | yes | 78 | — | — |
| FLOOR-q8 | q8 | MiniLM | 160M | yes | 81 | — | — |
| FLOOR-q8 | q8 | MiniLM | **128M** | **yes** | 74 | — | — |
| FLOOR-lexical | — | (no model) | 64M | yes | 13 | n/a | n/a |

## Results — write path (embedding worker drives a full batch)

| Config | dtype | model | cap | fit | peak_anon_mb |
|---|---|---|---|---|---|
| A1 | fp32 | MiniLM | 320M | yes | 164 |
| A2 | q8 | MiniLM | 320M | yes | 86 |
| FLOOR-fp32 | fp32 | MiniLM | 192M | yes | 184 |
| **FLOOR-fp32** | fp32 | MiniLM | **160M** | **OOM** | — |
| FLOOR-q8 | q8 | MiniLM | 128M | yes | 85 |
| B5 (lexical) | — | (no model) | 320M | yes | 13 |

**Floor:** fp32 MiniLM is the only config that OOM'd, and only at **160 MB**
(it needs ~141 MB anon for query, ~184 MB for write, which plus non-anon
overhead exceeds a 160 MB hard cap with swap off — a physically consistent
boundary, not contamination). q8 MiniLM still fits a **128 MB** cap on both the
query and write paths. Lexical-only (no embedding model) floors at ~13 MB anon
and fits **64 MB**.

---

## Quality — recall cost of each tier (re-embed + IR goldset, 31 queries)

Re-embedding the full 2 975-entry fixture under each model+dtype, then running
the repo IR benchmark (`benchmark/runner.ts`) over `baseline.jsonl` +
`baseline-claude.jsonl`. All scores are **hybrid** search mode unless noted.

| Config | model | dtype | R@5 | R@10 | R@20 | MRR | nDCG@20 |
|---|---|---|---|---|---|---|---|
| **fp32 baseline** | MiniLM | fp32 | **0.5806** | **0.6452** | **0.6452** | 0.4487 | 0.4914 |
| q8 *(zero-appliance default)* | MiniLM | q8 | 0.5161 | 0.6452 | 0.6452 | 0.4394 | 0.4831 |
| int8 | MiniLM | int8 | 0.5161 | 0.6452 | 0.6452 | 0.4394 | 0.4831 |
| **static (bge-small)** | bge-small | q8 | **0.6129** | **0.6774** | **0.6774** | 0.4348 | 0.5108 |
| lexical-only *(fallback)* | (none) | — | 0.4839 | 0.4839 | 0.4839 | 0.4086 | 0.4462 |

**Reading the quality table:** q8 and int8 are indistinguishable from each other,
and from fp32 at R@10/R@20 — quantising MiniLM costs only the top-5 ordering
(R@5 −6.5 pp), with full recall recovered by R@10. **Lexical-only is the real
cliff:** R@20 falls from 0.6452 to 0.4839 (−16 pp) and never recovers (lexical
R@5 = R@10 = R@20), which is exactly why the previous "zero-appliance =
lexical-only" stance was costly — and why this sweep keeps q8 semantic ON at
512 MB instead.

**Bonus finding — bge-small q8 beats fp32 MiniLM on recall** (R@5 0.6129 vs
0.5806, R@20 0.6774 vs 0.6452, nDCG@20 0.5108 vs 0.4914) at a peak working set of
≈ 115–124 MB. So a 512 MB-class board has a *better-quality* option than fp32
MiniLM that still fits comfortably: bge-small q8. It costs ~25 MB more anon than
MiniLM q8 for a meaningful recall lift. A reasonable future move is to promote
bge-small q8 to the `zero-plus` (and possibly `zero-appliance`) default once it is
validated against a broader goldset; this sweep keeps MiniLM q8 as the conservative
default (smallest footprint, known-good model) and records bge-small q8 as the
upgrade path.

- **fp16 MiniLM is unavailable on this runtime.** `Xenova/all-MiniLM-L6-v2`
  fp16 fails to initialise on this onnxruntime build
  (`InsertedPrecisionFreeCast … itr != node_args.end()` graph error). Recorded as
  an error, not an OOM. Do not offer fp16 as an appliance dtype on this stack.

**The recall-loss headline for the 512 MB tier:** q8 vs fp32 costs −6.5 pp at
R@5 (0.5806 → 0.5161) and **0 pp at R@10/R@20** (both hold 0.6452) — MRR −0.9 pp,
nDCG@20 −0.8 pp. Trivial next to the alternative: dropping semantic for
lexical-only costs −16 pp at R@20. Quantising to fit 512 MB is nearly free;
abandoning semantic is not.

---

## Skeptic audit — what had to be walked back

The prep handed over a working hypothesis ("zero-appliance stays lexical-only;
the 425 MB / ~310 MB-available budget cannot host an embedding model plus
index — a hardware ceiling"). **Tonight's data refutes that for a 512 MB-class
board.** Corrections applied:

1. **Walked back: "zero-appliance must be lexical-only."** q8 MiniLM semantic
   fits a 128 MB anon-budget with headroom (peak anon ≈ 85–94 MB across query,
   write, and sustained concurrent burst). A 512 MB-class board (Pi 3A+, Pi Zero
   2 W) has ample room for semantic + hybrid. The doctrine that semantic is "out
   by hardware constraint" on this tier is wrong — it was based on an unmeasured
   memory estimate. `docs/appliance-profiles.md` is updated accordingly.
2. **Corrected metric, twice.** The earlier baseline read `memory.current`
   (cache-inflated) as the fit signal; this sweep uses peak `anon + shmem` and
   the OOM-kill as dispositive. The "1.7 GB write peak" scare was page cache, not
   demand.
3. **Concurrency guard enforced.** A quality re-embed sweep was found running
   concurrently with the RAM matrix for ~19 minutes (violating the one-at-a-time
   rule). It was stopped before the CONCURRENT finalists — the most important
   rows — so those ran clean. Each `systemd` scope has its own cgroup
   `memory.stat`, so the contamination risk was *false OOMs* (host pressure), not
   false fits; the only OOMs observed (fp32 @160 MB) are physically consistent
   with the clean fp32 anon numbers and occurred after the contaminant was
   stopped, so no fit verdict needed walking back.
4. **Not over-claimed:** the heavy 25/100 burst is quoted for the bottom line
   (not the lighter 15/50), because a small burst understates the anon peak. Even
   so, fp32 stayed ≈ 224 MB and q8 ≈ 91 MB — comfortably inside budget.

**Net verdict:** one substantive claim was walked back — *zero-appliance can run
semantic* (q8), reversing the lexical-only-by-hardware-ceiling stance. Every fit
verdict in the tables is a clean OOM/anon result; nothing else needed retracting.

---

## How to reproduce

```bash
# On the experiment host (aarch64, cgroup v2, no Docker, no sudo):
export XDG_RUNTIME_DIR=/run/user/$(id -u)
bash benchmark/ramfit/orchestrate-sweep.sh        # full RAM matrix -> results/sweep-ram.jsonl
python3 benchmark/ramfit/summarize-sweep.py results/sweep-ram.jsonl   # markdown table + callouts

# Quality (re-embed + IR goldset) — run SEPARATELY, never concurrent with the RAM matrix:
MUNIN_EMBEDDINGS_DTYPE=q8 tsx benchmark/ramfit/quality-eval.mjs
```

Raw results are archived under `benchmark/ramfit/results/` (`sweep-ram.jsonl`,
`baseline.jsonl`, `baseline2.jsonl`). The measurement rig is `measure-anon.mjs`
(peak-anon sampler + query/write/concurrent modes), driven by `run-sweep-anon.sh`
and `orchestrate-sweep.sh`.
