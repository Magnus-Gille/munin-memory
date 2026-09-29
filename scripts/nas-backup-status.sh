#!/usr/bin/env bash
set -euo pipefail

# Publish the NAS backup's small, deliberately generic status payload. Keep the
# service/panel/messages fixed so a filename, path, command error, or other
# private detail can never reach the dashboard.
case "${1:-}" in
  pass)
    STATE='pass'
    MESSAGE='NAS backup completed successfully'
    ;;
  fail)
    STATE='fail'
    MESSAGE='NAS backup failed'
    ;;
  *)
    echo "usage: $0 pass|fail" >&2
    exit 64
    ;;
esac

# The status channel is optional and best effort. In particular, an unavailable
# hub must never turn a completed backup into a failed backup (or mask its
# original failure). Do not put the bearer token in curl's argv: the header is
# supplied through a process-substitution fd instead.
if [ -z "${HEIMDALL_HUB_URL:-}" ] || [ -z "${HEIMDALL_FLEET_TOKEN:-}" ]; then
  exit 0
fi

PAYLOAD=$(printf '%s\n' \
  "{\"service\":\"munin\",\"panel\":\"nas-backup\",\"kind\":\"status\",\"label\":\"NAS backup\",\"state\":\"${STATE}\",\"message\":\"${MESSAGE}\"}")

curl -fsS --max-time 5 -X POST \
  --header @<(printf 'Authorization: Bearer %s\n' "${HEIMDALL_FLEET_TOKEN}") \
  -H 'Content-Type: application/json' \
  --data-raw "${PAYLOAD}" \
  "${HEIMDALL_HUB_URL}" \
  >/dev/null 2>&1 || true

exit 0
