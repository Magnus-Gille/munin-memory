# Munin RAM-fit sweep — plan, schedule, resumability

**Goal A:** full Munin experience (all functions incl. local semantic/hybrid) in **1 GB**.
**Goal B:** best-effort, minimum quality loss in **512 MB**.
Owner asked (2026-06-18 ~11:00 CEST) to **start the heavy sweep at 22:00 CEST** (after token reset) and **ping via ratatoskr when done**.

## Why a sweep is needed
The binding constraint is the local embedding model. Today `src/embeddings.ts` loads **fp32** `all-MiniLM-L6-v2` (heaviest variant) with batch 25 — ~300–500 MB RSS. The prep added env knobs (committed on branch `experiment/ram-fit-sweep`, commit 322f34c):
- `MUNIN_EMBEDDINGS_DTYPE` (fp32|fp16|q8|int8|…) — primary RAM lever
- `MUNIN_SQLITE_CACHE_KIB`, `MUNIN_SQLITE_MMAP_BYTES` — keep DB pages off RSS under a cgroup cap

## Production safety (DONE during prep)
- Production = **huginmunin.local** (Munin active; DB `~/.munin-memory/memory.db` = 1.34 GB).
- Backups: **healthy.** `munin-backup.timer` runs daily ~03:00; fresh `sqlite3 .backup` snapshots land on the **NAS** at `100.99.119.52:/mnt/timemachine/backups/munin-memory/` (latest `memory-2026-06-18-0104.db`, 1.34 GB). 20 dailies present.
- **Known bug (to fix in the PR, NOT hot-patched):** `scripts/backup-to-nas.sh` prune pipeline (`ls -1t … | head`) trips `set -o pipefail` → SIGPIPE `status 141` nightly. The rsync SUCCEEDS first, so backups are safe, but the service reports failure and **retention never runs** (why 20 dailies piled up). The 22:00 Deliverables phase fixes this.
- The sweep NEVER touches production or the live DB. It runs against a **read-only copy** of the snapshot, staged on the non-prod arm64 host `magnus-desktop` (192.168.0.230) at `~/munin-ramfit/snapshot/memory.db` (byte-exact, verified).

## Experiment rig (built during prep by background subagent)
- Host: `magnus-desktop` 192.168.0.230 — arm64, 6 cores, 8 GB, cgroup v2 with the `memory` controller delegated to the user slice. Node 20 installed via nvm (user-space).
- **Docker was blocked** (user not in `docker` group; no headless sudo) → pivoted to a no-privilege native cap: `export XDG_RUNTIME_DIR=/run/user/$(id -u); systemd-run --user --scope --quiet -p MemoryMax=<cap> -p MemorySwapMax=0 env <KNOBS> node benchmark/ramfit/measure.mjs`. (To re-enable Docker instead, run `sudo usermod -aG docker magnus` on the host.)
- `benchmark/ramfit/` on the branch: `measure.mjs` (RSS/latency probe, reads its own cgroup `memory.peak`), `run-config.sh` (systemd-run capped runner), `quality-eval.mjs` (added in the 22:00 finalize phase). `Dockerfile` exists but is superseded.
- Memory measured via cgroup v2 `memory.peak`; `MemorySwapMax=0` → hard cap, cgroup OOM-kill = "did not fit".
- Quality fixture: `benchmark/fixtures/memory-snapshot-2026-04-07.db` + goldsets `benchmark/queries/baseline.jsonl` (15) + `baseline-claude.jsonl` (16); metric R@k/MRR/nDCG via `benchmark/runner.ts`.

## The 22:00 run
Driven by the workflow script `benchmark/ramfit/sweep.workflow.js`. Phases: Finalize harness → RAM matrix (serial, real 1.34 GB DB, caps 1024m/512m) → Quality matrix (uncapped, re-embed per config) → Synthesize (Goal A / Goal B / sidecar, parallel) → Adversarial verify → Deliverables (FINDINGS.md + prune-bug fix + docs/CHANGELOG/CLAUDE.md + draft PR).

### Trigger
Scheduled via CronCreate one-shot at **22:03 CEST 2026-06-18** (durable). Fires this session's REPL prompt:
> Run the staged Munin RAM-fit sweep now via `Workflow({scriptPath:'/Users/magnus/repos/munin-memory/benchmark/ramfit/sweep.workflow.js'})`. When it returns, send the ratatoskr completion ping (recipe below) with the two headline numbers. Rig + snapshot already staged; see benchmark/ramfit/PLAN.md.

Dependencies: the Claude Code session must stay open on this machine until ~22:00 (cron fires in-session); `caffeinate` was started to prevent sleep. Cloud routines were NOT used because the sweep needs LAN/SSH access to magnus-desktop, which the cloud lacks.

### Ratatoskr completion ping (verified working — sends over loopback, no key needed)
```
ssh huginmunin.local '
ENVF=/home/magnus/repos/ratatoskr/.env; set -a; . "$ENVF" 2>/dev/null; set +a;
CHAT=$(echo "$TELEGRAM_ALLOWED_USERS" | cut -d, -f1);
curl -s -m 8 -X POST http://127.0.0.1:3034/api/send \
  -H "Authorization: Bearer ${RATATOSKR_SEND_API_KEY}" -H "Content-Type: application/json" \
  -d "{\"chat_id\": ${CHAT}, \"text\": \"<MESSAGE>\"}"'
```
Fallback if ratatoskr is down: `himalaya message write -a gille` (email to magnus@gille.ai) — see global CLAUDE.md.

## Resume after a session restart
1. `git checkout experiment/ram-fit-sweep` (knobs at 322f34c).
2. Verify rig: `ssh 192.168.0.230 'docker images | grep ramfit; ls ~/munin-ramfit/results/'`.
3. Re-run: `Workflow({scriptPath:'benchmark/ramfit/sweep.workflow.js'})` (resumable via resumeFromRunId if a prior run journal exists).
4. Ping via the recipe above.
