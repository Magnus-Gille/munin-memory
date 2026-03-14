# Jarvis Architecture Plan — Munin + Mímir + Hugin

**Author:** Magnus Gille + Claude (Opus 4.6)
**Date:** 2026-03-13
**Status:** Draft — pending adversarial review by Codex

## Vision

A personal AI knowledge system where any agent (Claude, Codex, ChatGPT), on any platform (laptop, desktop, web, mobile), can access the full context of Magnus's professional life — projects, clients, people, documents, signals — through a single conversational interface.

The user says "prepare me for the Scania meeting tomorrow" and the agent has everything it needs: project status, previous meeting notes, open tasks, the full proposal PDF, and recent signals from relevant people.

## Architecture Overview

Three independent services, composing through HTTP and Munin entries as glue:

```
┌─────────────────────────────────────────────┐
│              Agent Interface                │
│    Claude Code / Desktop / Web / Mobile     │
│    Codex / ChatGPT (via Munin HTTP API)     │
└──────────┬──────────┬──────────┬────────────┘
           │          │          │
     ┌─────▼───┐ ┌────▼────┐ ┌──▼──────────┐
     │  Munin  │ │  Hugin  │ │   Mímir     │
     │ (Brain) │ │(Hunter) │ │ (Archive)   │
     │ Pi 1    │ │ Pi 1    │ │ Pi 2 + NAS  │
     └─────────┘ └─────────┘ └─────────────┘
```

| Service | Role | Runs on | Exists? |
|---------|------|---------|---------|
| **Munin** | Memory. Structured knowledge, search, relationships, decisions, status. The orchestration point — all entries can reference Mímir files and Hugin signals. | Pi 1 (huginmunin) | Yes, deployed |
| **Mímir** | Archive. Self-hosted authenticated file server. Serves documents, presentations, images, PDFs over HTTPS. Read-only API. | Pi 2 (NAS, 2TB disk) | Needs building |
| **Hugin** | Hunter. Active intelligence gathering — RSS feeds, blogs, newsletters, X. Writes findings to Munin as log entries and periodic digests. | Pi 1 (co-located with Munin) | Needs building |

### Design Principles

1. **Each service does one thing well.** Munin remembers. Mímir stores. Hugin hunts. No god services.
2. **Munin is the single query interface.** Agents ask Munin; Munin entries point to Mímir files and Hugin signals. Agents follow references when they need deeper content.
3. **Self-hosted and sovereign.** All data on Magnus's hardware. Cloud used only for transport (Cloudflare Tunnel) and as optional backup.
4. **Simple interfaces.** HTTP + Bearer token auth. No custom protocols, no message queues, no databases beyond SQLite.
5. **Incremental buildout.** Each step delivers standalone value. No big-bang migration.

## Current Infrastructure

### Hardware

| Node | Hostname | Tailscale IP | Role | Storage |
|------|----------|-------------|------|---------|
| MacBook Air | magnus-macbook-air | 100.119.150.76 | Development, mgc/ folder, Claude Code | Local SSD |
| Pi 1 | huginmunin.local | 100.97.117.37 | Munin Memory MCP server | SD card (small) |
| Pi 2 | NAS | 100.99.119.52 | Samba NAS + Time Machine | 2TB USB disk |

### Network

- **Tailscale mesh:** All three nodes on the same tailnet. Encrypted WireGuard tunnels.
- **Cloudflare Tunnel (Pi 1):** `munin-memory.gille.ai` → Pi 1 localhost:3030. Outbound-only, no open ports.
- **Cloudflare Tunnel (Pi 2):** Does not exist yet. Needed for Mímir.
- **LAN:** Both Pis on same local network (ethernet). Low latency for Pi-to-Pi communication.

### Software

- **Munin:** Node.js 20+, TypeScript, SQLite + FTS5 + sqlite-vec, Express, MCP protocol. 288 tests. OAuth 2.1 + Bearer auth.
- **NAS:** Debian, Samba 4.22.6, systemd. Receives Munin DB backups hourly via rsync.
- **mgc/ folder:** ~200 files across 15+ customer folders. Meeting notes (md), presentations (HTML), PDFs, images, task files. Git-tracked (local only).

### Agent Access Matrix (current)

| Environment | Local files | Munin | Mímir | Hugin |
|-------------|------------|-------|-------|-------|
| Claude Code (laptop) | Yes | Yes (HTTP) | — | — |
| Claude Desktop | No | Yes (mcp-remote) | — | — |
| Claude Web (claude.ai) | No | Yes (OAuth) | — | — |
| Claude Mobile | No | Yes (OAuth) | — | — |
| Codex (laptop) | Yes | Yes (HTTP) | — | — |

### Agent Access Matrix (target)

| Environment | Local files | Munin | Mímir | Hugin signals |
|-------------|------------|-------|-------|---------------|
| Claude Code (laptop) | Yes | Yes | Yes (HTTP) | Via Munin |
| Claude Desktop | No | Yes | Yes (HTTP) | Via Munin |
| Claude Web (claude.ai) | No | Yes | Yes (HTTP) | Via Munin |
| Claude Mobile | No | Yes | Yes (HTTP) | Via Munin |
| Codex (laptop) | Yes | Yes | Yes (HTTP) | Via Munin |
| ChatGPT (web) | No | Possible (HTTP) | Possible (HTTP) | Via Munin |

## Step 1: Mímir — Self-Hosted File Server

### Goal

Any authenticated agent can retrieve any file from Magnus's document archive over HTTPS.

### Technical Design

**Runtime:** Node.js (same stack as Munin for consistency, familiarity, and shared deployment patterns)

**Framework:** Express (minimal — static file serving + auth middleware + directory listing)

**Endpoints:**

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Health check for monitoring |
| `/files/*` | GET | Bearer | Serve file from archive directory tree |
| `/list/*` | GET | Bearer | JSON directory listing (recursive: false by default) |
| `/search` | GET | Bearer | Full-text search over extracted text index (Phase 2) |

**Auth:** Bearer token (`MIMIR_API_KEY`), same pattern as Munin v1. OAuth not needed initially — agents access Mímir via URLs in Munin entries, and the agent environment handles auth headers.

**File serving details:**
- Serves from a configurable root directory (default: `/mnt/artifacts/`)
- Path traversal protection (resolve + startsWith check)
- MIME type detection (built-in or `mime-types` package)
- Range request support for large files (PDF streaming)
- No upload endpoint — files arrive via rsync from laptop

**Directory listing (`/list/*`):**
```json
{
  "path": "/mgc/customers/lofalk-advokatbyra/",
  "entries": [
    { "name": "utbildning.pdf", "type": "file", "size": 45231, "modified": "2026-03-09T..." },
    { "name": "images/", "type": "directory", "modified": "2026-03-11T..." }
  ]
}
```

**Security:**
- Bearer token auth on all endpoints except `/health`
- Path traversal prevention (no `..`, symlink resolution, jail to root dir)
- Rate limiting (60 req/min, same as Munin)
- Body size irrelevant (read-only server)
- CORS headers for web clients if needed
- Security headers (X-Content-Type-Options, X-Frame-Options, CSP)

**Configuration (env vars):**

| Variable | Default | Description |
|----------|---------|-------------|
| `MIMIR_PORT` | `3031` | HTTP server port |
| `MIMIR_HOST` | `127.0.0.1` | Bind address (localhost for tunnel) |
| `MIMIR_API_KEY` | — | Bearer token (required) |
| `MIMIR_ROOT_DIR` | `/mnt/artifacts` | Root directory to serve files from |
| `MIMIR_ALLOWED_HOSTS` | — | DNS rebinding protection (same as Munin) |

### Deployment

**On NAS Pi (Pi 2):**

1. Create artifact directory:
   ```bash
   sudo mkdir -p /mnt/artifacts
   sudo chown magnus:magnus /mnt/artifacts
   ```

2. Project repo (simple, could even be a single file initially):
   ```
   mimir/
   ├── package.json
   ├── tsconfig.json
   ├── src/
   │   └── index.ts
   ├── .env
   └── mimir.service    # systemd unit
   ```

3. systemd service (`mimir.service`):
   ```ini
   [Unit]
   Description=Mímir File Server
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=magnus
   WorkingDirectory=/home/magnus/mimir
   ExecStart=/usr/bin/node dist/index.js
   Restart=always
   RestartSec=5
   EnvironmentFile=/home/magnus/mimir/.env

   # Sandboxing (same pattern as Munin)
   ProtectSystem=strict
   ReadOnlyPaths=/mnt/artifacts
   NoNewPrivileges=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

4. Cloudflare Tunnel — add route to existing tunnel or create new tunnel on Pi 2:
   - Route: `mimir.gille.ai` → `http://localhost:3031`
   - CF Access policy: Bypass for API (Bearer auth at origin), or Service Token (same as Munin)

### Laptop Sync

**rsync from MacBook to NAS (launchd plist or cron):**

```bash
#!/bin/bash
# sync-to-mimir.sh
rsync -av --delete \
  --exclude='.git/' \
  --exclude='.DS_Store' \
  --exclude='node_modules/' \
  --exclude='.playwright-mcp/' \
  --exclude='tools/' \
  --exclude='files/' \
  --exclude='.pytest_cache/' \
  --exclude='test-results/' \
  ~/mgc/ magnus@100.99.119.52:/mnt/artifacts/mgc/
```

**Schedule:** Every 15 minutes via launchd, or on-demand before important sessions.

**Conflict model:** Laptop is the source of truth. rsync `--delete` mirrors deletions. NAS is a read-only replica. No bidirectional sync.

### Munin Integration — Content Convention

When a file is indexed into Munin, the entry content follows this structure:

```markdown
# <Document Title>

**Source:** https://mimir.gille.ai/files/mgc/customers/lofalk-advokatbyra/utbildning.pdf
**Local:** ~/mgc/customers/lofalk-advokatbyra/utbildning.pdf
**Type:** PDF | HTML | Markdown | Image
**Size:** 45 KB
**Date:** 2026-03-09
**Tags:** client:lofalk, topic:ai-education, type:presentation

## Summary
<2-5 sentence summary of the document>

## Key Points
- <extracted insight 1>
- <extracted insight 2>
- ...

## Extracted Text (truncated)
<first ~5000 characters of extracted text, enough for semantic search to work>
```

This means:
- **Mobile/Web agents** get the summary and key points from Munin (sufficient for 90% of queries)
- **Any agent** can follow the `Source` URL to fetch the full file from Mímir when needed
- **Semantic search** works on the extracted text + summary (embedded by Munin's background worker)
- **Laptop agents** can also use the `Local` path for direct filesystem access

### Indexing Skill (`/index-artifacts`)

A Claude Code skill that scans mgc/ and creates/updates Munin entries:

**Input:** Optional path filter (e.g., `customers/lofalk-advokatbyra/`)

**For each file:**
1. Determine type (PDF, HTML, markdown, image, other)
2. Extract text:
   - PDF: `pdftotext` (poppler) or a Node.js PDF parser
   - HTML: strip tags, extract text content
   - Markdown: passthrough
   - Images: describe via Claude vision (optional, manual trigger)
   - Other: skip with warning
3. Generate summary (Claude summarizes the extracted text)
4. Write to Munin:
   - `documents/<customer>-<slug>/summary` — the index entry (content convention above)
   - Update `clients/<customer>/index` — manifest of all indexed artifacts for this client
5. Tag appropriately: `client:<name>`, `type:<filetype>`, `topic:<topic>`

**Idempotency:** Re-running updates existing entries. Uses file modification time to skip unchanged files.

**Estimated scope:** ~100 files worth indexing across 15 customers. One Claude Code session.

## Step 2: People as Knowledge Graph Nodes

### Goal

Structured profiles for every person Magnus works with or follows, enabling relationship traversal and signal targeting.

### Namespace Structure

```
people/<name>/profile       # Who they are, how Magnus knows them
people/<name>/sources       # Where they publish (RSS, blog, X, newsletter)
people/<name>/notes         # Freeform notes, meeting context
```

### Profile Template

```markdown
# <Full Name>

**Role:** <title, organization>
**Relationship:** <client contact | colleague | industry figure | friend>
**How we met:** <context>
**Last interaction:** <date, brief note>

## Why Follow
<What makes this person interesting/relevant to Magnus's work>

## Known For
- <topic 1>
- <topic 2>

## Contact
- Email: <if known>
- LinkedIn: <if known>
- X: <handle>
- Blog: <URL>
```

### Sources Template

```markdown
# Sources — <Name>

## Active Sources
- **Blog:** <URL> (RSS: <feed URL>)
- **X:** @<handle>
- **Newsletter:** <name> (<subscribe URL>)
- **GitHub:** <profile URL>

## Check Frequency
<daily | weekly | monthly | on-demand>
```

### Seeding

Populate from:
1. mgc/customers/ — extract contact names from meeting notes
2. Existing Munin `people/*` entries
3. Magnus's X follow list (via x-mcp-server)
4. Manual input for key industry figures

### Cross-Referencing via Tags

Every Munin entry that relates to a person gets tagged `person:<name>`. This enables:
- `memory_query("", tags: ["person:paul-graham"])` → everything related to Paul Graham
- `memory_query("", tags: ["client:lofalk", "person:sara"])` → Sara's involvement with Lofalk

This is a lightweight knowledge graph — no graph database needed, just consistent tagging.

## Step 3: Reading Queue

### Goal

Track what Magnus should read, has read, and the insights extracted from reading.

### Namespace Structure

```
reading/queue           # State entry: prioritized reading list
reading/<slug>/summary  # Completed read: summary, insights, relevance
```

### Queue Template

```markdown
# Reading Queue

## High Priority
1. **<Title>** — <Author> — <Source URL or Mímir URL>
   *Why:* <reason this is relevant>

2. ...

## Normal Priority
...

## Completed (move to reading/<slug>/summary)
- [x] <Title> (2026-03-10)
```

### Completed Read Template

```markdown
# <Title>

**Author:** <name>
**Source:** <URL>
**Read:** <date>
**Tags:** topic:<t>, person:<p>

## Summary
<3-5 sentences>

## Key Insights
- <insight 1>
- <insight 2>

## Relevance to My Work
<How this connects to Magnus's projects, clients, or thinking>

## Quotes
> <notable quote 1>
> <notable quote 2>
```

## Step 4: Hugin — The Intelligence Hunter

### Goal

Automated gathering of signals from people and sources Magnus follows. Writes findings to Munin. Agents can then answer "what's new?" queries.

### Technical Design

**Runtime:** Node.js (same stack)
**Location:** Pi 1 (co-located with Munin, since it's a Munin API client)
**Execution model:** Cron-triggered scripts, not a long-running daemon

**Project structure:**
```
hugin/
├── package.json
├── tsconfig.json
├── src/
│   ├── feeds.ts        # RSS/Atom feed fetcher + parser
│   ├── blogs.ts        # Blog sitemap/page checker
│   ├── x.ts            # X API integration (via x-mcp-server or direct)
│   ├── digest.ts       # Compile signals into periodic digests
│   ├── munin-client.ts # HTTP client for Munin Memory API
│   └── index.ts        # CLI entry point: hugin check | hugin digest
├── .env
└── hugin-*.timer       # systemd timers
```

### Data Flow

```
1. Hugin reads target list from Munin:
   memory_read("people/paul-graham", "sources")
   → RSS feed URL, blog URL, X handle

2. Hugin checks each source for new content:
   → Fetches RSS feed, compares against last-seen timestamps
   → Checks blog sitemap for new URLs
   → Queries X API for recent posts

3. For each new item found:
   → Extract: title, URL, date, author, text excerpt
   → Summarize (via Claude API or local model)
   → Deduplicate against existing Munin entries

4. Write to Munin:
   memory_log("people/paul-graham", "New essay: 'How to Start a Startup 2.0' — <summary>", tags: ["signal", "blog"])

5. Periodically compile digests:
   memory_write("digests/weekly", "2026-w11", "<compiled summary of all signals this week>")
```

### Scheduling

| Job | Frequency | What it does |
|-----|-----------|-------------|
| `hugin check --rss` | Every 6 hours | Check RSS feeds for all followed people |
| `hugin check --blogs` | Daily | Check blog sitemaps for new posts |
| `hugin check --x` | Daily | Check X for posts from followed accounts |
| `hugin digest --daily` | Daily 06:00 | Compile yesterday's signals into a daily digest |
| `hugin digest --weekly` | Monday 06:00 | Compile past week's signals into weekly digest |

### Deduplication

Hugin maintains a `last_checked` state per source in Munin:
```
signals/<source-slug>/state → { "last_checked": "2026-03-13T06:00:00Z", "last_item_url": "..." }
```

On each check, only items newer than `last_checked` are processed.

### Summarization

**Option A:** Call Claude API directly (cost: ~$0.01-0.05 per article summary)
**Option B:** Use a local model on Pi (limited by ARM64/8GB RAM — feasible with small models)
**Option C:** Store raw excerpts, let the querying agent summarize on demand

Recommendation: **Option A** for now. The volume is low (maybe 5-20 items/day across all sources). Cost is negligible. Quality is high.

### X Integration

The x-mcp-server already exists in `mgc/tools/x-mcp-server/`. Hugin can either:
1. Import and use its API client directly
2. Call it as an MCP tool (more complex, less necessary)
3. Use X API v2 directly with the same credentials

Recommendation: Direct API usage with shared credentials. Keep it simple.

### Digest Format

```markdown
# Weekly Signal Digest — W11 2026 (Mar 10-16)

## Highlights
- Paul Graham published "How to Start a Startup 2.0" — argues that...
- Andrej Karpathy posted thread on agent evaluation metrics
- 3 new posts from your AI/developer network

## By Person

### Paul Graham
- **"How to Start a Startup 2.0"** (Mar 12) — [blog](URL)
  Summary: ...

### Andrej Karpathy
- **Thread on agent evals** (Mar 14) — [X](URL)
  Summary: ...

## By Topic
- **AI Agents:** 4 items (Karpathy, Grady Booch, ...)
- **Startups:** 2 items (Graham, ...)

## Relevance to Active Projects
- Scania: Karpathy's eval metrics relevant to the AI assessment proposal
- Munin: Graham's "tools should be invisible" applies to our Jarvis direction
```

## Namespace Evolution Summary

### Current

```
projects/*          # Project status and logs
clients/*           # Customer context
people/*            # People profiles (thin)
meta/*              # System conventions, notes
infrastructure/*    # Hardware inventory, backups
tasks/*             # Task tracking
rituals/*           # Weekly plans
decisions/*         # Cross-cutting decisions
```

### Target (additions)

```
documents/*         # Indexed artifacts (summaries + Mímir references)
reading/*           # Reading queue and completed reads
signals/*           # Hugin tracking state per source
digests/*           # Compiled signal digests (daily, weekly)
```

### Tagging Convention

Prefix tags for cross-referencing:
- `client:<name>` — links to a client
- `person:<name>` — links to a person
- `topic:<topic>` — subject categorization
- `type:<artifact-type>` — document type (pdf, presentation, meeting-notes, proposal)
- `signal` — item from Hugin
- `blog`, `x`, `rss`, `newsletter` — signal source type

## Build Order and Dependencies

```
Step 1: Mímir ──────────────────────────┐
  1a. File server on NAS Pi             │
  1b. Cloudflare Tunnel for Pi 2        │
  1c. rsync from laptop                 │
  1d. /index-artifacts skill            ├── Foundation
  1e. Index mgc/ into Munin             │
                                        │
Step 2: People profiles ────────────────┘
  2a. Expand people/* with profiles
  2b. Add sources to each person
  2c. Cross-reference existing entries with person: tags

Step 3: Reading queue ──────── (independent of Steps 1-2)
  3a. Create reading/queue
  3b. Backfill any existing reading notes

Step 4: Hugin ──────────────── (depends on Step 2)
  4a. RSS feed checker
  4b. Blog sitemap checker
  4c. Write signals to Munin
  4d. Daily digest generation
  4e. Weekly digest generation
  4f. X integration (later, harder)
```

## Open Questions for Debate

1. **Mímir auth model:** Bearer token only, or should Mímir also support OAuth for web/mobile agents that access files directly? (Counter-argument: agents access Mímir URLs via WebFetch with Bearer token, not via MCP — OAuth might be unnecessary complexity.)

2. **Cloudflare Tunnel topology:** Second tunnel on Pi 2, or route `mimir.gille.ai` through the existing Pi 1 tunnel and proxy Pi 1 → Pi 2? (Trade-off: separate tunnel is simpler but requires cloudflared on Pi 2; proxying keeps one tunnel but adds latency and coupling.)

3. **Hugin location:** Pi 1 (co-located with Munin, easy API access) or Pi 2 (has more disk if we need to cache content)? Or laptop (has Claude API keys, but not always on)?

4. **Summarization for indexing:** Should `/index-artifacts` use Claude API calls to summarize each document, or should it store extracted text and let the querying agent summarize on demand? (Trade-off: upfront cost vs. query-time cost. Upfront means the summary is in Munin for semantic search. On-demand means fresher but slower.)

5. **MCP for Mímir:** Should Mímir expose MCP tools (like Munin does), or is plain HTTP sufficient? MCP would let agents discover and use Mímir natively. HTTP means agents use WebFetch. (Trade-off: MCP is richer but more implementation effort; HTTP is simpler and universally accessible.)

6. **Content size strategy:** Some PDFs will exceed Munin's 100KB content limit when fully extracted. Options: (a) store only summaries + first 5K chars, (b) chunk into multiple entries, (c) raise the limit. Which is the right default?

7. **Bidirectional sync?** Currently proposed as laptop→NAS one-way. Should agents ever be able to write files to Mímir (e.g., Hugin saves a downloaded PDF)? If so, the rsync model breaks.

8. **Backup strategy:** Mímir files are rsynced from laptop. But Hugin-generated content (digests, downloaded articles) would only exist on Pi. What's the backup plan for Pi-originated content?

## Success Criteria

The system is "Jarvis" when:

1. **Any agent, any platform** can answer "what do I know about client X?" with full context (status + documents + meeting notes + people involved)
2. **"What's new?"** returns a curated digest of signals from people and sources Magnus follows
3. **Full document access** works from mobile — agent can read and analyze a PDF stored on the NAS
4. **Zero manual sync** — laptop files appear on NAS automatically, signals appear in Munin automatically
5. **Single query interface** — agents only need Munin MCP tools to find everything; Mímir URLs are followed transparently
6. **Sovereignty** — all data on Magnus's hardware, all transport encrypted, no vendor lock-in for storage or intelligence
