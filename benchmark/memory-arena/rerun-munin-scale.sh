#!/bin/bash
# Rerun Munin's scale phase with corrected seeding (SEED_V2), re-judge N01–N12 blind, re-analyze.
# Owner-approved 2026-11-10 ("Yes, after 1 Dec"); API cap: total ledgers $60 (owner cap raised to $60 on 2026-11-13; run early, same day).
# Exit codes: 0 done, 3 API still unavailable (nothing changed), 1 other failure.
set -euo pipefail
cd "$(dirname "$0")"
RES=results
CELLS=()
for m in claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5; do for r in 1 2; do CELLS+=("munin__${m}__r${r}"); done; done

# 1. Preflight: one tiny Haiku call through the same client and ledger (fails closed).
if ! node --input-type=module -e "
import { Ledger, createMessage } from './src/api.mjs';
const l = new Ledger('$RES/ledgers', 60, 'rerun-preflight');
try { await createMessage({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'ok' }] }, { ledger: l, tag: 'preflight' }); console.log('API ok; ledgers total', l.globalTotal().toFixed(2)); }
catch (e) { console.error('API unavailable:', e.message.slice(0, 300)); process.exit(3); }"; then
  echo "Preflight failed; nothing changed."; exit 3
fi

# 2. Archive v1 scale answers (idempotent) and rerun the six Munin cells on a fresh 'scale-v2' store.
for c in "${CELLS[@]}"; do
  d="$RES/runs/$c"
  [ -f "$d/scale-v1.jsonl" ] || { mv "$d/scale.jsonl" "$d/scale-v1.jsonl"; mv "$d/meta-scale.json" "$d/meta-scale-v1.json"; }
done
for c in "${CELLS[@]}"; do
  rest="${c#munin__}"; model="${rest%__r*}"; rep="${rest##*__r}"
  node src/run.mjs --arm munin --model "$model" --rep "$rep" --phases scale --scale-store scale-v2 --cap 60 > "$RES/logs/rerun-scale_${c}.log" 2>&1 &
done
wait

# 3. Verify: 12 error-free answers per cell.
python3 - "${CELLS[@]}" <<'EOF'
import json, sys
for c in sys.argv[1:]:
    L = [json.loads(l) for l in open(f'results/runs/{c}/scale.jsonl') if l.strip()]
    ids = {x['id'] for x in L}; errs = [x['id'] for x in L if x['trace']['error']]
    assert len(ids) == 12 and not errs, f'{c}: {len(ids)} answers, errors {errs}'
print('all six Munin scale cells complete')
EOF
date -u +'{"rerun_at":"%Y-%m-%dT%H:%M:%SZ","seed":"SEED_V2 (status at last log date)","cells":"munin x 3 models x r1,r2","v1_answers":"runs/<cell>/scale-v1.jsonl"}' > "$RES/scale-rerun.json"

# 4. Blind re-judge of the changed questions (fresh labels), with one resume pass for failed calls.
FORCE=N01,N02,N03,N04,N05,N06,N07,N08,N09,N10,N11,N12
node src/judge.mjs --backend codex --v2 --force-qids "$FORCE"
node src/judge.mjs --backend codex --v2 --force-qids "$FORCE"

# 5. Re-analyze and repack the full measurement series.
node src/analyze.mjs > /dev/null
tar -czf "$RES/runs.tar.gz" -C "$RES" runs
echo "Rerun complete. See $RES/tables.md and $RES/analysis.json."
