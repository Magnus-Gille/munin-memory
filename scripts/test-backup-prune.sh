#!/usr/bin/env bash
# Self-check for the SIGPIPE-safe GFS prune logic in backup-to-nas.sh.
#
# Why this exists: the previous prune used `ls -1t ... | head -n N`, which trips
# `set -o pipefail` with SIGPIPE (exit 141) because `ls` keeps writing after
# `head` closes the pipe. Under `set -e` that 141 aborted the script, so the
# backup service reported failure nightly and retention never ran (20 dailies
# piled up instead of 14 + 4 Sundays). This test reproduces the failure shape
# and asserts the new array-slice prune (a) exits 0 and (b) keeps EXACTLY the
# 14 newest dailies UNION the 4 newest Sundays — not just ">= 14".
#
# Run: bash scripts/test-backup-prune.sh   (no NAS, no SSH — pure local fixture)
set -euo pipefail

# ── Portable date helper ──────────────────────────────────────────────────────
# Try GNU date first (Linux/Pi production), fall back to BSD date (macOS dev).
# If neither works, emit an explicit skip rather than silently passing.
portable_date_minus() {
    local anchor="$1" n="$2"
    date -u -d "$anchor -${n} days" +%Y-%m-%d 2>/dev/null \
        || date -u -j -v-"${n}"d -f "%Y-%m-%d" "$anchor" +%Y-%m-%d 2>/dev/null \
        || { echo "SKIP: neither GNU nor BSD date is available" >&2; exit 77; }
}

# Emits the ISO weekday (1=Mon … 7=Sun) for a given YYYY-MM-DD.
portable_dow() {
    local d="$1"
    date -d "$d" +%u 2>/dev/null \
        || date -j -f "%Y-%m-%d" "$d" +%u 2>/dev/null \
        || { echo "SKIP: neither GNU nor BSD date is available — cannot determine weekday" >&2; exit 77; }
}

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
        # Portable weekday detection: try GNU date, fall back to BSD date.
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
}

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── Fixture: 40 consecutive daily snapshots ending 2026-06-18 (a Thursday).
#    mtime set so `ls -1t` orders them newest-first deterministically. ─────────
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ANCHOR="2026-06-18"

# Build 40 days back from the anchor using the portable helper.
for i in $(seq 0 39); do
    day=$(portable_date_minus "$ANCHOR" "$i")
    f="$tmp/memory-${day}-0300.db"
    : > "$f"
    # Older files get older mtimes so `ls -t` is deterministic (newest = i=0).
    touch -d "$ANCHOR -${i} days" "$f" 2>/dev/null \
        || touch -t "$(date -u -j -v-"${i}"d -f '%Y-%m-%d' "$ANCHOR" +%Y%m%d0300)" "$f"
done

total_before=$(ls -1 "$tmp"/memory-*.db | wc -l | tr -d ' ')
[ "$total_before" = "40" ] || fail "fixture should have 40 files, got $total_before"

# ── Run the prune; assert it does NOT trip SIGPIPE / pipefail. ───────────────
rc=0
prune_dir "$tmp" || rc=$?
[ "$rc" = "0" ] || fail "prune exited non-zero (rc=$rc) — SIGPIPE/pipefail regression"

# ── Compute the EXACT expected keep-set from the fixture dates. ────────────────
# Rule: keep = (14 newest dailies) UNION (4 newest Sundays across all 40 days).
# Use a temp file as a portable set (bash 3 compatible — no associative arrays).
expected=$(mktemp)
trap 'rm -f "$expected"' EXIT

# 14 newest dailies (i=0..13)
for i in $(seq 0 13); do
    day=$(portable_date_minus "$ANCHOR" "$i")
    printf '%s\n' "memory-${day}-0300.db" >> "$expected"
done

# 4 newest Sundays across the full 40-day range (may overlap with top-14)
sun_count=0
for i in $(seq 0 39); do
    [ "$sun_count" -ge 4 ] && break
    day=$(portable_date_minus "$ANCHOR" "$i")
    dow=$(portable_dow "$day")
    if [ "$dow" = "7" ]; then
        printf '%s\n' "memory-${day}-0300.db" >> "$expected"
        sun_count=$((sun_count + 1))
    fi
done

# Deduplicate and sort the expected set.
expected_sorted=$(sort -u "$expected")
expected_total=$(printf '%s\n' "$expected_sorted" | wc -l | tr -d ' ')

# ── Assert: every expected file is present, nothing extra survived. ────────────
remaining=$(ls -1 "$tmp"/memory-*.db | wc -l | tr -d ' ')

# 1. Every file in the expected set must exist.
while IFS= read -r fname; do
    [ -e "$tmp/$fname" ] || fail "expected file $fname was wrongly pruned"
done <<< "$expected_sorted"

# 2. No extra files survived (exact match — checks Sunday retention regression).
for f in "$tmp"/memory-*.db; do
    fname=$(basename "$f")
    if ! printf '%s\n' "$expected_sorted" | grep -qxF "$fname"; then
        fail "unexpected file survived pruning: $fname"
    fi
done

# 3. Sanity: remaining count matches computed expected total.
[ "$remaining" = "$expected_total" ] \
    || fail "remaining count $remaining != expected $expected_total"

# 4. Pruning actually removed something (40 > expected).
[ "$expected_total" -lt 40 ] || fail "expected_total=$expected_total — fixture has no files to prune (logic error)"

echo "PASS: prune exits 0 (no SIGPIPE), keeps exactly $expected_total files (14 dailies UNION ${sun_count} Sundays); pruned $((40 - expected_total))/40"
