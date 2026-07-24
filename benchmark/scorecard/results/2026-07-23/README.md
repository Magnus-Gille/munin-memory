# Munin LongMemEval-S end-to-end scorecard

**Run date:** 2026-07-23

**Contract:** `munin-longmemeval-s-e2e-v2` (SHA-256 `bf7d3a4b4c7ab3eaf4ee9c2eb462599c98a1aeca237284372dd7324b4c7ac2a1`)

**Git commit:** `1b442fdde43e3bfedfe5143779c7684e70ae7100`

**Publication status:** Phase A Munin result; not a competitor comparison

## Results

| Measure | Result |
|---|---:|
| Questions | 500 |
| End-to-end answer accuracy | 10.2% (95% bootstrap CI 7.6%–13.0%) |
| Retrieval R@5 | 14.5% (95% bootstrap CI 12.0%–17.0%) |
| Retrieval latency p50 / p95 | 97.4 / 121.5 ms |
| Answer pipeline latency p50 / p95 | 5203.8 / 7745.2 ms |
| Retrieved-context budget | 8192 estimated tokens |
| Provider prompt / completion tokens | 3482748 / 75892 |
| Provider-reported cost | $4.5622 |
| Generated artifacts reused | yes |
| Transient retries | 0 |
| Peak process RSS | 849.8 MiB |
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
- This is a Munin Phase A result, not a competitor comparison.
- The retrieved-context budget is a deterministic estimate; provider-native prompt-token counts remain authoritative for billing.
- A single temperature-zero run reports seeded bootstrap confidence intervals over questions, not across-provider repeatability.
- The deterministic trust lanes and one live poison challenge complement, but do not replace, the repository security regression suite.
