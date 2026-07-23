# Agent-memory competitive analysis — July 2026

**Research date:** 2026-07-22

**Scope:** products, open-source projects, and platforms that compete for the
agent-memory layer. Ranking is by **competitive relevance to Munin**: product
maturity and distribution, memory quality evidence, deployment/governance,
developer experience, and strategic overlap. It is not a GitHub-star ranking.

## Executive verdict

Munin is technically competitive, but the market has moved from "vector memory"
to packaged **context infrastructure**: automatic capture, temporal/entity models,
MCP and SDK integrations, dashboards, connectors, managed hosting, and public
evaluation suites.

Munin's defensible category is narrower and stronger:

> **Sovereign operational memory for people and trusted agent groups: current
> truth, immutable decision history, least-privilege sharing, and reliable
> cross-client resumption from a database the user owns.**

No leading competitor combines Munin's mutable-state/append-only-log split,
MCP-first provider portability, SQLite/ARM footprint, CAS, OAuth and scoped
principals, transport-aware classification, stored-content injection defenses,
and source-backed orientation/handoff/commitment tools.

The largest weakness is no longer core retrieval. It is **proof and
productization**. Munin has a strong LongMemEval-S retrieval result, but not a
market-comparable end-to-end answer-quality result. It also lacks the five-minute
onboarding, review UI, importers, SDKs, and polished packaging now offered by
several competitors.

## Top ten

The ranking is multi-factor, not a benchmark leaderboard. Unless explicitly
described as independent, every product score below is vendor-run and should be
read as a dated claim under that vendor's chosen ingestion, model, token budget,
and judging configuration—not as a directly comparable result.

### 1. Mem0 — category and distribution leader

The strongest general-purpose competitor. It combines a large open-source
community, managed service, Python/TypeScript SDKs, many framework integrations,
automatic memory extraction, entity matching, and a rapidly improving benchmark
story. Its April 2026 algorithm changed to single-pass ADD-only extraction plus
semantic, keyword, and entity retrieval. It reports 92.5 on LoCoMo, 94.4 on
LongMemEval, and 64.1/48.6 on BEAM 1M/10M, with roughly 6.7–7.0K retrieved tokens.

- Evidence: [research](https://mem0.ai/research), [pricing](https://mem0.ai/pricing), [open source](https://github.com/mem0ai/mem0)
- Price: free OSS; hosted $0, $19/month, $249/month, then custom enterprise.
- Threat to Munin: distribution, integrations, benchmark marketing, and a very
  low-friction API.
- Munin advantage: stronger operational truth/history semantics, governance,
  local footprint, pull-only control, and security posture.

### 2. Supermemory — best packaged context product

Supermemory has turned memory into a broad context product: documents, multimodal
ingestion, connectors, search/graph operations, MCP, coding-agent plugins, scoped
keys, a console, local binaries, exports, suggested-memory review, and natural
date search. It reports 95% on LongMemEval-S at Recall@15 with aggregation and a
mean context of about 720 tokens, versus 71.2% for its Zep configuration.

- Evidence: [LongMemEval research](https://supermemory.ai/research/longmembench/), [pricing](https://supermemory.ai/pricing/), [changelog](https://supermemory.ai/changelog/)
- Price: $0, $19, $100, or $399/month; metered primitives; self-hosting on Scale
  and Enterprise.
- Threat to Munin: connectors, onboarding, review UI, migration/export, product
  velocity, and a much more legible user experience.
- Caveat: its headline is a vendor-run retrieval/aggregation evaluation, not the
  same metric as end-to-end LLM-judged answer accuracy.

### 3. Hindsight — strongest large-scale evidence

Hindsight is an MIT-licensed, self-hostable retain/recall/reflect system with MCP,
REST, SDKs, a local UI, structured facts, entities, temporal retrieval, graph
traversal, BM25/semantic fusion, and cross-encoder reranking. Its strongest claim
is BEAM-10M: 64.1%, versus 40.6% for Honcho and roughly 25–27% for the published
RAG/LIGHT baselines. It also has unusually strong open-source adoption.

- Evidence: [open source](https://github.com/vectorize-io/hindsight), [BEAM comparison](https://hindsight.vectorize.io/guides/2026/04/21/comparison-agent-memory-benchmark-hindsight-vs-alternatives), [cloud pricing](https://docs.hindsight.vectorize.io/billing/)
- Price: OSS free; cloud retain $10/M input tokens, recall $0.75/M output tokens,
  reflect/refresh $0.05/call, and old-memory storage $0.25/M tokens/month.
- Threat to Munin: reproducible scale evidence and a coherent three-operation API.
- Munin advantage: simpler local stack, explicit operational state/history,
  stronger authorization/classification, and no mandatory LLM on the core path.

### 4. Zep / Graphiti — temporal-graph leader

Zep's commercial Context Graph and Apache-licensed Graphiti project remain the
clearest reference for bi-temporal facts, invalidation, provenance, ontology-aware
entities, and graph + keyword + semantic retrieval. Zep reports 94.7% on LoCoMo
and 90.2% on LongMemEval, with 155–162 ms retrieval and about 4.4K–5.8K context
tokens.

- Evidence: [research](https://www.getzep.com/research/), [pricing](https://www.getzep.com/pricing/), [Graphiti](https://github.com/getzep/graphiti)
- Price: free 10K-credit tier; Flex $125/month ($104 annualized), Flex Plus
  $375/month ($312 annualized), then enterprise/BYOC.
- Threat to Munin: historical truth reconstruction and enterprise positioning.
- Munin advantage: dramatically lower operational complexity, edge fit, stronger
  human-auditable mutation semantics, and a broader MCP workflow layer.

### 5. MemClaw — closest direct narrative competitor

MemClaw is the most important new entrant for Munin's story specifically. It is
Apache-licensed and MCP-native, and targets multi-tenant, multi-agent fleets with
visibility scopes, trust tiers, row-level isolation, audit logs, PII quarantine,
hybrid graph/vector/keyword retrieval, contradiction handling, provenance,
per-agent tuning, lifecycle automation, and a managed service.

Its buyer and deployment target is materially heavier than Munin's: managed
agent fleets on Postgres/pgvector plus Neo4j rather than sovereign small-group
memory on SQLite. It is therefore the closest narrative competitor—governed
shared MCP memory—not necessarily the closest buyer competitor. Its benchmark
and ArgusFleet evidence are self-authored and require independent reproduction.

It reports 77.6% LoCoMo, 72.5% LongMemEval, 96.6–98.2% token savings, and a
23 ms warm raw-search p50 in its public/customer material. Its self-authored
ArgusFleet paper is more valuable than those headline scores: the harness found a
real direct-GET authorization bypass and a deduplication/contradiction pipeline
ordering bug, then documented remediation. The paper also reports strong-mode
write p50 around 1.8 seconds and live search measurements far above the 23 ms
raw-search headline, illustrating why workload definitions matter.

- Evidence: [product and benchmark summary](https://memclaw.net/), [pricing](https://memclaw.net/pricing/), [docs](https://memclaw.net/docs), [governance paper](https://arxiv.org/abs/2606.24535), [open source](https://github.com/caura-ai/caura-memclaw)
- Price: free; $49/$399 monthly or $41/$333 annualized; custom on-prem/air-gapped.
- Threat to Munin: it tells a crisp governed-shared-memory story, ships a managed
  path, and publishes a governance harness and enterprise case study.
- Munin advantage: stored content remains data rather than policy, write-time LLM
  enrichment is optional/off-path, status remains human-grounded truth, the stack
  is much smaller, and the access model includes transport classification.

**Borrow from MemClaw:** the adversarial governance harness, explicit provenance
chains, visibility/sharing UX, and case-study discipline. **Do not copy:**
mandatory "keystone" instructions loaded from memory or automatic failure-minted
rules; those conflict with Munin's data-not-commands invariant.

### 6. Honcho — reasoning-first user and peer memory

Honcho models workspaces, peers, sessions, and messages, then reasons in the
background to maintain peer cards and representations. This is meaningfully
different from fact retrieval and particularly strong for assistants, social
agents, education, and multi-participant personalization. It reports 89.9%
LoCoMo, 90.4% LongMemEval, and 40.9% BEAM-10M.

- Evidence: [product and pricing](https://honcho.dev/), [evals](https://honcho.dev/evals/), [open source](https://github.com/plastic-labs/honcho)
- Price: ingestion $2/M tokens; unlimited basic context retrieval; reasoning from
  $0.001 to $0.50/query. Self-hosting is AGPL-3.0.
- Threat to Munin: outcome is a ready-to-use representation, not just search
  results, and its peer model makes personalization easy to understand.
- Munin advantage: operational/project memory, governance, deterministic state,
  and lower reliance on inferred psychological conclusions.

### 7. Letta / MemGPT — strongest full agent-runtime alternative

Letta is not merely a memory backend; it owns the agent runtime and context
window. Memory blocks, archival memory, filesystem memory, sleep-time compute,
shared conversations, an ADE, and git-backed context make it the clearest
alternative when a team is willing to adopt an entire stateful-agent platform.
Letta's filesystem agent scored 74.0% on LoCoMo with GPT-4o-mini, an important
warning that tool-using agents and simple files can beat more elaborate memory
pipelines.

- Evidence: [filesystem benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory/), [pricing](https://docs.letta.com/guides/cloud/plans), [open source](https://github.com/letta-ai/letta)
- Price: OSS free; API plan $20/month + $0.10/active agent/month + tool execution
  and LLM usage.
- Threat to Munin: end-to-end context ownership and excellent inspection UX.
- Munin advantage: provider/runtime portability and a memory service usable by
  existing agents without replacing their harness.

### 8. Cognee — broad graph and data-to-memory platform

Cognee combines ingestion adapters, knowledge-graph construction, vector search,
session/permanent memory, MCP/API integrations, many graph/vector backends, and a
managed service. Its surface is much broader than Munin and increasingly aimed at
turning enterprise data sources into agent memory.

- Evidence: [product and pricing](https://www.cognee.ai/), [agent memory](https://docs.cognee.ai/guides/agent-memory-quickstart), [open source](https://github.com/topoteretes/cognee)
- Price: OSS free; cloud includes 1M tokens, then $2.50/M processed tokens plus
  $5/month per additional workspace.
- Threat to Munin: connectors, graph breadth, and enterprise data integration.
- Munin advantage: smaller trusted computing base, stronger memory semantics and
  controls, and much lower hardware/ops requirements.

### 9. MemOS — ambitious memory operating system

MemOS packages traces, policies, world models, skill crystallization, correction,
scheduling, local plugins, MCP, and cloud APIs as a "memory OS." It is fast-moving,
Apache-licensed, and has strong community traction, but its scope and
self-evolution claims are substantially broader than Munin's constitution.

- Evidence: [open source and reported results](https://github.com/MemTensor/MemOS), [cloud pricing](https://memos.openmem.net/pricing/)
- Price: cloud tiers are temporarily $0; published list prices are $19 and
  $286/month, then enterprise. OSS self-hosting is free.
- Threat to Munin: local plugins, memory correction, skill reuse, and ambitious
  packaging.
- Munin advantage: auditable, restrained semantics and a much smaller failure and
  security surface.

### 10. LangMem / LangGraph Store — ecosystem-native building blocks

LangMem supplies hot-path memory tools, background extraction/consolidation,
semantic/episodic/procedural patterns, prompt optimization, and native LangGraph
Store integration. It is a framework component rather than a governed memory
service, but LangChain distribution makes it a frequent default.

- Evidence: [concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/), [open source](https://github.com/langchain-ai/langmem), [LangSmith pricing](https://www.langchain.com/pricing)
- Price: MIT library free; managed LangSmith starts at $0 developer or $39/seat
  plus compute/storage usage.
- Threat to Munin: teams already using LangGraph may accept a weaker memory layer
  to avoid another service.
- Munin advantage: complete cross-runtime service, governance, operations, and
  opinionated continuity workflows.

## Sovereign alternatives and substitutes

The top ten captures the strongest product/platform competition, but Munin's
buyer is also likely to compare it with smaller local-first tools and with no
dedicated memory service at all:

- [Basic Memory](https://github.com/basicmachines-co/basic-memory) and
  [OpenMemory](https://github.com/CaviraOSS/OpenMemory) are closer to the
  local-first/MCP deployment posture than several ranked fleet platforms. They
  are important packaging and onboarding references even where Munin's
  governance and operational semantics are deeper.
- Plain Markdown plus git, repository status files, and provider-native memory
  conventions are the zero-service substitute. Letta's own filesystem result
  reinforces that simple files can be competitive on conversational benchmarks.
- Platform-native memory from OpenAI, Anthropic, and Google is a distribution
  threat for casual continuity even though it is not portable or self-hosted.

Munin therefore has to prove marginal value over well-maintained files: safer
shared access, live current-truth semantics, cross-client retrieval, commitments,
attention, provenance, and less manual reconstruction. Beating another vector
store is not sufficient.

## Normalized feature and product view

| System | OSS/self-host | Managed | MCP | Temporal/entity model | Governed sharing | Main strength |
|---|---|---|---|---|---|---|
| **Munin** | MIT; SQLite; ARM | No | Native stdio + HTTP | Soft expiry; tags/refs; no KG | Namespace ACL + classification + OAuth | Operational truth/history and sovereignty |
| Mem0 | Apache; configurable stack | Yes | Yes | Entity matching/graph | Platform scopes; enterprise audit | Adoption, API, integrations |
| Supermemory | Partial/local + paid self-host | Yes | Yes | Memory graph + dates | Orgs, scoped keys | Product UX and connectors |
| Hindsight | MIT; Docker/embedded | Yes | Yes | Entity, graph, temporal, reranker | Memory banks; less policy depth | Large-scale benchmark evidence |
| Zep/Graphiti | Graphiti Apache | Yes | Integration available | Strong bi-temporal KG | Enterprise/BYOC | Historical truth and context graphs |
| MemClaw | Apache; Postgres+Neo4j | Yes | Native | Graph, contradiction, 8-state lifecycle | Fleet scopes, trust tiers, audit | Governed agent fleets |
| Honcho | AGPL; Postgres stack | Yes | Yes | Peer representations over time | Workspaces/peers | Reasoning and personalization |
| Letta | Apache; full runtime | Yes | Client/tool integration | Agent-managed blocks/files | Shared agents/blocks | Context-window ownership |
| Cognee | Apache; many backends | Yes | Yes | Broad graph/vector pipeline | Multi-workspace/enterprise | Data and connector breadth |
| MemOS | Apache; local/cloud | Yes | Yes | Multi-tier self-evolving memory | User/agent isolation | Skill and policy evolution |
| LangMem | MIT library | Via LangSmith | Via ecosystem | App-defined | Namespace patterns | LangGraph-native primitives |

## Benchmark reality

### Munin's defensible current numbers

On the corrected per-question-isolated LongMemEval-S retrieval proxy (500
questions, 23,854 session entries, raw runner, MiniLM fp32):

| Mode | R@1 | R@5 | R@10 | R@20 | MRR | p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| Lexical | 56.7% | 89.0% | 92.0% | 92.0% | 91.4% | 27 / 41 ms |
| Hybrid | 54.2% | **92.2%** | **96.6%** | **96.6%** | 90.6% | 95 / 118 ms |

Sources: [experiment methodology](../benchmark/experiment-matrix.md), [hybrid report](../benchmark/reports/report-2026-06-28T18-04-02.json), [lexical report](../benchmark/reports/report-2026-06-28T16-59-32.json).

This is **session retrieval recall**, not end-to-end answer accuracy. It must not
be plotted next to Mem0's 94.4, Zep's 90.2, Honcho's 90.4, or MemClaw's 72.5 as
if they were the same metric. Munin's small answer-quality experiments are not
large or stable enough for a market claim.

Munin does have credible non-headline evidence:

- On-hardware ARM64 cgroup testing found q8 MiniLM at roughly 91–99 MB peak anon
  under concurrent load, fp32 at about 221–230 MB, and lexical-only around 13 MB.
  See [RAM-fit findings](../benchmark/ramfit/FINDINGS.md).
- A production health snapshot generated 2026-07-21 reported 8,710 entries,
  1,070 namespaces, 517,542 retrievals over 30 days, 100% embedding coverage,
  zero queued/failed embeddings, healthy complete consolidation, 739
  classification redactions, and 342 cross-zone blocks over 30 days. This is
  meaningful dogfood evidence, though not a public comparative benchmark.

### Why the market leaderboard is unreliable

Vendor scores differ in ingestion method, reader and judge model, retrieved-token
budget, top-k, prompts, dataset revision, and whether the number is retrieval,
F1, or judged answer accuracy. The benchmark owners and several vendors now say
LoCoMo and LongMemEval are approaching saturation or reward context stuffing.

The stronger 2026 evaluation direction is highly relevant to Munin:

- [LongMemEval-V2](https://arxiv.org/abs/2605.12493) evaluates whether memories
  turn agent trajectories into useful environment experience across as many as
  115M tokens.
- [GroupMemBench](https://arxiv.org/abs/2605.14498) finds the strongest tested
  group-memory system at only 46.0% and BM25 equal to or better than most systems;
  speaker attribution and knowledge updates remain weak.
- [MemEvoBench](https://arxiv.org/abs/2604.15774) tests long-horizon behavioral
  drift from poisoned memory, noisy tools, and biased feedback; static prompt
  defenses were insufficient.
- [ArgusFleet](https://arxiv.org/abs/2606.24535) demonstrates that governance
  invariants need live leakage, provenance, contradiction, and propagation probes.

Munin should compete on this next evaluation generation, not chase a cosmetically
higher LoCoMo number.

## Cost position

Munin's software and local retrieval cost $0. Optional consolidation is the only
normal model-dependent server cost and can use a local OpenAI-compatible endpoint.
The real cost is operator time: installation, TLS/reverse proxy, credentials,
backups, restores, monitoring, and upgrades.

This means "free" is not enough as positioning. Competitor hosted plans start at
$0–$20/month, which is cheap relative to engineering time. Munin must win on
**ownership, privacy, governance, provider portability, predictable local
operation, and no per-memory rent**. Then it must reduce setup and maintenance
enough that those benefits are not erased by operator burden.

## What to borrow

### P0 — do next

1. **A public, apples-to-apples evaluation suite.** Run the full 500-question
   end-to-end LongMemEval-S with a pinned reader/judge and token budget; add BEAM
   or LongMemEval-V2; then add GroupMemBench/MemEvoBench and ArgusFleet-style
   authorization/provenance probes. Report ingestion time/cost, answer accuracy,
   retrieved tokens, p50/p95, RAM, disk, and degraded modes. Where licenses and
   cost allow, run Mem0, Hindsight, Graphiti, and Munin through the same harness.

2. **Five-minute onboarding.** One command should install, create a
   local principal, configure the selected MCP client, run a health check, and
   demonstrate the first write→resume loop. Make the first embedding download
   explicit, or complete first success in lexical mode and enable embeddings
   afterward.

3. **Validate the shipped review inbox over `memory_extract`.** Munin now
   persists bounded principal-scoped proposals, shows exact source/precondition
   context, supports edit/decline/approve and reviewed correction-based undo,
   and applies with CAS without silent writes. The next question is measured
   dogfood value, not another proposal mechanism.

4. **Measure and simplify the remaining agent-facing friction.** Munin already
   ships task-level `memory_orient`, `memory_resume`, and `memory_handoff` tools.
   Measure real tool-choice failures, then add the smallest missing context-pack
   contract instead of reflexively adding more front doors to the 24-tool catalog.

### P1 — high-value extensions

5. **Temporal supersession without a knowledge graph.** Add `valid_from`, an
   explicit `supersedes` link, and as-of reads/history. Preserve immutable logs
   and CAS. This captures most of Graphiti/MemClaw's operational value without
   Neo4j or LLM mutation on every write.

6. **Token-budgeted, explainable context packs.** Return a ready-to-use bundle
   with source IDs, relevance/freshness components, validity, authorization
   scope, and why each item was included. Borrow Hindsight/Zep's context assembly
   and Supermemory's aggregation, while keeping provenance.

7. **Portable interchange and migration.** Define a versioned format that
   preserves state, logs, audit history, classifications, provenance, validity,
   IDs, and principal ownership. Keep it separate from installation UX and from
   the authoritative encrypted SQLite backup/restore path.

8. **Thin Python/TypeScript clients.** They can wrap MCP/HTTP rather than create a
   second semantic API. This expands adoption without turning Munin into a generic
   developer platform.

9. **Lightweight entity/alias matching.** Mem0's third retrieval signal is a good
   first move. Normalize names and aliases and use them as an exact/entity boost.
   Only graduate to typed relationships if real Munin queries prove the need.

10. **A thin local inspection surface.** Search, browse state/history, review
    suggestions, explain retrieval, correct with CAS, inspect sharing, and export.
    Do not build a general chat or document product.

### P2 — evidence-gated

11. **Per-principal retrieval adaptation.** Start with explicit configured
    preferences and audit/rollback. Only build learned proposals and shadow-mode
    tuning if end-to-end error analysis demonstrates that per-principal ranking
    differences are a recurring failure mode. Do not optimize the retrieval
    layer simply because the telemetry exists.

## What Munin should hone

1. **Operational memory, not transcript recall.** Project state, decisions,
   commitments, blockers, handoffs, narrative, and attention are a coherent
   product category the benchmark leaders largely do not serve.
2. **Current truth versus historical evidence.** Make the state/log split and
   human-grounded synthesis the center of the message and UI.
3. **Sovereign governed sharing.** Provider-neutral MCP, small-group/agent
   least privilege, transport classification, local data, and auditable actions
   are a stronger moat than another retrieval algorithm.
4. **Memory is data, never commands.** This becomes more valuable as competitors
   add automatic rule/skill/prompt evolution. Productize the safety property and
   prove it with MemEvoBench-style tests.
5. **Serious memory on modest hardware.** Frame the Pi/ARM work as low-cost,
   reliable, private infrastructure—not as a hobbyist benchmark.
6. **Real-world dogfood.** Publish privacy-safe operational evidence: months of
   use, recovery incidents, scale, cross-client handoffs, prevented leaks, and
   examples where preserved rationale changed an outcome.

## What to spend less time on

1. **A full temporal knowledge graph.** Zep, MemClaw, Cognee, and Hindsight are
   already committed here. Munin can capture the valuable 20%—supersession,
   provenance, entity aliases—without the operational and security surface.
2. **More retrieval micro-tuning before end-to-end evidence.** R@10 is already
   strong. The bottleneck is query/tool use, context assembly, answer quality, and
   outcome measurement.
3. **More MCP tools.** Twenty-four is enough. Improve discoverability, task-level
   recipes, and composite context packs.
4. **Further artificial RAM-floor proofs.** Semantic fit is established. Test the
   real appliance experience: install, cold start, SD wear, power, Wi-Fi failure,
   backup restore, upgrades, and recovery.
5. **Broad document connectors and multimodal ingestion.** Supermemory and Cognee
   own that race. Build migration/import portability, not another warehouse.
6. **Autonomous mutation, decay, or self-evolving rules.** Keep review, CAS,
   provenance, and explicit owner control. Automatic extraction may propose;
   it should not silently redefine truth or policy.
7. **A full agent runtime.** Letta owns context paging and agent self-management.
   Munin wins by remaining the portable memory plane across runtimes.
8. **Managed SaaS for now.** A hosted service would dilute the sovereignty wedge
   and add a second operational business. First make self-hosting appliance-easy;
   later consider paid support, managed updates, or a hardware/software bundle.

## Recommended 90-day sequence

1. **Weeks 1–3:** freeze and publish the Munin end-to-end evaluation protocol;
   run the complete LongMemEval-S suite with cost/token/latency reporting. Keep
   competitor adapters as a later, challengeable phase under a neutrality policy.
2. **Weeks 1–4:** in parallel, ship the one-command first-success path and publish
   a reproducible privacy-safe dogfood/TCO case study.
3. **Weeks 3–6:** implement temporal validity/supersession and define the
   downstream resume-quality outcome metric in #186.
4. **Weeks 5–9:** add the review inbox with write-time validation, retention,
   provenance, CAS, and correction semantics from the prior step.
5. **Weeks 7–12:** build portable interchange and the smallest token-budgeted
   context receipt justified by the benchmark and tool-choice evidence.

Per-principal learned tuning is outside the default 90-day plan. It proceeds only
if the evaluation/error analysis shows it addresses a material failure mode.

The decision gate after 90 days should be outcome-based: can a fresh client resume
real work faster, with fewer corrections and no trust-boundary regressions? If yes,
Munin has a differentiated product. If not, more retrieval machinery is unlikely to
fix the product.

## Research notes and limitations

- Prices and product surfaces were checked on 2026-07-22 and will change.
- Benchmark claims are attributed to their publishers unless explicitly called
  independent. Open-sourcing a harness improves reproducibility but does not make
  vendor-selected configurations neutral.
- GitHub stars are adoption signals, not quality measures, and were used only as
  secondary context.
- Platform-native memories from OpenAI, Anthropic, and Google are major substitutes
  but were excluded from the top ten because they are not portable standalone
  memory layers. Their distribution makes Munin's provider portability more—not
  less—important.
