# LongMemEval Adapter

Status: scaffold only

Why it belongs here:

- public benchmark for long-term chat assistant memory
- exposes evidence sessions and turn-level answer labels
- closest external proxy to Munin's retrieval claims

## Source

- Repo: <https://github.com/xiaowu0162/LongMemEval>
- Dataset: <https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned>
- License: MIT

## Intended Mapping

- question text -> `BenchmarkQuery.query`
- question type -> `BenchmarkQuery.category`
- answer session ids -> relevant retrieval targets
- turn-level `has_answer` -> optional future fine-grained diagnostics

## Expected Output

- `benchmark/generated/longmemeval-s.jsonl`
- `benchmark/generated/longmemeval-m.jsonl`

## Notes

LongMemEval is a proxy benchmark, not the primary truth source. Munin-native queries should remain the baseline regression set.
