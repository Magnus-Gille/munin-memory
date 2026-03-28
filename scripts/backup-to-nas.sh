#!/bin/bash
set -euo pipefail

# Munin Memory SQLite backup to NAS Pi
# Uses sqlite3 .backup for a consistent snapshot (no file locking issues)
# Filename format: memory-YYYY-MM-DD-HHMM.db (Heimdall parses this for freshness)

DB="/home/magnus/.munin-memory/memory.db"
NAS_HOST="100.99.119.52"
NAS_DIR="/home/magnus/backups/munin-memory"
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

# 3. rsync to NAS
rsync -az "$LOCAL_TMP" "magnus@${NAS_HOST}:${NAS_DIR}/${FILENAME}"

# 4. Cleanup local temp
rm -f "$LOCAL_TMP"

# 5. Prune old backups on NAS (keep last 168 = 7 days of hourly backups)
ssh "magnus@${NAS_HOST}" "cd ${NAS_DIR} && ls -1t memory-*.db 2>/dev/null | tail -n +169 | xargs -r rm --"

echo "$(date -Iseconds) Backup complete: ${FILENAME}"
