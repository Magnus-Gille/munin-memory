# Munin Memory — Product Requirements Document

## What Is This?

Munin Memory is a lightweight MCP (Model Context Protocol) server that gives Claude persistent memory across conversations. It is named after Munin, one of Odin's ravens in Norse mythology — the raven of memory.

This tool is built **for Claude, by Claude** (with Magnus Gille as the human collaborator). The "user" of this tool is Claude itself, operating via Claude Code or any MCP-compatible client. The human benefits indirectly — their AI collaborator remembers context, decisions, project states, and reasoning across sessions.

## The Problem

Claude loses all context between conversations. This means:

- Decisions get re-litigated because Claude doesn't remember why something was rejected
- Project states have to be re-explained every session
- Intermediate reasoning and analysis disappears when a conversation ends
- Claude asks the same clarifying questions repeatedly
- The human has to act as the memory layer, which is exhausting

## The Solution

A local-first MCP server backed by SQLite that exposes simple read/write/query tools. Claude can store and retrieve structured memories organized by namespace. No cloud, no complexity, no decay algorithms — just reliable persistent storage with good search.

## Design Principles

1. **Simplicity over sophistication** — No Hebbian learning, no decay curves, no vector embeddings. FTS5 keyword search is sufficient for v1. Fancy retrieval is a v2 concern.
2. **Reliability over features** — If Claude writes something, it must be there next time. Period.
3. **Low cognitive overhead for Claude** — Tool names should be obvious. Parameters should be minimal. Claude should never have to think about "how do I use this tool?" — it should be as natural as thinking "I should write this down."
4. **Portability** — Single SQLite file. Runs on macOS (laptop), Linux x86_64, and Linux ARM64. The data model should remain portable even if deployment packaging diverges across hardware profiles.
5. **Designed for the Hugin & Munin ecosystem** — This server should support a tiered hardware story: a constrained `zero-appliance` profile for Pi Zero 2 W class hardware, and a `full-node` profile for Pi 4/5 or stronger hardware. Design choices should not force a full rewrite before that hardware split is validated.

## Core Concepts

### Namespaces

All memories live in a namespace. Namespaces are hierarchical strings using `/` as separator. They allow Claude to organize knowledge by project, topic, or purpose.

Examples:
- `projects/gille-consulting`
- `projects/hugin-munin`
- `decisions/tech-stack`
- `presentations/ikea`
- `people/magnus`
- `meta/tool-usage-notes`

Namespaces are created implicitly when a memory is stored — no need to pre-register them.

### Entry Types

There are two fundamental types of memory:

**State entries** (mutable) — represent the *current* truth about something.
- "The consulting business is at ~20% capacity"
- "Magnus prefers Node.js for MCP servers"  
- "The Hugin/Munin RPi is set up with Raspberry Pi OS Lite 64-bit"
- These get updated/overwritten as things change

**Log entries** (append-only) — represent *things that happened* in chronological order.
- "2025-01-28: Decided to use SQLite over shodh-memory for the memory backend"
- "2025-02-12: Started building the munin-memory MCP server"
- These are never modified, only appended

This distinction matters. Claude needs both "what is the current status?" (state) and "what was the reasoning journey?" (log).

### Keys

State entries are identified by a namespace + key combination. The key should be a short, descriptive slug.

Examples:
- Namespace: `projects/gille-consulting`, Key: `status` → current project status
- Namespace: `projects/hugin-munin`, Key: `architecture` → current architecture decisions
- Namespace: `people/magnus`, Key: `preferences` → known preferences

Log entries don't have keys — they have timestamps and are ordered chronologically within their namespace.

## MCP Tools (The Interface Claude Uses)

These are the tools Claude will see and call. The names and parameters are critical UX decisions — they need to feel natural to an LLM.

### `memory_write`

Store or update a state entry.

Parameters:
- `namespace` (string, required) — e.g. "projects/hugin-munin"
- `key` (string, required) — e.g. "architecture"  
- `content` (string, required) — the actual content to store (markdown supported)
- `tags` (string[], optional) — freeform tags for cross-cutting concerns, e.g. ["raspberry-pi", "architecture"]

Behavior: If namespace+key already exists, overwrite it (update `updated_at`). If not, create it.

### `memory_read`

Retrieve a specific state entry.

Parameters:
- `namespace` (string, required)
- `key` (string, required)

Returns: The content, tags, created_at, and updated_at. Returns a clear "not found" message if the entry doesn't exist (not an error — Claude should be able to check if something exists).

### `memory_query`

Search across memories using full-text search.

Parameters:
- `query` (string, required) — search terms
- `namespace` (string, optional) — limit search to a specific namespace (or namespace prefix, e.g. "projects/" matches all projects)
- `entry_type` (string, optional) — "state" or "log" to filter by type
- `tags` (string[], optional) — filter by tags
- `limit` (number, optional, default 10) — max results

Returns: List of matching entries ranked by relevance, with namespace, key (if state), content (truncated to ~500 chars for readability), tags, and timestamps.

### `memory_log`

Append a chronological log entry.

Parameters:
- `namespace` (string, required)
- `content` (string, required)
- `tags` (string[], optional)

Behavior: Always appends. Never overwrites. Auto-timestamps.

### `memory_list`

List what's stored in a namespace or across all namespaces.

Parameters:
- `namespace` (string, optional) — if omitted, list all namespaces with entry counts. If provided, list all entries (state keys + log count) in that namespace.

Returns: Overview of what exists. This is Claude's way of "browsing" its memory — "what do I know about this topic?"

### `memory_delete`

Remove a specific state entry or clear a namespace.

Parameters:
- `namespace` (string, required)
- `key` (string, optional) — if provided, delete just that entry. If omitted, delete everything in the namespace.

Behavior: Requires confirmation in the response (i.e., returns what will be deleted before doing it). Log entries can only be deleted by clearing an entire namespace, not individually.

## What Good Looks Like — Example Usage Scenarios

### Scenario 1: Starting a new project

Claude and Magnus begin working on a website redesign.

```
Claude calls: memory_write(
  namespace="projects/gille-website", 
  key="brief",
  content="Redesign personal website. Current hosting: SiteGround (user@example.com). DNS: Cloudflare. Goal: professional consulting presence with AI focus.",
  tags=["website", "active"]
)

Claude calls: memory_log(
  namespace="projects/gille-website",
  content="Project started. Initial discussion about goals and branding."
)
```

### Scenario 2: Resuming work in a new conversation

Magnus says "Let's continue on the website." Claude has no context.

```
Claude calls: memory_read(namespace="projects/gille-website", key="brief")
→ Gets the full project brief

Claude calls: memory_query(query="website", namespace="projects/gille-website", entry_type="log")
→ Gets chronological history of what happened

Claude now has full context without Magnus repeating anything.
```

### Scenario 3: Making a decision

After evaluating options, Claude and Magnus decide on a tech stack.

```
Claude calls: memory_write(
  namespace="projects/gille-website",
  key="tech-stack",
  content="Astro + Tailwind. Rejected Next.js (overkill for mostly static site). Rejected Hugo (too limited for interactive elements).",
  tags=["decision", "tech-stack"]
)

Claude calls: memory_log(
  namespace="projects/gille-website",
  content="Decided on Astro + Tailwind for the website. Considered Next.js and Hugo. Astro chosen for balance of static performance and component flexibility."
)
```

### Scenario 4: Cross-project knowledge

Claude needs to check something that spans multiple contexts.

```
Claude calls: memory_query(query="raspberry pi setup", limit=5)
→ Returns results from projects/hugin-munin, projects/nas, etc.

Claude calls: memory_query(query="tech preferences", namespace="people/magnus")
→ Returns Magnus's known preferences
```

### Scenario 5: Browsing available knowledge

Claude wants to see what it knows.

```
Claude calls: memory_list()
→ Returns:
  projects/gille-consulting (3 state entries, 12 log entries)
  projects/hugin-munin (5 state entries, 8 log entries)
  projects/gille-website (2 state entries, 3 log entries)
  people/magnus (2 state entries, 0 log entries)
  decisions/tech-stack (1 state entry, 4 log entries)

Claude calls: memory_list(namespace="projects/hugin-munin")
→ Returns:
  State entries: architecture, hardware, os-setup, agent-config, status
  Log entries: 8 entries (2025-01-24 to 2025-02-12)
```

## Agent UX — How Claude Should Use This Tool

This section is critical. The tools alone don't create good behavior — Claude needs guidance on *when* and *how* to use them. The following should be included in any system prompt or CLAUDE.md file where munin-memory is available.

### Behavioral Guidelines for Claude

**At conversation start:**
- If the human references a project, topic, or prior work: call `memory_read` or `memory_query` to load relevant context BEFORE responding.
- If resuming known work: call `memory_list` on the relevant namespace to see what state exists.
- Do NOT dump everything from memory into the conversation. Load selectively based on what's relevant.

**During conversation:**
- When a decision is made: store the decision AND the rationale using both `memory_write` (state) and `memory_log` (chronological record).
- When new information about a person, project, or system is shared: update the relevant state entry.
- When you learn something you wish you'd known at the start: that's a signal to store it for next time.
- Use tags consistently. Good tags are reusable across namespaces (e.g., "decision", "blocker", "preference", "architecture").

**At conversation end (or at natural breakpoints):**
- Summarize any state changes and persist them. Don't rely on the next conversation to remember.
- If a project status has changed, update it.
- If there are open questions or next steps, log them.

**General principles:**
- Write for your future self. Be specific. "We discussed the architecture" is useless. "Decided on SQLite+FTS5 over shodh-memory because: ARM64 support missing, 7 GitHub stars, single maintainer risk" is useful.
- Don't over-store. Not every message needs to be logged. Store decisions, state changes, important context, and things you'd hate to lose.
- Namespaces should emerge naturally from the work. Don't over-engineer the taxonomy upfront.

### Response Formatting

Tool responses should be formatted for easy LLM consumption:

- State reads: return the full content, metadata, and timestamps in a clean structure
- Query results: return a ranked list with enough context to decide if a result is relevant (content preview, namespace, key, tags)
- List results: return structured overviews, not raw data dumps
- Errors: return clear, actionable messages ("Entry not found in namespace 'projects/foo' with key 'bar'" not "404")
- All responses should include a brief `hint` field with contextual suggestions (e.g., after a write: "Related entries in this namespace: architecture, status")

## Security

### v1 (Laptop / Local Development)

- **No authentication required.** The MCP server runs locally over stdio. Only the local user's Claude Code process can reach it.
- **Database file permissions:** The SQLite file should be created with `0600` permissions (owner read/write only).
- **No encryption at rest in v1.** The threat model for a local laptop is: if someone has access to your filesystem, you have bigger problems. However, the design should not preclude adding encryption later.
- **Sensitive data awareness:** Claude should use judgment about what to store. API keys, passwords, and credentials should NEVER be written to memory. The tool should reject writes containing common secret patterns (e.g., strings matching `sk-`, `ghp_`, `Bearer `, `-----BEGIN PRIVATE KEY-----`) and return a warning instead of storing.

### v2+ (Raspberry Pi / Multi-Agent)

When munin-memory moves beyond laptop-local usage and serves multiple agents, the security model changes. Hardware should be treated as tiered rather than assuming every Raspberry Pi target runs the same profile:

- `zero-appliance` — constrained Pi Zero 2 W class target, core memory first
- `full-node` — Pi 4/5 or stronger hardware for public-remote deployment and local semantic features

No full rewrite is recommended as the first move. The preferred path is to keep the MCP and SQLite contract stable, then validate the constrained profile on real hardware.

Under that model, the security requirements for networked multi-agent use remain:

- **Agent identity and access control:** Each agent (Hugin, Munin, or future agents) should authenticate with a token/key and have a defined access policy:
  - Read-only agents (can query but not write)
  - Read-write agents (can query and write to specific namespaces)
  - Admin agents (can delete, manage namespaces)
- **Namespace-level permissions:** An agent might have write access to `projects/` but only read access to `people/`. This maps to the Permission Guardian in the Hugin/Munin architecture.
- **Audit log:** All writes and deletes should be logged with the agent identity and timestamp in a separate, append-only audit table. This is non-negotiable for a multi-agent system — you need to know who changed what.
- **Encryption at rest:** SQLCipher or similar for the database file, with the key managed outside the database (environment variable or secrets manager).
- **Network transport:** If the MCP server listens on a network port (not just stdio), TLS is required. On a home network this can be self-signed, but it must be encrypted.

### Integration with Hugin/Munin Permission Guardian

The existing Hugin/Munin architecture spec includes a Permission Guardian component that gates tool access by tier. Munin-memory should be designed so that:

- The Permission Guardian can act as a proxy/middleware in front of munin-memory
- Access policies can be expressed as simple rules: `{ agent: "hugin", namespaces: ["projects/*"], permissions: ["read"] }`
- The memory server itself enforces nothing in v1 (trust the caller) but exposes the right hooks (agent ID in requests) for v2 to layer enforcement on top

## Non-Goals (v1)

- **No vector/semantic search** — FTS5 is enough. If Claude writes good content with meaningful terms, keyword search works.
- **No memory decay or scoring** — everything persists equally until explicitly deleted
- **No multi-user support** — this is a single-user system (Claude working with Magnus)
- **No authentication** — runs locally on trusted hardware
- **No web UI** — Claude is the interface
- **No automatic memory creation** — Claude decides what to store (no conversation surveillance)

## Future Considerations (v2+)

- Vector embeddings for semantic search (sqlite-vec or similar)
- Profile-aware packaging for `zero-appliance` and `full-node`
- Real-hardware validation for local semantic search on Pi Zero 2 W class hardware
- Integration with Hugin (planner agent) for automatic state management
- Backup/sync to NAS RPi
- Memory import from conversation exports
- Optional TTL (time-to-live) for temporary state entries

## Technical Constraints

- **Runtime:** Node.js (aligns with Clawdbot/MCP ecosystem)
- **Database:** SQLite with FTS5 extension
- **Protocol:** MCP (Model Context Protocol) over stdio
- **Platforms:** macOS (development), Linux ARM64 with tiered targets (`zero-appliance` and `full-node`)
- **Dependencies:** Minimal. better-sqlite3 (or similar) + MCP SDK. No ORMs, no frameworks.
- **Data location:** Configurable via environment variable, default `~/.munin-memory/memory.db`

## Success Criteria

This tool is successful if:

1. Claude can store and retrieve information reliably across conversations
2. Claude stops asking Magnus questions it has already asked before
3. Project context survives between sessions without manual re-briefing
4. Decision rationale is preserved and retrievable
5. The system runs unattended with zero maintenance
6. The system can be packaged for Raspberry Pi deployment without changing the core SQLite/MCP contract, while making realistic promises about `zero-appliance` versus `full-node`
