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
# Fail-loud, like offsite-backup.sh: an ERR trap + explicit die() push a `fail`
# Heimdall panel (same service/panel the sync uses) and exit non-zero, so a
# torn/failed/interrupted snapshot never silently skips the offsite copy.
#
# Concurrency: a flock guard prevents a timer-triggered run from overlapping a manual
# one and interleaving the rewrite of the shared snapshot with the sync (the lock is
# held through the handoff since the fd is inherited across exec).
#
# Usage:
#   ./offsite-snapshot.sh              snapshot, then run the encrypted offsite push
#   ./offsite-snapshot.sh --dry-run    snapshot locally, then dry-run the push (no remote writes)

# ---- Config (override via environment / EnvironmentFile) ----
DB="${MUNIN_OFFSITE_DB:-$HOME/.munin-memory/memory.db}"           # live memory DB
STAGING="${MUNIN_OFFSITE_STAGING:-$HOME/.munin-memory/offsite-staging}"  # snapshot dir (becomes ROOT)
SQLITE="${SQLITE_BIN:-sqlite3}"
LOCK="${MUNIN_OFFSITE_LOCK:-$HOME/.munin-memory/offsite-snapshot.lock}"   # concurrency guard (outside STAGING)
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

# Expected failure: log, push a fail panel, exit. (ERR trap disabled to avoid a
# double report — die() already reports.)
die() {
  trap - ERR
  log "ERROR: $*"
  push_panel fail "$* — see ${LOG}"
  exit 1
}

# Unexpected command failure in the snapshot region (before the exec handoff). Ensures
# a bare `set -e` abort still surfaces on the dashboard instead of a silent non-zero.
on_err() {
  local rc=$?
  trap - ERR
  log "ERROR: offsite snapshot failed (exit ${rc})"
  push_panel fail "snapshot failed (exit ${rc}) — see ${LOG}"
  exit "${rc}"
}
trap on_err ERR

mkdir -p "$(dirname "$LOG")"

# ---- Preflight ----
command -v "$SQLITE" >/dev/null 2>&1 || die "sqlite3 not found (SQLITE_BIN=$SQLITE)"
[ -f "$DB" ] || die "memory DB missing: $DB"

# ---- Concurrency lock ----
# Serialize runs so a timer-triggered snapshot can't interleave with a manual one
# (one process rewriting munin.sqlite while the other syncs the staging dir). fd 9 is
# inherited across the final exec, so the lock is held for the whole sync too. On the
# Pi (Linux) flock is always present; degrade to a warning elsewhere for local testing.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || die "cannot open lock file: $LOCK"
  flock -n 9 || die "another offsite snapshot run holds the lock ($LOCK) — refusing to overlap"
else
  log "WARN: flock not found — running without a concurrency lock"
fi

# ---- Staging safety ----
# The whole staging dir is mirrored offsite, so it must be a DEDICATED dir containing
# only the snapshot — never the live DB's directory, and never a dir the DB lives in.
mkdir -p "$STAGING" || die "cannot create staging dir: $STAGING"
STAGING_REAL=$(cd "$STAGING" && pwd -P) || die "cannot resolve staging dir: $STAGING"
DB_DIR_REAL=$(cd "$(dirname "$DB")" && pwd -P) || die "cannot resolve DB dir for: $DB"
DB_REAL="${DB_DIR_REAL}/$(basename "$DB")"
[ "$STAGING_REAL" != "$DB_DIR_REAL" ] || die "staging dir must not be the DB directory ($DB_DIR_REAL) — would mirror the live DB"
case "$DB_REAL" in
  "$STAGING_REAL"/*) die "the live DB ($DB_REAL) is inside the staging dir — would mirror it; use a dedicated staging dir";;
esac
SNAP="${STAGING_REAL}/munin.sqlite"

# ---- Consistent snapshot ----
# VACUUM INTO refuses to overwrite an existing file, and a stale snapshot (or its
# stray -wal/-shm) would otherwise get mirrored offsite. Clear the staging file first
# so the mirror is exactly one clean, standalone DB with no WAL sidecars. Escape any
# single quotes in the path for the SQL string literal (default path is quote-free,
# but MUNIN_OFFSITE_STAGING is an override).
rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm"
SQL_SNAP=${SNAP//\'/\'\'}

log "snapshotting ${DB} → ${SNAP} (VACUUM INTO)"
"$SQLITE" "$DB" "VACUUM INTO '${SQL_SNAP}'" 2>>"$LOG" \
  || die "VACUUM INTO failed — snapshot not created, refusing to upload a live DB"

# Verify the snapshot before it leaves the box (a corrupt snapshot is worse than none).
INTEGRITY=$("$SQLITE" "$SNAP" "PRAGMA integrity_check;" 2>&1 || echo "integrity_check errored")
if [ "$INTEGRITY" != "ok" ]; then
  rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm"
  die "snapshot integrity_check failed: ${INTEGRITY}"
fi
log "snapshot ok ($(du -h "$SNAP" 2>/dev/null | cut -f1 || echo '?')), integrity_check=ok"

# The staging dir is mirrored wholesale — assert it holds ONLY the verified snapshot
# so a stray/leftover file (or a sidecar) can never ride along in the offsite copy.
EXTRA=$(find "$STAGING_REAL" -mindepth 1 ! -path "$SNAP" 2>/dev/null | head -n 5 || true)
[ -z "$EXTRA" ] || die "staging dir holds files other than the snapshot — refusing to mirror: $(printf '%s' "$EXTRA" | tr '\n' ' ')"

# ---- Hand off to the shared offsite mechanism ----
# ROOT is the staging dir (always — the snapshot is the source of truth). SERVICE and
# REMOTE keep sensible munin defaults but stay overridable via EnvironmentFile.
export MIMIR_OFFSITE_ROOT="$STAGING_REAL"
: "${MIMIR_OFFSITE_SERVICE:=munin}";    export MIMIR_OFFSITE_SERVICE
: "${MIMIR_OFFSITE_REMOTE:=munin-crypt}"; export MIMIR_OFFSITE_REMOTE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/offsite-backup.sh" "$@"
