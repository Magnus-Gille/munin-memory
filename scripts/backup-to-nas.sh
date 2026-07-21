#!/bin/bash
set -euo pipefail

# Munin Memory SQLite backup.
#
# Uses sqlite3 .backup for a consistent snapshot (no file locking issues).
# Filename format: memory-YYYY-MM-DD-HHMM.db (Heimdall parses this for freshness).
#
# TWO DESTINATION MODES, selected by configuration — never hardcoded, so this
# script stays publication-safe and every installation-specific value lives in
# the ops .env:
#
#   remote  push the snapshot to another host over ssh/rsync
#           needs MUNIN_BACKUP_HOST and MUNIN_BACKUP_REMOTE_DIR
#   local   write the snapshot to a locally mounted volume
#           needs MUNIN_BACKUP_MOUNT and MUNIN_BACKUP_DIR
#
# Set MUNIN_BACKUP_MODE explicitly, or leave it unset and it is inferred from
# whichever pair is configured. Configuring neither is a hard error: a backup
# that silently writes nowhere is worse than one that refuses to start.
#
# Both modes share the free-space preflight, snapshot, integrity check, GFS
# retention, and post-write verification. Both verify what actually landed at
# the destination rather than trusting the transfer's exit status.

# ── Configuration ────────────────────────────────────────────────────────────
# MUNIN_DB is the historical name for the source database; keep accepting it so
# an existing ops .env does not silently start backing up the wrong file.
DB="${MUNIN_BACKUP_DB:-${MUNIN_DB:-${HOME}/.munin-memory/memory.db}}"

# Staging defaults to /tmp, which under the unit's PrivateTmp=yes is a tmpfs.
# Override with MUNIN_BACKUP_STAGING when a host has fast disk to spare — but
# read the rationale in munin-backup.service before pointing this at an SD card.
STAGING_DIR="${MUNIN_BACKUP_STAGING:-/tmp}"

BACKUP_HOST="${MUNIN_BACKUP_HOST:-}"
BACKUP_REMOTE_DIR="${MUNIN_BACKUP_REMOTE_DIR:-}"
BACKUP_MOUNT="${MUNIN_BACKUP_MOUNT:-}"
BACKUP_DIR="${MUNIN_BACKUP_DIR:-}"
MODE="${MUNIN_BACKUP_MODE:-}"

MOUNTPOINT_BIN="${MUNIN_MOUNTPOINT_BIN:-mountpoint}"
SSH_BIN="${MUNIN_SSH_BIN:-ssh}"
RSYNC_BIN="${MUNIN_RSYNC_BIN:-rsync}"

KEEP_DAILY="${MUNIN_BACKUP_KEEP_DAILY:-14}"
KEEP_SUNDAYS="${MUNIN_BACKUP_KEEP_SUNDAYS:-4}"

# ── Mode resolution ──────────────────────────────────────────────────────────
if [ -z "$MODE" ]; then
    if [ -n "$BACKUP_HOST" ]; then
        MODE="remote"
    elif [ -n "$BACKUP_MOUNT" ] || [ -n "$BACKUP_DIR" ]; then
        MODE="local"
    else
        echo "ERROR: no backup destination is configured." >&2
        echo "       Set MUNIN_BACKUP_MODE=remote with MUNIN_BACKUP_HOST and" >&2
        echo "       MUNIN_BACKUP_REMOTE_DIR, or MUNIN_BACKUP_MODE=local with" >&2
        echo "       MUNIN_BACKUP_MOUNT and MUNIN_BACKUP_DIR." >&2
        exit 64
    fi
fi

case "$MODE" in
    remote|local) ;;
    *) echo "ERROR: MUNIN_BACKUP_MODE must be 'remote' or 'local', got '${MODE}'." >&2; exit 64 ;;
esac

if [ "$MODE" = "remote" ]; then
    [ -n "$BACKUP_HOST" ] || { echo "ERROR: MUNIN_BACKUP_MODE=remote requires MUNIN_BACKUP_HOST." >&2; exit 64; }
    [ -n "$BACKUP_REMOTE_DIR" ] || { echo "ERROR: MUNIN_BACKUP_MODE=remote requires MUNIN_BACKUP_REMOTE_DIR." >&2; exit 64; }
    case "$BACKUP_REMOTE_DIR" in
        /*) ;;
        *) echo "ERROR: MUNIN_BACKUP_REMOTE_DIR must be an absolute path." >&2; exit 64 ;;
    esac
else
    [ -n "$BACKUP_DIR" ] || { echo "ERROR: MUNIN_BACKUP_MODE=local requires MUNIN_BACKUP_DIR." >&2; exit 64; }
    [ -n "$BACKUP_MOUNT" ] || { echo "ERROR: MUNIN_BACKUP_MODE=local requires MUNIN_BACKUP_MOUNT." >&2; exit 64; }
    command -v "$MOUNTPOINT_BIN" >/dev/null 2>&1 || { echo "ERROR: mountpoint checker not found: $MOUNTPOINT_BIN" >&2; exit 69; }

    # Both paths must be absolute and lexically normalized. Rejecting dot
    # segments prevents a configured child path from escaping the mount root.
    case "$BACKUP_MOUNT" in /*) ;; *) echo "ERROR: MUNIN_BACKUP_MOUNT must be an absolute path." >&2; exit 64 ;; esac
    case "$BACKUP_DIR" in /*) ;; *) echo "ERROR: MUNIN_BACKUP_DIR must be an absolute path." >&2; exit 64 ;; esac
    case "/${BACKUP_MOUNT#/}/" in *"/../"*|*"/./"*) echo "ERROR: MUNIN_BACKUP_MOUNT must not contain dot path segments." >&2; exit 64 ;; esac
    case "/${BACKUP_DIR#/}/" in *"/../"*|*"/./"*) echo "ERROR: MUNIN_BACKUP_DIR must not contain dot path segments." >&2; exit 64 ;; esac

    while [ "$BACKUP_MOUNT" != "/" ] && [ "${BACKUP_MOUNT%/}" != "$BACKUP_MOUNT" ]; do BACKUP_MOUNT="${BACKUP_MOUNT%/}"; done
    while [ "$BACKUP_DIR" != "/" ] && [ "${BACKUP_DIR%/}" != "$BACKUP_DIR" ]; do BACKUP_DIR="${BACKUP_DIR%/}"; done
    if [ "$BACKUP_MOUNT" = "/" ]; then
        echo "ERROR: MUNIN_BACKUP_MOUNT must not be /; configure a dedicated mounted filesystem." >&2
        exit 64
    fi
    case "$BACKUP_DIR" in
        "$BACKUP_MOUNT"/*) ;;
        "$BACKUP_MOUNT") echo "ERROR: MUNIN_BACKUP_DIR must be a child of MUNIN_BACKUP_MOUNT, not the mount root itself." >&2; exit 64 ;;
        *) echo "ERROR: MUNIN_BACKUP_DIR must be inside MUNIN_BACKUP_MOUNT." >&2; exit 64 ;;
    esac
fi

TIMESTAMP=$(date -u +%Y-%m-%d-%H%M)
FILENAME="memory-${TIMESTAMP}.db"
LOCAL_TMP="${STAGING_DIR}/${FILENAME}"

# Remove the staging snapshot on EVERY exit path, not just the successful one,
# and take sqlite's sidecars with it: `.backup` leaves a <file>-journal (and can
# leave -wal/-shm) next to the snapshot, so removing only $LOCAL_TMP strands
# them. Observed for real — an interrupted run left an orphaned -journal behind.
trap 'rm -f "$LOCAL_TMP" "${LOCAL_TMP}-journal" "${LOCAL_TMP}-wal" "${LOCAL_TMP}-shm"' EXIT

# ── Portable stat ────────────────────────────────────────────────────────────
# The flavour is detected ONCE and never mixed: GNU spells the format `-c`,
# while GNU's `-f` means --file-system, so a BSD-style `stat -f '%d' path` on
# GNU treats '%d' as a filename and reports filesystem status instead of a
# device ID. Falling back across flavours would compare the wrong value rather
# than fail honestly.
if stat -c '%d' . >/dev/null 2>&1; then
    STAT_FLAVOR="gnu"
elif stat -f '%d' . >/dev/null 2>&1; then
    STAT_FLAVOR="bsd"
else
    echo "ERROR: no usable stat(1) flavour for backup verification." >&2
    exit 69
fi

device_id() {
    if [ "$STAT_FLAVOR" = "gnu" ]; then stat -c '%d' "$1" 2>/dev/null; else stat -f '%d' "$1" 2>/dev/null; fi
}

size_bytes() {
    if [ "$STAT_FLAVOR" = "gnu" ]; then stat -c '%s' "$1" 2>/dev/null; else stat -f '%z' "$1" 2>/dev/null; fi
}

# ── Local-mode destination guards ────────────────────────────────────────────
# Lexical containment is necessary but not sufficient: a symlink anywhere
# between the verified mount root and the destination resolves outside the
# mount, and both mkdir and install follow it. Without this the job can report a
# successful mounted-volume backup while writing the plaintext database
# elsewhere on the system.
assert_no_symlink_components() {
    if [ -L "$BACKUP_MOUNT" ]; then
        echo "ERROR: MUNIN_BACKUP_MOUNT is a symlink and cannot be verified as a mount root: $BACKUP_MOUNT" >&2
        exit 69
    fi
    local current="$BACKUP_MOUNT"
    local rest="${BACKUP_DIR#"$BACKUP_MOUNT"/}"
    local segment
    # Manual split (no `set --`) so path segments are never glob-expanded.
    while [ -n "$rest" ]; do
        segment="${rest%%/*}"
        if [ "$segment" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
        [ -z "$segment" ] && continue
        current="$current/$segment"
        if [ -L "$current" ]; then
            echo "ERROR: backup destination path component is a symlink: $current" >&2
            exit 69
        fi
    done
}

# Re-validate the mount immediately before every destination mutation. The
# preflight runs before a potentially slow SQLite snapshot, and a removable/NAS
# mount can drop during that window — after which mkdir would recreate the
# destination on the root filesystem and the backup would silently succeed
# locally.
assert_mount_active() {
    if ! "$MOUNTPOINT_BIN" -q -- "$BACKUP_MOUNT"; then
        echo "ERROR: MUNIN_BACKUP_MOUNT is $1: $BACKUP_MOUNT" >&2
        exit 69
    fi
}

# Bind the destination to the mounted filesystem's identity, not just to a path
# string, so a nested mount or a race that leaves the path resolving elsewhere
# is caught before the database is written. Guarded assignments: a bare
# `dev=$(device_id ...)` would abort at the assignment under `set -e`, skipping
# the actionable message below.
assert_dest_on_mounted_fs() {
    local mount_dev dest_dev
    if ! mount_dev=$(device_id "$BACKUP_MOUNT") || [ -z "$mount_dev" ]; then
        echo "ERROR: cannot determine the device of MUNIN_BACKUP_MOUNT: $BACKUP_MOUNT" >&2
        exit 69
    fi
    if ! dest_dev=$(device_id "$BACKUP_DIR") || [ -z "$dest_dev" ]; then
        echo "ERROR: cannot determine the device of MUNIN_BACKUP_DIR: $BACKUP_DIR" >&2
        exit 69
    fi
    if [ "$mount_dev" != "$dest_dev" ]; then
        echo "ERROR: backup destination is not on the mounted backup filesystem: $BACKUP_DIR" >&2
        exit 69
    fi
}

echo "$(date -Iseconds) Starting Munin backup (mode=${MODE})..."

if [ "$MODE" = "local" ]; then
    # Deliberately before sqlite3 and mkdir. If a removable/NAS mount
    # disappears, mkdir must never recreate the destination on the root fs.
    if ! "$MOUNTPOINT_BIN" -q -- "$BACKUP_MOUNT"; then
        echo "ERROR: MUNIN_BACKUP_MOUNT is not an active mountpoint: $BACKUP_MOUNT" >&2
        exit 69
    fi
    assert_no_symlink_components
fi

# ── 0. Preflight: staging free space ─────────────────────────────────────────
# The snapshot is a full copy of the DB, so staging needs room for it. Fail
# loudly and immediately rather than writing most of a snapshot and dying on
# ENOSPC — a half-run that reports failure is far cheaper to diagnose than one
# that fails 90% of the way through a long job.
DB_BYTES=$(size_bytes "$DB")
if [ -z "$DB_BYTES" ]; then
    echo "ERROR: cannot stat the source database: $DB" >&2
    exit 66
fi
DB_KB=$(( DB_BYTES / 1024 ))
AVAIL_KB=$(df -Pk "$STAGING_DIR" | awk 'NR==2 {print $4}')
NEED_KB=$(( DB_KB * 12 / 10 ))   # snapshot + 20% headroom
if [ "$AVAIL_KB" -lt "$NEED_KB" ]; then
    echo "ERROR: staging dir ${STAGING_DIR} has ${AVAIL_KB} KB free but the" >&2
    echo "       snapshot needs ~${NEED_KB} KB (database is ${DB_KB} KB)." >&2
    echo "       Point MUNIN_BACKUP_STAGING at a location with more room, or" >&2
    echo "       shrink the database. Refusing to start a doomed snapshot." >&2
    exit 1
fi

# ── 1. Consistent snapshot ───────────────────────────────────────────────────
sqlite3 "$DB" ".backup $LOCAL_TMP"

# ── 2. Verify snapshot integrity ─────────────────────────────────────────────
INTEGRITY=$(sqlite3 "$LOCAL_TMP" "PRAGMA integrity_check;" 2>&1)
if [ "$INTEGRITY" != "ok" ]; then
    echo "ERROR: Integrity check failed: $INTEGRITY" >&2
    exit 1  # staging snapshot is removed by the EXIT trap
fi
SNAPSHOT_BYTES=$(size_bytes "$LOCAL_TMP")

# ── 3. GFS retention, applied identically at either destination ──────────────
# Keep the N most recent daily snapshots plus the M most recent Sunday ones.
#
# SIGPIPE-safety: an earlier prune used `ls -1t ... | head -n N`. Under
# `set -o pipefail`, `head` closes the pipe after N lines, `ls` keeps writing,
# gets SIGPIPE, and the pipeline exit status becomes 141 — which `set -e` then
# treats as fatal. The transfer had already succeeded, but the service reported
# failure nightly and retention never ran (dailies piled up). Read the full `ls`
# output into an array instead — no live pipe for a producer to die on.
#
# `ls -1 | sort -r` rather than `ls -1t`: retention follows the date the
# snapshot REPRESENTS (encoded in the filename), not the file's mtime. A restore
# or an `rsync --ignore-times` re-sync can give an old-dated file a fresh mtime,
# which under `-t` would keep a stale snapshot and prune a recent one. Lexical
# descending = date descending because filenames are zero-padded ISO dates.
read -r -d '' PRUNE_SCRIPT <<'REMOTE' || true
set -euo pipefail
cd "$1" || exit 0
keep_daily="$2"
keep_sundays="$3"

keep=$(mktemp)
trap 'rm -f "$keep"' EXIT

all=()
while IFS= read -r line; do
    all+=("$line")
done < <(ls -1 memory-*.db 2>/dev/null | sort -r || true)

i=0
for f in ${all[@]+"${all[@]}"}; do
    [ "$i" -ge "$keep_daily" ] && break
    printf '%s\n' "$f" >> "$keep"
    i=$((i + 1))
done

sundays=0
for f in ${all[@]+"${all[@]}"}; do
    [ "$sundays" -ge "$keep_sundays" ] && break
    d=$(printf '%s\n' "$f" | sed -nE 's/^memory-([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p')
    [ -z "$d" ] && continue
    dow=$(date -d "$d" +%u 2>/dev/null || date -j -f "%Y-%m-%d" "$d" +%u 2>/dev/null || echo 0)
    if [ "$dow" = "7" ]; then
        printf '%s\n' "$f" >> "$keep"
        sundays=$((sundays + 1))
    fi
done

prune=()
while IFS= read -r line; do
    prune+=("$line")
done < <(ls -1 memory-*.db 2>/dev/null | grep -vxFf "$keep" || true)
if [ "${#prune[@]}" -gt 0 ]; then
    printf '%s\0' "${prune[@]}" | xargs -0 -r rm --
fi
REMOTE

# ── 4. Deliver to the destination ────────────────────────────────────────────
if [ "$MODE" = "remote" ]; then
    "$SSH_BIN" "$BACKUP_HOST" "mkdir -p '${BACKUP_REMOTE_DIR}'"

    # No -z: on a fast LAN the sending CPU, not the link, is the bottleneck.
    # Measured on a 1.85 GB snapshot over this link:
    #   rsync -az  29 s  (~65 MB/s, gzip-bound)
    #   rsync -a   19 s  (~100 MB/s, near line rate)
    # Compression would be right over a slow WAN; here it is a pessimisation.
    # tests/backup-script.test.ts pins the intent so it is not "tidied" back.
    "$RSYNC_BIN" -a "$LOCAL_TMP" "${BACKUP_HOST}:${BACKUP_REMOTE_DIR}/${FILENAME}"

    # Post-transfer verification. rsync exiting 0 does not by itself prove the
    # expected bytes are readable at the destination under the expected name —
    # verify what actually landed rather than trusting the exit status.
    # The remote may be GNU or BSD. Ask for the GNU form first and fall back,
    # then REQUIRE a bare integer: GNU's `-f` means --file-system, so a BSD-style
    # probe landing on a GNU host prints a filesystem report rather than failing
    # cleanly. Comparing that against a byte count would be comparing garbage —
    # demand a number and fail closed otherwise.
    REMOTE_BYTES=$("$SSH_BIN" "$BACKUP_HOST" \
        "stat -c '%s' '${BACKUP_REMOTE_DIR}/${FILENAME}' 2>/dev/null || stat -f '%z' '${BACKUP_REMOTE_DIR}/${FILENAME}' 2>/dev/null" || true)
    REMOTE_BYTES=$(printf '%s' "$REMOTE_BYTES" | tr -d '[:space:]')
    case "$REMOTE_BYTES" in
        ''|*[!0-9]*) REMOTE_BYTES="" ;;
    esac
    if [ -z "$REMOTE_BYTES" ] || [ "$REMOTE_BYTES" != "$SNAPSHOT_BYTES" ]; then
        echo "ERROR: backup did not land intact on ${BACKUP_HOST}." >&2
        echo "       expected ${SNAPSHOT_BYTES} bytes, destination reports '${REMOTE_BYTES:-<missing>}'." >&2
        echo "       Retention was NOT run, so existing snapshots are untouched." >&2
        exit 69
    fi

    "$SSH_BIN" "$BACKUP_HOST" "bash -s '${BACKUP_REMOTE_DIR}' '${KEEP_DAILY}' '${KEEP_SUNDAYS}'" <<<"$PRUNE_SCRIPT"
else
    # Revalidate immediately before each mutation — the snapshot above is slow
    # enough for a mount to disappear, and for a symlink to be planted, after
    # the preflight checks passed.
    assert_mount_active "no longer an active mountpoint"
    assert_no_symlink_components
    mkdir -p "$BACKUP_DIR"
    assert_mount_active "no longer an active mountpoint"
    assert_no_symlink_components
    assert_dest_on_mounted_fs
    install -m 600 "$LOCAL_TMP" "$BACKUP_DIR/$FILENAME"

    # Post-write verification. Path-based check-then-use cannot be made atomic
    # in shell, so a narrow race remains between the last check and `install`.
    # Verify where the file ACTUALLY landed and remove it if it is not on the
    # mounted filesystem: a wrong-location write becomes a loud failure instead
    # of a silently "successful" backup sitting on the root filesystem.
    written_dev=""
    mount_dev_now=""
    written_dev=$(device_id "$BACKUP_DIR/$FILENAME") || true
    mount_dev_now=$(device_id "$BACKUP_MOUNT") || true
    if [ -z "$written_dev" ] || [ "$written_dev" != "$mount_dev_now" ] \
       || ! "$MOUNTPOINT_BIN" -q -- "$BACKUP_MOUNT"; then
        rm -f "$BACKUP_DIR/$FILENAME"
        echo "ERROR: backup did not land on the mounted filesystem; removed $BACKUP_DIR/$FILENAME" >&2
        exit 69
    fi

    written_bytes=$(size_bytes "$BACKUP_DIR/$FILENAME") || true
    if [ "$written_bytes" != "$SNAPSHOT_BYTES" ]; then
        rm -f "$BACKUP_DIR/$FILENAME"
        echo "ERROR: backup is truncated (expected ${SNAPSHOT_BYTES} bytes, wrote ${written_bytes:-0}); removed." >&2
        exit 69
    fi

    bash -s "$BACKUP_DIR" "$KEEP_DAILY" "$KEEP_SUNDAYS" <<<"$PRUNE_SCRIPT"
fi

# ── 5. Staging cleanup is handled by the EXIT trap. ──────────────────────────
echo "$(date -Iseconds) Backup complete: ${FILENAME} (mode=${MODE})"
