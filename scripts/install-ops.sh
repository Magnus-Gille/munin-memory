#!/usr/bin/env bash
set -euo pipefail

# Install / refresh Munin's OPERATIONAL scripts + systemd units into a dedicated
# ops dir that is DECOUPLED from any git checkout (munin-memory#172 follow-up).
#
# Why: the backup/offsite cron jobs used to execute scripts straight out of a dev
# checkout (~/repos/munin-memory). When that checkout drifted / accumulated
# abandoned WIP, ops was running unknown code. Now cron runs from ~/munin-ops,
# which contains ONLY these installed copies — so a messy checkout can never
# affect a running backup. This checkout stays the *source*; ~/munin-ops is the
# *runtime*. Re-run this after `git pull` to update the runtime.
#
# Usage (from a clean checkout):
#   git pull --ff-only
#   scripts/install-ops.sh          # copy scripts → ~/munin-ops, install units, daemon-reload
#
# Then enable the timers (one-time):
#   sudo systemctl enable --now munin-backup.timer munin-offsite.timer
# (munin-offsite also needs its rclone crypt remote configured first — see
#  docs/offsite-backup.md.)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPS_DIR="/home/magnus/munin-ops"   # units hardcode this path — keep them in sync
SCRIPTS=(backup-to-nas.sh offsite-backup.sh offsite-snapshot.sh)
UNITS=(munin-backup.service munin-backup.timer munin-offsite.service munin-offsite.timer)

echo "==> Installing operational scripts into ${OPS_DIR}/scripts (from ${REPO_DIR})"
install -d -m 755 "${OPS_DIR}/scripts"
for s in "${SCRIPTS[@]}"; do
  install -m 755 "${REPO_DIR}/scripts/${s}" "${OPS_DIR}/scripts/${s}"
  echo "    ${s}"
done

echo "==> Installing systemd units into /etc/systemd/system (sudo)"
for u in "${UNITS[@]}"; do
  sudo install -m 644 "${REPO_DIR}/${u}" "/etc/systemd/system/${u}"
  echo "    ${u}"
done
sudo systemctl daemon-reload

echo "==> Done. Runtime is ${OPS_DIR} (decoupled from this checkout)."
echo "    Enable timers:  sudo systemctl enable --now munin-backup.timer munin-offsite.timer"
echo "    (munin-offsite needs its rclone crypt remote first — see docs/offsite-backup.md)"
