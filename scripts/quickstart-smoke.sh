#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/munin-quickstart-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_ROOT"' EXIT

START_SECONDS="$(date +%s)"
MUNIN_QUICKSTART_SKIP_INSTALL=1 \
  "$PROJECT_ROOT/scripts/quickstart.sh" \
  --data-dir "$SMOKE_ROOT/data" \
  --config-dir "$SMOKE_ROOT/config" \
  --json > "$SMOKE_ROOT/result.json"
ELAPSED_SECONDS="$(( $(date +%s) - START_SECONDS ))"

node - "$SMOKE_ROOT/result.json" "$ELAPSED_SECONDS" <<'NODE'
const fs = require("node:fs");
const [reportPath, elapsedRaw] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const elapsed = Number(elapsedRaw);
if (!result.ok) throw new Error("quick-start result was not ok");
if (elapsed >= 300) throw new Error(`quick-start exceeded five minutes: ${elapsed}s`);
if (result.firstSuccess?.steps?.length !== 6) throw new Error("first-success flow was incomplete");
for (const artifact of result.artifacts) {
  const mode = fs.statSync(artifact).mode & 0o077;
  if (mode !== 0) throw new Error(`artifact is not owner-only: ${artifact}`);
}
console.log(`Quick-start clean-environment smoke PASS (${elapsed}s)`);
NODE
