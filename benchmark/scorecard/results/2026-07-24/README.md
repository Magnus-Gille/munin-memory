# Munin LongMemEval-S end-to-end scorecard

**Run date:** 2026-07-24

**Contract:** `munin-longmemeval-s-e2e-v3` (SHA-256 `40a9e5f0cb6ffd5d0729130eb06511c5473bc282efdf6bebbf80086d1407fc94`)

**Git commit:** `cfcda8535446e5763c427ea8a1b78598f1ce2686`

**Publication status:** Phase A Munin result; not a competitor comparison

## Results

| Measure | Result |
|---|---:|
| Questions | 500 |
| End-to-end answer accuracy | 52.8% (95% bootstrap CI 48.6%–57.2%) |
| Retrieval R@5 | 91.5% (95% bootstrap CI 89.4%–93.4%) |
| Retrieval latency p50 / p95 | 98.4 / 125.7 ms |
| Answer pipeline latency p50 / p95 | 5220.2 / 7496.3 ms |
| Retrieved-context budget | 8192 estimated tokens |
| Reranker recency weight | 0 (contract-pinned via public `memory_query` `search_recency_weight`) |
| Provider prompt / completion tokens | 3519913 / 90975 |
| Provider-reported cost | $4.7095 |
| Generated artifacts reused | yes |
| Transient retries | 0 |
| Peak process RSS | 797.8 MiB |
| Generated DB + query artifacts | 603.0 MiB |

Reader: `anthropic/claude-haiku-4.5`. Judge: `anthropic/claude-sonnet-4.5`. Actual response
models: `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-4.5`.
Actual providers: `Amazon Bedrock`, `Google`.

## Trust lanes

- Namespace isolation and classification-ceiling probes: **pass**
- Instruction-shaped data boundary probes: **pass**
- Live reader poison challenge: **pass**

These focused lanes complement the repository security regression suite; they do
not replace it.

## Reproduction

```bash
OPENROUTER_API_KEY=... npm run scorecard:longmemeval:s
npm run scorecard:publish -- --report <generated-report.json>
```

The raw report beside this summary contains all 500 retrieval and answer results,
query-set checksums, provider identities, native token usage/cost, environment
lineage, stage timings, resource measurements, and trust-lane evidence.

## Limitations

- Generated benchmark artifacts were reused after exact provenance validation; ingestion and embedding durations cover only this resumed process, not the original artifact build.
- The production reranker's freshness weighting is pinned to 0 via the public memory_query parameter search_recency_weight. LongMemEval corpus write-recency is an artifact of ingestion order and carries no semantic meaning; the production default (0.2) buries evidence sessions (issue #248 measured R@5 91.5% at weight 0 vs 14.5% at the default on identical artifacts). This is a documented caller-side production parameter, not a benchmark-only ranking fork.
- This is a Munin Phase A result, not a competitor comparison.
- The retrieved-context budget is a deterministic estimate; provider-native prompt-token counts remain authoritative for billing.
- A single temperature-zero run reports seeded bootstrap confidence intervals over questions, not across-provider repeatability.
- The deterministic trust lanes and one live poison challenge complement, but do not replace, the repository security regression suite.
