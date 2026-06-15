# State of Memory Systems 2026 → Munin

## Meta-finding: what Munin's architecture lets through the door

Three of Munin's foundational commitments act as a filter that almost every external memory system fails to pass — not because the ideas are bad, but because they presuppose an architecture Munin deliberately rejects:

1. **External server, not an agent runtime.** Munin does not own Claude's context window. It provides *one slot* in a context the MCP host assembles, not the page table. Any mechanism that requires moving content in/out of the live context window mid-turn (MemGPT paging, Letta self-editing blocks) has no insertion point.
2. **Pull-based, never push.** Sessions *query* Munin; Munin never auto-injects into a system prompt. Every system whose headline feature is auto-injection (OpenAI Dreaming V3, Gemini consumer Personal Context) is architecturally opposite — and the security literature now *validates* that stance (Tenable's finding that Dreaming V3's injected-memory channel is a cross-session prompt-injection exfiltration vector).
3. **Stored content is data, never commands; owner-auditable; no autonomous decay.** Any system that lets an LLM silently mutate or delete the store at write time (Mem0 ADD/UPDATE/DELETE, A-MEM retroactive note evolution, MemoryBank Ebbinghaus soft-delete) collides with the constitution and the explicit "everything persists until explicitly deleted" rule.

The recurring pattern: the *conceptual* insight (tiered retrieval, offline consolidation, recency+relevance scoring, attention-position mitigation) almost always already lives in Munin — typically because Munin converged on it independently — while the *mechanism* (an agent loop, a write-time LLM call, an auto-mutating store, a push channel) is exactly the part that doesn't transfer to a pull-based external server. **No source in this harvest produced a mechanism that is simultaneously novel, validated, and transferable.** The adversarial verification list is empty because there were no ADOPT candidates to verify.

---

## ADOPT (verified)

**None.** No source survived to ADOPT; the adversarial codebase-verification queue was empty.

---

## VALIDATE — confirms existing Munin choices, no code change

These sources independently arrive at design decisions Munin already made, and provide theoretical/empirical backing.

- **MemGPT — LLM-as-OS (arXiv 2310.08560, Packer et al. 2023).** The OS-paging loop needs agent-runtime control of the live context window — impossible for an external server. Its transferable core (tiered retrieval, archival compression, attention-position mitigation) is already present: `memory_query` previews + `memory_get` by ID (lazy tiered fetch), the consolidation worker (archival compression analog), boundary serialization (Lost-in-the-Middle). The only additive idea — a within-session `budget_pressure` hint — is low-value because Munin can't observe the real context window and Claude already has that information implicitly.

- **Generative Agents (arXiv 2304.03442, Park et al. 2023).** All three retrieval dimensions map onto existing code: Relevance → sqlite-vec KNN + FTS5 hybrid RRF; Recency decay → `getFreshnessScore()` exponential decay + `search_recency_weight`; Reflection → the consolidation worker (LLM synthesis → `synthesis` key + provenance). Importance scoring doesn't transfer (synchronous LLM call per write violates the better-sqlite3 write path; already approximated by structural heuristics). Access-time recency doesn't transfer — Munin serves discontinuous pull-based sessions where unqueried ≠ forgotten.

- **Sleep-time Compute (arXiv 2504.13171, Lin et al. 2025).** Structurally identical to the consolidation worker: idle-time LLM reasoning over a corpus, pre-computing a `synthesis` that sessions pull instead of re-deriving. Multi-query amortization maps to "one synthesis benefits all later sessions in a namespace." The threshold gate on unincorporated logs already proxies the paper's "query predictability gates efficacy" nuance. Explicit query-prediction prompts would be a net negative for a general-purpose store with diffuse query distribution.

- **A Survey of Memory for Autonomous LLM Agents (arXiv 2603.07670, Du, Mar 2026).** Validates the full Munin stack: FTS5+vector+RRF, boundary serialization, `valid_until` soft expiry, offline consolidation, write-path filtering, synthesis provenance, retrieval analytics. Its primary actionable finding — retrieval-outcome data should feed reranking — is already Munin's planned Feature 4 Phase 2. The two genuinely novel ideas (dual-buffer consolidation probation; AgeMem RL-trained forgetting) are labeled open research challenges with no validated implementation, and the learned-forgetting track needs a training loop Munin doesn't have.

- **OpenAI Dreaming V3 (product, 2026-06-04).** Three sub-mechanisms split three ways: async cross-conversation synthesis → ALREADY_HAVE (consolidation worker); auto system-prompt injection → REJECT, and the Tenable/TechTimes exfiltration finding is *direct empirical validation* of Munin's pull-only stance + `scanForInjection`; temporal restatement → an already-filed-but-unbuilt signal. Nets to VALIDATE: confirms two stances, adds product evidence to one backlog item. (See P3 note below.)

- **Gemini personalization / Memory Bank / CLI Auto Memory (2025–2026).** Consumer auto-injection is architecturally opposite to Munin's pull model (and its most-criticized footgun). ADK Memory Bank's scoped semantic retrieval + TTL + revision history all already exist (multi-principal access, `valid_until`, sqlite-vec, audit/CAS). CLI Auto Memory's review-inbox pattern (propose, never auto-write) is already `memory_extract`. The background-extraction trigger is a Hugin-side daemon concern, not an MCP-server change.

- **Human memory: systems consolidation, sleep replay, schema integration, reconsolidation (cognitive neuroscience).** Sleep replay → consolidation worker (oldest-first log serialization, prior-synthesis echo, `status` as ground truth). Schema integration → the `groundingSection` treating owner-maintained `status` as inviolable. Reconsolidation (update-on-retrieval) is the one unimplemented analog — would mean triggering immediate re-synthesis when a queried namespace then receives a contradicting write — but Munin is pull-based and can't observe post-retrieval client behavior directly, and this sits on unvalidated Feature 4 Phase 1 outcome signals. Premature to build.

---

## ALREADY_HAVE — shipped, paper cited in-code

- **Lost in the Middle (arXiv 2307.03172, Liu et al. 2023).** Fully mitigated and shipped. `boundarySerialize<T>()` in `src/tools.ts` reorders rank-sorted results so the strongest items sit at the two context edges, exposed as `memory_query`'s `serialization: "boundary"` parameter. The paper is cited by name in the implementation comment (commit `fec3d86`). Analytics-safe: `retrieval_events` record true linear ranks, not display order. Nothing to add.

- **Anthropic Claude / project memory + API memory tool (`memory_20250818`).** Every substantive mechanism maps onto existing capability: project-scoped isolation → `projects/<name>` namespaces; periodic synthesis → consolidation worker; pull-based retrieval → `memory_query`; session handshake → `memory_orient` + CLAUDE.md protocol; explicit save → `memory_write`/`memory_log`; per-entry CRUD → `memory_write`/`memory_delete`. The one novel angle — pairing saves with a context-compaction boundary — is agent-runtime-internal; Munin can't observe compaction, so it survives only as the existing CLAUDE.md convention ("write at natural breakpoints"). The flat file-store API tool is a strictly weaker primitive that Munin subsumes.

---

## REJECT — mechanism architecturally incompatible

- **A-MEM (arXiv 2502.12110, NeurIPS 2025).** All three novelties conflict with explicit choices: (1) per-write LLM enrichment reverses "writes are never blocked by embedding generation"; (2) write-time O(N²) neighbor scan is a known scaling flaw (the D-MEM follow-on exists to fix it) — Munin's batch namespace-level consolidation sidesteps it; (3) retroactive mutation of existing entries' tags/descriptions violates log immutability and the audit trail. The entry-level cross-reference gap (vs. Munin's namespace-level) is worth a future issue, but scoped from the consolidation path, not from A-MEM's mechanism.

- **MemoryBank (arXiv 2305.10250, AAAI 2024).** Core contribution is server-driven automatic deletion via Ebbinghaus decay (`R = e^(−t/S)`, S++ on recall) — directly prohibited by "no memory decay; everything persists until explicitly deleted." There's no ranking slot to inject a decay multiplier into RRF without redesigning scoring, and the "strengthening on recall" signal is already captured (richer) by retrieval analytics wired to the planned Phase 2 reranker. The scalar S counter would be a strict downgrade.

- **Mem0 / Mem0g (arXiv 2504.19413, ECAI 2025; token-efficient variant Apr 2026).** Core mechanism is autonomous LLM-driven write-time ADD/UPDATE/DELETE/NOOP mutation — violates "data, never commands," owner-auditability, and the two-layer state model; `memory_extract` is deliberately suggestion-only for exactly this reason. The one extractable sub-idea (entity matching as a third retrieval signal alongside semantic+keyword) is a small retrieval-tuning item for `queryEntriesHybridScored`, worth pursuing only after zero-appliance vector search is validated — not the Mem0 mechanism.

- **Letta / MemGPT runtime — context constitution / affordances / self-editing blocks.** Every interesting capability requires the agent to be inside its own runtime loop owning the context window. Translated to Munin, all primitives already exist: self-editing blocks → `memory_write`/`memory_update_status`; context constitution → CLAUDE.md handshake + namespace conventions; affordances → the 22 MCP tools; sleep-time compute → consolidation worker; three-tier memory → state/log/search. The only true differentiators (runtime context-window ownership; a graphical ADE) are an architectural impossibility and a UX feature, respectively — neither a transferable memory mechanism.

- **Rewind/Limitless + Pieces LTM-2.5 — passive activity capture.** The whole value proposition is an OS-level passive-capture daemon (screen OCR + audio) — opposite to Munin's intentional, decision-point writes, infeasible on a Pi serving remote clients, and a massive prompt-injection attack-surface expansion with no write-time filtering viable at capture speed. The periodic roll-up pattern is already the consolidation worker. The one conceptually transferable refinement — multi-tier hierarchical summarization (`synthesis/YYYY-MM-DD` daily roll-ups → longer-range synthesis) — is a config-gated second pass on an existing feature, parked in the backlog as a refinement only if single-tier synthesis proves too coarse for long-lived namespaces. Not compelling enough to adopt.

---

## Backlog note (not an ADOPT)

The only forward-pointing item with fresh external weight is the **already-filed temporal-restatement signal** (P3), reinforced by Dreaming V3's product evidence. Concrete shape if prioritized: detect state entries whose content references a now-past future date (relative to `MUNIN_DISPLAY_TIMEZONE` wall-clock) and surface a new `past_event_stale` attention item in `memory_attention`/`memory_consolidate` — prompting the session to restate or expire the entry rather than silently rewriting it, preserving the auditability Dreaming V3 sacrifices. This is a refinement of an existing filed item, not a new adoption from this harvest, so it is excluded from the ADOPT backlog below.


---

*Generated by the memory-frontier-harvest workflow (14 sources surveyed: 7 VALIDATE, 2 ALREADY_HAVE, 5 REJECT, 0 ADOPT). Each source independently surveyed, ADOPT candidates adversarially verified against the live codebase. 2026-06-06.*
