# Changelog

All notable changes to Munin Memory are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
While this project is pre-1.0, any release may contain breaking changes — the
changelog is the canonical record of what moved.

## [Unreleased]

## [0.2.0] — 2026-04-11

First tagged release since the initial public drop on 2026-03-03. Roughly six
weeks of iteration: the server grew from a small note-store with seven MCP
tools to a twenty-two-tool memory system with multi-principal access control,
retrieval analytics, and an optional OpenRouter-backed consolidation worker.

### Added

- **Computed lifecycle dashboard** — `memory_orient` replaces the manually
  maintained workbench with a dashboard computed from `projects/*` and
  `clients/*` status entries, grouped by lifecycle tag. Compare-and-swap via
  `expected_updated_at` prevents concurrent environments from blindly
  overwriting each other.
- **Semantic and hybrid search** — optional `sqlite-vec` + Transformers.js
  embedding pipeline behind three feature gates (`MUNIN_EMBEDDINGS_ENABLED`,
  `MUNIN_SEMANTIC_ENABLED`, `MUNIN_HYBRID_ENABLED`). Hybrid is now the default
  search mode; missing modes degrade to lexical with a warning rather than
  failing the request.
- **Background consolidation worker** — optional OpenRouter-backed worker that
  synthesizes recent log entries into a `synthesis` key per tracked namespace,
  extracting decisions, open threads, and cross-namespace references. Anchored
  to the human-maintained `status` entry so it cannot override phase or
  lifecycle. Disabled by default; requires `OPENROUTER_API_KEY`.
- **Retrospective synthesis tools** — `memory_narrative`, `memory_commitments`,
  `memory_patterns`, `memory_handoff`, and `memory_extract`. All source-backed:
  every surfaced signal points at a concrete entry, with empty-result reasons
  when nothing meets the threshold.
- **Outcome-aware retrieval (Phase 1)** — `retrieval_events`,
  `retrieval_outcomes`, and `retrieval_sessions` schema captures what Claude
  does after each retrieval. Surfaced via `memory_insights`; explicit feedback
  via `memory_retrieval_feedback`. Observation only — no ranking changes yet.
- **`memory_history`** — audit log change feed, cursorable for multi-agent sync.
- **`memory_attention`** — attention triage for stale active entries,
  missing-status namespaces, and upcoming event staleness.
- **`memory_resume`** — resume-a-project tool backed by namespace history.
- **`memory_consolidate`** — manual trigger for the consolidation worker.
- **`memory_update_status`** — structured status patch with CAS.
- **OAuth 2.1 support** — dynamic client registration, PKCE, refresh-token
  rotation, consent flow gated by trusted proxy headers. Enables Claude.ai
  (Web) and Claude Mobile. Dual auth — legacy Bearer tokens continue to work
  unchanged.
- **Multi-principal access control** — server-enforced namespace isolation
  with scoped `namespace_rules` per principal. Phase 2 adds consent-time
  auto-mapping of OAuth clients to principals via a trusted email header.
- **`munin-admin` CLI** — principal management, OAuth-client device inventory,
  agent service token issuance and rotation, `--json` output on every
  subcommand. Shipped as a `bin` entry in `package.json`.
- **Agent service token auth** — SHA-256 hashed service tokens for agent
  principals.
- **Temporal query filters** — `since` / `until` on `memory_query`.
- **Librarian classification enforcement** — optional data-classification
  ceiling per namespace with transport-aware redaction across direct reads,
  aggregate tools, and history. Disabled by default via
  `MUNIN_LIBRARIAN_ENABLED=false`.
- **Appliance profiles** — explicit `zero-appliance` vs `full-node` direction
  for Raspberry Pi deployments, documented in `docs/appliance-profiles.md`.
- **Stdio-to-HTTP bridge** — SDK-based bridge enabling multi-session MCP
  access from stdio clients, with auto-reconnect and configurable idle TTL.
- **Migration framework** — versioned, idempotent schema migrations. Current
  schema is at v7.
- **Prefixed tag convention** — colons allowed in tags (`client:lofalk`,
  `person:sara`, `topic:ai-education`, `type:pdf`, `source:external`) for
  cross-referencing without rigid schemas.
- **Local timestamps in tool responses** — display layer renders human-friendly
  local timestamps via `MUNIN_DISPLAY_TIMEZONE` while storage stays UTC.
- **Hourly SQLite backup script** — rolling 7-day retention to a NAS path.
- **GitHub Actions CI** — test and build on every push.
- **Retrieval evaluation harness** — benchmark runner for retrieval quality
  measurement (`benchmark/`). Dataset adapters are being added post-0.2.0.

### Changed

- **Default search mode: `lexical` → `hybrid`.** Queries that previously ran
  keyword-only now fuse FTS5 with vector results via Reciprocal Rank Fusion
  when semantic mode is available.
- **HTTP transport: stateful → stateless.** Each POST to `/mcp` creates a
  fresh transport and a fresh MCP `Server` instance. Simplifies scaling and
  removes a class of cross-session bugs.
- **`memory_orient` response shape** — now includes computed dashboard,
  maintenance suggestions, curated notes overlay, and (transitionally) any
  legacy workbench entry with a deprecation marker. Completed task namespaces
  and demo namespaces are hidden by default.
- **Tool responses expose hybrid search metadata** — `search_mode_actual`,
  degradation warnings, and ranking diagnostics.

### Fixed

- FTS5 query escaping for hyphenated terms and multi-word AND-splits.
- `memory_query` distinguishes validation failure modes and names the
  expected parameter on error.
- Embeddings cache path resolves from the absolute DB directory, fixing
  `HF_HUB_CACHE` under systemd sandboxing.
- Consolidation circuit breaker is no longer dead code.
- `memory_insights` `followthrough_rate` bounded to `[0, 1]`.
- `memory_resume` respects full namespace paths rather than first-segment only.
- `memory_handoff` surfaces the actual status content instead of a stub.
- Stopword filtering in `memory_patterns` term extraction.
- Tag filtering applied in SQL before `LIMIT` to prevent false negatives.
- Numerous heuristic refinements across `memory_narrative`,
  `memory_commitments`, `memory_patterns`, and `memory_extract` to reduce
  false positives and surface empty-result reasons.

### Security

- **OAuth hardening from Codex adversarial review** — confidential client
  secrets encrypted at rest (AES-256-GCM, key derived from
  `MUNIN_OAUTH_CLIENT_SECRET_KEY` or `MUNIN_API_KEY`). Access tokens, refresh
  tokens, and authorization codes stored as SHA-256 hashes. Consent endpoints
  fail-closed for public issuers unless both `MUNIN_OAUTH_TRUSTED_USER_HEADER`
  and `MUNIN_OAUTH_TRUSTED_USER_VALUE` are set.
- **HTTP hardening** — tunnel-ready request validation and host allowlist via
  `MUNIN_ALLOWED_HOSTS`.
- **Dependency patches** — `path-to-regexp` and `picomatch` ReDoS fixes,
  plus general `npm audit` remediation.
- **Librarian residual leaks closed** — direct-entry, aggregate, and history
  redaction now enforce the classification ceiling consistently; writes that
  would create orphaned entries are rejected.
- **OpenRouter zero-data-retention** — consolidation requests opt out of
  provider retention.

### Deprecated

- **`meta/workbench`** — replaced by the computed dashboard. Still surfaced in
  `memory_orient` with a deprecation note during the transition. Delete once
  your environments have migrated.

## [0.1.0] — 2026-03-03

Initial public release (commit `c40c127`). Core MCP tool surface
(`memory_write`, `memory_read`, `memory_get`, `memory_query`, `memory_log`,
`memory_list`, `memory_delete`), SQLite + FTS5 storage, Bearer token auth,
stdio transport, and the first HTTP transport for Raspberry Pi deployment.

[Unreleased]: https://github.com/Magnus-Gille/munin-memory/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Magnus-Gille/munin-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Magnus-Gille/munin-memory/releases/tag/v0.1.0
