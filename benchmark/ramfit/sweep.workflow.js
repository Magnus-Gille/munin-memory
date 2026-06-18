export const meta = {
  name: 'munin-ramfit-sweep',
  description: 'Broad experimental sweep: full Munin experience in 1GB (Goal A) + min-quality-loss in 512MB (Goal B), measured in memory-capped Docker on arm64',
  whenToUse: 'Scheduled 22:00 run for the appliance RAM-fit investigation',
  phases: [
    { title: 'Finalize harness' },
    { title: 'RAM matrix' },
    { title: 'Quality matrix' },
    { title: 'Synthesize' },
    { title: 'Adversarial verify' },
    { title: 'Deliverables' },
  ],
}

// ---------------------------------------------------------------------------
// Context for every agent. The rig was pre-built during prep; agents discover
// its exact interface by reading the files rather than relying on hard-coded
// names. Memory caps use systemd-run --user --scope (Docker was blocked — user
// not in docker group, no headless sudo). Production is never touched.
// ---------------------------------------------------------------------------
const HOST = '192.168.0.230' // magnus-desktop, arm64 8GB, Docker, non-prod
const SNAP = '~/munin-ramfit/snapshot/memory.db' // 1.34GB prod snapshot, READ-ONLY
const ENV = `
ENVIRONMENT (verified during prep):
- Reach the experiment host with: ssh ${HOST} '...'  (passwordless; NO sudo, NO docker access). arm64, 6 cores, 8GB, cgroup v2 with the 'memory' controller delegated to the user slice. Node 20 installed via nvm during prep.
- Memory caps use systemd-run (no privileges): export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemd-run --user --scope --quiet -p MemoryMax=<cap> -p MemorySwapMax=0 env <KNOBS> node benchmark/ramfit/measure.mjs. A cgroup OOM-kill (process killed, no JSON emitted) = 'did not fit' (this is the gold-standard fit signal — trust it over any reported MB).
- MEASUREMENT METHODOLOGY (two baseline runs exposed traps — do NOT repeat them): (a) kernel 5.15 has no memory.peak — poll memory.current every ~50ms and take the max; (b) MORE IMPORTANT: memory.current is dominated by RECLAIMABLE FILE CACHE, not demand. Baseline2 saw "1.7GB" write peaks that were just page cache from copying the 1.34GB DB to /tmp (ext4) — nothing OOM'd at 320m, proving real demand is tiny (host memory.stat showed file=2.0GB vs anon=7.5MB). THE PRIMARY MUST-FIT METRIC IS PEAK ANON+SHMEM (from cgroup memory.stat 'anon'+'shmem'), polled to its max — report THAT as peak_anon_mb. Report memory.current peak too, but label it cache-inflated/informational. The dispositive fit signal remains: no OOM-kill under MemoryMax=<cap> with MemorySwapMax=0.
- Do NOT copy the 1.34GB DB into a cache-inflating path for write tests if avoidable — open the snapshot in place read-only for query mode; for write mode use the smallest writable copy that still exercises the embedding worker, and always report anon (not current) as the verdict.
- MEASURE BOTH PATHS per config: (i) QUERY path (semantic+hybrid over the goldset) AND (ii) WRITE / embedding-generation path (worker embeds a full batch). ALSO add a SUSTAINED/CONCURRENT mini-load (a burst of queries + an embedding backlog at once) for the finalist configs — the burst is where anon peaks, and a 15-query/50-entry burst may understate it. Report peak_anon for each.
- Repo on THIS laptop: ~/repos/munin-memory, branch experiment/ram-fit-sweep. Knobs already committed: MUNIN_EMBEDDINGS_DTYPE, MUNIN_SQLITE_CACHE_KIB, MUNIN_SQLITE_MMAP_BYTES. The repo is also rsynced+built on the host at ~/munin-ramfit/repo.
- The RAM-fit rig already exists under benchmark/ramfit/ (measure.mjs, run-config.sh — systemd-run based; Dockerfile is superseded/unused). READ those files to learn the exact invocation. Baseline results are at ~/munin-ramfit/results/baseline.jsonl on the host.
- Real production DB snapshot (1.34GB, READ-ONLY, pristine) staged on host at ${SNAP}. Quality fixture: benchmark/fixtures/memory-snapshot-2026-04-07.db (2975 entries) + goldsets benchmark/queries/baseline.jsonl (15) + baseline-claude.jsonl (16).
HARD RULES: never modify src/*; never touch huginmunin/production or any live DB; open the snapshot read-only (or copy it); RAM-matrix runs must execute ONE AT A TIME (concurrent capped processes corrupt peak-RSS readings). Record an OOM-kill as a valid 'did not fit' result, not a failure.
`

// Curated config matrix (NOT full cartesian — staged search). Each agent reads
// the harness to map these knobs onto run-config.sh.
const RAM_MATRIX = `
RAM-FIT MATRIX — run serially against the real 1.34GB snapshot. For EACH config, sweep the CAP LADDER {1024m, 512m, 320m} (stop a config at the cap where it OOMs) and record true peak (memory.current polling), OOM/fit, sem/hybrid p50, vec_loaded, for BOTH query and write modes.
CAP MEANING (state this in synthesis): 1024m≈1GB board; 512m≈512MB board (generous); 320m≈ the REAL available RAM on a 512MB Pi Zero 2W / Pi 3A+ after the OS (~150-200MB) — 320m is the honest test for the cheapest boards, NOT 512m. Baseline findings so far (CONFIRM + extend with peak_anon): query-path true peaks fp32 172MB / q8 80MB; NOTHING OOM'd at 320m in any mode (query or write, fp32 or q8, even batch=25) under swap=0 — i.e. real anon demand fits 320m everywhere tested. The question has shifted from "can it fit" to "how much headroom + what's optimal": measure peak_anon precisely, push the cap LOWER than 320m for finalists to find the true floor, and test sustained/concurrent load. If fp32 full-semantic genuinely fits ~320m, quantization is for headroom/cache-perf, not capability — say so.
Goal A (keep MiniLM quality, target 1024m):
  A1 dtype=fp32  batch=4  sqlite=default                          @1024m
  A2 dtype=q8    batch=4  sqlite=default                          @1024m
  A3 dtype=q8    batch=1  cache_kib=2048 mmap=0 OMP=1             @1024m
  A4 dtype=fp16  batch=4  sqlite=default                          @1024m
  A5 dtype=int8  batch=4  sqlite=default                          @1024m
Goal B (target 512m, find min-quality-loss that fits):
  B1 dtype=q8    batch=1  cache_kib=1024 mmap=0 OMP=1             @512m
  B2 dtype=int8  batch=1  cache_kib=1024 mmap=0 OMP=1             @512m
  B3 model=<STATIC> batch=1 cache_kib=1024 mmap=0 OMP=1          @512m   (static/Model2Vec-class embedding model; no transformer forward pass)
  B4 model=<STATIC> batch=1 cache_kib=512  mmap=0 OMP=1          @512m
  B5 MUNIN_EMBEDDINGS_ENABLED=false (lexical-only)               @512m   (floor: RSS with no model — also models the embedding-sidecar device footprint)
Also re-run the best Goal-B MiniLM config and the static config @1024m to see headroom.
`

const QUALITY_MATRIX = `
QUALITY MATRIX — uncapped (quality is independent of the RAM cap). For each distinct embedding config, RE-EMBED the quality fixture corpus (benchmark/fixtures/memory-snapshot-2026-04-07.db, copy it writable) under that model+dtype, then run the repo IR benchmark (benchmark/runner.ts runBenchmark) over baseline.jsonl + baseline-claude.jsonl. Emit R@5/R@10/R@20/MRR/nDCG and the delta vs the fp32 baseline.
Configs: fp32 (baseline) | fp16 | q8 | int8 | <STATIC model> | lexical-only.
Re-embedding is REQUIRED: a query embedded with model X must be compared against a corpus embedded with model X, else recall is meaningless. The fp32 baseline corpus already matches the stored vectors; verify your fp32 re-embed reproduces the known baseline before trusting the others.
`

// ===========================================================================
phase('Finalize harness')
const ready = await agent(
  `Finalize the RAM-fit rig for the sweep. ${ENV}
Tasks:
1. Read benchmark/ramfit/ (Dockerfile, measure.mjs, run-config.sh) and ~/munin-ramfit/results/baseline.jsonl to confirm the rig works and learn its interface. Confirm sqlite-vec + onnxruntime-node load on arm64 (vec_loaded=true in baseline results).
2. Pick a concrete STATIC / Model2Vec-class embedding model that is loadable via @huggingface/transformers feature-extraction on arm64 in this image (e.g. a minishlab "potion" static model or a small static-retrieval model). Verify it actually loads and produces 384-or-other-dim vectors in the container. Report the exact model id chosen as STATIC (or, if none load cleanly, say so and propose the smallest real transformer fallback, e.g. a 'q8' bge/gte-small).
3. Author benchmark/ramfit/quality-eval.mjs: given env (model, dtype), copy benchmark/fixtures/memory-snapshot-2026-04-07.db to a writable temp, re-embed the whole corpus under that config (reuse src/embeddings + the vec table write path from dist/), then run benchmark/runner.ts runBenchmark over baseline.jsonl + baseline-claude.jsonl and print R@5/R@10/R@20/MRR/nDCG as one JSON line. Verify the fp32 path reproduces the committed baseline numbers (sanity gate) before proceeding.
4. Precache all needed model/dtype variants into ~/munin-ramfit/hf-cache (fp32/fp16/q8/int8 MiniLM + the STATIC model) so capped runs need no network.
Report: rig OK? vec_loaded? the STATIC model id, the fp32 quality sanity check (matches baseline?), and any blocker. Keep it short.`,
  { phase: 'Finalize harness' }
)

phase('RAM matrix')
const ramResults = await agent(
  `Run the RAM-fit matrix. ${ENV}
${RAM_MATRIX}
Substitute <STATIC> with the static model id from the finalize step: ${ready}
Run every config SERIALLY (one container at a time). For each, capture: peak_rss_mb, fit (no OOM/137), semantic_p50_ms, hybrid_p50_ms, vec_loaded. Return a compact markdown table of ALL configs plus the raw JSONL appended to ~/munin-ramfit/results/sweep-ram.jsonl. Call out: the lightest config that fits 1024m at full MiniLM quality, and which configs (if any) fit 512m.`,
  { phase: 'RAM matrix' }
)

phase('Quality matrix')
const qualityResults = await agent(
  `Run the quality matrix. ${ENV}
${QUALITY_MATRIX}
Substitute <STATIC> with: ${ready}
Return a compact table: config → R@5/R@10/R@20/MRR/nDCG and Δ vs fp32 baseline. Explicitly state the recall loss (in pp) of q8, int8, and the static model vs fp32 hybrid, and how lexical-only compares. Append raw results to ~/munin-ramfit/results/sweep-quality.jsonl.`,
  { phase: 'Quality matrix' }
)

phase('Synthesize')
const data = `RAM RESULTS:\n${ramResults}\n\nQUALITY RESULTS:\n${qualityResults}\n\nHARNESS/STATIC NOTE:\n${ready}`
const [goalA, goalB, sidecar] = await parallel([
  () => agent(
    `GOAL A — "full Munin experience (all functions incl. local semantic/hybrid) in 1GB". From the measured data below, determine the cheapest config that delivers full experience within ~1024m with NO meaningful recall loss, and map it to a concrete cheap board (recall the prep finding: Orange Pi 3B 1GB ~€30, Radxa Zero 3W 1GB ~€21, Pi Zero 2W 1GB). State peak RSS headroom and the exact env knobs. If nothing fits 1024m at full quality, say so and give the closest.\n\n${data}`,
    { phase: 'Synthesize', label: 'goalA' }
  ),
  () => agent(
    `GOAL B — "best-effort, minimum loss of quality for 512MB". From the data, rank the options that fit 512m by recall retained: aggressive-MiniLM (q8/int8 + lean sqlite) vs static-embedding model vs lexical-only vs embedding-sidecar (device runs no model). Give the recommended 512m config, its exact recall loss vs full fp32 hybrid (pp), the env knobs, and the cheap board it unlocks (Pi Zero 2W 512MB, the Skald 3A+, sub-€25 boards). Be honest about what's lost.\n\n${data}`,
    { phase: 'Synthesize', label: 'goalB' }
  ),
  () => agent(
    `EMBEDDING-SIDECAR analysis. Using the lexical-only (no-model) RSS floor from the data as the device footprint, design the "one LAN embedding server + N cheap e-ink Munin boards" option: what code change Munin needs (a remote-embedding backend for query + write embedding, since today src/embeddings.ts always loads the model locally), the device RSS it achieves, the latency/availability tradeoff, and why it's attractive for the hackathon fleet. Cross-reference docs/appliance-profiles.md outcome #2 (offloaded embedding path).\n\n${data}`,
    { phase: 'Synthesize', label: 'sidecar' }
  ),
])
const synthesis = await agent(
  `Merge into ONE coherent findings section with a clear bottom line for both goals. Keep the measured numbers. Sections: (1) Goal A verdict + config + board, (2) Goal B verdict + config + recall cost + board, (3) sidecar option, (4) a small results table. Be decisive.\n\nGOAL A:\n${goalA}\n\nGOAL B:\n${goalB}\n\nSIDECAR:\n${sidecar}`,
  { phase: 'Synthesize', label: 'merge' }
)

phase('Adversarial verify')
const verdict = await agent(
  `You are a skeptic. Audit the synthesis against the raw measured data. Check specifically: (a) does the claimed 512m config ACTUALLY fit (no OOM/137 in the RAM results)? (b) is the recall-loss number supported by the quality matrix, or overstated/understated? (c) did the fp32 quality re-embed reproduce the committed baseline (if not, ALL quality deltas are suspect)? (d) any measurement artifact — e.g. vec_loaded=false silently degrading semantic to lexical, q8-query-vs-fp32-corpus mismatch inflating loss, single-run RSS noise? List each claim as SUPPORTED / OVERSTATED / UNSUPPORTED with the number that backs your call, and give required corrections.\n\nSYNTHESIS:\n${synthesis}\n\nRAW DATA:\n${data}`,
  { phase: 'Adversarial verify' }
)

phase('Deliverables')
const deliver = await agent(
  `Produce the deliverables on branch experiment/ram-fit-sweep (commit, do NOT push to main, do NOT merge). ${ENV}
1. Write benchmark/ramfit/FINDINGS.md = the merged synthesis + the corrections from the skeptic audit + full results tables. Lead with the two bottom lines (1GB and 512MB).
2. Fix the production backup prune bug in scripts/backup-to-nas.sh: the prune pipeline (ls -1t ... | head) trips 'set -o pipefail' with SIGPIPE (status 141), so the service reports failure nightly and retention never runs (20 dailies piled up instead of 14+4). Make the prune SIGPIPE-safe (the rsync already succeeds; the fix must not change the backup itself). Keep set -euo pipefail elsewhere. Add a brief test or a self-check note if practical. Do NOT deploy — just fix on the branch.
3. Update docs/appliance-profiles.md and CHANGELOG.md to record the validated 1GB/512MB findings and the new env knobs (MUNIN_EMBEDDINGS_DTYPE, MUNIN_SQLITE_CACHE_KIB, MUNIN_SQLITE_MMAP_BYTES) — also add these three to the env-var table in CLAUDE.md.
4. git add the ramfit/ files + doc updates + the prune fix and commit with a clear conventional message (Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>). Then create a DRAFT PR with gh (base main) summarizing both findings + the prune fix; if gh fails, just report the branch is ready.
Return: the PR url (or branch state), the two headline numbers (best 1GB config + RSS; best 512MB config + recall loss), and the skeptic's net verdict (did any claim need walking back?).`,
  { phase: 'Deliverables' }
)

return {
  goalA_oneLiner: goalA,
  goalB_oneLiner: goalB,
  skeptic: verdict,
  deliverables: deliver,
  ram: ramResults,
  quality: qualityResults,
}
