#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?Usage: $0 <pi-hostname-or-ip>}"
USER="${DEPLOY_USER:-$(whoami)}"
LOCAL_DB="${HOME}/.munin-memory/memory.db"
REMOTE_DIR="/home/${USER}/.munin-memory"

if [ ! -f "${LOCAL_DB}" ]; then
  echo "Error: Local database not found at ${LOCAL_DB}"
  exit 1
fi

echo "==> Creating remote directory..."
ssh "${USER}@${HOST}" "mkdir -p ${REMOTE_DIR}"

echo "==> Copying database to Pi..."
scp "${LOCAL_DB}" "${USER}@${HOST}:${REMOTE_DIR}/memory.db"

echo "==> Setting permissions..."
ssh "${USER}@${HOST}" "chmod 600 ${REMOTE_DIR}/memory.db"

echo "==> Restarting service..."
ssh "${USER}@${HOST}" "sudo systemctl restart munin-memory"

echo ""
echo "Done! Database migrated to ${HOST}:${REMOTE_DIR}/memory.db"
echo "The Pi is now the source of truth. Your local copy at ${LOCAL_DB} is a backup."
