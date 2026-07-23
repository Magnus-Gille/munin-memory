# Optional Phase B competitor-neutrality policy

Phase A publishes Munin's own complete result first. It does not reuse
vendor-published headline numbers and does not imply hardware parity between
unlike systems.

If Phase B is pursued, every competitor adapter must:

1. use the same released dataset bytes, reader, judge, retrieved-context budget,
   grading rubric, uncertainty method, and reporting schema as Munin;
2. start from the competitor's current documented, vendor-recommended
   self-hosted configuration, with every deviation disclosed;
3. publish adapter code, dependency versions, configuration, ingestion rules,
   raw results, infrastructure requirements, latency, tokens, RAM, disk, and
   cost;
4. separate native retrieval from any aggregation, graph, reranking, or
   reflection stage rather than silently crediting one system for more context;
5. invite maintainers to challenge the configuration and publish corrected
   reruns without deleting the original result;
6. label failures, unsupported features, and degraded modes explicitly instead
   of coercing them into zero scores or favorable exclusions.

At least two independently runnable OSS systems are required before Munin
publishes a comparative table. Until then, the Phase A artifact is presented
only as a reproducible Munin scorecard.
