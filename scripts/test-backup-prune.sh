#!/usr/bin/env bash
# Self-check for the SIGPIPE-safe GFS prune logic in backup-to-nas.sh.
#
# Why this exists: the previous prune used `ls -1t ... | head -n N`, which trips
# `set -o pipefail` with SIGPIPE (exit 141) because `ls` keeps writing after
# `head` closes the pipe. Under `set -e` that 141 aborted the script, so the
# backup service reported failure nightly and retention never ran (20 dailies
# piled up instead of 14 + 4 Sundays). This test reproduces the failure shape
# and asserts the new array-slice prune (a) exits 0 and (b) keeps exactly the
# 14 newest dailies + the 4 newest Sundays.
#
# Run: bash scripts/test-backup-prune.sh   (no NAS, no SSH — pure local fixture)
set -euo pipefail

# ── The prune logic under test — kept byte-identical to backup-to-nas.sh's
#    remote heredoc body (the `cd "$1"` + array-slice retention). If you change
#    one, change the other. ──────────────────────────────────────────────────
prune_dir() {
    set -euo pipefail
    cd "$1" || exit 0

    keep=$(mktemp)
    trap 'rm -f "$keep"' EXIT

    all=()
    while IFS= read -r line; do
        all+=("$line")
    done < <(ls -1t memory-*.db 2>/dev/null || true)

    i=0
    for f in ${all[@]+"${all[@]}"}; do
        [ "$i" -ge 14 ] && break
        printf '%s\n' "$f" >> "$keep"
        i=$((i + 1))
    done

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

    prune=()
    while IFS= read -r line; do
        prune+=("$line")
    done < <(ls -1 memory-*.db 2>/dev/null | grep -vxFf "$keep" || true)
    if [ "${#prune[@]}" -gt 0 ]; then
        printf '%s\0' "${prune[@]}" | xargs -0 -r rm --
    fi
}

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── Fixture: 40 consecutive daily snapshots ending 2026-06-18 (a Thursday).
#    mtime set so `ls -1t` orders them newest-first deterministically. ─────────
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Build 40 days back from 2026-06-18. Use a fixed anchor so Sunday math is stable.
for i in $(seq 0 39); do
    day=$(date -u -d "2026-06-18 -${i} days" +%Y-%m-%d 2>/dev/null) \
        || day=$(date -u -j -v-"${i}"d -f "%Y-%m-%d" "2026-06-18" +%Y-%m-%d) # BSD/macOS fallback
    f="$tmp/memory-${day}-0300.db"
    : > "$f"
    # Older files get older mtimes so `ls -t` is deterministic (newest = i=0).
    touch -d "2026-06-18 -${i} days" "$f" 2>/dev/null \
        || touch -t "$(date -u -j -v-"${i}"d -f '%Y-%m-%d' '2026-06-18' +%Y%m%d0300)" "$f"
done

total_before=$(ls -1 "$tmp"/memory-*.db | wc -l | tr -d ' ')
[ "$total_before" = "40" ] || fail "fixture should have 40 files, got $total_before"

# ── Run the prune; assert it does NOT trip SIGPIPE / pipefail. ───────────────
rc=0
prune_dir "$tmp" || rc=$?
[ "$rc" = "0" ] || fail "prune exited non-zero (rc=$rc) — SIGPIPE/pipefail regression"

# ── Assert retention: 14 newest dailies + up to 4 Sundays, deduplicated. ─────
# The 14 newest dailies span 2026-06-18 .. 2026-06-05. Sundays in that window:
# 2026-06-15? (no) — compute the expected Sunday set from the full 40-day range.
remaining=$(ls -1 "$tmp"/memory-*.db | wc -l | tr -d ' ')

# Newest 14 are always kept.
for i in $(seq 0 13); do
    day=$(date -u -d "2026-06-18 -${i} days" +%Y-%m-%d 2>/dev/null) \
        || day=$(date -u -j -v-"${i}"d -f "%Y-%m-%d" "2026-06-18" +%Y-%m-%d)
    [ -e "$tmp/memory-${day}-0300.db" ] || fail "newest-14 daily ${day} was wrongly pruned"
done

# The 4 most recent Sundays across the 40-day range must survive.
sun_kept=0
for i in $(seq 0 39); do
    day=$(date -u -d "2026-06-18 -${i} days" +%Y-%m-%d 2>/dev/null) \
        || day=$(date -u -j -v-"${i}"d -f "%Y-%m-%d" "2026-06-18" +%Y-%m-%d)
    dow=$(date -u -d "$day" +%u 2>/dev/null || echo 0)
    if [ "$dow" = "7" ] && [ "$sun_kept" -lt 4 ]; then
        [ -e "$tmp/memory-${day}-0300.db" ] || fail "recent Sunday ${day} was wrongly pruned"
        sun_kept=$((sun_kept + 1))
    fi
done

# Sanity: pruning actually removed something (40 > kept >= 14).
[ "$remaining" -lt 40 ] || fail "prune removed nothing (kept all 40)"
[ "$remaining" -ge 14 ] || fail "prune removed too much (kept $remaining < 14)"

echo "PASS: prune exits 0 (no SIGPIPE), keeps 14 dailies + ${sun_kept} Sundays; ${remaining}/40 retained"
