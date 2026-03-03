#!/usr/bin/env bash
set -euo pipefail

# Usage: ./deploy-rpi.sh <pi-hostname-or-ip> [--bridge-only|--server-only]
#
# Deploys munin-memory to a Raspberry Pi. Two components:
#   - Server: systemd HTTP service (for local/network MCP access)
#   - Bridge: stdio-to-HTTP proxy for Claude Code (connects to remote server)
#
# By default, deploys both. Use flags to deploy only one.

resolve_host() {
  local input="$1"
  # If user gave an explicit IP or non-.local name, use it directly
  if [[ "$input" != *.local ]]; then
    echo "$input"
    return
  fi
  # Try mDNS (.local) first — fastest on LAN
  if ssh -o ConnectTimeout=2 -o BatchMode=yes "${USER}@${input}" true &>/dev/null; then
    echo "$input"
    return
  fi
  # Fall back to Tailscale MagicDNS (strip .local)
  local bare="${input%.local}"
  if ssh -o ConnectTimeout=5 -o BatchMode=yes "${USER}@${bare}" true &>/dev/null; then
    echo >&2 "Note: $input not reachable, using Tailscale ($bare)"
    echo "$bare"
    return
  fi
  echo >&2 "Error: Cannot reach $input or $bare"
  exit 1
}

HOST=$(resolve_host "${1:?Usage: $0 <pi-hostname-or-ip> [--bridge-only|--server-only]}")
MODE="${2:-both}"
USER="${DEPLOY_USER:-$(whoami)}"
REMOTE_DIR="/home/${USER}/munin-memory"

echo "==> Building locally..."
npm run build

echo "==> Syncing to ${USER}@${HOST}:${REMOTE_DIR}..."
rsync -avz --exclude node_modules --exclude .env --exclude .git \
  ./ "${USER}@${HOST}:${REMOTE_DIR}/"

echo "==> Installing dependencies on Pi (compiles native modules for ARM64)..."
ssh "${USER}@${HOST}" "cd ${REMOTE_DIR} && npm install --production"

# --- Server deployment ---

if [[ "$MODE" != "--bridge-only" ]]; then
  echo "==> Installing systemd service..."
  ssh "${USER}@${HOST}" "sudo cp ${REMOTE_DIR}/munin-memory.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable munin-memory"

  echo "==> Checking for .env file..."
  ssh "${USER}@${HOST}" "test -f ${REMOTE_DIR}/.env || (echo 'WARNING: No .env file found at ${REMOTE_DIR}/.env — create one with MUNIN_API_KEY=<key>' && exit 1)"

  echo "==> Restarting service..."
  ssh "${USER}@${HOST}" "sudo systemctl restart munin-memory"
  sleep 2
  ssh "${USER}@${HOST}" "sudo systemctl status munin-memory --no-pager"

  echo ""
  echo "Server running at http://${HOST}:3030"
  echo "Health check: curl http://${HOST}:3030/health"
fi

# --- Bridge configuration for Claude Code ---

if [[ "$MODE" != "--server-only" ]]; then
  echo ""
  echo "==> Configuring MCP bridge for Claude Code on Pi..."

  # Check if Claude Code is installed
  if ! ssh "${USER}@${HOST}" "command -v claude &>/dev/null"; then
    echo "WARNING: 'claude' CLI not found on Pi. Install Claude Code first, then run:"
    echo "  claude mcp add-json munin-memory '<config>' -s user"
    echo ""
    echo "Config JSON:"
    cat <<'CONFIGEOF'
{"type":"stdio","command":"node","args":["/home/<user>/munin-memory/dist/bridge.js"],"env":{"MUNIN_REMOTE_URL":"https://<your-domain>/mcp","MUNIN_AUTH_TOKEN":"<your-token>","MUNIN_REQUEST_TIMEOUT_MS":"60000"}}
CONFIGEOF
  else
    # Read auth credentials from local config if available
    BRIDGE_CONFIG=$(python3 -c "
import json, os
with open(os.path.expanduser('~/.claude.json')) as f:
    d = json.load(f)
ms = d.get('mcpServers', {}).get('munin-memory', {})
env = ms.get('env', {})
# Rewrite path for Pi
config = {
    'type': 'stdio',
    'command': 'node',
    'args': ['${REMOTE_DIR}/dist/bridge.js'],
    'env': env
}
print(json.dumps(config))
" 2>/dev/null) || true

    if [[ -n "$BRIDGE_CONFIG" ]]; then
      echo "  Registering munin-memory MCP server on Pi..."
      ssh "${USER}@${HOST}" "claude mcp remove munin-memory -s user 2>/dev/null; claude mcp add-json munin-memory '${BRIDGE_CONFIG}' -s user"
      echo "  Done — bridge configured for Claude Code on Pi"
    else
      echo "WARNING: Could not read local MCP config. Configure manually on Pi:"
      echo "  claude mcp add-json munin-memory '<config>' -s user"
    fi
  fi
fi

echo ""
echo "Deploy complete!"
