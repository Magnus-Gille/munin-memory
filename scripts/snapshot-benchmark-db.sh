#!/usr/bin/env bash
# Create a consistent SQLite snapshot for local benchmark evaluation.
#
# The source may contain personal memory. Snapshots and manifests are ignored by
# Git, but callers are still responsible for using synthetic or reviewed data.
#
# Usage: ./scripts/snapshot-benchmark-db.sh /path/to/source.db [output-dir]

set -euo pipefail

DB_PATH="${1:?Usage: $0 /path/to/source.db [output-dir]}"
OUTPUT_DIR="${2:-benchmark/fixtures}"

if [ ! -f "$DB_PATH" ]; then
  echo "Error: database not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
SNAPSHOT_DATE=$(date -u +%Y-%m-%d)
SNAPSHOT_PATH="$OUTPUT_DIR/memory-snapshot-$SNAPSHOT_DATE.db"

echo "Creating sensitive local benchmark snapshot..."
echo "  Source: $DB_PATH"
echo "  Destination: $SNAPSHOT_PATH"
sqlite3 "$DB_PATH" ".backup '$SNAPSHOT_PATH'"

ENTRY_COUNT=$(sqlite3 "$SNAPSHOT_PATH" "SELECT COUNT(*) FROM entries;")
SCHEMA_VERSION=$(sqlite3 "$SNAPSHOT_PATH" "SELECT MAX(version) FROM schema_version;")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')

printf '{\n  "snapshot_date": "%s",\n  "snapshot_file": "%s",\n  "entry_count": %s,\n  "schema_version": %s,\n  "git_commit": "%s"\n}\n' \
  "$SNAPSHOT_DATE" "$(basename "$SNAPSHOT_PATH")" "$ENTRY_COUNT" "$SCHEMA_VERSION" "$COMMIT" \
  > "$OUTPUT_DIR/manifest.json"

echo "  Entries: $ENTRY_COUNT"
echo "  Schema: v$SCHEMA_VERSION"
echo "  Manifest: $OUTPUT_DIR/manifest.json"
echo "  WARNING: do not commit or share this snapshot without reviewing its contents."
