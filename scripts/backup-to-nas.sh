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
ssh "magnus@${NAS_HOST}" "bash -s '${NAS_DIR}'" <<'REMOTE'
set -euo pipefail
cd "$1" || exit 0
keep=$(mktemp)
trap 'rm -f "$keep"' EXIT
ls -1t memory-*.db 2>/dev/null | head -n 14 > "$keep"
for f in $(ls -1t memory-*.db 2>/dev/null); do
    d=$(echo "$f" | sed -nE 's/^memory-([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p')
    [ -z "$d" ] && continue
    if [ "$(date -d "$d" +%u 2>/dev/null)" = "7" ]; then
        echo "$f"
    fi
done | head -n 4 >> "$keep"
{ ls -1 memory-*.db 2>/dev/null | grep -vxFf "$keep" || true; } | xargs -r rm --
REMOTE

echo "$(date -Iseconds) Backup complete: ${FILENAME}"
