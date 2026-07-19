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
  if ssh -o ConnectTimeout=2 -o BatchMode=yes "${DEPLOY_ACCOUNT}@${input}" true &>/dev/null; then
    echo "$input"
    return
  fi
  # Fall back to Tailscale MagicDNS (strip .local)
  local bare="${input%.local}"
  if ssh -o ConnectTimeout=5 -o BatchMode=yes "${DEPLOY_ACCOUNT}@${bare}" true &>/dev/null; then
    echo >&2 "Note: $input not reachable, using Tailscale ($bare)"
    echo "$bare"
    return
  fi
  echo >&2 "Error: Cannot reach $input or $bare"
  exit 1
}

DEPLOY_ACCOUNT="${DEPLOY_USER:-$(id -un)}"
case "$DEPLOY_ACCOUNT" in
  ''|*[!a-zA-Z0-9._-]*) echo "Error: DEPLOY_USER contains unsupported characters" >&2; exit 1 ;;
esac
HOST=$(resolve_host "${1:?Usage: $0 <pi-hostname-or-ip> [--bridge-only|--server-only]}")
MODE="${2:-both}"
REMOTE_DIR="/home/${DEPLOY_ACCOUNT}/munin-memory"

# The deploy target must be a pure artifact. Refuse before rsync so an existing
# checkout is never partially overwritten or cleaned up automatically.
echo "==> Verifying deploy target carries no git metadata..."
ssh "${DEPLOY_ACCOUNT}@${HOST}" "test ! -e '${REMOTE_DIR}/.git' || { echo 'ERROR: deploy target contains .git; choose a clean artifact directory' >&2; exit 1; }"

echo "==> Building locally..."
npm run build

echo "==> Syncing to ${DEPLOY_ACCOUNT}@${HOST}:${REMOTE_DIR}..."
rsync -avz \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  --exclude .codex \
  --exclude .claude \
  --exclude AGENTS.md \
  --exclude STATUS.md \
  --exclude 'benchmark/data/raw/' \
  --exclude 'benchmark/data/cache/' \
  --exclude 'benchmark/generated/' \
  --exclude 'benchmark/footprint-calculator/' \
  --exclude 'benchmark/reports/' \
  ./ "${DEPLOY_ACCOUNT}@${HOST}:${REMOTE_DIR}/"

echo "==> Installing dependencies on Pi (compiles native modules for ARM64)..."
ssh "${DEPLOY_ACCOUNT}@${HOST}" "cd '${REMOTE_DIR}' && npm ci --omit=dev"

# --- Server deployment ---

if [[ "$MODE" != "--bridge-only" ]]; then
  echo "==> Installing systemd service..."
  ssh "${DEPLOY_ACCOUNT}@${HOST}" "sed -e 's|<user>|${DEPLOY_ACCOUNT}|g' -e 's|<install-dir>|munin-memory|g' '${REMOTE_DIR}/munin-memory.service' | sudo tee /etc/systemd/system/munin-memory.service > /dev/null && sudo systemctl daemon-reload && sudo systemctl enable munin-memory"

  echo "==> Checking for .env file..."
  ssh "${DEPLOY_ACCOUNT}@${HOST}" "test -f '${REMOTE_DIR}/.env' || (echo 'WARNING: No .env file found at ${REMOTE_DIR}/.env — create one with MUNIN_API_KEY=<key>' && exit 1)"

  echo "==> Restarting service..."
  ssh "${DEPLOY_ACCOUNT}@${HOST}" "sudo systemctl restart munin-memory"
  sleep 2
  ssh "${DEPLOY_ACCOUNT}@${HOST}" "sudo systemctl status munin-memory --no-pager"

  echo ""
  echo "Server running at http://${HOST}:3030"
  echo "Health check: curl http://${HOST}:3030/health"
fi

# --- Bridge configuration for Claude Code ---

PI_CREDS_PATH="/home/${DEPLOY_ACCOUNT}/.config/munin/credentials.json"

sync_credentials_file() {
  local local_path="$1"
  # Expand a leading ~ on the local side
  local_path="${local_path/#\~/$HOME}"
  if [[ ! -r "$local_path" ]]; then
    echo "  WARNING: MUNIN_CREDENTIALS_FILE=${local_path} is not readable locally; skipping sync"
    return 1
  fi
  echo "  Syncing credentials file to ${HOST}:${PI_CREDS_PATH} (chmod 600)"
  ssh "${DEPLOY_ACCOUNT}@${HOST}" "mkdir -p '$(dirname "${PI_CREDS_PATH}")' && chmod 700 '$(dirname "${PI_CREDS_PATH}")'"
  scp -q "$local_path" "${DEPLOY_ACCOUNT}@${HOST}:${PI_CREDS_PATH}"
  ssh "${DEPLOY_ACCOUNT}@${HOST}" "chmod 600 '${PI_CREDS_PATH}'"
  return 0
}

if [[ "$MODE" != "--server-only" ]]; then
  echo ""
  echo "==> Configuring MCP bridge for Claude Code on Pi..."

  # Check if Claude Code is installed
  if ! ssh "${DEPLOY_ACCOUNT}@${HOST}" "command -v claude &>/dev/null"; then
    echo "WARNING: 'claude' CLI not found on Pi. Install Claude Code first, then:"
    echo "  1. Create ${PI_CREDS_PATH} (chmod 600) with keys auth_token / cf_client_id / cf_client_secret"
    echo "  2. Register the bridge:"
    echo "     claude mcp add-json munin-memory '<config>' -s user"
    echo ""
    echo "Config JSON (preferred — credentials in a chmod 600 file):"
    cat <<CONFIGEOF
{"type":"stdio","command":"node","args":["${REMOTE_DIR}/dist/bridge.js"],"env":{"MUNIN_REMOTE_URL":"https://<your-domain>/mcp","MUNIN_CREDENTIALS_FILE":"${PI_CREDS_PATH}","MUNIN_REQUEST_TIMEOUT_MS":"60000"}}
CONFIGEOF
    echo ""
    echo "Fallback (less secure — inline plaintext token in MCP client config):"
    cat <<CONFIGEOF
{"type":"stdio","command":"node","args":["${REMOTE_DIR}/dist/bridge.js"],"env":{"MUNIN_REMOTE_URL":"https://<your-domain>/mcp","MUNIN_AUTH_TOKEN":"<your-token>","MUNIN_REQUEST_TIMEOUT_MS":"60000"}}
CONFIGEOF
  else
    # Read auth credentials from local config if available. If the local
    # config references MUNIN_CREDENTIALS_FILE, sync the file to the Pi and
    # rewrite the env value to the Pi-local path. Otherwise, copy the env
    # block verbatim.
    LOCAL_CREDS_PATH=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('~/.claude.json')) as f:
        d = json.load(f)
    env = d.get('mcpServers', {}).get('munin-memory', {}).get('env', {})
    print(env.get('MUNIN_CREDENTIALS_FILE', ''))
except Exception:
    pass
" 2>/dev/null) || true

    CREDS_SYNCED=false
    if [[ -n "$LOCAL_CREDS_PATH" ]]; then
      if sync_credentials_file "$LOCAL_CREDS_PATH"; then
        CREDS_SYNCED=true
      fi
    fi

    BRIDGE_CONFIG=$(CREDS_SYNCED="$CREDS_SYNCED" PI_CREDS_PATH="$PI_CREDS_PATH" REMOTE_DIR="$REMOTE_DIR" python3 -c "
import json, os
with open(os.path.expanduser('~/.claude.json')) as f:
    d = json.load(f)
ms = d.get('mcpServers', {}).get('munin-memory', {})
env = dict(ms.get('env', {}))
creds_synced = os.environ.get('CREDS_SYNCED') == 'true'
pi_creds_path = os.environ.get('PI_CREDS_PATH', '')
if creds_synced and env.get('MUNIN_CREDENTIALS_FILE'):
    env['MUNIN_CREDENTIALS_FILE'] = pi_creds_path
elif env.get('MUNIN_CREDENTIALS_FILE'):
    # Strip an unsynced workstation-local path so the Pi bridge does not
    # start up pointing at a non-existent file.
    env.pop('MUNIN_CREDENTIALS_FILE', None)
config = {
    'type': 'stdio',
    'command': 'node',
    'args': [os.environ.get('REMOTE_DIR', '') + '/dist/bridge.js'],
    'env': env,
}
print(json.dumps(config))
" 2>/dev/null) || true

    if [[ -n "$BRIDGE_CONFIG" ]]; then
      echo "  Registering munin-memory MCP server on Pi..."
      ssh "${DEPLOY_ACCOUNT}@${HOST}" "claude mcp remove munin-memory -s user 2>/dev/null; claude mcp add-json munin-memory '${BRIDGE_CONFIG}' -s user"
      echo "  Done — bridge configured for Claude Code on Pi"
    else
      echo "WARNING: Could not read local MCP config. Configure manually on Pi:"
      echo "  claude mcp add-json munin-memory '<config>' -s user"
    fi
  fi
fi

echo ""
echo "Deploy complete!"
