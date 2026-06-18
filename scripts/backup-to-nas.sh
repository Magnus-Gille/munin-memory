#!/bin/bash
set -euo pipefail

# Munin Memory SQLite backup to NAS Pi
# Uses sqlite3 .backup for a consistent snapshot (no file locking issues)
# Filename format: memory-YYYY-MM-DD-HHMM.db (Heimdall parses this for freshness)

DB="/home/magnus/.munin-memory/memory.db"
NAS_HOST="100.99.119.52"
NAS_DIR="/mnt/timemachine/backups/munin-memory"
TIMESTAMP=$(date -u +%Y-%m-%d-%H%M)
FILENAME="memory-${TIMESTAMP}.db"
LOCAL_TMP="/tmp/${FILENAME}"

echo "$(date -Iseconds) Starting Munin backup..."

# 1. Create a consistent snapshot using sqlite3 .backup
sqlite3 "$DB" ".backup $LOCAL_TMP"

# 2. Verify integrity of the backup
INTEGRITY=$(sqlite3 "$LOCAL_TMP" "PRAGMA integrity_check;" 2>&1)
if [ "$INTEGRITY" != "ok" ]; then
    echo "ERROR: Integrity check failed: $INTEGRITY" >&2
    rm -f "$LOCAL_TMP"
    exit 1
fi

# 3. Ensure target dir exists, then rsync to NAS
ssh "magnus@${NAS_HOST}" "mkdir -p '${NAS_DIR}'"
rsync -az "$LOCAL_TMP" "magnus@${NAS_HOST}:${NAS_DIR}/${FILENAME}"

# 4. Cleanup local temp
rm -f "$LOCAL_TMP"

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

# All snapshots, newest first, read into an array via a `while read` loop. The
# producer (`ls`) runs to completion feeding the loop — there is no `head` to
# close the pipe early, so no SIGPIPE, so no spurious pipefail/`set -e` abort.
# (`while read` is portable to bash 3.2; `mapfile` is bash 4+.)
all=()
while IFS= read -r line; do
    all+=("$line")
done < <(ls -1t memory-*.db 2>/dev/null || true)

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
    if [ "$(date -d "$d" +%u 2>/dev/null || echo 0)" = "7" ]; then
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
