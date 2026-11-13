#!/bin/bash
# v0.7.1 tool-surface check (owner-approved 2026-11-13): full Munin arm (ingest, probe, scale with SEED_V2)
# on the v0.7.1 build, 3 models x 2 reps, results in results-v071/. Shared spend cap: results/ledgers total <= $60.
set -euo pipefail
cd "$(dirname "$0")"
export ARENA_VARIANT=v071 ARENA_MUNIN_REPO="${ARENA_MUNIN_REPO:?set to the v0.7.1 build checkout}"
for m in claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5; do for r in 1 2; do
  node src/run.mjs --arm munin --model "$m" --rep "$r" --cap 60 > "results-v071/logs/munin__${m}__r${r}.log" 2>&1 &
done; done
wait
echo "v071 runs finished"
