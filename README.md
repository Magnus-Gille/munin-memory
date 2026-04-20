# Munin Memory

Persistent memory for AI assistants, self-hosted and provider-portable.

Named after Munin, one of Odin's two ravens — the one responsible for memory.

## Why

AI assistants forget everything between conversations. The context you build up — project decisions, personal preferences, how your systems work — evaporates when the session ends.

Some providers offer built-in memory features, but that context lives on their servers, in their format, under their control. If you switch providers, or they change their terms, or they shut down — your accumulated context goes with them.

Munin Memory is a different approach: a lightweight [MCP](https://modelcontextprotocol.io/) server that stores your AI's memory in a SQLite database **you own and control**. It runs on a Raspberry Pi, a VPS, or your laptop. Any MCP-compatible AI client can connect — today that's Claude across all platforms, tomorrow it could be any provider that supports the protocol.

The underlying principle: **your AI's memory is your data, and it should live on your infrastructure.**

For the full argument, see [Resilient and Sovereign AI](https://gille.ai/en/blog/resilient-and-sovereign-ai/).

## What it does

Munin is more than a key-value store for AI. The features are designed around how an assistant actually needs to think across time, across devices, and across people.

- **Background consolidation (the "sleep" feature)** — an optional worker periodically synthesizes recent log entries into an enriched `synthesis` entry via an OpenRouter LLM call, extracting decisions, open threads, and cross-namespace references. The human-maintained `status` entry is treated as ground truth: the synthesizer supplements it, but can never override phase or lifecycle. Ground-truth anchoring is enforced in the prompt, not by trust.
- **Computed lifecycle dashboard** — `memory_orient` returns a single "where is everything" view, computed dynamically from status entries in `projects/*` and `clients/*` and grouped by lifecycle (active, blocked, completed, stopped, maintenance, archived). No manual workbench to keep current.
- **Retrospective synthesis tools** — `memory_narrative`, `memory_commitments`, `memory_patterns`, and `memory_handoff` derive reviewable, source-backed signals from logs and audit history: blocker age, decision churn, open commitments, anti-patterns, and handoff packs between environments or agents. Every surfaced signal is tied to an explicit source entry — no hidden policy, no hallucinated summaries.
- **Two memory types** — state entries (mutable, current truth) and log entries (append-only, chronological history). A clean conceptual model that maps to how projects actually evolve.
- **Structured status updates with CAS** — `memory_update_status` patches tracked status entries with compare-and-swap (`expected_updated_at`) so concurrent environments (laptop, desktop, web, mobile) don't blindly overwrite each other.
- **Hierarchical namespaces** — `projects/website`, `people/alice`, `decisions/tech-stack`, `clients/acme`, and so on. Prefixed tags (`client:lofalk`, `person:sara`, `topic:ai-education`) cross-reference entries without rigid schemas.
- **Three search modes** — keyword (FTS5), semantic (vector embeddings), and hybrid (fused via Reciprocal Rank Fusion). Semantic modes are optional and profile-dependent.
- **Multi-principal access control** — server-enforced namespace isolation. The owner gets full access; family members, agents, and external principals get scoped permissions. OAuth clients auto-map to principals via a trusted proxy email header. A `munin-admin` CLI manages principals, devices, and service tokens.
- **Outcome-aware retrieval** — Munin observes what the assistant does after each retrieval (opened a result? wrote in the namespace? reformulated the query?) and accumulates per-entry signals over time. Inspectable via `memory_insights`; explicit feedback via `memory_retrieval_feedback`.
- **Cursorable change feed + provenance** — audit history can be paged forward for multi-agent sync, and entries and audits carry actor provenance.
- **Content security** — writes are heuristically scanned for common secrets (API keys, tokens, inline passwords) and rejected before storage. Confidential OAuth client secrets are encrypted at rest.
- **Dual auth** — Bearer token (simple) + OAuth 2.1 with dynamic client registration and PKCE (for web and mobile clients).
- **Two transports** — stdio (local) and Streamable HTTP (network).

Twenty-two MCP tools in total. The full list is in [CLAUDE.md](CLAUDE.md#mcp-tools-exposed).

## What it looks like in practice

These features exist to solve specific friction points that appear once you actually use persistent AI memory every day:

- **"What's next?" gives a real answer.** Open any project and ask. `memory_orient` returns the computed dashboard grouped by lifecycle; for a specific project, the synthesis entry provides the consolidated arc — decisions, blockers, and open threads — without you having to paste a summary. The consolidation worker quietly rolls logs into a readable synthesis while you're away.
- **Decisions survive the conversation that made them.** When you decide something, log it once. Six weeks later, `memory_narrative` or `memory_commitments` surfaces it with rationale and timestamp. No searching through chat history.
- **Cross-environment continuity.** Claude Code on your laptop, Claude Desktop, Claude Web, and Claude Mobile all talk to the same Munin instance. A status update made on mobile shows up in your laptop session. The two-layer model (local detail files + Munin summary state) keeps each environment fast without losing coherence.
- **Cross-namespace awareness.** The consolidator extracts references between namespaces — "this project depends on `people/sara` finishing X". Later, when you update Sara's status, you can see what's blocked on her.
- **Honest retrospection.** `memory_patterns` only surfaces patterns that are backed by actual source entries. `memory_commitments` tracks open, overdue, at-risk, and completed follow-through. Nothing is invented — every signal points back to a source.
- **Shared memory with scoped access.** A family member or a research agent can use the same Munin server without seeing your work namespaces. Principals have namespace rules and the server enforces them on every tool call, with denial semantics that make disallowed namespaces invisible rather than merely refused.
- **Handoff between agents.** When one agent (or one environment) hands work to another, `memory_handoff` assembles a source-backed pack: current state, recent decisions, open loops, recent actors, and recommended next actions. Tuned for multi-agent setups where context transfer matters.

## Architecture

```
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │  Claude Code │  │Claude Desktop│  │  Claude Web  │
 │  (Bearer)    │  │  (Bearer)    │  │  (OAuth)     │
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
Also supports stdio transport for local use (Claude Code
or Claude Desktop running on the same machine as the server).
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
| `zero-appliance` | Raspberry Pi Zero 2 W class hardware | Core memory and lexical search only. Semantic is out by hardware constraint (~310MB available RAM cannot host an embedding model + index), not by quality preference. |
| `zero-plus-appliance` | Raspberry Pi 5 2GB class hardware | Core memory plus local embeddings/hybrid search in an appliance form factor. Justified by retrieval pilot data showing semantic materially lifts recall on prose-weighted corpora. |
| `full-node` | Raspberry Pi 4/5 4GB+, mini PC, VPS, or stronger hardware | Full public-remote deployment, OAuth, and local semantic/hybrid search. |

No full rewrite is recommended as the first move. The current direction is to keep the MCP and SQLite contract stable, validate the constrained profile on real hardware, and decide whether the entry tier should stay at Zero or move up to `zero-plus-appliance`. See [docs/appliance-profiles.md](docs/appliance-profiles.md) for the full rationale and the real-hardware spike plan.

## Getting started

### Prerequisites

- Node.js 20+
- npm

### Install and build

```bash
git clone https://github.com/Magnus-Gille/munin-memory.git
cd munin-memory
npm install
npm run build
```

### Local mode (stdio)

The simplest way to run — Claude Code connects directly via stdin/stdout:

```bash
# Register with Claude Code
claude mcp add-json munin-memory \
  '{"command":"node","args":["'$(pwd)'/dist/index.js"]}'
```

### Network mode (HTTP)

For remote access — run as a service, connect from any device:

```bash
# Generate an API key
export MUNIN_API_KEY=$(openssl rand -hex 32)

# Start the server
MUNIN_TRANSPORT=http MUNIN_API_KEY=$MUNIN_API_KEY node dist/index.js

# Register with Claude Code
claude mcp add --transport http \
  -H "Authorization: Bearer $MUNIN_API_KEY" \
  -s user munin-memory http://localhost:3030/mcp
```

### Connect from Claude Web / Mobile (OAuth)

When running in HTTP mode, the server exposes OAuth 2.1 endpoints. Configure your MCP client with the server URL and the OAuth flow handles authentication automatically. For public deployments, OAuth consent is now fail-closed: you must configure a trusted proxy-authenticated header/value pair for `/authorize` and `/authorize/approve`, or the server will refuse to serve public consent. See the [OAuth section in CLAUDE.md](CLAUDE.md#oauth-21-feature-3) for endpoint details.

## Configuration

All configuration is via environment variables. Copy `.env.example` for a starting point.

| Variable | Default | Description |
|----------|---------|-------------|
| `MUNIN_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `MUNIN_HTTP_PORT` | `3030` | HTTP server port |
| `MUNIN_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MUNIN_API_KEY` | — | Bearer token (required for HTTP mode) |
| `MUNIN_MEMORY_DB_PATH` | `~/.munin-memory/memory.db` | Database file location |
| `MUNIN_EMBEDDINGS_ENABLED` | `true` | Enable semantic search |
| `MUNIN_SEMANTIC_ENABLED` | `true` | Allow semantic search requests |
| `MUNIN_HYBRID_ENABLED` | `true` | Enable hybrid search (FTS5 + vector) |
| `MUNIN_OAUTH_ISSUER_URL` | `http://localhost:3030` | OAuth issuer (set to your public URL) |
| `MUNIN_OAUTH_CLIENT_SECRET_KEY` | — | Optional dedicated key for encrypting confidential OAuth client secrets at rest; defaults to `MUNIN_API_KEY` |
| `MUNIN_OAUTH_TRUSTED_USER_HEADER` | — | Trusted header name required for public OAuth consent |
| `MUNIN_OAUTH_TRUSTED_USER_VALUE` | — | Exact trusted header value required for public OAuth consent |
| `MUNIN_OAUTH_ALLOW_LOCALHOST_CONSENT` | `true` | Allow consent on loopback-only local development |

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

## Deploying to a Raspberry Pi

This is how I run it today — a `full-node` deployment on a Pi 5 on my desk, accessible from anywhere via a Cloudflare Tunnel. The general pattern:

1. **Deploy the code** — `./scripts/deploy-rpi.sh <your-pi-hostname>`
2. **Install the systemd service** — see `munin-memory.service` as a template
3. **Set up a reverse proxy** — Cloudflare Tunnel, Tailscale, WireGuard, nginx, or whatever fits your setup
4. **Configure OAuth** — set `MUNIN_OAUTH_ISSUER_URL` to your public domain and configure `MUNIN_OAUTH_TRUSTED_USER_HEADER` + `MUNIN_OAUTH_TRUSTED_USER_VALUE` so browser consent is only available to your authenticated user

The deploy script and service file are tailored to my setup. You will likely need to adjust paths, usernames, and network configuration for yours.

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

See `CLAUDE.md` for the full technical reference, including architecture details, spec amendments from the debates, and implementation notes.

## Opinionated workflow

Munin works best with an explicit operating model — one where you define what goes into state entries versus log entries, which namespaces track project health, and when each environment writes versus just reads. Without that model, memory tends to drift: redundant state, lost history, stale dashboards.

The conventions that govern live Claude sessions are stored in Munin itself (in `meta/conventions`, surfaced by `memory_orient`). That is the canonical runtime contract — it wins in any conflict.

For the underlying concepts — why the two entry types exist, what tracked statuses are for, and how to think about the two data layers — see [docs/usage-model.md](docs/usage-model.md).

## Tests

```bash
npm test              # Run the full Vitest suite
npm run test:watch    # Watch mode
```

## Status

Early-stage open source, but in daily use. It runs my own setup — Claude across four platforms (CLI, Desktop, Web, Mobile) sharing persistent memory through a Raspberry Pi 5 on my desk, publicly reachable via a Cloudflare Tunnel.

What's live today: the full MCP tool surface (22 tools), background consolidation via OpenRouter, the computed lifecycle dashboard, retrospective synthesis tools, multi-principal access control with OAuth auto-mapping and the `munin-admin` CLI, outcome-aware retrieval signals (Phase 1, observation only), and the five-layer security stack (Cloudflare Tunnel, Cloudflare Access, Bearer/OAuth, app hardening, Pi hardening).

What it is not: a polished mass-market product. It is optimized for a technically comfortable self-hoster. The deployment scripts assume Linux/systemd familiarity, you will need to adapt paths and network setup to your own environment, and the Pi Zero 2 W appliance direction is documented but not yet validated on hardware. Multi-principal access is implemented and tested, but in practice the server is still primarily used by a single human owner plus a handful of agent principals.

Built by Claude (Opus 4.6) and Magnus Gille, adversarially reviewed by Codex (GPT-5.4).

## Project docs

- [CHANGELOG.md](CHANGELOG.md) — release notes and version history
- [docs/vision.md](docs/vision.md)
- [docs/roadmap.md](docs/roadmap.md)
- [docs/appliance-profiles.md](docs/appliance-profiles.md)
- [docs/usage-model.md](docs/usage-model.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
