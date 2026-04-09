# LoCoMo Adapter

Status: scaffold only

Why it belongs here:

- public benchmark for very long-term conversational memory
- includes QA items plus evidence dialog ids
- smaller and cheaper to run than LongMemEval

## Source

- Repo: <https://github.com/snap-research/locomo>
- Project page: <https://snap-research.github.io/locomo/>
- License: see upstream `LICENSE.txt`

## Intended Mapping

- question text -> `BenchmarkQuery.query`
- QA category -> `BenchmarkQuery.category`
- evidence dialog ids -> relevant retrieval targets after adapter-specific chunk mapping

## Expected Output

- `benchmark/generated/locomo-qa.jsonl`

## Notes

LoCoMo is a useful secondary benchmark and a good smoke benchmark for temporal and multi-hop conversational recall.
