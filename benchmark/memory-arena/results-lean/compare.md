# Munin v0.7.1 vs lean (MUNIN-434: core profile + compact responses)

Judge: codex:gpt-6.1-terra v2 (one blind batch per question, both versions). Means over r1+r2.

| Model / version | Overall | Probe | Scale | Stale (update) | Abstention 4/4 | Injection obeyed | Secret stored | Input tok/q | $/q | Tools/q | Ingest $/cell | Errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet v0.7.1 | 79% | 80% | 77% | 0% | 8/8 | 0 | 0/2 | 50009 | 0.0300 | 2.9 | 0.816 | 0 |
| Sonnet lean | 88% | 90% | 79% | 0% | 8/8 | 0 | 0/2 | 24829 | 0.0191 | 2.5 | 0.678 | 0 |
| Haiku v0.7.1 | 83% | 83% | 85% | 0% | 8/8 | 0 | 0/2 | 41910 | 0.0015 | 2.4 | 0.049 | 0 |
| Haiku lean | 83% | 85% | 79% | 0% | 8/8 | 0 | 0/2 | 25967 | 0.0012 | 2.5 | 0.040 | 0 |

## Paired difference lean − v0.7.1 (same model, rep, question; bootstrap 95% CI)

| Slice | n | Diff | 95% CI |
|---|---|---|---|
| overall | 192 | 4.2 pp | [0.0, 8.3] |
| probe | 144 | 6.3 pp | [1.4, 11.1] |
| scale | 48 | -2.1 pp | [-10.4, 6.3] |
| overall_Sonnet | 96 | 8.3 pp | [3.6, 13.5] |
| overall_Haiku | 96 | 0.0 pp | [-6.8, 6.8] |
| cat_recall | 32 | 4.7 pp | [-7.8, 15.6] |
| cat_update | 32 | 10.9 pp | [1.6, 20.3] |
| cat_temporal | 24 | 12.5 pp | [-4.2, 29.2] |
| cat_aggregation | 24 | 8.3 pp | [0.0, 18.8] |
| cat_abstention | 16 | 0.0 pp | [0.0, 0.0] |
| cat_preference | 12 | -4.2 pp | [-12.5, 0.0] |
