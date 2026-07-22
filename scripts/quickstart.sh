#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
START_SECONDS="$(date +%s)"

fail() {
  printf 'Quick start preflight failed: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "supported platforms are macOS and Linux" ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js 20+ is required (found $(node --version))"
fi

cd "$PROJECT_ROOT"
if [[ "${MUNIN_QUICKSTART_SKIP_INSTALL:-0}" != "1" ]]; then
  npm ci >&2
fi
npm run build >&2

INSTALL_SECONDS="$(( $(date +%s) - START_SECONDS ))"
export MUNIN_QUICKSTART_INSTALL_MS="$(( INSTALL_SECONDS * 1000 ))"
exec node "$PROJECT_ROOT/dist/quickstart-cli.js" --project-root "$PROJECT_ROOT" "$@"
