#!/bin/bash
set -euo pipefail

# Munin Memory SQLite backup to NAS Pi
# Uses sqlite3 .backup for a consistent snapshot (no file locking issues)
# Filename format: memory-YYYY-MM-DD-HHMM.db (Heimdall parses this for freshness)

DB="${MUNIN_DB:-/home/magnus/.munin-memory/memory.db}"
NAS_HOST="100.99.119.52"
NAS_DIR="/mnt/timemachine/backups/munin-memory"
TIMESTAMP=$(date -u +%Y-%m-%d-%H%M)
FILENAME="memory-${TIMESTAMP}.db"
# Staging defaults to /tmp, which under the unit's PrivateTmp=yes is a tmpfs.
# That is intentional on huginmunin — see the rationale in munin-backup.service.
# Override with MUNIN_BACKUP_STAGING when a host has fast disk to spare.
STAGING_DIR="${MUNIN_BACKUP_STAGING:-/tmp}"
LOCAL_TMP="${STAGING_DIR}/${FILENAME}"

# Remove the staging snapshot on EVERY exit path, not just the successful one,
# and take sqlite's sidecars with it: `.backup` leaves a <file>-journal (and can
# leave -wal/-shm) next to the snapshot, so removing only $LOCAL_TMP strands
# them. Observed for real — an interrupted run left an orphaned -journal behind.
trap 'rm -f "$LOCAL_TMP" "${LOCAL_TMP}-journal" "${LOCAL_TMP}-wal" "${LOCAL_TMP}-shm"' EXIT

echo "$(date -Iseconds) Starting Munin backup..."

# 0. Preflight: the snapshot is a full copy of the DB, so staging needs room for
# it. Fail loudly and immediately rather than writing most of a snapshot and
# dying on ENOSPC — a half-run that reports failure is far cheaper to diagnose
# than one that fails 90% of the way through a 30-minute job.
# GNU stat (Linux/the Pi) and BSD stat (macOS, where the test suite also runs)
# spell "size in bytes" differently. Both forms are O(1); `wc -c` would be the
# other portable option but invites reading a 1.85 GB file on some platforms.
# -P forces POSIX single-line df output, so a long device name cannot wrap the
# figure we want onto a third line.
DB_BYTES=$(stat -c %s "$DB" 2>/dev/null || stat -f %z "$DB" 2>/dev/null || true)
AVAIL_KB=$(df -Pk "$STAGING_DIR" 2>/dev/null | awk 'NR==2 {print $4}')

# Fail CLOSED when either figure is unreadable. This is not defensive padding:
# an empty value sails straight through both of the checks below. `$(( "" / 1024 ))`
# evaluates to 0, and `[ "" -lt 1229 ]` returns 2 with "integer expression
# expected" — a status `set -e` does NOT catch inside an `if` condition. So an
# unparseable stat or df would make this guard silently pass, in precisely the
# situation it exists to catch. Verified by hand; a regression test covers it.
for _probe in "database size:${DB_BYTES}" "free space in ${STAGING_DIR}:${AVAIL_KB}"; do
    _label=${_probe%%:*}
    _value=${_probe##*:}
    case "$_value" in
        ''|*[!0-9]*)
            echo "ERROR: could not determine ${_label} (got '${_value}')." >&2
            echo "       Refusing to start a backup whose staging space cannot" >&2
            echo "       be verified." >&2
            exit 1
            ;;
    esac
done

DB_KB=$(( DB_BYTES / 1024 ))
NEED_KB=$(( DB_KB * 12 / 10 ))   # snapshot + 20% headroom
if [ "$AVAIL_KB" -lt "$NEED_KB" ]; then
    echo "ERROR: staging dir ${STAGING_DIR} has ${AVAIL_KB} KB free but the" >&2
    echo "       snapshot needs ~${NEED_KB} KB (database is ${DB_KB} KB)." >&2
    echo "       Point MUNIN_BACKUP_STAGING at a location with more room, or" >&2
    echo "       shrink the database. Refusing to start a doomed snapshot." >&2
    exit 1
fi

# 1. Create a consistent snapshot using sqlite3 .backup
# The path is quoted INSIDE the dot-command: sqlite3 tokenizes dot-command
# arguments on whitespace itself, independently of shell quoting, so an
# unquoted MUNIN_BACKUP_STAGING containing a space would be split and the
# backup written somewhere unintended. Verified: unquoted fails on such a
# path, quoted succeeds.
sqlite3 "$DB" ".backup '$LOCAL_TMP'"

# 2. Verify integrity of the backup
INTEGRITY=$(sqlite3 "$LOCAL_TMP" "PRAGMA integrity_check;" 2>&1)
if [ "$INTEGRITY" != "ok" ]; then
    echo "ERROR: Integrity check failed: $INTEGRITY" >&2
    exit 1  # staging snapshot is removed by the EXIT trap
fi

# 3. Ensure target dir exists, then rsync to NAS
ssh "magnus@${NAS_HOST}" "mkdir -p '${NAS_DIR}'"
# No -z: this is a fast LAN and the Pi's CPU, not the link, is the bottleneck.
# Measured on the 1.85 GB snapshot, huginmunin -> NAS:
#   rsync -az  29 s  (~65 MB/s, gzip-bound)
#   rsync -a   19 s  (~100 MB/s, near line rate)
# Compression would be the right call over a slow WAN link; over this one it is
# a pessimisation. scripts/test-backup-staging.sh pins this so it is not
# "tidied" back to -az.
rsync -a "$LOCAL_TMP" "magnus@${NAS_HOST}:${NAS_DIR}/${FILENAME}"

# 4. Cleanup local temp — handled by the EXIT trap set above.

# 5. Prune old backups on NAS — GFS retention:
#    - keep the 14 most recent daily snapshots
#    - plus the 4 most recent Sunday snapshots (rolling monthly coverage)
#
# SIGPIPE-safety: the old prune used `ls -1t ... | head -n N`. Under
# `set -o pipefail`, `head` closes the pipe after N lines, `ls` keeps writing,
# gets SIGPIPE, and the pipeline exit status becomes 141 — which `set -e` then
# treats as a fatal error. The rsync had already succeeded, but the service
# reported failure nightly and retention never ran (dailies piled up). The fix:
# read the full `ls` output into a bash array (no live pipe for a producer to
# die on), then slice the first N with array indexing. No `head`, no SIGPIPE.
ssh "magnus@${NAS_HOST}" "bash -s '${NAS_DIR}'" <<'REMOTE'
set -euo pipefail
cd "$1" || exit 0

keep=$(mktemp)
trap 'rm -f "$keep"' EXIT

# All snapshots, sorted by encoded filename date (newest first), read into an
# array via a `while read` loop. Using `ls -1 | sort -r` instead of `ls -1t`
# ensures retention is based on the date the snapshot *represents* (encoded in
# the filename as YYYY-MM-DD), not the file's mtime. A backfill/restore/rsync
# --ignore-times re-sync can touch an old-dated file and give it a fresh mtime,
# which would make `ls -t` sort it as "newest" and keep a stale snapshot while
# pruning a genuinely recent one. Lexical descending = date descending because
# filenames are zero-padded ISO dates. `sort` drains its input fully before
# emitting output, so there is no live producer for `| head` to truncate — no
# SIGPIPE possible. (`while read` is portable to bash 3.2; `mapfile` is bash 4+.)
all=()
while IFS= read -r line; do
    all+=("$line")
done < <(ls -1 memory-*.db 2>/dev/null | sort -r || true)

# Keep the 14 most recent daily snapshots (array slice, not `head`). The
# `${all[@]+...}` guard keeps `set -u` happy when the array is empty.
i=0
for f in ${all[@]+"${all[@]}"}; do
    [ "$i" -ge 14 ] && break
    printf '%s\n' "$f" >> "$keep"
    i=$((i + 1))
done

# Plus the 4 most recent Sunday snapshots, in newest-first order. A counter +
# `break` replaces the old `... | head -n 4`, which was the real SIGPIPE source:
# the loop kept producing after head closed the pipe at the 4th match, and under
# pipefail that surfaced as exit 141 → `set -e` aborted the whole backup.
sundays=0
for f in ${all[@]+"${all[@]}"}; do
    [ "$sundays" -ge 4 ] && break
    d=$(printf '%s\n' "$f" | sed -nE 's/^memory-([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p')
    [ -z "$d" ] && continue
    dow=$(date -d "$d" +%u 2>/dev/null || date -j -f "%Y-%m-%d" "$d" +%u 2>/dev/null || echo 0)
    if [ "$dow" = "7" ]; then
        printf '%s\n' "$f" >> "$keep"
        sundays=$((sundays + 1))
    fi
done

# Delete everything not in the keep set. grep -v exits 1 when it matches nothing
# to delete (all files kept) — guard with `|| true` so that is not fatal.
prune=()
while IFS= read -r line; do
    prune+=("$line")
done < <(ls -1 memory-*.db 2>/dev/null | grep -vxFf "$keep" || true)
if [ "${#prune[@]}" -gt 0 ]; then
    printf '%s\0' "${prune[@]}" | xargs -0 -r rm --
fi
REMOTE

echo "$(date -Iseconds) Backup complete: ${FILENAME}"
