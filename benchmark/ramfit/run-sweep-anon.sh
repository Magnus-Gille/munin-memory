#!/usr/bin/env bash
# run-sweep-anon.sh — RAM-fit matrix runner (peak-anon edition).
#
# Runs measure-anon.mjs under systemd-run --user --scope with MemoryMax/MemorySwapMax=0.
# Primary fit signal: no OOM-kill (exit 137 / no JSON). Primary metric: peak_anon_mb.
#
# One config at a time (serial) — concurrent capped processes corrupt peak readings.
# Appends one JSON line per run to the results file (default sweep-ram.jsonl).

set -uo pipefail

RESULTS_DIR="${HOME}/munin-ramfit/results"
HF_CACHE="${HOME}/munin-ramfit/hf-cache"
SNAPSHOT="${HOME}/munin-ramfit/snapshot/memory.db"
RESULTS_FILE="${RESULTS_DIR}/sweep-ram.jsonl"
REPO_DIR="${HOME}/munin-ramfit/repo"

mkdir -p "${RESULTS_DIR}"

export NVM_DIR="${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "${NVM_DIR}/nvm.sh" ] && . "${NVM_DIR}/nvm.sh"
nvm use 20 --silent 2>/dev/null || true
NODE_BIN=$(command -v node)
echo "[sweep] node: $(${NODE_BIN} --version) at ${NODE_BIN}" >&2

export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# run_one <label> <cap> <KEY=VAL ...knobs>
# Knobs are passed straight to the spawned process env.
run_one() {
  local LABEL="$1"; shift
  local CAP="$1"; shift
  local KNOBS=("$@")
  local TMPOUT EXIT_CODE=0
  TMPOUT=$(mktemp)

  echo "[sweep] >>> ${LABEL} @${CAP} :: ${KNOBS[*]}" >&2

  systemd-run --user --scope --quiet \
    -p "MemoryMax=${CAP}" \
    -p "MemorySwapMax=0" \
    env \
      MUNIN_MEMORY_DB_PATH="${SNAPSHOT}" \
      MUNIN_EMBEDDINGS_ENABLED=true \
      MUNIN_SEMANTIC_ENABLED=true \
      MUNIN_HYBRID_ENABLED=true \
      MUNIN_EMBEDDINGS_LOCAL_ONLY=true \
      TRANSFORMERS_CACHE="${HF_CACHE}" \
      HF_HUB_OFFLINE=1 \
      TRANSFORMERS_OFFLINE=1 \
      "${KNOBS[@]}" \
    "${NODE_BIN}" "${REPO_DIR}/benchmark/ramfit/measure-anon.mjs" \
    > "${TMPOUT}" 2>/dev/null || EXIT_CODE=$?

  local RESULT
  RESULT=$(tail -1 "${TMPOUT}" 2>/dev/null || true)

  local IS_OOM=false
  if [[ ${EXIT_CODE} -eq 137 ]]; then
    IS_OOM=true
  elif [[ ${EXIT_CODE} -ne 0 && -z "${RESULT}" ]]; then
    IS_OOM=true
  fi

  local LINE
  if ${IS_OOM}; then
    echo "[sweep]     OOM-killed (exit ${EXIT_CODE}) — DID NOT FIT @${CAP}" >&2
    LINE=$(LABEL="${LABEL}" CAP="${CAP}" EXIT_CODE="${EXIT_CODE}" KNOBS="${KNOBS[*]}" python3 -c "
import json,os
print(json.dumps({
  'label': os.environ['LABEL'], '_cap': os.environ['CAP'], 'oom': True, 'fit': False,
  'knobs': os.environ['KNOBS'], 'exit_code': int(os.environ['EXIT_CODE']),
  'peak_anon_mb': None, 'peak_current_mb': None,
  'semantic_p50_ms': None, 'hybrid_p50_ms': None, 'vec_loaded': None,
  'errors': ['OOM-killed by cgroup (MemorySwapMax=0)'],
}))
")
    echo "${LINE}" | tee -a "${RESULTS_FILE}"
    rm -f "${TMPOUT}"
    return 137   # signal OOM to caller for cap-ladder early stop
  fi

  if [[ -z "${RESULT}" ]]; then
    echo "[sweep]     no JSON output (exit ${EXIT_CODE}) — treating as error" >&2
    cat "${TMPOUT}" >&2 | head -20
    LINE=$(LABEL="${LABEL}" CAP="${CAP}" EXIT_CODE="${EXIT_CODE}" KNOBS="${KNOBS[*]}" python3 -c "
import json,os
print(json.dumps({'label': os.environ['LABEL'], '_cap': os.environ['CAP'], 'oom': False, 'fit': None,
  'knobs': os.environ['KNOBS'], 'exit_code': int(os.environ['EXIT_CODE']), 'errors':['no JSON output']}))
")
    echo "${LINE}" | tee -a "${RESULTS_FILE}"
    rm -f "${TMPOUT}"
    return 0
  fi

  # Fit (no OOM): inject label/cap/fit=true into the result JSON
  LINE=$(LABEL="${LABEL}" CAP="${CAP}" KNOBS="${KNOBS[*]}" RESULT="${RESULT}" python3 -c "
import json,os
d=json.loads(os.environ['RESULT'])
d['label']=os.environ['LABEL']; d['_cap']=os.environ['CAP']; d['oom']=False; d['fit']=True
d['knobs']=os.environ['KNOBS']
print(json.dumps(d))
")
  echo "${LINE}" | tee -a "${RESULTS_FILE}"
  rm -f "${TMPOUT}"
  return 0
}

# sweep_ladder <label> <cap-csv> <KEY=VAL...>
# Runs caps left→right, stops at the first cap that OOMs (lower caps would also OOM).
sweep_ladder() {
  local LABEL="$1"; shift
  local CAPS="$1"; shift
  local IFS=','
  read -ra CAP_ARR <<< "${CAPS}"
  unset IFS
  for CAP in "${CAP_ARR[@]}"; do
    run_one "${LABEL}" "${CAP}" "$@"
    local RC=$?
    if [[ ${RC} -eq 137 ]]; then
      echo "[sweep]     stopping ${LABEL} ladder at ${CAP} (OOM); lower caps would also OOM" >&2
      break
    fi
  done
  echo "[sweep] === ${LABEL} ladder done ===" >&2
}

# Dispatch: the orchestrator calls this script with a single config spec on argv.
#   $1 = mode (query|write|concurrent)
#   $2 = label
#   $3 = caps csv
#   rest = knobs
MODE_ARG="${1:?mode required}"; shift
LABEL_ARG="${1:?label required}"; shift
CAPS_ARG="${1:?caps required}"; shift

sweep_ladder "${LABEL_ARG}" "${CAPS_ARG}" "MODE=${MODE_ARG}" "$@"
