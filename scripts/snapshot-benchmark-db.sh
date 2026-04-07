#!/bin/bash
# Create a consistent SQLite snapshot for benchmark evaluation.
# Usage:
#   ./scripts/snapshot-benchmark-db.sh                    # local DB
#   ./scripts/snapshot-benchmark-db.sh --remote           # pull from Pi (huginmunin)
#   ./scripts/snapshot-benchmark-db.sh /path/to/db        # specific local DB

set -euo pipefail

OUTPUT_DIR="benchmark/fixtures"
REMOTE_HOST="huginmunin"
REMOTE_DB_PATH="/home/magnus/.munin-memory/memory.db"

if [ "${1:-}" = "--remote" ]; then
  mkdir -p "$OUTPUT_DIR"
  DATE=$(date -u +%Y-%m-%d)
  SNAPSHOT_PATH="$OUTPUT_DIR/memory-snapshot-$DATE.db"

  echo "Pulling benchmark snapshot from $REMOTE_HOST..."
  # Create a consistent backup on the Pi, then copy it
  ssh "$REMOTE_HOST" "sqlite3 '$REMOTE_DB_PATH' \".backup '/tmp/munin-benchmark-snapshot.db'\""
  scp "$REMOTE_HOST:/tmp/munin-benchmark-snapshot.db" "$SNAPSHOT_PATH"
  ssh "$REMOTE_HOST" "rm -f /tmp/munin-benchmark-snapshot.db"
  # Record the Pi's deployed commit, not the local checkout
  REMOTE_COMMIT=$(ssh "$REMOTE_HOST" "cd ~/repos/munin-memory && git rev-parse --short HEAD 2>/dev/null || echo 'unknown'")

  echo "  Destination: $SNAPSHOT_PATH"
else
  DB_PATH="${1:-$HOME/.munin-memory/memory.db}"

  if [ ! -f "$DB_PATH" ]; then
    echo "Error: Database not found at $DB_PATH"
    echo "  Use --remote to pull from huginmunin"
    exit 1
  fi

  mkdir -p "$OUTPUT_DIR"
  DATE=$(date -u +%Y-%m-%d)
  SNAPSHOT_PATH="$OUTPUT_DIR/memory-snapshot-$DATE.db"

  echo "Creating benchmark snapshot..."
  echo "  Source: $DB_PATH"
  echo "  Destination: $SNAPSHOT_PATH"

  sqlite3 "$DB_PATH" ".backup '$SNAPSHOT_PATH'"
fi

# Get metadata
ENTRY_COUNT=$(sqlite3 "$SNAPSHOT_PATH" "SELECT COUNT(*) FROM entries;")
SCHEMA_VERSION=$(sqlite3 "$SNAPSHOT_PATH" "SELECT MAX(version) FROM schema_version;")
COMMIT="${REMOTE_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')}"

echo "  Entries: $ENTRY_COUNT"
echo "  Schema: v$SCHEMA_VERSION"
echo "  Commit: $COMMIT"
echo "  Done."

# Write manifest
cat > "$OUTPUT_DIR/manifest.json" <<EOF
{
  "snapshot_date": "$DATE",
  "snapshot_file": "memory-snapshot-$DATE.db",
  "entry_count": $ENTRY_COUNT,
  "schema_version": $SCHEMA_VERSION,
  "git_commit": "$COMMIT"
}
EOF

echo "  Manifest written to $OUTPUT_DIR/manifest.json"
