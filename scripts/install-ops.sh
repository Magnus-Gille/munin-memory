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
OPS_USER="${MUNIN_OPS_USER:-$(id -un)}"
OPS_HOME="${MUNIN_OPS_HOME:-$HOME}"
OPS_DIR="${MUNIN_OPS_DIR:-${OPS_HOME}/munin-ops}"
SCRIPTS=(backup-to-nas.sh offsite-backup.sh offsite-snapshot.sh)
UNITS=(munin-backup.service munin-backup.timer munin-offsite.service munin-offsite.timer)

# ── Backup destination-model guard ───────────────────────────────────────────
# backup-to-nas.sh exists in two INCOMPATIBLE destination models: it either
# pushes to a remote host over ssh/rsync, or writes to a local mounted volume.
# A host is provisioned for exactly one of them, in its ops .env.
#
# Swapping the model on an already-provisioned host does not fail here — it
# fails on the next timer fire, silently, and the first symptom is a missing
# off-host copy noticed days later. That is not hypothetical: the repo's script
# was changed to the local-mount model while the deployed host was provisioned
# for the remote model, so a reinstall would have replaced a just-repaired
# backup with one that exits 64 ("MUNIN_BACKUP_DIR is required") every night.
#
# Refuse instead, and say exactly what to do. Override deliberately with
# MUNIN_OPS_ALLOW_MODEL_CHANGE=true once the host's .env matches the new model.
backup_destination_model() {  # path → remote | local-mount | unknown | absent
  local f="$1"
  [[ -f "$f" ]] || { echo "absent"; return; }
  if grep -qE '^[[:space:]]*NAS_HOST=' "$f"; then
    echo "remote"
  elif grep -q 'MUNIN_BACKUP_MOUNT' "$f"; then
    echo "local-mount"
  else
    echo "unknown"
  fi
}

echo "==> Installing operational scripts into ${OPS_DIR}/scripts (from ${REPO_DIR})"
install -d -m 755 "${OPS_DIR}/scripts"
for s in "${SCRIPTS[@]}"; do
  if [[ "$s" == "backup-to-nas.sh" ]]; then
    src_model=$(backup_destination_model "${REPO_DIR}/scripts/${s}")
    dst_model=$(backup_destination_model "${OPS_DIR}/scripts/${s}")
    if [[ "$dst_model" != "absent" && "$dst_model" != "unknown" &&
          "$src_model" != "unknown" && "$src_model" != "$dst_model" ]]; then
      if [[ "${MUNIN_OPS_ALLOW_MODEL_CHANGE:-}" != "true" ]]; then
        {
          echo "ERROR: refusing to change this host's backup destination model."
          echo "       deployed: ${dst_model}   (${OPS_DIR}/scripts/${s})"
          echo "       incoming: ${src_model}   (${REPO_DIR}/scripts/${s})"
          echo
          echo "       The two models need different configuration, so installing"
          echo "       the incoming one would leave the nightly backup failing"
          echo "       silently from its next run:"
          echo "         remote      needs NAS_HOST/NAS_DIR and ssh access"
          echo "         local-mount needs MUNIN_BACKUP_MOUNT + MUNIN_BACKUP_DIR"
          echo "                     on an actively mounted filesystem"
          echo
          echo "       Fix the host's ops .env for the incoming model FIRST, then"
          echo "       re-run with MUNIN_OPS_ALLOW_MODEL_CHANGE=true."
          echo "       Nothing has been installed; the deployed backup is untouched."
        } >&2
        exit 1
      fi
      echo "    WARNING: destination model ${dst_model} -> ${src_model} (MUNIN_OPS_ALLOW_MODEL_CHANGE=true)"
    fi
  fi
  install -m 755 "${REPO_DIR}/scripts/${s}" "${OPS_DIR}/scripts/${s}"
  echo "    ${s}"
done

echo "==> Installing systemd units into /etc/systemd/system (sudo)"
for u in "${UNITS[@]}"; do
  rendered=$(mktemp)
  trap 'rm -f "$rendered"' EXIT
  sed \
    -e "s|<user>|${OPS_USER}|g" \
    -e "s|<home-dir>|${OPS_HOME}|g" \
    -e "s|<ops-dir>|${OPS_DIR}|g" \
    "${REPO_DIR}/${u}" > "$rendered"
  sudo install -m 644 "$rendered" "/etc/systemd/system/${u}"
  rm -f "$rendered"
  trap - EXIT
  echo "    ${u}"
done
sudo systemctl daemon-reload

echo "==> Done. Runtime is ${OPS_DIR} (decoupled from this checkout)."
echo "    Enable timers:  sudo systemctl enable --now munin-backup.timer munin-offsite.timer"
echo "    (munin-offsite needs its rclone crypt remote first — see docs/offsite-backup.md)"
