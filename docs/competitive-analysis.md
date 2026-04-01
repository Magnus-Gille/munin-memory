# Competitive Analysis: AI Memory Tools

> Generated: 2026-04-01 | Research spike for munin-memory

---

## Executive Summary

The AI memory tool landscape has matured rapidly through 2025–2026, converging on hybrid architectures that combine vector search, graph relationships, and key-value storage. Munin Memory occupies a distinctive niche: **MCP-native, SQLite-backed, self-hosted, single-user-first** — a sovereignty-first design that no other tool in this survey replicates. The principal gaps are graph/temporal memory (Zep's killer feature), automatic memory extraction from conversation text (mem0, Zep, LangMem), and memory decay in retrieval ranking. These gaps are real but addressable within our existing architecture. The most impactful near-term investments are (1) surfacing staleness as a retrieval signal (Phase 2 of the existing outcome-aware pipeline), (2) adding temporal validity windows to state entries, and (3) an admin CLI for principal management — all feasible without leaving SQLite or MCP.

---

## Tools Surveyed

### 1. mem0

**Repository:** github.com/mem0ai/mem0 | **Stars:** ~48,000 | **Language:** Python + JS

**Key features:**
- Automatic memory extraction: on every message pair, an LLM extraction phase identifies salient facts and chooses ADD / UPDATE / DELETE / NOOP against the existing memory store
- Multi-level scoping: user-level, session-level, and agent-level memory with no cross-contamination
- Multi-store architecture: vector search + knowledge graph + key-value, all unified behind one API
- Graph memory variant for complex relational structures between entities
- Managed cloud (mem0.ai) + open-source library

**Architecture:**
- Python core, REST API, SDKs for Python and JavaScript
- Pluggable backends: vector DB (Qdrant, Chroma, Pinecone, etc.), graph DB (Neo4j), key-value (Redis)
- Cloud: SOC 2 & HIPAA compliant, BYOK, memory versioning and audit trail

**Community traction:**
- ~48,000 GitHub stars; 14 million library downloads
- AWS chose mem0 as the exclusive memory provider for their Agent SDK
- Academic paper published (arXiv 2504.19413) with 26% accuracy improvement benchmark

**Unique capabilities vs munin-memory:**
- LLM-driven automatic extraction and de-duplication of memories
- Explicit graph memory for entity relationships
- Production-grade cloud with compliance certifications
- Multi-agent and multi-user memory in one store
- 90%+ token cost savings via memory compression in context

---

### 2. Zep

**Repository:** github.com/getzep/zep + github.com/getzep/graphiti | **Language:** Python

**Key features:**
- **Temporal knowledge graph (Graphiti):** facts carry validity windows — when information changes, the old fact is invalidated (not deleted), enabling queries like "what was true on date X?"
- Context assembled from multiple sources: chat history, business data, documents, app events
- Dialog classification, structured data extraction, fact table construction — all automatic
- Sub-200ms retrieval latency
- 94.8% DMR benchmark accuracy; 18.5% accuracy improvement vs baseline

**Architecture:**
- Core open-source component is `graphiti` (temporal KG engine), BSD licensed
- Zep Cloud is the managed offering; the Community Edition (self-hosted server) was deprecated in 2025 and moved to a `legacy/` folder
- Graphiti supports both unstructured conversational data and structured business data with prescribed or learned ontology

**Community traction:**
- Graphiti repo: ~7,000 stars and actively maintained
- Academic paper: arXiv 2501.13956 "Zep: A Temporal Knowledge Graph Architecture for Agent Memory"
- LangChain integration maintained

**Unique capabilities vs munin-memory:**
- Temporal fact validity (not just "what is true now" but "what was true when")
- Automatic construction of entity relationship graphs from conversation
- Multi-hop graph queries across entity relationships
- Structured data extraction with user-defined schemas

---

### 3. Letta (formerly MemGPT)

**Repository:** github.com/letta-ai/letta | **Stars:** ~21,600 | **Language:** Python

**Key features:**
- **LLM-as-OS paradigm:** the agent actively manages its own memory, moving data between virtual context (everything available) and physical context (actual context window), analogous to OS virtual memory
- Tiered memory: in-context working memory, archival storage (vector-searchable), recall storage (conversation history)
- Self-editing memory: agents use tool calls to read/write/summarize their own memory blocks
- Persistent agents as long-running services (not stateless calls)
- Git-backed memory, skills, and subagents (Letta Code)
- Agent Development Environment: graphical web UI for inspecting and debugging agent state
- Letta Evals: open-source evaluation framework for stateful agents

**Architecture:**
- Python server with REST API + Python/TypeScript SDKs
- PostgreSQL (production) or SQLite (local dev) backend
- Stateful agents persist identity, memory, and skill sets across calls
- Model-agnostic: any LLM provider

**Community traction:**
- 21,600 GitHub stars; Felicis seed-funded
- DeepLearning.AI partnered course on Letta
- #1 model-agnostic on Terminal-Bench coding benchmark (Letta Code)

**Unique capabilities vs munin-memory:**
- Agents that autonomously manage their own memory (no human-in-the-loop for memory curation)
- Web UI / Agent Development Environment for observability
- Multi-agent coordination with shared memory pools
- Self-improving agents (memory reflects learned behavior over time)

---

### 4. Khoj

**Repository:** github.com/khoj-ai/khoj | **Language:** Python | **Last updated:** March 2026

**Key features:**
- "AI second brain" — personal knowledge assistant that ingests documents (PDF, Markdown, Org-mode, Word, Notion) and the web
- Multi-LLM: works with any local (Ollama, llama3, qwen, mistral) or cloud LLM (GPT, Claude, Gemini)
- Scheduled automations and deep research tasks
- Multi-platform access: browser, Obsidian plugin, Emacs, desktop app, mobile, WhatsApp
- Custom agents with persona, knowledge base, and tool set
- Full self-hosting via Docker or pip; optional cloud service

**Architecture:**
- Python/Django backend; modular plugin architecture for data sources and frontends
- Vector search over ingested documents
- LLM-agnostic via API abstraction
- Web UI included

**Community traction:**
- Actively maintained (last release March 2026)
- Large community via Obsidian integration (popular Obsidian plugin)
- Self-hosting community support

**Unique capabilities vs munin-memory:**
- Document ingestion from many formats and live web search
- Scheduled autonomous research (not just reactive retrieval)
- Multi-platform native clients (mobile, WhatsApp, Obsidian)
- LLM-agnostic by design — not Claude-specific

---

### 5. LangMem (LangChain)

**Repository:** github.com/langchain-ai/langmem | **Language:** Python

**Key features:**
- Procedural, episodic, and semantic memory types, each with appropriate storage and retrieval strategies
- Memory tools: `create_manage_memory_tool` (write) and `create_search_memory_tool` (read) — agent-facing, no human loop
- Prompt optimization: `metaprompt`, `gradient`, and simple algorithms for rewriting system prompts based on accumulated experience
- Two-layer architecture: stateless Core API (portable) + hot-path Processing (LangGraph-integrated)
- Namespace isolation for multi-user/tenant separation

**Architecture:**
- Pure Python library — not a server, not a protocol
- Pluggable storage: integrates with LangGraph's storage layer, or any custom store
- Not LangChain-dependent despite the name; usable standalone

**Community traction:**
- Official LangChain project; MongoDB integration for production deployments
- Positioned as the memory solution within the large LangGraph/LangChain ecosystem

**Unique capabilities vs munin-memory:**
- Prompt optimization — learns to update the agent's system prompt over time
- Episodic memory type (conversation-level, time-bounded episodes)
- Flexible backend: attach to any storage system

---

### 6. basic-memory

**Repository:** github.com/basicmachines-co/basic-memory | **Stars:** ~2,700 | **Language:** Python

**Key features:**
- **Markdown-first:** knowledge is stored as plain Markdown files on disk — human-readable, Git-compatible, no proprietary format lock-in
- MCP-native: designed as a Model Context Protocol server (like munin-memory)
- Hybrid search: full-text + vector similarity (FastEmbed embeddings)
- Schema system: `schema_infer`, `schema_validate`, `schema_diff` tools for validating knowledge base structure
- Per-project cloud routing: individual projects can be routed through cloud while others stay local
- FastMCP 3.0, auto-update CLI

**Architecture:**
- Python, local-first, files on disk
- SQLite index for search; Markdown files as source of truth
- Stdio MCP transport

**Community traction:**
- ~2,700 GitHub stars; Discord community
- Active development through 2025–2026; FastMCP 3.0 upgrade recent

**Unique capabilities vs munin-memory:**
- Human-readable Markdown storage (trivially Git-commitable, diffable, portable)
- Schema validation for knowledge base structure
- Source-of-truth is files, not a database — survives database corruption

---

### 7. Official MCP Knowledge Graph Memory Server

**Repository:** github.com/modelcontextprotocol/servers (src/memory) | **Language:** TypeScript

**Key features:**
- Reference implementation bundled with the MCP servers monorepo
- Knowledge graph model: entities + relations + observations
- CRUD operations on entities and their relationships
- JSON Lines file storage (not SQLite)
- Docker or npm deployment

**Community traction:**
- Bundled with the reference MCP servers; well-known starting point
- Low stars of its own (part of parent repo ~40,000 stars)

**Unique capabilities vs munin-memory:**
- Entity-relation model (graph primitives baked in)
- Simpler architecture — suitable for learning/prototyping

---

## Feature Comparison

| Feature | Munin | mem0 | Zep | Letta | Khoj | LangMem | basic-memory |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Protocol** | | | | | | | |
| MCP-native (stdio + HTTP) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| REST API | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Python/JS library | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| **Deployment** | | | | | | | |
| Self-hosted / local-first | ✅ | Partial | Deprecated | ✅ | ✅ | Library | ✅ |
| Single-file SQLite backend | ✅ | ❌ | ❌ | Partial | ❌ | ❌ | ❌ |
| ARM64 / Raspberry Pi support | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Managed cloud option | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | Partial |
| **Search** | | | | | | | |
| Keyword / FTS search | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Vector / semantic search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid search (RRF fusion) | ✅ | ✅ | ✅ | ✅ | Partial | ✅ | ✅ |
| **Memory model** | | | | | | | |
| State entries (mutable K/V) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Log entries (append-only) | ✅ | ❌ | ❌ | Partial | ❌ | ❌ | ❌ |
| Hierarchical namespaces | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | Partial |
| Auto-extraction from conversation | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Graph / entity relationships | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Temporal validity windows | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Memory decay / forgetting | ❌ | ✅ | ✅ | ❌ | ❌ | Partial | ❌ |
| Markdown / human-readable store | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Auth & Security** | | | | | | | |
| OAuth 2.1 (PKCE, dynamic reg.) | ✅ | ❌ | ❌ | ❌ | Partial | ❌ | ❌ |
| Bearer token auth | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ❌ |
| Multi-principal access control | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Secret-pattern write rejection | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| OAuth client secrets encrypted at rest | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Observability** | | | | | | | |
| Outcome-aware retrieval analytics | ✅(P1) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Learned reranking from outcomes | ❌(P2) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Web UI / dashboard | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Admin CLI | ❌(P2) | ✅ | ✅ | ✅ | ✅ | N/A | ❌ |
| **Developer ergonomics** | | | | | | | |
| Compare-and-swap (CAS writes) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Computed project dashboard | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Maintenance suggestions | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-agent / multi-user | Planned | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## Gap Analysis

### Features We're Missing

#### 1. Temporal Validity / Fact Invalidation *(Zep's killer feature)*

Zep stores when a fact became true and when it was superseded — so a query can ask "what was true on date X?" rather than only "what is true now?" Munin state entries are simply overwritten on every write; the old value is gone. We do have append-only log entries, but they are unstructured history, not a queryable temporal index on state.

**Why it matters:** For personal memory, outdated facts (old addresses, stale job titles, superseded decisions) currently persist with equal weight to current facts. Temporal validity would let retrieval surface freshness and let users query historical state.

**Feasibility in our architecture:** Medium. SQLite supports adding `valid_from` / `valid_until` columns to state entries. Retrieval queries would need an additional filter/boost. The CAS machinery already tracks `updated_at`; extending to a temporal index is achievable without changing the fundamental model.

#### 2. Automatic Memory Extraction from Conversation *(mem0, Zep, LangMem)*

All three major cloud platforms automatically extract structured memories from raw conversation text using an LLM pass. The agent doesn't have to explicitly call `memory_write` — the memory layer infers what to remember. Munin is entirely agent-driven: Claude decides what to write and how to structure it.

**Why it matters:** For naive or lightly-prompted agents, important information can slip past without explicit write calls. Auto-extraction lowers the barrier and catches more signal.

**Feasibility:** Medium. This is fundamentally a prompt-engineering concern on the Claude side, not infrastructure. However, Munin could offer an optional tool (e.g., `memory_extract`) that accepts raw conversation text and suggests write operations — implemented as a thin prompt wrapper, no new backend needed. The LLM does the extraction work.

#### 3. Memory Decay / Staleness in Retrieval Ranking *(mem0, Zep, emerging research)*

Current munin retrieval (FTS5 + vector KNN + RRF) treats a 3-year-old entry identically to one written yesterday. Recency-weighted scoring — multiplying semantic similarity by a time-decay factor — is the most-requested pattern in 2025–2026 AI memory forums and is standard in mem0 and Zep.

**Why it matters:** Stale entries pollute retrieval. `memory_orient` already flags staleness as a maintenance concern, but this is advisory (user must act), not automatic (system deprioritizes stale entries in ranking).

**Feasibility:** Small-Medium. This is a retrieval-layer change. We already collect `updated_at` timestamps. Adding a time-decay multiplier to the RRF score (configurable decay half-life) is a contained change to `db.ts` query logic. Phase 2 of the existing outcome-aware retrieval pipeline is the natural home for this.

#### 4. Admin CLI for Principal Management *(already Phase 2 in roadmap)*

All mature tools ship a CLI for managing users, agents, scopes, and credentials. Munin requires manual SQLite inserts to provision principals — noted as Phase 2 in the access control implementation.

**Why it matters:** Makes multi-user (Sara onboarding, agent provisioning) practical without database spelunking. Without this, multi-principal is a paper feature.

**Feasibility:** Small. The schema and enforcement are already implemented (migration v5). This is pure CLI plumbing on top of existing DB operations.

#### 5. Entity / Relationship Graph Index *(mem0 graph, Zep Graphiti, MCP reference server)*

Munin has hierarchical namespaces and tag cross-references, but no first-class entity model and no relationship traversal. The MCP reference server, mem0, and Zep all store typed relationships between entities (e.g., `[Magnus] --works_at--> [Gillearna AB]`).

**Why it matters:** Currently, connecting related facts requires either namespace co-location or tag lookups — both are lossy. A lightweight entity index would enable "what do I know about Person X?" queries that traverse linked facts automatically.

**Feasibility:** Large. sqlite-vec is already loaded; we could add a separate `entities` + `entity_relations` table. This is architecturally additive but requires new tool surface area and careful design to avoid scope creep. Worth a design spike.

#### 6. Web UI / Inspection Dashboard *(Letta, Zep, Khoj, mem0)*

Letta's Agent Development Environment lets developers inspect agent memory state, edit memory blocks, replay sessions, and debug retrieval. Munin has `memory_orient` and `memory_insights` as CLI/LLM tools, but no browser-based view.

**Why it matters:** For onboarding family members or debugging retrieval quality, a visual interface is much more accessible than MCP tool calls.

**Feasibility:** Large-XL. Requires a separate frontend project. Not well-suited to the single-user-first architecture — medium-term, not short-term.

---

### Features We Do Better

1. **MCP-native, protocol-first design.** Munin is designed from the ground up as an MCP server — not an adapter or a bolt-on. The tool surface, error messages, and conventions are all optimized for LLM consumption. No competitor in this survey is MCP-native except basic-memory.

2. **Single-file SQLite zero-ops backend.** A single `.db` file on a Raspberry Pi SD card, with no external services, no network databases, no Docker Compose stacks. Every competitor requires Redis, Postgres, Neo4j, Qdrant, or a cloud subscription. This is a genuine differentiator for personal/homelab deployment.

3. **Append-only log entries as a first-class primitive.** Munin models memory as two distinct types: mutable state and immutable history. No other tool surveyed has explicit append-only log entries — they either overwrite state or rely on embeddings of conversation turns. Logs are ideal for decision history, event timelines, and audit trails.

4. **Compare-and-swap (optimistic locking) on status writes.** `expected_updated_at` prevents blind overwrites in concurrent environments. No other tool surveyed offers this at the memory API level — it's a database-level concern elsewhere.

5. **Outcome-aware retrieval analytics (Phase 1).** Munin passively records retrieval events and follow-through actions (opened, wrote to namespace, reformulated query). This is the foundation for learned reranking — a capability none of the surveyed tools implement at the MCP layer. mem0 mentions memory versioning; Zep tracks fact provenance; but neither instruments retrieval outcomes.

6. **OAuth 2.1 with dynamic client registration and PKCE.** Munin supports Claude.ai and Claude Mobile connecting via standard OAuth flows, encrypted client secrets at rest, and a hardened consent page. This enables sovereign, cloud-ai-connected memory without exposing a raw API key — no comparable tool offers this.

7. **Secret-pattern write rejection.** Every write is scanned for API keys, tokens, passwords, and private keys before storage. Competitors do not surface this as a feature — it's a silent gap in their security models.

8. **Tiered hardware profiles (zero-appliance / full-node).** Explicit support for Pi Zero 2 W–class targets — semantic features gracefully disabled, core memory operational. No other tool in this survey targets sub-1W edge hardware.

9. **Computed project dashboard and maintenance suggestions.** `memory_orient` returns a living project dashboard, maintenance alerts (stale statuses, upcoming events, missing lifecycle tags), and curated notes in one call. This is highly tailored to the "memory as a second brain for work" use case — no competitor offers analogous tooling.

---

### Emerging Patterns (2025–2026)

Based on the research literature, forums, and blog posts surveyed:

1. **Graph + vector + keyword hybrid architectures** are becoming the standard. Pure vector search is no longer sufficient; temporal and relational graphs are being added everywhere.

2. **Temporal memory** (facts with validity windows) is recognized as the next major unsolved problem after retrieval accuracy. Zep's Graphiti paper (arXiv 2501.13956) is the most-cited recent work.

3. **Memory decay / recency scoring** is widely requested. The pattern: `score = semantic_similarity × exp(-λ × days_since_access)` appears in multiple 2025 blog posts and the MAGMA research paper. Users consistently report frustration with stale entries polluting retrieval.

4. **Auto-extraction is table stakes** for cloud tools but remains rare in self-hosted tools. The pattern of "LLM reads conversation, decides what to remember, calls write tools" is now commoditized via LangMem and mem0.

5. **Multi-agent memory sharing** (with scoped permissions) is the next frontier. Production systems increasingly need one memory store with per-agent namespace isolation — exactly what Munin's access control (Phase 1) lays the groundwork for.

6. **MemOS** (arXiv 2025) proposes treating memory as an operating system concern — a unified memory scheduler across all agent processes. Academic; unlikely to be productized quickly, but signals long-term architectural direction.

7. **MCP as the memory delivery protocol** is gaining traction: basic-memory and the official MCP reference implementation demonstrate that the community is converging on MCP as the right layer for memory access. Munin is ahead of this curve.

8. **Markdown / human-readable storage** is a niche but passionate preference (basic-memory, Obsidian users). The portability and Git-compatibility argument resonates with the self-hosting community.

---

## Recommendations

Prioritized by combined impact × feasibility, constrained to our SQLite + MCP-native architecture.

### 1. Memory Decay in Retrieval Ranking — Phase 2 of Outcome-Aware Pipeline

**What:** Add a time-decay multiplier to the RRF scoring function in `memory_query`. Score = current RRF score × `exp(-λ × days_since_updated)`, with `λ` configurable (or derived from outcome signals as Phase 2 matures). Expose `search_recency_weight` parameter on `memory_query`.

**Rationale:** This is the single most-requested feature in AI memory tooling across forums and research in 2025–2026. We already collect `updated_at` on every entry. The change is contained to `db.ts` and the `memory_query` handler. It directly leverages the `retrieval_events` / `retrieval_outcomes` infrastructure we built in Feature 4.

**Impact:** High — stale entries polluting retrieval is a day-to-day friction point.
**Feasibility:** High — additive change, no schema migration needed.
**Effort:** S

---

### 2. Temporal Validity on State Entries

**What:** Add `valid_until` (nullable timestamp) to state entries. When set, entries past their validity date are excluded from default retrieval (soft-expired) but remain queryable with `include_expired: true`. Surface as a parameter on `memory_write` and as a filter on `memory_query`. Add `expires_soon` to `memory_orient` maintenance suggestions.

**Rationale:** Addresses the core gap vs. Zep's temporal knowledge graph without requiring a full graph engine. Straightforward SQLite migration (add nullable column). Useful for time-bounded facts: meeting prep notes, temporary delegations, event context, project deadlines. Complements the existing staleness maintenance alerts.

**Impact:** High — prevents outdated facts from polluting retrieval without requiring manual cleanup.
**Feasibility:** High — nullable column addition, filter in query logic.
**Effort:** S-M (schema migration + query changes + tool parameter + orient integration)

---

### 3. Admin CLI for Principal Management

**What:** Implement `munin-admin` CLI (Phase 2 boundary already defined in `CLAUDE.md`) with subcommands: `principals list`, `principals add <id> --type <family|agent|external> --namespace-rules <json>`, `principals revoke <id>`, `principals show <id>`. SQLite operations on the existing `principals` table (migration v5).

**Rationale:** Multi-principal access control is fully implemented in the server but requires raw SQL inserts to use. This is a blocker for the Sara onboarding use case and for provisioning agent service tokens. The schema, enforcement, and resolution logic are all done — this is pure CLI plumbing.

**Impact:** Medium-High — unlocks the multi-user/multi-agent use case that is already architecturally ready.
**Feasibility:** High — no new backend logic.
**Effort:** S

---

### 4. `memory_extract` Tool — Conversation-to-Memory Pipeline

**What:** Add a `memory_extract` MCP tool that accepts `conversation_text` (raw transcript) and returns a structured list of suggested `memory_write` / `memory_log` calls for Claude to review and execute. The extraction logic is a prompted LLM call — Munin supplies the prompt template; the MCP client's LLM does the work (no external API call from Munin itself).

**Rationale:** Bridges the gap with mem0/Zep/LangMem automatic extraction without requiring Munin to call an LLM (which would add a dependency). Claude already does this extraction implicitly; making it an explicit tool gives a structured interface and allows the calling agent to batch-review suggestions before committing them.

**Impact:** Medium — reduces friction for memory capture in long conversations.
**Feasibility:** Medium — Munin provides the prompt template and parses the LLM response; the tool output is suggestions, not committed writes (so errors are safe).
**Effort:** M (tool definition, prompt engineering, response parsing, tests)

---

### 5. Lightweight Entity Index

**What:** Add `entities` (id, name, type, namespace, description) and `entity_mentions` (entry_id, entity_id) tables via a new migration. Expose `memory_entity_link` (create/update entity), `memory_entity_get` (retrieve with linked entries), and surface entity hits in `memory_query` results. Start with manual entity linking (Claude tags entries), not auto-extraction.

**Rationale:** Addresses the most significant structural gap vs. mem0 graph and Zep Graphiti. Rather than a full temporal knowledge graph (which is a large, risky rewrite), a lightweight entity index gives 80% of the value: "what do I know about this person/project?" traversal queries. SQLite joins make this efficient. FTS5 already indexes entry content; entity mentions add a structured cross-reference layer.

**Impact:** High long-term — enables richer "second brain" queries.
**Feasibility:** Medium — additive schema change, but requires new tool surface and design discipline to avoid namespace/entity duplication.
**Effort:** L (schema migration, 2-3 new tools, query integration, tests, documentation)

---

## Not Recommended (Now)

- **Full temporal knowledge graph (Graphiti-style):** L-XL effort; would require Neo4j or a significant SQLite schema expansion. The `valid_until` approach (Recommendation 2) gives most of the user-facing value.
- **Web UI:** XL effort; outside scope for personal/homelab deployment. MCP tool surface (`memory_orient`, `memory_insights`) is the right interface for LLM consumers.
- **Auto-extraction via external LLM API:** Adds a hard dependency on an external API, contradicts the sovereignty-first design, and raises cost/privacy concerns. The `memory_extract` tool (Recommendation 4) achieves the goal without this dependency.
- **Managed cloud service:** Outside the project's mission. Sovereignty is the differentiator.

---

*Research conducted April 2026. Tool capabilities and star counts reflect available data at time of writing. Community statistics are approximate.*
