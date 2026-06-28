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

## Methodology note — per-question haystack isolation (required for comparable numbers)

All runs prior to the per-question isolation change (merged as part of the
`feat/longmemeval-per-question-isolation` work) pooled ALL 500 questions'
sessions into a single shared ~20K-entry DB and queried each question against
that global pool. Canonical LongMemEval methodology scores each question only
against its own ~40-session haystack.

The global-pool numbers below are **superseded** and should not be compared to
published LongMemEval scores or future Munin runs. The adapter now emits
`scope_namespace` per query and inserts sessions into per-question namespaces —
all new runs use per-question isolation automatically. The comparable
per-question-isolation numbers are in the section below.

## Current Baseline (SUPERSEDED — global pool, not comparable)

- `LongMemEval-S`, `session` + lexical
- 500 queries
- 19,195 synthetic entries (global pool)
- `R@1 = 0.025`
- `R@5 = 0.0508`
- `R@10 = 0.0558`
- `NDCG@5 = 0.04467`
- `MRR = 0.05237`

## Current Best Result (SUPERSEDED — global pool, not comparable)

- `LongMemEval-S`, `session` + hybrid
- 500 queries
- 19,195 synthetic entries (global pool)
- `R@1 = 0.1017`
- `R@5 = 0.2255`
- `R@10 = 0.2793`
- `NDCG@5 = 0.1818`
- `MRR = 0.2034`

## Per-question isolation baseline (comparable)

`LongMemEval-S`, `session` granularity, 500 queries, raw runner mode,
23,854 synthetic entries across 500 per-question namespaces (~48 sessions
per question's haystack). Each query restricted to its own namespace via
`scope_namespace`; semantic/hybrid use the exhaustive-KNN scoped path.
Embedding model: `Xenova/all-MiniLM-L6-v2` (fp32). Generated 2026-06-28.

Semantic/hybrid use an exact namespace-local distance scan (`vec_distance_L2`
over only the in-namespace vectors) — not a global KNN window — so scoping is
exact regardless of corpus size.

| Mode | R@1 | R@5 | R@10 | R@20 | NDCG@5 | NDCG@20 | MRR |
|------|-----|-----|------|------|--------|---------|-----|
| lexical | 0.5668 | 0.8898 | 0.9202 | 0.9202 | 0.8706 | — | 0.9145 |
| hybrid  | 0.5423 | 0.9217 | 0.9656 | 0.9656 | 0.8842 | 0.9018 | 0.9061 |

Reading:
- Hybrid beats lexical at R@5 (0.9217 vs 0.8898) — the semantic arm adds real
  signal on questions where vocabulary overlap alone is insufficient.
- Hybrid lifts the recall ceiling **R@10 0.9202 → 0.9656** — the semantic arm
  recovers harder (vocabulary-mismatch / multi-session) questions.
- Both plateau by R@10 (R@10 == R@20): evidence not found by depth 10 is not
  found by 20 — the genuine retrieval frontier (~3.4% of questions for hybrid).
- Remaining gap to published hybrid figures (~98.4% R@5) is now *real*, not a
  measurement artifact: weak MiniLM embeddings + no reranker. Closing it is the
  scope of the #122 stretch items (stronger embeddings, optional haiku rerank).

**Comparability caveat:** before citing these against another system, confirm
the haystack scale matches the variant they report (LongMemEval-S ≈ 40–50
sessions/question — consistent with our ~48). A different scale must be
footnoted.

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
