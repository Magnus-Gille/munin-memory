#!/bin/bash
# MUNIN-434 lean check (NOT yet approved: needs Magnus's go-ahead before running; paid Anthropic API).
# Full Munin arm (ingest, probe, scale with SEED_V2) on the feat/munin-434-token-economy build with
# MUNIN_TOOL_PROFILE=core and MUNIN_RESPONSE_MODE=compact, Sonnet + Haiku x 2 reps, results in results-lean/.
# Baseline: the v0.7.1 cells from results-v071/runs, symlinked as munin071__<model>__r<n> so judge.mjs
# (ARENA_VARIANT=lean --backend codex --v2) scores both blind in one batch; then node src/compare-lean.mjs.
# Expected spend ~$4.75 at v0.7.1 token cost (v071 ledgers: Sonnet $2.22/$2.29, Haiku $0.12/$0.12), likely
# ~$3 if the projected ~38% input cut holds. Shared spend cap: results/ledgers total <= ARENA_CAP (default 60;
# total was $52.70 before this run, so ~$7.30 headroom).
set -euo pipefail
cd "$(dirname "$0")"
export ARENA_VARIANT=lean ARENA_MUNIN_REPO="${ARENA_MUNIN_REPO:?set to the MUNIN-434 build checkout (npm run build done)}"
export MUNIN_TOOL_PROFILE=core MUNIN_RESPONSE_MODE=compact
CAP="${ARENA_CAP:-60}"
mkdir -p results-lean/runs results-lean/logs
for m in claude-sonnet-5-5 claude-haiku-5-5; do for r in 1 2; do
  ln -sfn "../../results-v071/runs/munin__${m}__r${r}" "results-lean/runs/munin071__${m}__r${r}"
done; done
for m in claude-sonnet-5-5 claude-haiku-5-5; do for r in 1 2; do
  node src/run.mjs --arm munin --model "$m" --rep "$r" --cap "$CAP" > "results-lean/logs/munin__${m}__r${r}.log" 2>&1 &
done; done
wait
echo "lean runs finished; next: ARENA_VARIANT=lean node src/judge.mjs --backend codex --v2 && node src/compare-lean.mjs"
