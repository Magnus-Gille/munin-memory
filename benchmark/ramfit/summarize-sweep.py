#!/usr/bin/env python3
"""Summarize sweep-ram.jsonl into a compact markdown table + callouts."""
import json, sys

path = sys.argv[1] if len(sys.argv) > 1 else "benchmark/ramfit/results/sweep-ram.jsonl"
rows = [json.loads(l) for l in open(path) if l.strip()]

def cap_mb(c):
    if not c: return None
    return int(str(c).rstrip("Mm"))

# Order by appearance
print("| label | mode | cap | fit | peak_anon_mb | peak_current_mb | sem_p50 | hyb_p50 | vec | emb | err |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for d in rows:
    err = d.get("errors") or []
    errs = (err[0][:40] if err else "")
    fit = d.get("fit")
    fitstr = "OOM" if d.get("oom") else ("yes" if fit else ("?" if fit is None else "no"))
    print("| {label} | {mode} | {cap} | {fit} | {anon} | {cur} | {sp} | {hp} | {vec} | {emb} | {err} |".format(
        label=d.get("label",""), mode=d.get("mode",""), cap=d.get("_cap",""),
        fit=fitstr, anon=d.get("peak_anon_mb"), cur=d.get("peak_current_mb"),
        sp=d.get("semantic_p50_ms"), hp=d.get("hybrid_p50_ms"),
        vec=("Y" if d.get("vec_loaded") else "n"), emb=d.get("batch_embedded"), err=errs))

# Callout: lightest config that fits 1024m at full MiniLM quality (fp32, vec loaded)
print("\n### Callouts")
fp32_fits = [d for d in rows if d.get("dtype")=="fp32" and d.get("model","").endswith("MiniLM-L6-v2")
             and d.get("fit") and d.get("vec_loaded") and cap_mb(d.get("_cap"))==1024]
if fp32_fits:
    best = min(fp32_fits, key=lambda d: (d.get("peak_anon_mb") or 1e9))
    print(f"Full-MiniLM fp32 @1024m: anon={best.get('peak_anon_mb')}MB ({best.get('label')}/{best.get('mode')}) — fits with huge headroom")

# 512m fitters
fit512 = sorted({(d.get("label"), d.get("mode"), d.get("peak_anon_mb"))
                 for d in rows if cap_mb(d.get("_cap"))==512 and d.get("fit")})
print(f"Configs fitting 512m: {len(fit512)}")

# OOM rows
ooms = [(d.get("label"), d.get("mode"), d.get("_cap")) for d in rows if d.get("oom")]
print(f"OOM rows (did not fit): {ooms if ooms else 'NONE'}")

# error rows (e.g. fp16)
errrows = [(d.get("label"), d.get("mode"), d.get("_cap"), (d.get("errors") or [''])[0][:60]) for d in rows if d.get("errors")]
if errrows:
    print("Error rows:")
    for r in errrows: print("  ", r)
