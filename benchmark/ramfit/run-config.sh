#!/usr/bin/env bash
# run-config.sh — host-side runner for RAM-fit measurement using systemd-run user scopes.
# No Docker required. Appends one JSON result line per config to the results file.
#
# Matrix (baseline2 — 9 configs):
#   dtype: fp32, q8
#   cap:   512m, 320m
#   mode:  query, write (batch=4)
#   plus:  fp32/320m/write/batch=25 (historical hog)
#
# Usage: bash benchmark/ramfit/run-config.sh [--output <file>]
#
# Requirements:
#   - systemd user slice with memory controller delegated
#   - XDG_RUNTIME_DIR set (handled below)
#   - Node.js 22+ on PATH (Node 24 preferred; nvm is used when available)

set -euo pipefail

RESULTS_DIR="${HOME}/munin-ramfit/results"
HF_CACHE="${HOME}/munin-ramfit/hf-cache"
SNAPSHOT="${HOME}/munin-ramfit/snapshot/memory.db"
RESULTS_FILE="${RESULTS_DIR}/baseline2.jsonl"
REPO_DIR="${HOME}/munin-ramfit/repo"

# Allow override via --output flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) RESULTS_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Node path via nvm ────────────────────────────────────────────────────────
export NVM_DIR="${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "${NVM_DIR}/nvm.sh" ] && . "${NVM_DIR}/nvm.sh"
if command -v nvm >/dev/null 2>&1; then
  nvm use 24 --silent >/dev/null 2>&1 || true
fi
NODE_BIN=$(command -v node || true)
if [[ -z "${NODE_BIN}" ]]; then
  echo "[run-config] Node.js 22 or newer is required (Node 24 preferred); no node executable was found." >&2
  exit 1
fi
NODE_MAJOR=$("${NODE_BIN}" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ || "${NODE_MAJOR}" -lt 22 ]]; then
  echo "[run-config] Node.js 22 or newer is required (Node 24 preferred); found $("${NODE_BIN}" --version 2>/dev/null || echo unknown)." >&2
  exit 1
fi
mkdir -p "${RESULTS_DIR}" "${HF_CACHE}"
echo "[run-config] node: $("${NODE_BIN}" --version) at ${NODE_BIN}"

# ── systemd-run setup ────────────────────────────────────────────────────────
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# ── Run one config ────────────────────────────────────────────────────────────
run_one() {
  local CAP="${1}"
  local DTYPE="${2}"
  local MODE="${3}"        # query | write
  local BATCH_SIZE="${4}"  # e.g. 4 or 25
  local TMPOUT
  TMPOUT=$(mktemp)
  local EXIT_CODE=0

  echo "[run-config] Starting: cap=${CAP} dtype=${DTYPE} mode=${MODE} batch=${BATCH_SIZE}"

  # Build env vars for this run
  local DTYPE_ENV=""
  if [[ "${DTYPE}" != "fp32" && -n "${DTYPE}" ]]; then
    DTYPE_ENV="MUNIN_EMBEDDINGS_DTYPE=${DTYPE}"
  fi

  systemd-run --user --scope --quiet \
    -p "MemoryMax=${CAP}" \
    -p "MemorySwapMax=0" \
    env \
      MUNIN_MEMORY_DB_PATH="${SNAPSHOT}" \
      MUNIN_EMBEDDINGS_MODEL="Xenova/all-MiniLM-L6-v2" \
      MUNIN_EMBEDDINGS_ENABLED=true \
      MUNIN_SEMANTIC_ENABLED=true \
      MUNIN_HYBRID_ENABLED=true \
      MUNIN_EMBEDDINGS_BATCH_SIZE="${BATCH_SIZE}" \
      OMP_NUM_THREADS=2 \
      MUNIN_SQLITE_CACHE_KIB=4096 \
      MUNIN_SQLITE_MMAP_BYTES=0 \
      TRANSFORMERS_CACHE="${HF_CACHE}" \
      MODE="${MODE}" \
      ${DTYPE_ENV} \
    "${NODE_BIN}" "${REPO_DIR}/benchmark/ramfit/measure.mjs" \
    > "${TMPOUT}" 2>/dev/null || EXIT_CODE=$?

  # OOM: systemd OOM-kills scope → exit 137 (SIGKILL) or non-zero with no JSON output
  local RESULT
  RESULT=$(tail -1 "${TMPOUT}" 2>/dev/null || true)

  local IS_OOM=false
  if [[ ${EXIT_CODE} -eq 137 ]]; then
    IS_OOM=true
  elif [[ ${EXIT_CODE} -ne 0 && ${EXIT_CODE} -ne 2 && -z "${RESULT}" ]]; then
    IS_OOM=true
  fi

  if ${IS_OOM}; then
    echo "[run-config] OOM-killed (exit ${EXIT_CODE}) — cap=${CAP} dtype=${DTYPE} mode=${MODE}"
    local OOM_LINE
    OOM_LINE=$(python3 -c "
import json
print(json.dumps({
  'oom': True, 'cap': '${CAP}', 'dtype': '${DTYPE}', 'mode': '${MODE}',
  'batch': ${BATCH_SIZE}, 'model': 'Xenova/all-MiniLM-L6-v2',
  'peak_rss_mb': None, 'queries_run': 0,
  'semantic_p50_ms': None, 'hybrid_p50_ms': None,
  'vec_loaded': None, 'batch_embedded': None,
  'errors': ['OOM-killed by cgroup'],
}))
")
    echo "${OOM_LINE}" | tee -a "${RESULTS_FILE}"
  elif [[ ${EXIT_CODE} -ne 0 && ${EXIT_CODE} -ne 2 ]]; then
    echo "[run-config] non-zero exit (${EXIT_CODE}) — cap=${CAP} dtype=${DTYPE} mode=${MODE}"
    local ERR_LINE
    ERR_LINE=$(python3 -c "
import json
print(json.dumps({
  'error': True, 'cap': '${CAP}', 'dtype': '${DTYPE}', 'mode': '${MODE}',
  'batch': ${BATCH_SIZE}, 'exit_code': ${EXIT_CODE},
}))
")
    echo "${ERR_LINE}" | tee -a "${RESULTS_FILE}"
    cat "${TMPOUT}" >&2
  else
    if [[ -z "${RESULT}" ]]; then
      echo "[run-config] no output from measure.mjs" >&2
      cat "${TMPOUT}" >&2
    else
      # Inject _cap, oom=false into result JSON
      local RESULT_WITH_META
      RESULT_WITH_META=$(echo "${RESULT}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
d['_cap']='${CAP}'
d['oom']=False
print(json.dumps(d))
")
      echo "${RESULT_WITH_META}" | tee -a "${RESULTS_FILE}"
    fi
  fi

  rm -f "${TMPOUT}"
  echo "[run-config] Done: cap=${CAP} dtype=${DTYPE} mode=${MODE}"
  echo "---"
}

# ── Baseline2 matrix — 9 configs, serial ─────────────────────────────────────
# #  DTYPE  CAP    MODE   BATCH
run_one "512M"  "fp32" "query" "25"   # 1
run_one "320M"  "fp32" "query" "25"   # 2
run_one "512M"  "q8"   "query" "25"   # 3
run_one "320M"  "q8"   "query" "25"   # 4
run_one "512M"  "fp32" "write" "4"    # 5
run_one "320M"  "fp32" "write" "4"    # 6
run_one "512M"  "q8"   "write" "4"    # 7
run_one "320M"  "q8"   "write" "4"    # 8
run_one "320M"  "fp32" "write" "25"   # 9 — historical hog

echo "[run-config] All 9 runs complete. Results in ${RESULTS_FILE}"
