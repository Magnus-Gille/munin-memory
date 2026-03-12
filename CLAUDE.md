# Munin Memory — CLAUDE.md

## What this project is

Munin Memory is an MCP (Model Context Protocol) server that provides persistent memory for Claude across conversations. Named after Odin's raven of memory. Built **for Claude, by Claude** — Claude is the primary "user" of the tools this server exposes.

Part of the Hugin & Munin personal AI system. See `prd.md` for full product context and `technical-spec.md` for implementation details.

## Architecture overview

- **Runtime:** Node.js 20+, TypeScript (strict mode)
- **Database:** SQLite via `better-sqlite3` with FTS5 full-text search + sqlite-vec vector search
- **Protocol:** MCP over stdio (local) or stateless Streamable HTTP (network, Express-based)
- **Auth:** Dual auth — legacy Bearer token (MUNIN_API_KEY) + OAuth 2.1 (dynamic client registration, PKCE)
- **Platforms:** macOS (dev), Linux ARM64 (Raspberry Pi 5 target)

### Core concepts

- **State entries** — mutable key-value pairs (namespace + key). Represent current truth. Upserted on write.
- **Log entries** — append-only, timestamped, no key. Represent chronological history. Never modified.
- **Namespaces** — hierarchical strings with `/` separator (e.g. `projects/hugin-munin`). Created implicitly.
- **FTS5 search** — keyword search across all entries (lexical mode).
- **Vector search** — sqlite-vec KNN over 384-dim embeddings from Transformers.js (semantic mode).
- **Hybrid search** — Reciprocal Rank Fusion (RRF) of FTS5 + vector results.

### MCP tools exposed

| Tool | Purpose |
|------|---------|
| `memory_orient` | **Start here.** Returns conventions, computed project dashboard (grouped by lifecycle), curated notes, maintenance suggestions, and namespace overview in one call |
| `memory_write` | Store/update a state entry (namespace + key + content). Supports compare-and-swap via `expected_updated_at` for tracked statuses. Auto-canonicalizes lifecycle tags. |
| `memory_read` | Retrieve a specific state entry by namespace + key |
| `memory_get` | Retrieve any entry (state or log) by UUID |
| `memory_query` | Search memories (lexical/semantic/hybrid) with filters |
| `memory_log` | Append a chronological log entry to a namespace |
| `memory_list` | Browse namespaces and their contents (with recent log previews and demo filtering) |
| `memory_delete` | Delete entries (with token-based confirmation) |

## Project structure

```
munin-memory/
├── package.json
├── tsconfig.json
├── CLAUDE.md              # This file
├── prd.md                 # Product requirements (reference)
├── technical-spec.md      # Technical spec (reference)
├── src/
│   ├── index.ts           # Entry point — MCP server setup, stdio + Express HTTP transports
│   ├── db.ts              # SQLite init, pragmas, queries, vec operations
│   ├── migrations.ts      # Migration framework + migration definitions (v1-v3)
│   ├── embeddings.ts      # Embedding pipeline, background worker, feature flags
│   ├── oauth.ts           # OAuth 2.1 provider (OAuthServerProvider impl, SQLite-backed)
│   ├── consent.ts         # Minimal HTML consent page for OAuth authorization
│   ├── tools.ts           # MCP tool definitions and handlers
│   ├── security.ts        # Secret pattern detection + input validation
│   └── types.ts           # TypeScript type definitions
├── tests/
│   ├── db.test.ts
│   ├── embeddings.test.ts
│   ├── migrations.test.ts
│   ├── http-hardening.test.ts
│   ├── http-transport.test.ts   # Stateless HTTP route tests
│   ├── oauth.test.ts              # OAuth provider unit tests
│   ├── oauth-integration.test.ts  # OAuth end-to-end tests (supertest)
│   ├── tools.test.ts
│   └── security.test.ts
├── docs/
│   └── agentic-dev-days-munin-memory.md   # Presentation case study for the stateless HTTP incident
├── munin-memory.service   # systemd unit file for RPi deployment
├── scripts/
│   ├── deploy-rpi.sh      # Deploy to Raspberry Pi
│   └── migrate-db.sh      # One-time DB migration to Pi
└── dist/                  # Compiled output (gitignored)
```

## How to build

```bash
npm install
npm run build    # Compiles TypeScript to dist/
```

## How to test

```bash
npm test         # Runs vitest (single run)
npm run test:watch  # Runs vitest in watch mode
```

## How to run locally

**Stdio mode** (default — for Claude Code, Claude Desktop local):
```bash
node dist/index.js
```

**HTTP mode** (for network access — RPi deployment, remote clients):
```bash
MUNIN_TRANSPORT=http MUNIN_API_KEY=<key> node dist/index.js
```

Development with auto-reload:
```bash
npm run dev      # tsx watch src/index.ts
```

## Deployment to Raspberry Pi

```bash
# First deploy (set DEPLOY_USER if your Pi username differs from local)
./scripts/deploy-rpi.sh <your-pi-hostname>

# One-time database migration
./scripts/migrate-db.sh <your-pi-hostname>
```

The Pi needs a `.env` file at the project root:
```
MUNIN_API_KEY=<generate with: openssl rand -hex 32>
MUNIN_OAUTH_ISSUER_URL=https://<your-domain>
MUNIN_ALLOWED_HOSTS=<your-domain>,<your-domain>:443
```

## MCP client configuration

**Claude Code (HTTP — connecting to remote server):**
```bash
claude mcp add --transport http \
  -H "Authorization: Bearer <MUNIN_API_KEY>" \
  -s user munin-memory https://<your-domain>/mcp
```

If using Cloudflare Access, add `-H "CF-Access-Client-Id: <ID>"` and `-H "CF-Access-Client-Secret: <SECRET>"` headers.

**Claude Desktop (HTTP — via mcp-remote bridge):**
Uses `mcp-remote` bridge with Bearer + any reverse proxy auth headers.

**Claude.ai / Claude Mobile (OAuth — via Settings > Connectors):**
URL: `https://<your-domain>/mcp` — OAuth 2.1 flow handles auth automatically.
Requires reverse proxy path policies for OAuth endpoints (see OAuth section below).

**Claude Code (stdio — local dev only):**
```bash
claude mcp add-json munin-memory '{"command":"node","args":["/path/to/munin-memory/dist/index.js"]}' -s user
```

## Computed dashboard and tracked statuses

The project dashboard in `memory_orient` is computed dynamically from status entries, replacing the manually-maintained `meta/workbench`.

### Tracked namespaces
Namespaces matching `projects/*` or `clients/*` are "tracked". Status entries (`key = "status"`) in these namespaces feed the computed dashboard.

### Lifecycle tags
Canonical lifecycle tags: `active`, `blocked`, `completed`, `stopped`, `maintenance`, `archived`. Aliases are auto-normalized on write: `done` → `completed`, `paused` → `stopped`, `inactive` → `archived`.

### Compare-and-swap (CAS)
`memory_write` accepts an optional `expected_updated_at` parameter. For tracked status writes, if the entry was modified since the given timestamp, the write returns `status: "conflict"` instead of overwriting. This prevents blind overwrites from concurrent environments.

### Curated overlay
`meta/workbench-notes` is a freeform entry for items not backed by namespaces (obligations, cross-cutting notes). Read by `memory_orient` as a `notes` field alongside the computed dashboard.

### Maintenance suggestions
`memory_orient` returns `maintenance_needed` when it detects: active-but-stale entries (>14 days), tracked namespaces missing a status key, conflicting lifecycle tags, or missing lifecycle tags.

### Legacy workbench
During the transition period, `memory_orient` includes `legacy_workbench` if `meta/workbench` exists, with a deprecation note. Delete `meta/workbench` when the transition is complete.

## Key design decisions

- SQLite + FTS5 + sqlite-vec for storage, keyword search, and vector search
- `better-sqlite3` for synchronous database access (simpler with MCP stdio model)
- All writes validated against secret patterns before storage (API keys, tokens, passwords rejected)
- State entries (mutable) and log entries (append-only) are the two fundamental types
- Namespaces are hierarchical strings separated by `/`
- Database location configurable via `MUNIN_MEMORY_DB_PATH` env var (default: `~/.munin-memory/memory.db`)
- Database file created with `0600` permissions
- **Dual auth:** Bearer token (MUNIN_API_KEY) for existing clients + OAuth 2.1 for web/mobile
- HTTP transport uses Express (required by MCP SDK's `mcpAuthRouter`)
- `/mcp` runs in stateless Streamable HTTP mode: fresh transport and fresh MCP `Server` per POST request
- `agent_id` field included in schema for future multi-agent support

## Semantic search architecture (Feature 2)

### Overview

Embedding pipeline runs asynchronously: writes are never blocked by embedding generation. A background worker processes entries with `embedding_status = 'pending'` in batches.

### Data flow

1. `memory_write` / `memory_log` → entry stored with `embedding_status = 'pending'`
2. Background worker claims pending entries → generates embeddings via Transformers.js → stores in `entries_vec` vec0 table
3. `memory_query` with `search_mode: "semantic"` → generates query embedding → KNN search via sqlite-vec
4. `memory_query` with `search_mode: "hybrid"` → runs both FTS5 and KNN, merges via RRF (k=60)

### Schema

- **Migration v2** adds `embedding_status` (CHECK: pending/processing/generated/failed) and `embedding_model` columns to `entries`
- **`entries_vec`** vec0 virtual table created idempotently on startup (NOT in migration — requires sqlite-vec extension loaded). Schema: `entry_id TEXT, embedding float[384]`
- No SQL trigger for vec cleanup — done in application code during `executeDelete`

### Three-tier feature gates

| Gate | Env var | Default | Controls |
|------|---------|---------|----------|
| Infra | `MUNIN_EMBEDDINGS_ENABLED` | `true` | Load model, run worker |
| Gate 1 | `MUNIN_SEMANTIC_ENABLED` | `true` | Accept `search_mode: "semantic"` |
| Gate 2 | `MUNIN_HYBRID_ENABLED` | `false` | Accept `search_mode: "hybrid"` |

When a requested mode is unavailable, `memory_query` degrades to lexical search with a `warning` and `search_mode_actual` in the response.

### Circuit breaker

After `MUNIN_EMBEDDINGS_MAX_FAILURES` (default 5) consecutive embedding failures, the circuit breaker trips: embedding generation is disabled, all search degrades to lexical. Reset requires server restart.

### Background worker

- Uses recursive `setTimeout` (not `setInterval`) to prevent overlap
- Claims rows atomically: `UPDATE ... SET embedding_status = 'processing' WHERE id IN (SELECT ... LIMIT batchSize)`
- Guards against stale writes: checks `updated_at` before persisting embeddings
- `stopEmbeddingWorker()` awaits in-flight batch before returning (graceful shutdown)

### Key implementation details (from Codex adversarial review)

- `embeddingToBuffer()`: uses `Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)` — NOT `Buffer.from(f32)` which silently truncates
- RRF scoring: entries in only one result set contribute `1/(60 + rank)` from that set + 0 from the other. No Infinity sentinel.
- Over-fetch 5x limit from each source for RRF (not 3x)
- Vec0 tables don't have an `id` column — use `entry_id TEXT` metadata column instead

## OAuth 2.1 (Feature 3)

### Overview

OAuth 2.1 support enables Claude.ai and Claude mobile to connect to Munin Memory. Uses the MCP SDK's built-in `mcpAuthRouter()` and `requireBearerAuth()` middleware backed by a SQLite OAuth provider.

### Dual auth on `/mcp`

The `verifyAccessToken()` method checks in order:
1. **Legacy Bearer token** — if token matches `MUNIN_API_KEY`, returns immediately (backward compat)
2. **OAuth access token** — looks up in `oauth_tokens` table

Existing Claude Code and Claude Desktop clients using `MUNIN_API_KEY` continue working unchanged.

### OAuth endpoints (served by MCP SDK auth router)

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-authorization-server` | OAuth metadata discovery (RFC 8414) |
| `/.well-known/oauth-protected-resource` | Protected resource metadata (RFC 9728) |
| `/authorize` | Authorization + consent page |
| `/authorize/approve` | Consent form POST handler (custom) |
| `/token` | Code exchange + token refresh |
| `/register` | Dynamic client registration (RFC 7591) |
| `/revoke` | Token revocation (RFC 7009) |

### Schema (migration v3)

- **`oauth_clients`** — registered OAuth clients (client_id, secret, redirect_uris, metadata)
- **`oauth_auth_codes`** — authorization codes (code, client_id, PKCE challenge, expiry)
- **`oauth_tokens`** — access + refresh tokens (token, type, client_id, scopes, expiry, revoked)

### Token lifecycle

- Access tokens: configurable TTL (default 1 hour), checked on every request
- Refresh tokens: configurable TTL (default 30 days), rotation on use (old token revoked)
- Auth codes: 10-minute TTL, single use
- Cleanup: expired/revoked tokens swept on a periodic cleanup timer (60s)

### Reverse proxy path policies

If using a reverse proxy (e.g. Cloudflare Access, nginx), configure path-based auth:
- `/.well-known/*`, `/token`, `/register`, `/health` — public (metadata, server-to-server)
- `/authorize`, `/authorize/approve` — user authentication (browser consent flow)
- `/mcp` — API authentication (Bearer token or OAuth)

### Key files

- `src/oauth.ts` — `MuninOAuthProvider` (implements `OAuthServerProvider`), `MuninClientsStore`
- `src/consent.ts` — Self-contained HTML consent page
- `src/index.ts` — Express app setup, mounts `mcpAuthRouter()` + `requireBearerAuth()`
- `src/migrations.ts` — Migration v3 creates OAuth tables

## Code style

- TypeScript strict mode
- No classes unless genuinely needed — prefer functions and modules
- Error messages must be clear and actionable for an LLM reading them
- Keep dependencies minimal
- No ORMs, no frameworks

## Security rules

Content is scanned before every write. Reject writes containing:
- API keys (`sk-`, `ghp_`, `gho_`, `github_pat_`, `AKIA...`)
- Bearer tokens
- Private keys / certificates
- Inline passwords/secrets

See `technical-spec.md` § Security Module for the full pattern list.

## Input validation

- `namespace`: must match `/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/`
- `key`: must match `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`
- `content`: max 100,000 characters
- `tags`: each tag matches `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`, max 20 tags

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MUNIN_MEMORY_DB_PATH` | `~/.munin-memory/memory.db` | Database file location |
| `MUNIN_MEMORY_LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |
| `MUNIN_MEMORY_MAX_CONTENT_SIZE` | `100000` | Max content size in characters |
| `MUNIN_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MUNIN_HTTP_PORT` | `3030` | HTTP server port (http mode only) |
| `MUNIN_HTTP_HOST` | `127.0.0.1` | HTTP bind address (http mode only) |
| `MUNIN_API_KEY` | — | Bearer token for auth (required in http mode) |
| `MUNIN_EMBEDDINGS_ENABLED` | `true` | Load embedding model + run worker |
| `MUNIN_SEMANTIC_ENABLED` | `true` | Gate 1: accept `search_mode: "semantic"` |
| `MUNIN_HYBRID_ENABLED` | `false` | Gate 2: accept `search_mode: "hybrid"` |
| `MUNIN_EMBEDDINGS_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model for embeddings |
| `MUNIN_EMBEDDINGS_BACKFILL` | `true` | Backfill existing entries on startup |
| `MUNIN_EMBEDDINGS_BATCH_SIZE` | `25` | Entries per worker batch |
| `MUNIN_EMBEDDINGS_BATCH_DELAY_MS` | `200` | Delay between worker batches |
| `MUNIN_EMBEDDINGS_MAX_FAILURES` | `5` | Circuit breaker failure threshold |
| `MUNIN_EMBEDDINGS_LOCAL_ONLY` | `false` | Only use cached models (no downloads) |
| `MUNIN_ALLOWED_HOSTS` | — | Comma-separated extra Host headers to accept (e.g. `your-domain.com:443,your-domain.com`) |
| `MUNIN_OAUTH_ISSUER_URL` | `http://localhost:3030` | OAuth issuer URL (set to your public domain in production) |
| `MUNIN_OAUTH_ACCESS_TOKEN_TTL` | `3600` | Access token lifetime (seconds) |
| `MUNIN_OAUTH_REFRESH_TOKEN_TTL` | `2592000` | Refresh token lifetime (30 days, seconds) |

## Spec amendments from adversarial review

A pre-implementation debate between Claude (Opus 4.6) and Codex (GPT-5.3) produced spec amendments. See `debate/resolution.md` for the full record. Key changes from the original `technical-spec.md`:

1. **UPSERT** uses `ON CONFLICT ... DO UPDATE`, not `INSERT OR REPLACE`
2. **All mutations** wrapped in a single `db.transaction()` (entries + audit_log)
3. **WAL mode** + `busy_timeout=5000` + `synchronous=NORMAL` set at DB init
4. **Composite indexes** replace the useless tags index: `(namespace, entry_type, key)` and `(namespace, entry_type, created_at DESC)`
5. **CHECK constraints** enforce state→key NOT NULL, log→key NULL, and `json_type(tags)='array'`
6. **Timestamps** always UTC ISO 8601 via single `nowUTC()` function
7. **FTS rebuild** function included in `db.ts` (not just a comment)
8. **New tool `memory_get`** for fetching full entries by ID
9. **Delete uses token-based confirmation** instead of simple boolean
10. **LIKE queries** escape `_` and `%` wildcards in namespace prefix search
11. **Tag filtering** applied before `limit` in query results

When `technical-spec.md` and `debate/resolution.md` conflict, the resolution takes precedence.

## Important constraints

- The spec files (`prd.md`, `technical-spec.md`) are the source of truth, **amended by `debate/resolution.md`**.
- v1 is local-only, single-user. Multi-agent auth and encryption are v2 concerns.
- Semantic search (sqlite-vec + Transformers.js) available via `memory_query` with `search_mode` parameter. Three-tier gating: infra + semantic gate + hybrid gate.
- No memory decay or scoring — everything persists until explicitly deleted.
- The design must not preclude future deployment on Raspberry Pi 5 (ARM64).
