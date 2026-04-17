# Experiment Matrix

This is the current benchmark progression for public proxy evaluations. The goal is to change one retrieval variable at a time and keep comparisons honest.

## LongMemEval

| Priority | Variant | Why | Status |
|---|---|---|---|
| 1 | `session` + lexical | Coarse baseline. Measures current floor with minimal adapter logic. | Done |
| 2 | `round` + lexical | Tests whether corpus granularity is the main bottleneck before adding heavier retrieval machinery. | Done |
| 3 | `session` + hybrid | Tests whether retrieval method, not just corpus shaping, is the dominant bottleneck. | Done |
| 4 | `round` + hybrid | Re-tests finer granularity under a retriever that already proved materially stronger. | Next |
| 5 | `round` + query preprocessing | Time-aware filtering or expansion for temporal questions. | Planned |
| 6 | `fact` + hybrid | Closest to specialized memory-system designs, but highest coupling and implementation cost. | Planned |

## Decision Rules

- If `round` + lexical materially improves over `session` + lexical, granularity is a primary bottleneck.
- If `session` + hybrid materially improves over `session` + lexical, retrieval method is a primary bottleneck.
- If `round` + hybrid materially improves over `session` + hybrid, finer corpus shaping is justified under a stronger retriever.
- If temporal questions remain weak after `round` + hybrid, query preprocessing and temporal indexing become justified.
- If all of the above remain weak, the benchmark is signaling a deeper mismatch between Munin's product model and conversational-memory benchmarks.

## Current Baseline

- `LongMemEval-S`, `session` + lexical
- 500 queries
- 19,195 synthetic entries
- `R@1 = 0.025`
- `R@5 = 0.0508`
- `R@10 = 0.0558`
- `NDCG@5 = 0.04467`
- `MRR = 0.05237`

## Current Best Result

- `LongMemEval-S`, `session` + hybrid
- 500 queries
- 19,195 synthetic entries
- `R@1 = 0.1017`
- `R@5 = 0.2255`
- `R@10 = 0.2793`
- `NDCG@5 = 0.1818`
- `MRR = 0.2034`

## LoCoMo

Secondary public benchmark. Smaller and cheaper to run than LongMemEval, covers 5 question categories (single-hop, multi-hop, temporal, open-domain, adversarial).

| Priority | Variant | Why | Status |
|---|---|---|---|
| 1 | `session` + lexical | Coarse baseline. Mirrors the LongMemEval progression. | Done |
| 2 | `dialog` + lexical | Tests dialog-level granularity — expected to be too fine for pure BM25. | Done |
| 3 | `session` + hybrid | First apples-to-apples comparison with production retrieval path, now that relaxed-FTS fallback is live. | Next |
| 4 | `dialog` + hybrid | Re-tests dialog granularity under the stronger retriever. | Planned |

### LoCoMo Baselines (pre relaxed-FTS fallback fix)

- `session` + lexical: `R@1 = 0.066`, `MRR = 0.079` (1359/1536 queries hit fallback = 88%)
- `dialog` + lexical: `R@1 = 0.001` (1508/1531 queries hit fallback = 98.5%, too granular for BM25 without semantic reranking)

Fallback-usage baselines above are from the pre-fix benchmark runner that called `queryEntriesLexicalScored` directly and missed the production relaxed-lexical path. Reruns against the fixed runner are queued under #19.

### Run

```bash
npm run benchmark:locomo                 # session + lexical
npm run benchmark:locomo:dialog          # dialog + lexical
npm run benchmark:locomo:hybrid          # session + hybrid
npm run benchmark:locomo:dialog:hybrid   # dialog + hybrid
```

`benchmark:fetch:locomo` is a prerequisite the combined scripts already run.
