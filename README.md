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

- **9 MCP tools** for reading, writing, searching, and organizing memories
- **Two memory types:** state entries (mutable, current truth) and log entries (append-only, chronological history)
- **Hierarchical namespaces** (e.g. `projects/website`, `people/alice`, `decisions/tech-stack`)
- **Three search modes:** keyword (FTS5), semantic (vector embeddings), and hybrid (both combined via Reciprocal Rank Fusion)
- **Content security:** writes are heuristically scanned for common secrets — obvious API keys, tokens, and inline passwords are rejected before storage
- **OAuth secret hygiene:** confidential OAuth client secrets are encrypted at rest
- **Dual auth:** Bearer token (simple) + OAuth 2.1 (for web/mobile clients)
- **Two transports:** stdio (local) and Streamable HTTP (network)

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
│  sqlite-vec + Transformers.js (semantic search)     │
└─────────────────────────────────────────────────────┘
Also supports stdio transport for local use (Claude Code
or Claude Desktop running on the same machine as the server).
```

Key technology choices:
- **SQLite** — single-file database, no server process, runs everywhere including ARM64
- **FTS5** — built-in full-text search, no external service needed
- **sqlite-vec** — vector similarity search for semantic queries
- **Transformers.js** — local embedding generation (all-MiniLM-L6-v2), no API calls
- **MCP** — open protocol, not locked to any provider

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

## Deploying to a Raspberry Pi

This is how I run it — a Pi 5 on my desk, accessible from anywhere via a Cloudflare Tunnel. The general pattern:

1. **Deploy the code** — `./scripts/deploy-rpi.sh <your-pi-hostname>`
2. **Install the systemd service** — see `munin-memory.service` as a template
3. **Set up a reverse proxy** — Cloudflare Tunnel, Tailscale, WireGuard, nginx, or whatever fits your setup
4. **Configure OAuth** — set `MUNIN_OAUTH_ISSUER_URL` to your public domain and configure `MUNIN_OAUTH_TRUSTED_USER_HEADER` + `MUNIN_OAUTH_TRUSTED_USER_VALUE` so browser consent is only available to your authenticated user

The deploy script and service file are tailored to my setup. You will likely need to adjust paths, usernames, and network configuration for yours.

## Design process

Every major feature was designed through structured adversarial debates between Claude (Opus) and Codex (GPT-5.3). One AI proposes, the other critiques, they iterate, and the resolution becomes the implementation spec.

The summaries of these debates are in the `debate/` directory:

- `debate/resolution.md` — v1 core design (schema, queries, tools)
- `debate/expansion-resolution.md` — v2 features (tunnel, semantic search, OAuth)
- `debate/tunnel-security-summary.md` — 5-layer security architecture
- `debate/conventions-summary.md` — memory conventions and session protocol

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

This is an early-stage open-source project. It works well for my use case — Claude across 4 platforms (CLI, Desktop, Web, Mobile) sharing persistent memory through a Raspberry Pi on my desk.

It is usable today, but it is still optimized for a technically comfortable self-hoster rather than a polished mass-market product. The deployment scripts assume Linux/systemd familiarity, the security model is primarily single-user, and you should expect to adapt parts of the setup to your own environment.

Built by Claude (Opus 4.6) and Magnus Gille, adversarially reviewed by Codex (GPT-5.3).

## Project docs

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
