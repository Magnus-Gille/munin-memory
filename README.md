# Munin Memory

Persistent memory for AI assistants, self-hosted and provider-portable.

Named after Munin, one of Odin's two ravens — the one responsible for memory.
Munin Memory is unrelated to the established Munin network-monitoring project.

## Why

AI assistants forget everything between conversations. The context you build up — project decisions, personal preferences, how your systems work — evaporates when the session ends.

Some providers offer built-in memory features, but that context lives on their servers, in their format, under their control. If you switch providers, or they change their terms, or they shut down — your accumulated context goes with them.

Munin Memory is a different approach: a lightweight [MCP](https://modelcontextprotocol.io/) server that stores your AI's memory in a SQLite database **you own and control**. It runs on a Raspberry Pi, a VPS, or your laptop, and any MCP-compatible client can use the same memory contract.

The underlying principle: **your AI's memory is your data, and it should live on your infrastructure.**

For the full argument, see [Resilient and Sovereign AI](https://gille.ai/en/blog/resilient-and-sovereign-ai/).

## What it does

Munin is more than a key-value store for AI. The features are designed around how an assistant actually needs to think across time, across devices, and across people.

- **Background consolidation (the "sleep" feature)** — an optional worker periodically synthesizes recent log entries into an enriched `synthesis` entry via an OpenRouter LLM call, extracting decisions, open threads, and cross-namespace references. The human-maintained `status` entry is treated as ground truth: the synthesizer supplements it, but can never override phase or lifecycle. Ground-truth anchoring is enforced in the prompt, not by trust.
- **Computed lifecycle dashboard** — `memory_orient` returns a single "where is everything" view, computed dynamically from status entries in `projects/*` and `clients/*` and grouped by lifecycle (active, blocked, completed, stopped, maintenance, archived). No manual workbench to keep current.
- **Retrospective synthesis tools** — `memory_narrative`, `memory_commitments`, `memory_patterns`, and `memory_handoff` derive reviewable, source-backed signals from logs and audit history: blocker age, decision churn, open commitments, anti-patterns, and handoff packs between environments or agents. Every surfaced signal is tied to an explicit source entry — no hidden policy, no hallucinated summaries.
- **Two memory types** — state entries (mutable, current truth) and log entries (append-only, chronological history). A clean conceptual model that maps to how projects actually evolve.
- **Atomic state-write preconditions** — `memory_update_status` and `memory_write` support compare-and-swap (`expected_updated_at`) so concurrent environments do not blindly overwrite each other. `memory_write` also supports `create_if_absent: true` for ledgers and other first-writer-wins state: exactly one competing writer creates the key, while losers receive a typed conflict and the winner's `current_updated_at`.
- **Explicit correction history** — `memory_write` and `memory_log` accept `supersedes` plus a mandatory `expected_updated_at` to create a new revision without destroying the original evidence. Normal retrieval returns only the current revision; `memory_get` can open historical UUIDs and `memory_read(as_of)` resolves state at a past instant.
- **Hierarchical namespaces** — `projects/website`, `people/alice`, `decisions/tech-stack`, `clients/acme`, and so on. Prefixed tags (`client:acme`, `person:alice`, `topic:ai-education`) cross-reference entries without rigid schemas.
- **Three search modes** — keyword (FTS5), semantic (vector embeddings), and hybrid (fused via Reciprocal Rank Fusion). Semantic modes are optional and profile-dependent.
- **Multi-principal access control** — server-enforced namespace isolation. The owner gets full access; family members, agents, and external principals get scoped permissions. OAuth clients auto-map to principals via a trusted proxy email header. A `munin-admin` CLI manages principals, devices, and service tokens.
- **Outcome-aware retrieval** — Munin observes what the assistant does after each retrieval (opened a result? wrote in the namespace? reformulated the query?) and accumulates per-entry signals over time. Inspectable via `memory_insights`; explicit feedback via `memory_retrieval_feedback`.
- **Cursorable change feed + provenance** — audit history can be paged forward for multi-agent sync, and entries and audits carry actor provenance.
- **Content security** — writes are heuristically scanned for common secrets (API keys, tokens, inline passwords) and rejected before storage. Confidential OAuth client secrets are encrypted at rest.
- **Dual auth** — Bearer token (simple) + OAuth 2.1 with dynamic client registration and PKCE (for web and mobile clients).
- **Two transports** — stdio (local) and Streamable HTTP (network).

Twenty-three MCP tools in total. The compact checked inventory is in [AGENTS.md](AGENTS.md#mcp-tools-exposed).

## What it looks like in practice

These features exist to solve specific friction points that appear once you actually use persistent AI memory every day:

- **"What's next?" gives a real answer.** Open any project and ask. `memory_orient` returns the computed dashboard grouped by lifecycle; for a specific project, the synthesis entry provides the consolidated arc — decisions, blockers, and open threads — without you having to paste a summary. The consolidation worker quietly rolls logs into a readable synthesis while you're away.
- **Decisions survive the conversation that made them.** When you decide something, log it once. Six weeks later, `memory_narrative` or `memory_commitments` surfaces it with rationale and timestamp. No searching through chat history.
- **Cross-environment continuity.** Different coding agents, desktop clients, and web or mobile MCP clients can share one Munin instance. A status update from one environment is available to the next. The two-layer model (local detail files + Munin summary state) keeps each environment fast without losing coherence.
- **Cross-namespace awareness.** The consolidator extracts references between namespaces — "this project depends on `people/alice` finishing X". Later, when you update Alice's status, you can see what's blocked on her.
- **Honest retrospection.** `memory_patterns` only surfaces patterns that are backed by actual source entries. `memory_commitments` tracks open, overdue, at-risk, and completed follow-through. Nothing is invented — every signal points back to a source.
- **Shared memory with scoped access.** A family member or a research agent can use the same Munin server without seeing your work namespaces. Principals have namespace rules and the server enforces them on every tool call, with denial semantics that make disallowed namespaces invisible rather than merely refused.
- **Handoff between agents.** When one agent (or one environment) hands work to another, `memory_handoff` assembles a source-backed pack: current state, recent decisions, open loops, recent actors, and recommended next actions. Tuned for multi-agent setups where context transfer matters.

## Architecture

```
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ Coding agent │  │Desktop client│  │  Web client  │
 │  (stdio)     │  │  (Bearer)    │  │  (OAuth)     │
 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │ HTTPS
               ┌──────────┴──────────┐
               │    Reverse proxy    │
               │ (Cloudflare Tunnel, │
               │   nginx, etc.)      │
               └──────────┬──────────┘
                          │
┌─────────────────────────┴───────────────────────────┐
│              Munin Memory MCP Server                │
│  Node.js · TypeScript · Express · HTTP transport    │
├─────────────────────────────────────────────────────┤
│  SQLite + FTS5 (keyword search)                     │
│  Optional: sqlite-vec + embedding backend           │
└─────────────────────────────────────────────────────┘
Also supports stdio transport for any local MCP client.
```

Key technology choices:
- **SQLite** — single-file database, no server process, runs everywhere including ARM64
- **FTS5** — built-in full-text search, no external service needed
- **sqlite-vec** — optional vector similarity search for semantic queries
- **Embedding backend** — local embedding generation is supported today, but it is not assumed for every hardware profile
- **MCP** — open protocol, not locked to any provider

## Hardware Profiles

Munin Memory now has an explicit tiered appliance direction instead of assuming every Raspberry Pi deployment should run the same feature set.

| Profile | Target | Default expectations |
|---------|--------|----------------------|
| `zero-appliance` | Raspberry Pi 3A+ / Zero 2 W (512MB class) | Core memory **plus q8 semantic/hybrid search**. The 2026-06-18 on-hardware RAM-fit sweep refuted the earlier "semantic is out by hardware constraint" assumption: q8 MiniLM holds a peak working set ≈ 74–99 MB and fits even a 128MB cgroup cap. |
| `zero-plus` | Raspberry Pi 5 2GB class hardware | Core memory plus q8 semantic/hybrid search with more headroom (larger embedding batch, bigger page cache). |
| `full-node` | Raspberry Pi 4/5 4GB+, mini PC, VPS, or stronger hardware | Full public-remote deployment, OAuth, and local semantic/hybrid search. |

No full rewrite is recommended as the first move: keep the MCP and SQLite contract stable. The 2026-06-18 RAM-fit sweep validated the constrained profile on real hardware and settled the entry tier — Zero/3A+ stays viable as `zero-appliance` with q8 semantic ON. Select a tier with the `MUNIN_PROFILE` env var. See [docs/appliance-profiles.md](docs/appliance-profiles.md) for the full rationale and the validated findings.

## Getting started

### Prerequisites

- Node.js 20+
- npm

### Canonical five-minute path

```bash
git clone https://github.com/Magnus-Gille/munin-memory.git
cd munin-memory
./scripts/quickstart.sh
```

The quick start installs the locked dependencies, builds Munin, preflights the
runtime/SQLite/paths/profile/port/auth posture, generates placeholder-only
configs for Codex, Claude Code, Claude Desktop, and generic Streamable HTTP,
then verifies orient → status/health → write/log → resume → read against a fresh
or existing owner-only database. It defaults to local stdio and lexical search so
first success needs neither a bearer credential nor an embedding-model download.

See [the five-minute quick-start guide](docs/quickstart.md) for client setup,
semantic enablement, measurements, upgrade/rollback, and uninstall behavior.

For developer-only manual setup, run `npm ci && npm run build` and use the
transport commands below.

### Local mode (stdio)

The simplest way to run is to configure your MCP client to launch:

```bash
node /absolute/path/to/munin-memory/dist/index.js
```

An optional Claude Code registration example is
`claude mcp add-json munin-memory '{"command":"node","args":["/absolute/path/to/munin-memory/dist/index.js"]}'`.

### Network mode (HTTP)

For remote access — run as a service, connect from any device:

```bash
# Generate an API key
export MUNIN_API_KEY=$(openssl rand -hex 32)

# Start the server
MUNIN_TRANSPORT=http MUNIN_API_KEY=$MUNIN_API_KEY node dist/index.js

# Verify the unauthenticated health endpoint
curl http://127.0.0.1:3030/health
```

The HTTP bearer token configured as `MUNIN_API_KEY` is a shared owner
credential: requests authenticated with it are intentionally attributed to
`owner`. For tenant or service clients that need distinct attribution, provision
an agent principal and use its one-time service token instead. Grant only the
namespaces that client needs; this example covers both direct state entries in
`traces/codex-tenant` and optional child namespaces below it:

```bash
npx munin-admin principals add codex-cli \
  --type agent \
  --rules '[{"pattern":"traces/codex-tenant","permissions":"rw"},{"pattern":"traces/codex-tenant/*","permissions":"rw"}]'
```

The command prints the raw token once. Configure the client with that token as
`Authorization: Bearer ...`; writes and `memory_history.agent_id` will then use
`codex-cli` rather than `owner`. If the client only writes child namespaces, omit
the exact rule; if it only writes state keys directly in one namespace, omit the
`/*` rule.

### Connect from an OAuth-capable client

When running in HTTP mode, the server exposes OAuth 2.1 endpoints. Configure your MCP client with the server URL and the OAuth flow handles authentication automatically. For public deployments, OAuth consent is now fail-closed: you must configure a trusted proxy-authenticated header/value pair for `/authorize` and `/authorize/approve`, or the server will refuse to serve public consent. See the configuration below and the route/provider contracts in `src/index.ts` and `src/oauth.ts` for details.

## Configuration

All configuration is via environment variables. Copy `.env.example` for a starting point.

| Variable | Default | Description |
|----------|---------|-------------|
| `MUNIN_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `MUNIN_HTTP_PORT` | `3030` | HTTP server port |
| `MUNIN_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MUNIN_API_KEY` | — | Bearer token (required for HTTP mode) |
| `MUNIN_RATE_LIMIT_PER_CALLER_MAX` | `60` | Authenticated MCP requests admitted per caller per window |
| `MUNIN_RATE_LIMIT_PER_CREDENTIAL_MAX` | `180` | Aggregate requests admitted per authenticated principal/client credential per window |
| `MUNIN_RATE_LIMIT_GLOBAL_MAX` | `300` | Process-wide MCP admission backstop per window |
| `MUNIN_RATE_LIMIT_WINDOW_MS` | `60000` | Continuous-refill admission window in milliseconds |
| `MUNIN_RATE_LIMIT_MAX_CALLERS` | `1000` | Maximum independently tracked caller buckets; overflow remains capped |
| `MUNIN_MEMORY_DB_PATH` | `~/.munin-memory/memory.db` | Database file location |
| `MUNIN_PROFILE` | — | Optional hardware preset: `zero-appliance`, `zero-plus`, or `full-node` |
| `MUNIN_EMBEDDINGS_ENABLED` | `true` | Enable semantic search |
| `MUNIN_EMBEDDINGS_MODEL` | profile-dependent; otherwise `Xenova/bge-small-en-v1.5` | Local embedding model |
| `MUNIN_SEMANTIC_ENABLED` | `true` | Allow semantic search requests |
| `MUNIN_HYBRID_ENABLED` | `true` | Enable hybrid search (FTS5 + vector) |
| `MUNIN_OAUTH_ISSUER_URL` | `http://localhost:3030` | OAuth issuer (set to your public URL) |
| `MUNIN_OAUTH_CLIENT_SECRET_KEY` | — | Optional dedicated key for encrypting confidential OAuth client secrets at rest; defaults to `MUNIN_API_KEY` |
| `MUNIN_OAUTH_TRUSTED_USER_HEADER` | — | Trusted header name required for public OAuth consent |
| `MUNIN_OAUTH_TRUSTED_USER_VALUE` | — | Exact trusted header value required for public OAuth consent |
| `MUNIN_OAUTH_ALLOW_LOCALHOST_CONSENT` | `true` | Allow consent on loopback-only local development |
| `MUNIN_OWNER_ALIASES` | legacy compatibility alias | Optional comma-separated owner names recognized by orientation and injection checks |
| `MUNIN_OWNER_PROFILE_NAMESPACE` | `people/owner` | Canonical owner-profile namespace; lookup falls back to existing `people/magnus` data |

See `.env.example` for the full list.

## Credential storage (MCP bridge)

The stdio-to-HTTP bridge (`dist/bridge.js`) needs a Bearer token and optionally Cloudflare Access client credentials to talk to a remote Munin server. MCP clients typically pass these via env vars in their config file, which means the secrets end up in plaintext on disk (often `0644`, syncable to dotfile repos, easy to screenshot).

**Recommended: store secrets in a `chmod 600` JSON file, not in your MCP client config.**

```bash
mkdir -p ~/.config/munin
cat > ~/.config/munin/credentials.json <<'JSON'
{
  "auth_token": "…",
  "cf_client_id": "…",
  "cf_client_secret": "…"
}
JSON
chmod 600 ~/.config/munin/credentials.json
```

Then point the bridge at the file in your MCP client config (example: `~/.codex/config.toml`):

```toml
[mcp_servers.munin-memory.env]
MUNIN_REMOTE_URL = "https://munin.example.com/mcp"
MUNIN_CREDENTIALS_FILE = "/Users/you/.config/munin/credentials.json"
```

The bridge refuses to read a credentials file that is group- or world-accessible — fix perms with `chmod 600`. If both the file and inline env vars are set, the file wins and a stderr warning lists the env vars that were ignored.

All three fields are optional; omit `cf_client_id` / `cf_client_secret` if you don't use Cloudflare Access. Rotate the Bearer token at a cadence that fits your threat model — once a quarter is a reasonable default for a personal deployment.

Each bridge process also sends a generated, non-secret `X-Munin-Client-Id` so
several agents sharing one legacy bearer credential receive independent admission
buckets. Set `MUNIN_BRIDGE_CLIENT_ID` to a stable opaque label when correlation
across bridge restarts is useful. The caller ID is a cooperative partition, not an
authentication boundary: the authenticated principal/client credential retains an
aggregate bucket, and the process retains a global backstop. Separate OAuth clients
or agent service tokens provide the strongest isolation.

The bridge retries only a Munin admission 429 marked
`X-Munin-Rate-Limit: admission-v1`, which is emitted before the request body is
processed and is therefore safe to replay. Unmarked proxy or upstream 429 responses
are returned without replay. Marked responses follow the server's `Retry-After`,
with positive jitter and bounded defaults: two retries, a 10-second total wait
budget, and 250 ms maximum jitter. Override these with
`MUNIN_BRIDGE_RATE_LIMIT_RETRIES`, `MUNIN_BRIDGE_RATE_LIMIT_MAX_WAIT_MS`, and
`MUNIN_BRIDGE_RATE_LIMIT_JITTER_MS`. Authentication failures (401/403) and other
HTTP failures are never retried by this path.

## Grimnir ecosystem

Munin is the persistent-memory component in the broader Grimnir ecosystem. Hugin
dispatches work, gille-inference provides an OpenAI-compatible inference gateway,
Mimir serves artifacts, Heimdall observes service health, and the Grimnir repository
documents the system contract. Munin does not require any of them: its supported
boundary is MCP plus SQLite, so it remains useful as a standalone server.

Compared with mem0, Zep/Graphiti, Letta, LangMem, basic-memory, and the MCP reference
memory server, Munin emphasizes an inspectable state-plus-log model, a single-file
self-hosted database, server-enforced namespace isolation, and first-class MCP over
both stdio and HTTP. It does not yet offer a managed cloud, automatic relationship
graphs, or turnkey conversation ingestion. See
[docs/competitive-analysis.md](docs/competitive-analysis.md) for the dated survey.

## Deploying to Linux or Raspberry Pi

The included deployment path is a generic systemd-oriented starting point:

1. **Deploy the code** — `./scripts/deploy-rpi.sh <your-pi-hostname>`
2. **Install the systemd service** — see `munin-memory.service` as a template
3. **Set up a reverse proxy** — Cloudflare Tunnel, Tailscale, WireGuard, nginx, or whatever fits your setup
4. **Configure OAuth** — set `MUNIN_OAUTH_ISSUER_URL` to your public domain and configure `MUNIN_OAUTH_TRUSTED_USER_HEADER` + `MUNIN_OAUTH_TRUSTED_USER_VALUE` so browser consent is only available to your authenticated user

The script renders the placeholders in `munin-memory.service`, refuses to deploy
over an existing Git checkout, and does not copy `.env` or database files. Review
the service user, paths, reverse-proxy trust boundary, and backup location for your
host before enabling it.

The optional `munin-backup.timer` intentionally has no destination default. It
supports two modes, configured in `~/munin-ops/.env`, and refuses to start if
neither is set rather than writing nowhere:

- **`remote`** — push to another host over ssh/rsync. Set `MUNIN_BACKUP_HOST` and
  `MUNIN_BACKUP_REMOTE_DIR`. The transfer is verified by comparing the
  destination's byte count against the snapshot, since `rsync` exiting `0` does
  not prove the bytes are readable there. Retention only runs after that check
  passes, so a failed transfer never prunes existing snapshots.
- **`local`** — write to a mounted volume. Set `MUNIN_BACKUP_MOUNT` to the
  filesystem root and `MUNIN_BACKUP_DIR` to an absolute child. The mount is
  verified before *and* after each write, symlinked path components are rejected,
  and the written file's filesystem identity is confirmed — so a dropped mount
  cannot silently redirect backups to the system disk.

`scripts/install-ops.sh` refuses to install a script whose destination model
differs from what the host is configured for, because that failure would
otherwise surface only as a missing backup days later.

For the broader appliance direction, the project now distinguishes between `full-node` and `zero-appliance` deployments. A Pi Zero 2 W is being treated as a constrained profile that needs explicit hardware validation rather than assumed feature parity. See [docs/appliance-profiles.md](docs/appliance-profiles.md).

## Design process

Every major feature was designed through structured adversarial debates between Claude (Opus) and Codex (GPT-5.4, earlier rounds used GPT-5.3). One AI proposes, the other critiques, they iterate, and the resolution becomes the implementation spec. Roughly two-thirds of Codex critiques change the plan in a non-trivial way, which is the entire reason the process exists.

The `debate/` directory holds the resolutions and round summaries. Highlights:

- `debate/resolution.md` — v1 core design (schema, queries, tools)
- `debate/expansion-resolution.md` — v2 features (tunnel, semantic search, OAuth)
- `debate/tunnel-security-summary.md` — 5-layer security architecture
- `debate/conventions-summary.md` — memory conventions and session protocol
- `debate/multi-principal-p1-summary.md` — multi-principal access control
- `debate/computed-dashboard-summary.md` — computed lifecycle dashboard
- `debate/admin-cli-summary.md` — `munin-admin` CLI

See [AGENTS.md](AGENTS.md#sources-of-truth) for the concise source-of-truth map; detailed architecture and spec amendments remain in `docs/`, `debate/`, and the implementation itself.

## Opinionated workflow

Munin works best with an explicit operating model — one where you define what goes into state entries versus log entries, which namespaces track project health, and when each environment writes versus just reads. Without that model, memory tends to drift: redundant state, lost history, stale dashboards.

Session conventions can be stored in Munin itself (in `meta/conventions`, surfaced by `memory_orient`). That entry is the instance's runtime contract and can be adapted for any MCP client.

For the underlying concepts — why the two entry types exist, what tracked statuses are for, and how to think about the two data layers — see [docs/usage-model.md](docs/usage-model.md).

## Tests

```bash
npm test              # Run the full Vitest suite
npm run test:watch    # Watch mode
```

## Status

Early-stage open source and intended for technically comfortable self-hosters.

Available today: 23 MCP tools, background consolidation through OpenRouter or a
compatible local endpoint, lifecycle and retrospective views, multi-principal
authorization, OAuth and service tokens, retrieval signals, and encrypted backup
helpers. The constrained profile has been validated under cgroup memory limits on
ARM64; appliance provisioning and user-experience testing on each named board remain
ongoing.

It is not a polished mass-market product or a managed service. Operators remain
responsible for TLS/reverse-proxy configuration, trusted OAuth headers, key custody,
backup restoration tests, upgrades, and review of any model-generated synthesis.

Built by Claude (Opus 4.6) and Magnus Gille, adversarially reviewed by Codex (GPT-5.4).

## Project docs

- [CHANGELOG.md](CHANGELOG.md) — release notes and version history
- [docs/vision.md](docs/vision.md)
- [docs/roadmap.md](docs/roadmap.md)
- [docs/appliance-profiles.md](docs/appliance-profiles.md)
- [docs/usage-model.md](docs/usage-model.md)
- [docs/competitive-analysis.md](docs/competitive-analysis.md)
- [PUBLICATION.md](PUBLICATION.md) — publication and history-audit boundary
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
