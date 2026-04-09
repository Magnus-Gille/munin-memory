# BEIR Adapter

Status: scaffold only

Why it belongs here:

- public zero-shot IR benchmark with standard retrieval metrics
- good for generic lexical vs semantic vs hybrid regression
- not memory-specific, so use a small subset only

## Source

- Repo: <https://github.com/beir-cellar/beir>
- Datasets: <https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/>
- License: Apache-2.0 for the framework; individual datasets may vary

## Intended Mapping

- source query -> `BenchmarkQuery.query`
- source qrels -> `expected_ids`
- chosen subset name -> benchmark category suffix or report metadata

## Expected Output

- `benchmark/generated/beir-scifact.jsonl`

## Notes

Start with `scifact` or another compact subset. Do not treat BEIR as evidence that Munin is good at memory; treat it as a retrieval regression suite.
