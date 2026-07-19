#!/bin/bash
set -euo pipefail

# Munin Memory SQLite backup to a local or mounted backup directory
# Uses sqlite3 .backup for a consistent snapshot (no file locking issues)
# Filename format: memory-YYYY-MM-DD-HHMM.db (Heimdall parses this for freshness)

DB="${MUNIN_BACKUP_DB:-${HOME}/.munin-memory/memory.db}"
BACKUP_DIR="${MUNIN_BACKUP_DIR:-${HOME}/backups/munin-memory}"
TIMESTAMP=$(date -u +%Y-%m-%d-%H%M)
FILENAME="memory-${TIMESTAMP}.db"
LOCAL_TMP=$(mktemp "${TMPDIR:-/tmp}/munin-memory-backup.XXXXXX.db")
trap 'rm -f "$LOCAL_TMP"' EXIT

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

# 3. Copy to the configured directory. It may be a local disk or a mounted NAS.
mkdir -p "$BACKUP_DIR"
install -m 600 "$LOCAL_TMP" "$BACKUP_DIR/$FILENAME"

# 4. Cleanup local temp
rm -f "$LOCAL_TMP"

# 5. Prune old backups — GFS retention:
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
(
set -euo pipefail
cd "$BACKUP_DIR" || exit 0

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
)

echo "$(date -Iseconds) Backup complete: ${FILENAME}"
