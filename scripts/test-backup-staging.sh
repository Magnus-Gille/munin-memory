#!/usr/bin/env bash
# Hermetic self-check for the staging/transfer behaviour of backup-to-nas.sh.
#
# No NAS, no SSH, no sqlite3, no real database: `sqlite3`, `ssh`, `rsync`, and
# `df` are replaced by stubs on PATH, so this runs anywhere and never touches
# production. What it pins down:
#
#   1. STAGING LOCATION is configurable via MUNIN_BACKUP_STAGING and defaults
#      to /tmp when unset. On huginmunin /tmp is a tmpfs and that is the
#      deliberate choice — disk staging was measured at 12.5 MB/s on the SD
#      boot card (>20 min per run, ~675 GB/year of wear on the OS's own media)
#      versus ~32 s in tmpfs. The knob exists for hosts with fast spare disk.
#
#   2. rsync DOES NOT COMPRESS (-a, never -az). Measured huginmunin -> NAS on
#      the 1.85 GB snapshot: `-az` 29 s (~65 MB/s, gzip-bound on the Pi's CPU)
#      vs `-a` 19 s (~100 MB/s, near line rate). Compression is a pessimisation
#      on a fast LAN. It would be the right call over a slow WAN link, which is
#      why this is asserted rather than left to preference.
#
#   3. THE STAGING FILE AND ITS SQLITE SIDECARS ARE ALWAYS REMOVED, including
#      when a later step fails. `.backup` leaves a <snapshot>-journal (and can
#      leave -wal/-shm) beside the snapshot; an early version of the EXIT trap
#      removed only the snapshot and a real interrupted run stranded a journal
#      file. The failure path is exercised for real by forcing the rsync stub
#      to exit non-zero.
#
#   4. THE PREFLIGHT REFUSES A DOOMED RUN. The snapshot is a full copy of the
#      DB; if staging cannot hold it the job must fail immediately with an
#      actionable message rather than 90% of the way through a long snapshot.
#
# Run: bash scripts/test-backup-staging.sh   (pure local fixture)

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_DIR}/scripts/backup-to-nas.sh"

pass=0
fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

BIN="${SANDBOX}/bin"
mkdir -p "$BIN"

# A stand-in for the real database. Only its size is read (by the preflight).
FAKE_DB="${SANDBOX}/memory.db"
head -c 1048576 /dev/zero >"$FAKE_DB"   # 1 MiB

# --- stubs -----------------------------------------------------------------
# sqlite3: honours ".backup <path>" by creating a placeholder at <path> PLUS a
# -journal sidecar, mirroring what the real .backup leaves behind. Answers
# integrity/quick check pragmas with "ok". Records the snapshot path.
cat >"${BIN}/sqlite3" <<'STUB'
#!/usr/bin/env bash
case "${2:-}" in
  .backup*)
    # Mirror sqlite3's own dot-command handling: strip the surrounding quotes
    # the caller adds so a staging path containing spaces survives tokenizing.
    target="${2#.backup }"
    target="${target#\'}"
    target="${target%\'}"
    printf 'fake-sqlite-snapshot' >"$target"
    printf 'fake-journal' >"${target}-journal"
    printf '%s\n' "$target" >>"${STUB_LOG_DIR}/snapshot-path"
    ;;
  *integrity_check*|*quick_check*) echo "ok" ;;
esac
exit 0
STUB

# ssh: consumes stdin (the prune heredoc would otherwise SIGPIPE) and logs.
cat >"${BIN}/ssh" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
printf '%s\n' "$*" >>"${STUB_LOG_DIR}/ssh-args"
exit 0
STUB

# rsync: logs its argv, and fails when FORCE_RSYNC_FAIL=1 so the cleanup path
# on failure can be exercised for real rather than assumed.
cat >"${BIN}/rsync" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_LOG_DIR}/rsync-args"
[ "${FORCE_RSYNC_FAIL:-0}" = "1" ] && exit 23
exit 0
STUB

# df: reports a caller-chosen free-space figure when FORCE_DF_AVAIL is set,
# emits header-only (unparseable) output when FORCE_DF_BROKEN=1, and otherwise
# delegates to the real df so the happy path stays honest.
cat >"${BIN}/df" <<'STUB'
#!/usr/bin/env bash
if [ "${FORCE_DF_BROKEN:-0}" = "1" ]; then
  echo "Filesystem 1024-blocks Used Available Capacity Mounted-on"
  exit 0
fi
if [ -n "${FORCE_DF_AVAIL:-}" ]; then
  echo "Filesystem 1024-blocks Used Available Capacity Mounted-on"
  echo "stubfs 1000000 0 ${FORCE_DF_AVAIL} 1% /"
  exit 0
fi
exec /bin/df "$@"
STUB

chmod +x "${BIN}/sqlite3" "${BIN}/ssh" "${BIN}/rsync" "${BIN}/df"

run_backup() { # $1 = log dir, rest = env assignments
  local logdir="$1"; shift
  mkdir -p "$logdir"
  env PATH="${BIN}:${PATH}" STUB_LOG_DIR="$logdir" MUNIN_DB="$FAKE_DB" "$@" \
    bash "$SCRIPT" >"${logdir}/stdout" 2>"${logdir}/stderr"
  echo $? >"${logdir}/exit"
}

echo "== backup-to-nas.sh staging & transfer =="

# --- 1. explicit staging dir is honoured ------------------------------------
STAGE="${SANDBOX}/stage"; mkdir -p "$STAGE"
L1="${SANDBOX}/run1"
run_backup "$L1" MUNIN_BACKUP_STAGING="$STAGE"

check "exits 0 on the happy path" "$(cat "${L1}/exit")" "0"

snap="$(head -1 "${L1}/snapshot-path" 2>/dev/null || echo '')"
case "$snap" in
  "${STAGE}/"*) ok "snapshot staged under MUNIN_BACKUP_STAGING" ;;
  *)            bad "snapshot staged under MUNIN_BACKUP_STAGING (got '${snap:-<none>}')" ;;
esac

# --- 2. rsync must not compress ---------------------------------------------
rsync_args="$(head -1 "${L1}/rsync-args" 2>/dev/null || echo '')"
case "$rsync_args" in
  *-az*|*" -z"*) bad "rsync does not compress on the LAN (got '$rsync_args')" ;;
  *-a*)          ok  "rsync does not compress on the LAN" ;;
  *)             bad "rsync invoked with archive mode (got '${rsync_args:-<none>}')" ;;
esac

# --- 3. staging (incl. sidecars) is clean after success ---------------------
check "staging empty after a successful run" \
      "$(find "$STAGE" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"

# --- 4. staging is clean after a mid-run failure ----------------------------
STAGE2="${SANDBOX}/stage-fail"; mkdir -p "$STAGE2"
L2="${SANDBOX}/run2"
run_backup "$L2" MUNIN_BACKUP_STAGING="$STAGE2" FORCE_RSYNC_FAIL=1

rc2="$(cat "${L2}/exit")"
if [ "$rc2" != "0" ]; then ok "propagates a transfer failure (exit $rc2)"
else bad "propagates a transfer failure (exited 0)"; fi

leftovers="$(find "$STAGE2" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$leftovers" = "0" ]; then
  ok "staging empty after a FAILED run — snapshot AND -journal sidecar removed"
else
  bad "staging empty after a FAILED run (stranded: $(find "$STAGE2" -type f | tr '\n' ' '))"
fi

# --- 5. default staging remains /tmp when unset -----------------------------
L3="${SANDBOX}/run3"
run_backup "$L3"
snap3="$(head -1 "${L3}/snapshot-path" 2>/dev/null || echo '')"
case "$snap3" in
  /tmp/*) ok "defaults to /tmp when MUNIN_BACKUP_STAGING is unset" ;;
  *)      bad "defaults to /tmp when unset (got '${snap3:-<none>}')" ;;
esac
rm -f "$snap3" "${snap3}-journal" 2>/dev/null || true

# --- 5b. staging path containing a space ------------------------------------
# sqlite3 tokenizes dot-command arguments on whitespace itself, independently of
# shell quoting, so an unquoted `.backup $LOCAL_TMP` writes to the wrong place
# (or fails) the moment MUNIN_BACKUP_STAGING contains a space. Now that the
# staging dir is operator-configurable this is reachable, so pin it.
STAGE_SP="${SANDBOX}/stage with space"; mkdir -p "$STAGE_SP"
L7="${SANDBOX}/run7"
run_backup "$L7" MUNIN_BACKUP_STAGING="$STAGE_SP"

check "handles a staging path containing spaces" "$(cat "${L7}/exit")" "0"
snap7="$(head -1 "${L7}/snapshot-path" 2>/dev/null || echo '')"
case "$snap7" in
  "${STAGE_SP}/"*) ok "snapshot lands in the spaced path, not a split fragment" ;;
  *)               bad "snapshot lands in the spaced path (got '${snap7:-<none>}')" ;;
esac

# --- 6. preflight threshold, pinned at the exact boundary -------------------
# The fake DB is 1 MiB, so DB_KB=1024 and NEED_KB=1024*12/10=1228 (the 20%
# headroom, integer-truncated). Probing 1227/1228 pins that arithmetic exactly:
# a generous margin like "offer 100 KB" would still pass if the headroom factor
# were deleted, which is precisely the vacuous-assertion trap this suite already
# fell into once.
STAGE3="${SANDBOX}/stage-full"; mkdir -p "$STAGE3"
L4="${SANDBOX}/run4"
run_backup "$L4" MUNIN_BACKUP_STAGING="$STAGE3" FORCE_DF_AVAIL=1227

rc4="$(cat "${L4}/exit")"
if [ "$rc4" != "0" ]; then ok "preflight refuses 1 KB below the threshold (exit $rc4)"
else bad "preflight refuses 1 KB below the threshold (exited 0 — is the 20% headroom gone?)"; fi

if grep -q "staging dir" "${L4}/stderr" 2>/dev/null; then
  ok "preflight failure names the staging dir and the shortfall"
else
  bad "preflight failure names the staging dir and the shortfall"
fi

check "preflight aborts BEFORE writing a snapshot" \
      "$(find "$STAGE3" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"

STAGE4="${SANDBOX}/stage-just-enough"; mkdir -p "$STAGE4"
L5="${SANDBOX}/run5"
run_backup "$L5" MUNIN_BACKUP_STAGING="$STAGE4" FORCE_DF_AVAIL=1228
check "preflight allows exactly the threshold" "$(cat "${L5}/exit")" "0"

# --- 7. preflight fails CLOSED on unreadable free space ---------------------
# Regression for the fail-open hole: an empty AVAIL_KB makes `[ "" -lt N ]`
# return 2, which `set -e` does not catch inside an `if`, so the guard would
# silently pass. Header-only df output reproduces that exactly.
STAGE5="${SANDBOX}/stage-broken-df"; mkdir -p "$STAGE5"
L6="${SANDBOX}/run6"
run_backup "$L6" MUNIN_BACKUP_STAGING="$STAGE5" FORCE_DF_BROKEN=1

rc6="$(cat "${L6}/exit")"
if [ "$rc6" != "0" ]; then ok "unparseable df output fails CLOSED (exit $rc6)"
else bad "unparseable df output fails CLOSED (exited 0 — guard silently skipped)"; fi

check "no snapshot written when free space is unreadable" \
      "$(find "$STAGE5" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"

echo
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
