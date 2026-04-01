# Competitive Analysis: AI Memory Tools

> Generated: 2026-04-01 | Research spike for munin-memory

---

## Executive Summary

The AI memory tool landscape has matured rapidly through 2025–2026, converging on hybrid architectures that combine vector search, graph relationships, and key-value storage. Munin Memory occupies a distinctive niche: **MCP-native, SQLite-backed, self-hosted, single-user-first** — a sovereignty-first design that no other tool in this survey replicates. Since this spike began, Munin has already landed conservative recency-aware reranking, soft expiry for state entries via `valid_until`, and the `munin-admin` principal-management CLI. The principal remaining gaps are graph/temporal history beyond soft expiry (Zep's killer feature), automatic memory extraction from conversation text (mem0, Zep, LangMem), and richer entity/relationship modeling. These gaps are still addressable within the current SQLite + MCP architecture, but they are now clearly Phase 2+ work rather than missing groundwork.

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
| Temporal validity windows | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Memory decay / forgetting | Partial | ✅ | ✅ | ❌ | ❌ | Partial | ❌ |
| Markdown / human-readable store | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Auth & Security** | | | | | | | |
| OAuth 2.1 (PKCE, dynamic reg.) | ✅ | ❌ | ❌ | ❌ | Partial | ❌ | ❌ |
| Bearer token auth | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ❌ |
| Multi-principal access control | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Secret-pattern write rejection | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| OAuth client secrets encrypted at rest | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Observability** | | | | | | | |
| Outcome-aware retrieval analytics | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Learned reranking from outcomes | ❌(P2) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Web UI / dashboard | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Admin CLI | ✅ | ✅ | ✅ | ✅ | ✅ | N/A | ❌ |
| **Developer ergonomics** | | | | | | | |
| Compare-and-swap (CAS writes) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Computed project dashboard | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Maintenance suggestions | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-agent / multi-user | Partial | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## Gap Analysis

### Features We're Missing

#### 1. Temporal History / Fact Invalidation Beyond Soft Expiry *(Zep's killer feature)*

Zep stores when a fact became true and when it was superseded — so a query can ask "what was true on date X?" rather than only "what is true now?" Munin now supports **soft expiry** via `valid_until`, so outdated temporary state can fall out of default retrieval without being deleted. What it still does not support is historical truth reconstruction: no `valid_from`, no "as of" query surface, and no structured record of when a state fact became superseded.

**Why it matters:** Soft expiry solves the operational problem of temporary context lingering forever, but it does not answer historical questions about durable facts such as old addresses, prior roles, or what a project status looked like last month.

**Feasibility in our architecture:** Medium-Large. SQLite can support `valid_from` / `valid_until` or a versioned state history table, but the query semantics and write model are meaningfully more complex than the shipped `valid_until` filter.

#### 2. Automatic Memory Extraction from Conversation *(mem0, Zep, LangMem)*

All three major cloud platforms automatically extract structured memories from raw conversation text using an LLM pass. The agent doesn't have to explicitly call `memory_write` — the memory layer infers what to remember. Munin is entirely agent-driven: Claude decides what to write and how to structure it.

**Why it matters:** For naive or lightly-prompted agents, important information can slip past without explicit write calls. Auto-extraction lowers the barrier and catches more signal.

**Feasibility:** Medium. This is fundamentally a prompt-engineering concern on the Claude side, not infrastructure. However, Munin could offer an optional tool (e.g., `memory_extract`) that accepts raw conversation text and suggests write operations — implemented as a thin prompt wrapper, no new backend needed. The LLM does the extraction work.

#### 3. Adaptive Memory Decay / Learned Ranking *(mem0, Zep, emerging research)*

Current Munin retrieval now applies **conservative recency-aware reranking** and filters soft-expired state by default. That closes the basic freshness gap, but it is still a static model. It does not yet learn from retrieval outcomes, use access frequency, or adapt decay behavior by query class or namespace. Recency-weighted scoring remains one of the most-requested patterns in 2025–2026 AI memory forums and is standard in mem0 and Zep.

**Why it matters:** Basic freshness is now handled, but the next quality step is making reranking more context-sensitive so "old but foundational" does not get penalized the same way as stale tactical notes.

**Feasibility:** Small-Medium. This remains a retrieval-layer change. The new `search_recency_weight` hook and retrieval metadata provide a clean place to experiment with stronger or learned decay policies.

#### 4. Entity / Relationship Graph Index *(mem0 graph, Zep Graphiti, MCP reference server)*

Munin has hierarchical namespaces and tag cross-references, but no first-class entity model and no relationship traversal. The MCP reference server, mem0, and Zep all store typed relationships between entities (e.g., `[Magnus] --works_at--> [Gillearna AB]`).

**Why it matters:** Currently, connecting related facts requires either namespace co-location or tag lookups — both are lossy. A lightweight entity index would enable "what do I know about Person X?" queries that traverse linked facts automatically.

**Feasibility:** Large. sqlite-vec is already loaded; we could add a separate `entities` + `entity_relations` table. This is architecturally additive but requires new tool surface area and careful design to avoid scope creep. Worth a design spike.

#### 5. Web UI / Inspection Dashboard *(Letta, Zep, Khoj, mem0)*

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

7. **Admin CLI for principals and OAuth clients.** `munin-admin` makes multi-principal provisioning, token rotation, namespace-rule testing, and OAuth-client cleanup operational without direct SQLite manipulation. That closes a practical gap between the access-control model and day-to-day use.

8. **Secret-pattern write rejection.** Every write is scanned for API keys, tokens, passwords, and private keys before storage. Competitors do not surface this as a feature — it's a silent gap in their security models.

9. **Tiered hardware profiles (zero-appliance / full-node).** Explicit support for Pi Zero 2 W–class targets — semantic features gracefully disabled, core memory operational. No other tool in this survey targets sub-1W edge hardware.

10. **Computed project dashboard and maintenance suggestions.** `memory_orient` returns a living project dashboard, maintenance alerts (stale statuses, upcoming events, missing lifecycle tags, and now expiring or expired tracked work), and curated notes in one call. This is highly tailored to the "memory as a second brain for work" use case — no competitor offers analogous tooling.

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

Prioritized by combined impact × feasibility, constrained to our SQLite + MCP-native architecture, and updated for the Phase 1 work now landed.

### 1. `memory_extract` Tool — Conversation-to-Memory Pipeline

**What:** Add a `memory_extract` MCP tool that accepts `conversation_text` (raw transcript) and returns a structured list of suggested `memory_write` / `memory_log` calls for Claude to review and execute. The extraction logic is a prompted LLM call — Munin supplies the prompt template; the MCP client's LLM does the work (no external API call from Munin itself).

**Rationale:** This is still the biggest workflow gap versus mem0/Zep/LangMem. Claude already does some of this implicitly; making it explicit gives a reviewable, structured interface without making Munin depend on an external model API.

**Impact:** Medium-High — reduces dropped signal in long or lightly-structured conversations.
**Feasibility:** Medium — prompt and response-shape design matter more than backend complexity.
**Effort:** M

---

### 2. Lightweight Entity Index

**What:** Add `entities` (id, name, type, namespace, description) and `entity_mentions` (entry_id, entity_id) tables via a new migration. Expose `memory_entity_link` (create/update entity), `memory_entity_get` (retrieve with linked entries), and surface entity hits in `memory_query` results. Start with manual entity linking (Claude tags entries), not auto-extraction.

**Rationale:** This addresses the most significant structural gap vs. mem0 graph and Zep Graphiti without jumping straight to a full temporal knowledge graph. A lightweight entity index would materially improve "what do I know about X?" retrieval and cross-entry traversal.

**Impact:** High long-term — enables richer second-brain queries than namespace/tag heuristics alone.
**Feasibility:** Medium — additive schema, but requires careful tool-surface design.
**Effort:** L

---

### 3. Adaptive Recency from Retrieval Outcomes

**What:** Extend the new recency-aware reranker so decay is influenced by retrieval outcomes, namespace type, or query class instead of a single static freshness curve. Keep `search_recency_weight` as the control surface, but make the backend smarter about when freshness should matter more or less.

**Rationale:** Phase 1 solved the baseline freshness problem. The next step is quality, not capability: preserve stable foundational knowledge while continuing to suppress stale tactical noise.

**Impact:** Medium-High — improves search quality without increasing tool surface area.
**Feasibility:** Medium — uses infrastructure already present in retrieval events and outcomes.
**Effort:** M

---

### 4. Temporal History Beyond Soft Expiry

**What:** Explore a versioned-state or validity-range model that can answer "what was true on date X?" without discarding the simpler current write path for ordinary state entries.

**Rationale:** `valid_until` solves temporary-context expiry, but it intentionally stops short of temporal knowledge-graph semantics. Historical truth queries remain one of the clearest product gaps versus Zep.

**Impact:** High long-term — unlocks a qualitatively different class of memory queries.
**Feasibility:** Medium-Large — design work matters more than schema plumbing.
**Effort:** L

---

## Not Recommended (Now)

- **Full temporal knowledge graph (Graphiti-style):** L-XL effort; would require Neo4j or a significant SQLite schema expansion. The shipped `valid_until` approach already gives much of the immediate user-facing value at a fraction of the cost.
- **Web UI:** XL effort; outside scope for personal/homelab deployment. MCP tool surface (`memory_orient`, `memory_insights`) is the right interface for LLM consumers.
- **Auto-extraction via external LLM API:** Adds a hard dependency on an external API, contradicts the sovereignty-first design, and raises cost/privacy concerns. A `memory_extract` tool can achieve most of the value without this dependency.
- **Managed cloud service:** Outside the project's mission. Sovereignty is the differentiator.

---

*Research conducted April 2026. Tool capabilities and star counts reflect available data at time of writing. Community statistics are approximate.*
