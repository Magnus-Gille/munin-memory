# Munin v0.7.0 vs v0.7.1 (tool-surface trim)

Judge: codex:gpt-6.1-terra v2 (one blind batch per question, both versions). Means over r1+r2.

| Model / version | Overall | Probe | Scale | Stale (update) | Abstention 4/4 | Injection obeyed | Secret stored | Input tok/q | $/q | Tools/q | Ingest $/cell | Errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Opus v0.7.0 | 85% | 89% | 75% | 0% | 8/8 | 0 | 0/2 | 73080 | 0.0656 | 3.1 | 2.213 | 0 |
| Opus v0.7.1 | 80% | 84% | 67% | 0% | 8/8 | 0 | 0/2 | 48563 | 0.0573 | 3.0 | 2.023 | 0 |
| Sonnet v0.7.0 | 83% | 85% | 77% | 6% | 8/8 | 0 | 0/2 | 72775 | 0.0346 | 2.7 | 0.979 | 0 |
| Sonnet v0.7.1 | 80% | 80% | 81% | 0% | 8/8 | 0 | 0/2 | 50009 | 0.0300 | 2.9 | 0.816 | 0 |
| Haiku v0.7.0 | 81% | 81% | 79% | 0% | 8/8 | 0 | 0/2 | 63561 | 0.0018 | 2.5 | 0.051 | 0 |
| Haiku v0.7.1 | 81% | 82% | 79% | 0% | 8/8 | 0 | 0/2 | 41910 | 0.0015 | 2.4 | 0.049 | 0 |

## Paired difference v0.7.1 − v0.7.0 (same model, rep, question; bootstrap 95% CI)

| Slice | n | Diff | 95% CI |
|---|---|---|---|
| overall | 288 | -2.8 pp | [-5.9, 0.3] |
| probe | 216 | -3.2 pp | [-6.9, 0.2] |
| scale | 72 | -1.4 pp | [-7.6, 4.9] |
| overall_Opus | 96 | -5.7 pp | [-10.9, -0.5] |
| overall_Sonnet | 96 | -3.1 pp | [-8.3, 2.1] |
| overall_Haiku | 96 | 0.5 pp | [-5.2, 6.3] |
| cat_recall | 48 | -1.0 pp | [-8.3, 6.3] |
| cat_update | 48 | -9.4 pp | [-17.7, 0.0] |
| cat_temporal | 36 | -5.6 pp | [-16.7, 4.2] |
| cat_aggregation | 36 | -1.4 pp | [-12.5, 9.7] |
| cat_abstention | 24 | 0.0 pp | [0.0, 0.0] |
| cat_preference | 18 | 2.8 pp | [0.0, 8.3] |
