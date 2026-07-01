#!/bin/bash
set -euo pipefail

# Munin offsite backup — SNAPSHOT WRAPPER (munin-memory#172).
#
# The one munin-specific difference from the shared offsite mechanism: never upload
# a live SQLite file mid-write. This wrapper takes a consistent point-in-time
# snapshot of the memory DB with `VACUUM INTO` (safe to run while the server writes,
# WAL readers don't block writers), verifies it with PRAGMA integrity_check, then
# hands off to the copied-verbatim scripts/offsite-backup.sh with MIMIR_OFFSITE_ROOT
# pointed at the staging dir. offsite-backup.sh owns everything after — rclone crypt
# (fail-closed), current/ + 30-day history, delete-count gate, Heimdall pass/fail.
#
# Snapshot failures are fail-loud here too: they push a `fail` Heimdall panel (same
# service/panel the sync uses) and exit non-zero, so a torn/failed snapshot never
# silently skips the offsite copy.
#
# Usage:
#   ./offsite-snapshot.sh              snapshot, then run the encrypted offsite push
#   ./offsite-snapshot.sh --dry-run    snapshot locally, then dry-run the push (no remote writes)

# ---- Config (override via environment / EnvironmentFile) ----
DB="${MUNIN_OFFSITE_DB:-$HOME/.munin-memory/memory.db}"           # live memory DB
STAGING="${MUNIN_OFFSITE_STAGING:-$HOME/.munin-memory/offsite-staging}"  # snapshot dir (becomes ROOT)
SNAP="${STAGING}/munin.sqlite"                                    # consistent snapshot file
SQLITE="${SQLITE_BIN:-sqlite3}"
LOG="${MIMIR_OFFSITE_LOG:-$HOME/.munin-memory/offsite-backup.log}"
# Heimdall panel identity — mirror offsite-backup.sh's so a snapshot failure lands
# on the SAME panel as a sync failure.
SERVICE="${MIMIR_OFFSITE_SERVICE:-munin}"
PANEL="${MIMIR_OFFSITE_PANEL:-offsite}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" | tee -a "$LOG" >&2; }

push_panel() {
  local state="$1" message="$2"
  [ -n "${HEIMDALL_HUB_URL:-}" ] && [ -n "${HEIMDALL_FLEET_TOKEN:-}" ] || return 0
  curl -fsS --max-time 5 -X POST "$HEIMDALL_HUB_URL" \
    -H "Authorization: Bearer ${HEIMDALL_FLEET_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"service\":\"${SERVICE}\",\"panel\":\"${PANEL}\",\"kind\":\"status\",\"label\":\"Offsite backup\",\"state\":\"${state}\",\"message\":\"${message}\"}" \
    >/dev/null 2>&1 || true
}

die() {
  log "ERROR: $*"
  push_panel fail "$* — see ${LOG}"
  exit 1
}

mkdir -p "$(dirname "$LOG")"

# ---- Preflight ----
command -v "$SQLITE" >/dev/null 2>&1 || die "sqlite3 not found (SQLITE_BIN=$SQLITE)"
[ -f "$DB" ] || die "memory DB missing: $DB"
mkdir -p "$STAGING" || die "cannot create staging dir: $STAGING"

# ---- Consistent snapshot ----
# VACUUM INTO refuses to overwrite an existing file, and a stale snapshot (or its
# stray -wal/-shm) would otherwise get mirrored offsite. Clear the staging file first
# so the mirror is exactly one clean, standalone DB with no WAL sidecars.
rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm"

log "snapshotting ${DB} → ${SNAP} (VACUUM INTO)"
"$SQLITE" "$DB" "VACUUM INTO '${SNAP}'" 2>>"$LOG" \
  || die "VACUUM INTO failed — snapshot not created, refusing to upload a live DB"

# Verify the snapshot before it leaves the box (a corrupt snapshot is worse than none).
INTEGRITY=$("$SQLITE" "$SNAP" "PRAGMA integrity_check;" 2>&1 || echo "integrity_check errored")
if [ "$INTEGRITY" != "ok" ]; then
  rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm"
  die "snapshot integrity_check failed: ${INTEGRITY}"
fi
log "snapshot ok ($(du -h "$SNAP" 2>/dev/null | cut -f1 || echo '?')), integrity_check=ok"

# ---- Hand off to the shared offsite mechanism ----
# ROOT is the staging dir (always — the snapshot is the source of truth). SERVICE and
# REMOTE keep sensible munin defaults but stay overridable via EnvironmentFile.
export MIMIR_OFFSITE_ROOT="$STAGING"
: "${MIMIR_OFFSITE_SERVICE:=munin}";    export MIMIR_OFFSITE_SERVICE
: "${MIMIR_OFFSITE_REMOTE:=munin-crypt}"; export MIMIR_OFFSITE_REMOTE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/offsite-backup.sh" "$@"
