# Changelog

All notable changes to Munin Memory are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
While this project is pre-1.0, any release may contain breaking changes — the
changelog is the canonical record of what moved.

## [Unreleased]

## [0.3.1] — 2026-06-01

Bug fixes, user-test-driven UX improvements, and lexical-anchor controls for
semantic/hybrid search. Ten commits since v0.3.0. No schema migration required —
safe to deploy to Pi by replacing the binary and restarting.

### Added

- **`memory_query` lexical-anchor controls for semantic/hybrid recall (#77)** —
  semantic/hybrid search ran pure KNN with no distance threshold, so a query
  with no lexical match (e.g. a made-up identifier) still returned up to `limit`
  loosely-related vector neighbours. Three additive controls, none of which
  change default recall:
  - `require_lexical_match` (boolean, default `false`) on `memory_query`: in
    semantic/hybrid modes, drop results that have no lexical (FTS5) anchor.
    Injected canonical/attention entries are exempt. Uses a scoped FTS existence
    check so a genuine lexical match is never dropped for ranking low.
  - A `warning` is now always emitted when a hybrid query degrades to
    semantic-only (zero FTS5 matches), so callers know recall came purely from
    vectors.
  - `MUNIN_SEMANTIC_MAX_DISTANCE` (env, unset = unbounded): optional L2 distance
    cutoff applied in `queryEntriesSemanticScored` to drop far vector candidates.

### Changed

- **CAS docs corrected to cover all state writes** — `expected_updated_at`
  compare-and-swap is enforced for *every* state write (any namespace), not
  only tracked `projects/*`/`clients/*` status writes. Updated the
  `memory_write` description, the `expected_updated_at` parameter description,
  and the compact conventions returned by `memory_orient` to match the actual
  behavior. (#80)
- **Namespace grammar documented in the write/log tool descriptions** — the
  `memory_write` and `memory_log` namespace (and key) parameter descriptions now
  state the allowed grammar inline (start alphanumeric, then alphanumeric/`_`/
  `-`/`/`; dots and spaces invalid). `validateNamespace` now names the offending
  character and its position in the error message. (#82)
- **`memory_insights` explains empty results** — when no entry has reached the
  `min_impressions` threshold (default 3), the response now carries an
  explanatory `message` field instead of a bare empty `entries` array. (#83)
- **Docs polish (#83)** — the system-injected `classification:internal` tag is
  now documented in the compact conventions and the `memory_read` description;
  `memory_history` clarifies cursor direction (`next_cursor` points to the
  oldest row of a cursorless page); the compact conventions add two inline
  example workflows.
- **`memory_query` explain parity across search modes (#81)** — documented that
  the per-result `match{}` block (already populated by the result formatter for
  lexical, semantic, and hybrid modes) carries `heuristic_score`,
  `freshness_score`, and `reasons` in every mode, plus the mode-specific
  signals (`lexical_rank`/`lexical_score`, `semantic_rank`/`semantic_distance`,
  and `hybrid_score`). Added a unit guard pinning the explain reasons for
  semantic-only and hybrid match objects so the three modes stay at parity.
- **`memory_orient` output is now bounded (#78)** — `standard`/`full` modes
  default `dashboard_limit_per_group` to 10 (was unbounded), and
  `maintenance_needed` is collapsed to an oldest-first top-10 list plus a new
  `maintenance_meta` block (`total`, `shown`, `truncated`, and a
  `full_list_hint`) in compact/standard modes. The full maintenance list is
  available with `detail:"full"`. This prevents the standard/full response from
  growing large enough to overflow the MCP output limit and stops the
  maintenance list from flooding the compact handshake.

### Fixed

- **`memory_query` validates the `namespace` filter** — an invalid namespace
  filter (e.g. containing a dot or space) now returns a `validation_error`
  instead of silently returning zero results, matching the write/read/log
  paths. Valid prefix filters with a trailing slash (e.g. `projects/`) are
  still accepted. (#79)
- **Deterministic recency tie-break in query reranking** — `rerankQueryResults`
  now breaks heuristic ties by the entries' stored `updated_at` rather than by a
  freshness score computed from the wall clock. `getFreshnessScore` clamps age
  to `>= 0`, so any entry whose `updated_at` is at or after the instant the
  ranker reads the clock collapsed to freshness `1.0`. Two entries written ~1ms
  apart therefore compared *equal* when ranked immediately but *distinct* a few
  milliseconds later — so the result order depended on **when** the ranker ran.
  `memory_query` and the benchmark runner run milliseconds apart, which made
  their result ordering disagree for score-tied recent entries under load (the
  flaky `runner-parity` test, #74). The stored `updated_at` is fixed data and
  order-equivalent to freshness for already-aged entries, so rankings over real
  corpora are unchanged. (#74)
- **Deterministic tracked-status ordering** — `getTrackedStatuses` now orders by
  `updated_at DESC, rowid` instead of `updated_at DESC` alone, so tied rows
  (same-millisecond writes) can't come back in different relative order across
  connections. (#74)

## [0.3.0] — 2026-05-30

Roughly six weeks past v0.2.0. Headline items: DB-managed bearer-token rotation,
accent-insensitive and camelCase-aware lexical search, tool-call telemetry, a
self-feeding consolidation cross-reference scanner, a full benchmark/eval
harness with a deterministic CI regression gate, and two transitive-dependency
security fixes (including a protobufjs RCE). Schema advanced through migrations
v14–v18.

### Added

- **`munin-admin bearer rotate/revoke/list`** — DB-managed bearer token rotation with configurable grace window. DB tokens are checked alongside env-var tokens in `verifyAccessToken`, allowing zero-downtime rotation. Migration v16 adds the `bearer_tokens` table. (#35)
- **Tool call telemetry (Layer 1)** — migration v14 adds a `tool_calls`
  table. Every MCP tool call is instrumented with fire-and-forget timing:
  `tool_name`, `success`, `error_type`, `response_size_bytes`, and
  `duration_ms`. `memory_status` now includes a `telemetry` field (owner-
  only) with per-tool aggregates over the last 7 days. Pruned alongside
  retrieval analytics at the configured retention window (#28).
- **Orphan cross-reference discovery** — the consolidation worker now scans
  the unincorporated log window for mentions of other tracked namespaces
  (`projects/*`, `clients/*`, `people/*`, `decisions/*`) and checks whether
  the target namespace's `status`/`synthesis` state entries contain a
  reciprocal reference. Orphaned connections (≥2 mentions, no back-reference)
  are merged with LLM-extracted cross-references before the single
  `cross_references` write — the LLM wins on `(source, target)` collision, and
  scanner-derived refs are tagged `related_to` with `confidence = 0.5` and a
  context string prefixed `Scanner-detected: …`. Closes the ~50% orphan gap
  measured in the 2026-04-04 Phase 2 consolidation spike (#29).
- **Scanner observability** — the consolidation worker now emits a
  `Scanner[<namespace>]: targets=… candidates=… dropped_reciprocal=…
  dropped_llm_merge=… kept=…` log line whenever any candidate passes the
  mention threshold, including the case where everything is filtered out.
  Lets us tell whether a silent scanner means "nothing to find" or "filters
  too strict" without re-instrumenting.
- **4xx diagnostic logging on `/mcp`** — when an HTTP MCP request returns a
  4xx status, the request log entry now carries a `diagnostics` field with
  redacted request headers and a 500-char body snippet. Sensitive headers
  (`authorization`, `cookie`, `proxy-authorization`, `cf-access-client-secret`,
  `x-api-key`) are replaced with `[REDACTED]`. Zero overhead on 2xx responses.
  Helps capture minimal reproductions for client-side MCP quirks (#32).
- **Bridge credentials file** — the MCP stdio-to-HTTP bridge now accepts
  `MUNIN_CREDENTIALS_FILE`, a path to a `chmod 600` JSON file holding
  `auth_token` / `cf_client_id` / `cf_client_secret`. The bridge refuses to
  read the file if it has any group or world bits set, and logs a warning if
  inline env vars are set but overridden by the file. This keeps Bearer tokens
  and Cloudflare Access secrets out of MCP client config files (Codex CLI,
  Claude Desktop, etc.), which typically land on disk as plaintext `0644`.
  README has a new "Credential storage" section (#30).
- `MUNIN_CONSOLIDATION_MAX_LOGS_PER_RUN` (default `15`) — caps how many
  unincorporated logs a single consolidation run incorporates, so a large
  backlog drains incrementally over successive worker ticks instead of
  producing one oversized synthesis request.
- **Retrieval CI regression gate (#70, Phase 4).** A deterministic gate
  that fails the build when a code change degrades retrieval quality.
  It builds a small, fully synthetic corpus (`benchmark/ci-gate/corpus.json`)
  into an ephemeral SQLite DB, runs the benchmark in `raw` + `lexical`
  mode (bm25 over a fixed corpus — no embeddings, no network, no
  recency/time dependence, so the numbers are stable across machines),
  and compares the aggregate scores (R@1, R@5, R@10, nDCG@5, MRR) against
  a committed baseline (`benchmark/ci-gate/baseline.json`). Any metric
  regressing beyond a tiny floating-point tolerance fails. Run it with
  `npm run benchmark:ci-gate`; re-bless an intentional change with
  `npm run benchmark:ci-gate -- --update-baseline`. Wired into
  `.github/workflows/ci.yml` and also exercised on every `npm test` run
  via `tests/ci-gate.test.ts` (policy unit tests + an end-to-end pass
  check that keeps the committed corpus, query set, and baseline in
  sync). Scope note: the gate covers the retrieval-recall + lexical-ranking
  (`raw`) layer; the production reranker is intentionally not gated here
  because its freshness/attention inputs are time-relative and would rot
  a committed baseline — raw-vs-production parity stays guarded by
  `tests/runner-parity.test.ts`.
- **Benchmark `production_ranker` mode (PR 2b).** The benchmark runner
  now offers a second code path that runs results through the same
  pipeline `memory_query` uses in production: canonical reference
  injection, attention/triage injection, completed-task filtering, and
  `rerankQueryResults` with heuristic + freshness scoring — sliced to
  the user-facing limit. Opt in with `runnerMode: "production_ranker"`
  on `runBenchmark`, or `--runner-mode production_ranker` on the
  LongMemEval / LoCoMo adapter CLIs. Fails loud when the snapshot
  schema is too old for the rerank pipeline (need v5+); pass
  `fallbackRunnerMode: "raw"` to opt into a silent downgrade with a
  `warnings[]` entry. New report fields: `runner_mode_requested`
  (always present, equal to `runner_mode` for non-degraded runs);
  `search_recency_weight` (number for `production_ranker`, `null` for
  `raw` — `0` would falsely imply "rerank ran with zero recency");
  `principal_id: "owner"` reserved for a future multi-principal
  benchmarking mode. New tests: `tests/runner-parity.test.ts` asserts
  the runner's `production_ranker` top-k IDs match what
  `memory_query` returns for the same DB and query (4 corpus shapes:
  tracked-status, canonical-injection, decision-lookup, and the
  relaxed-lexical fallback path) plus 4 prereq-handling cases;
  `tests/benchmark-import-boundary.test.ts` pins the curated set of
  names the benchmark surface is allowed to import from `src/tools.ts`
  so the boundary survives until issue #59 extracts the rerank
  pipeline into a dedicated module. The runner's per-query
  `executeQuery` now returns full `Entry[]` (not just IDs) so the
  caller picks the projection — IDs+namespaces for raw, full entries
  for the production reranker. PR 2a's `runner_mode` field gains its
  second value: previously always `"raw"`, now `"production_ranker"`
  when the new path is selected. Issue #59 tracks the planned
  follow-up that moves the exported reranker names into
  `src/internal/reranker.ts`.
- **Benchmark instrumentation (PR 2a — report schema v2).** Reports
  produced by `benchmark/runner.ts` now carry a `report_schema_version: 2`
  tag and additive fields on top of the existing v1 shape: top-20 scoring
  (`recallAt20`, `ndcgAt20`); per-query `duration_ms` captured with
  `performance.now()` and rounded to 0.01 ms; `overall_duration`,
  `by_search_mode_duration`, and per-category `duration` summaries with
  `{p50_ms, p95_ms, total_ms}` (nearest-rank percentiles, parity with
  `src/db.ts:computeP95`); `query_set_sources[]` per-file lineage
  (filename, raw-bytes SHA-256, byte size, record count) with optional
  manifest cross-check (`manifest_source_id`, `manifest_match`); a
  deterministic `query_set_checksum` over sorted `(filename, sha256)`
  pairs; `snapshot_schema_version` renamed from `schema_version` (the
  old field is kept as a deprecated alias for one release); and a
  `runner_mode` discriminator (PR 2a always emits `"raw"`; PR 2b will
  add `"production_ranker"`). New `loadQueriesWithSource` /
  `loadQueriesFromDirWithSources` helpers and `RunBenchmarkOptions`
  (`querySetSources`, `manifestPath`) thread the lineage end-to-end.
  `.gitattributes` pins `eol=lf` for `.jsonl`/`.json`/`.md`/`.ts`/`.sh`
  so query-file SHAs are stable across macOS/Linux/Windows. No changes
  to `src/tools.ts`; production paths are untouched.
- Retrieval benchmark lineage manifest at
  `benchmark/queries/retrieval-v1.manifest.{json,md}`. Curated source index
  that reconciles munin-native query sets (`baseline.jsonl`,
  `baseline-claude.jsonl`, `example.jsonl` — 34 records) with munin-zero
  pilot evidence (v2/v3/v3b/v3c, pinned at commit `ad4baff`) into eight
  first-class source entries (176 records total) plus an explicit
  `omitted_artifacts[]` inventory. Records `munin-zero#6` as closed by
  pilot v3c with sha256-pinned evidence (report + intents + queries +
  results + targets, plus the v3b lexical baseline that substantiates
  the "vs 0/6" comparison) and the six target UUIDs. Validator test in
  `tests/retrieval-manifest.test.ts` parses every native JSONL against
  the `BenchmarkQuery` shape, verifies sha256 pins for in-repo native
  sources, asserts the exact v1 source freeze, and includes negative
  tests for `source_class`, target metadata, closure evidence, and
  derived totals. (External munin-zero artifacts are pinned by path +
  sha256 in the manifest but are not checked out by CI.) The manifest is a citation /
  provenance index, not a runner input or label store. No existing JSONL
  is modified.

### Changed

- **Accent-insensitive lexical search** — migration v15 recreates the
  `entries_fts` virtual table with `tokenize='unicode61 remove_diacritics 2'`
  and rebuilds the index. Queries for `Mimir` now match content containing
  `Mímir` (and vice versa), removing one of the two token-mismatch failure
  modes observed in the 2026-04-20 retrieval pilot v3c T10 case. Porter
  stemming stays deferred pending a separate evaluation against the Swedish
  portion of the corpus (#40).
- `memory_orient` compact conventions now include a rule clarifying that
  memory describes external artifacts at a point in time, so models should
  verify feature-level claims (UI copy, flows, exact behavior) against the
  current artifact — code, templates, running app — before asserting to
  the user. Backend capability ≠ UI exposure. State entries remain the
  current truth within Munin; the new rule is scoped to claims that depend
  on external reality. Prompted by an external tester report of an Opus 4.6
  session hallucinating UI features despite accurate Munin retrieval (#33).
- `memory_insights` aggregates now include session-segmented reformulation
  context: `reformulation_rate_adjusted` (excludes single-event sessions
  from the denominator), `reformulation_explanation` (human-readable note
  about known session-correlation limitations), `total_sessions`, and
  `multi_event_sessions`. The raw `reformulation_rate` is retained for
  backwards compatibility (#25).
- **Backup schedule reduced from hourly to daily** with GFS retention (14 most
  recent daily snapshots + 4 most recent Sunday snapshots, ~18 files total).
  Previous policy kept 168 hourly snapshots which grew to ~50 GB and filled
  the NAS Pi's SD card. New target is ~7 GB. Backup destination moved from
  `/home/magnus/backups/munin-memory` (SD card) to
  `/mnt/timemachine/backups/munin-memory` (1.8 TB external HDD).
  `munin-backup.{service,timer}` are now version-controlled in the repo root
  alongside `munin-memory.service`.
- **Benchmark report schema v3 — removed the deprecated `schema_version`
  alias (#58).** `BenchmarkReport.schema_version` (a one-release mirror of
  `snapshot_schema_version` introduced in report schema v2 / PR 2a) is gone.
  `report_schema_version` is now `3`. Consumers must read
  `snapshot_schema_version` for the snapshot DB migration version. This is a
  breaking change to the report shape; historical report JSON under
  `benchmark/reports/` is unaffected (frozen records).

### Fixed

- **`memory_update_status` no longer drops non-canonical sections.** Previously
  the parse → merge → format cycle only recognized the five canonical sections
  (`Phase`, `Current Work`, `Blockers`, `Next Steps`, `Notes`); anything else
  (`Vision`, `Roadmap`, `Milestones`, custom sections) was silently discarded
  on the next call — even a no-op `lifecycle` flip would wipe them. Now
  `parseStructuredStatus` collects unknown `## Heading` sections into an
  `extras` array, `buildStructuredStatus` carries them across patches, and
  `formatStructuredStatus` re-emits them after the canonical block. Heimdall
  and other downstream readers that depend on `## Vision` / `## Milestones`
  no longer need the `memory_write patch` workaround. (#44)
- **FTS5 now matches camelCase / PascalCase identifiers against separated-word
  queries.** Migration v17 recreates the FTS triggers to augment indexed
  content with a case-split copy via the `munin_split_tokens` SQL UDF, and
  rebuilds the existing index. `WebFetch` is now findable via `web fetch`,
  `XMLParser` via `XML parser`, `parseXMLResponse` via `parse XML response`,
  `OAuthToken` via `oauth token`, and `IPv6Address` via `IPv6 address`.
  Original phrases still match unchanged (the augmented copy is appended,
  not substituted). The maintenance helper `rebuildFTS()` was rewritten to
  use `delete-all` + augmented re-population, since FTS5's built-in
  `'rebuild'` command would silently strip the split-token augmentation by
  reading from `entries` directly. Known limitation: quoted phrases that
  span identifier-internal punctuation like `"90/10"` are still
  tokenizer-split by `unicode61` — query as separate tokens or rely on
  FTS5's near-match ranking. (#42)
- **Consolidation worker no longer stalls indefinitely on a large backlog
  (#51).** A namespace with many unincorporated logs produced a synthesis
  that overflowed the OpenRouter `max_tokens` cap, returning truncated JSON
  that failed to parse. Repeated parse failures tripped the circuit breaker,
  which silently disabled *all* consolidation until the next process restart;
  the growing backlog meant the namespace could never self-recover. Fixed by
  raising `max_tokens` (2048 → 4096) and bounding the per-run log window
  (`MUNIN_CONSOLIDATION_MAX_LOGS_PER_RUN`) so backlogs drain incrementally.
- **Consolidation backlog drain hardened (follow-up to #51).** The initial
  per-run cap used a timestamp-only cursor that silently dropped logs sharing
  the boundary second, never re-selected a sub-`MIN_LOGS` tail, and let each
  drain slice overwrite the previous slice's cross-references. Fixed with a
  composite `(created_at, id)` cursor (no same-timestamp data loss), a
  `drain_in_progress` flag on `consolidation_metadata` (migration v18) that
  forces the worker to keep draining until the backlog is empty regardless of
  `MIN_LOGS`, and additive cross-reference upserts during a drain so orphan
  references discovered in earlier slices survive later ones.
- **`munin-admin` now honors `MUNIN_MEMORY_DB_PATH`.** The admin CLI
  previously only accepted a `--db` flag and ignored the
  `MUNIN_MEMORY_DB_PATH` env var that the server respects — so a dry-run
  that exported the env var to a throwaway path silently wrote to the
  production database instead. `resolveDbPath()` now falls back to
  `MUNIN_MEMORY_DB_PATH` when no explicit path is given, with precedence
  `--db` flag > env var > `~/.munin-memory/memory.db` default. The server
  and embedding-cache paths are unaffected (they already passed the env
  value explicitly). Help text and the `--db` docstring updated to
  document the precedence.
- **`memory_status` telemetry now reports a real 95th-percentile response
  size.** The `p95_response_size_bytes` field returned by
  `getToolCallAggregates` was previously computed as
  `MAX(response_size_bytes)` despite the name. It is now computed in JS via
  nearest-rank (`ceil(0.95 * n) - 1` on the ascending-sorted non-null sizes
  per tool). Field name and shape are unchanged — operators reading this
  telemetry will see lower, more representative values from this release
  forward. Empty per-tool inputs continue to report `null`.
- `memory_query` hybrid mode now mirrors the lexical-mode relaxed-token
  fallback: when the strict AND-of-all-words FTS5 query returns zero matches,
  the hybrid path retries with an OR-of-content-terms query before collapsing
  to semantic-only. Previously, compound natural-language questions (e.g.
  "OAuth token expiry access control") surfaced only semantic signal even
  when lexical evidence was present in the corpus (#27).
- `memory_commitments` no longer extracts derived commitments from resolved
  sources. Three new suppression rules: (1) `synthesis` key entries are
  skipped so milestone labels in consolidation output (e.g. "Genesis (MVP
  Complete - 2026-03-21)") no longer masquerade as commitments; (2) entries
  whose own tags carry a terminal lifecycle (`completed`, `archived`,
  `stopped`, `failed`) are skipped; (3) entries living in a namespace whose
  status is terminal are skipped — catches task result documents and
  post-mortems that contain forward-looking dated language retrospectively
  (#26).

### Security

- **Transitive `protobufjs` bumped to 7.6.1 via an npm override to clear a
  prototype-pollution / remote-code-execution vulnerability.** `protobufjs`
  is pulled in transitively (not called directly by Munin); the `overrides`
  block pins the patched version. (#50)
- **`hono` bumped to 4.12.23 and `@hono/node-server` to 1.19.14 via
  `overrides`** to pick up upstream security fixes. (#49)

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

[Unreleased]: https://github.com/Magnus-Gille/munin-memory/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Magnus-Gille/munin-memory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Magnus-Gille/munin-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Magnus-Gille/munin-memory/releases/tag/v0.1.0
