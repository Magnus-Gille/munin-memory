# Munin Memory — Technical Specification

> This document is the implementation guide for Claude Code. Read `prd.md` first for context, motivation, and UX requirements. This document covers the how.

## Project Structure

```
munin-memory/
├── package.json
├── tsconfig.json
├── .env.example
├── CLAUDE.md              # Instructions for Claude Code when working on this project
├── prd.md                 # Product requirements (reference)
├── technical-spec.md      # This file (reference)
├── src/
│   ├── index.ts           # Entry point — MCP server setup and stdio transport
│   ├── db.ts              # SQLite database initialization, migrations, and queries
│   ├── tools.ts           # MCP tool definitions and handlers
│   ├── security.ts        # Secret pattern detection and input validation
│   └── types.ts           # TypeScript type definitions
├── tests/
│   ├── db.test.ts         # Database layer tests
│   ├── tools.test.ts      # Tool handler tests
│   └── security.test.ts   # Security validation tests
└── dist/                  # Compiled output
```

## Technology Choices

| Choice | Technology | Rationale |
|--------|-----------|-----------|
| Language | TypeScript | Type safety, MCP SDK is TS-native, aligns with Clawdbot ecosystem |
| Runtime | Node.js 20+ | LTS, stable, available on ARM64 |
| Database | better-sqlite3 | Synchronous API (simpler for MCP stdio), native FTS5 support, fast, well-maintained |
| MCP SDK | @modelcontextprotocol/sdk | Official SDK |
| Test runner | vitest | Fast, TS-native, zero config |
| Build | tsup or tsc | Simple bundling to dist/ |

## Database Schema

Single SQLite database file. Two tables + one FTS5 virtual table.

### Table: `entries`

```sql
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,                    -- UUID v4
  namespace TEXT NOT NULL,                -- e.g. "projects/hugin-munin"
  key TEXT,                               -- e.g. "architecture" (NULL for log entries)
  entry_type TEXT NOT NULL CHECK(entry_type IN ('state', 'log')),
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',                 -- JSON array of strings
  agent_id TEXT DEFAULT 'default',        -- For future multi-agent support
  created_at TEXT NOT NULL,               -- ISO 8601
  updated_at TEXT NOT NULL                -- ISO 8601
);

-- Unique constraint: one state entry per namespace+key
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_ns_key 
  ON entries(namespace, key) WHERE entry_type = 'state';

-- Fast lookups by namespace
CREATE INDEX IF NOT EXISTS idx_entries_namespace ON entries(namespace);

-- Fast lookups by type
CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(entry_type);

-- Fast lookups by tags (for future tag queries)
CREATE INDEX IF NOT EXISTS idx_entries_tags ON entries(tags);

-- Chronological ordering for logs
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
```

### Table: `audit_log`

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,                -- ISO 8601
  agent_id TEXT NOT NULL DEFAULT 'default',
  action TEXT NOT NULL,                   -- 'write', 'update', 'delete', 'delete_namespace'
  namespace TEXT NOT NULL,
  key TEXT,                               -- NULL for log entries or namespace-level ops
  detail TEXT                             -- Optional context, e.g. "overwritten previous value"
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
```

### FTS5 Virtual Table

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  content,
  namespace,
  key,
  tags,
  content='entries',
  content_rowid='rowid'
);
```

FTS5 triggers to keep the index in sync:

```sql
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content, namespace, key, tags) 
  VALUES (new.rowid, new.content, new.namespace, new.key, new.tags);
END;

CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, namespace, key, tags) 
  VALUES('delete', old.rowid, old.content, old.namespace, old.key, old.tags);
END;

CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content, namespace, key, tags) 
  VALUES('delete', old.rowid, old.content, old.namespace, old.key, old.tags);
  INSERT INTO entries_fts(rowid, content, namespace, key, tags) 
  VALUES (new.rowid, new.content, new.namespace, new.key, new.tags);
END;
```

## MCP Tool Definitions

Each tool is defined with a JSON Schema for parameters and a handler function. Below are the exact tool definitions the MCP server should register.

### `memory_write`

```json
{
  "name": "memory_write",
  "description": "Store or update a state entry in memory. If an entry with the same namespace+key exists, it will be overwritten. Use this for mutable facts: project status, current decisions, known preferences.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "namespace": {
        "type": "string",
        "description": "Hierarchical namespace using / separator. E.g. 'projects/hugin-munin', 'people/magnus', 'decisions/tech-stack'"
      },
      "key": {
        "type": "string",
        "description": "Short descriptive slug for this entry. E.g. 'status', 'architecture', 'preferences'"
      },
      "content": {
        "type": "string",
        "description": "The content to store. Markdown supported. Be specific and write for your future self."
      },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional freeform tags for cross-cutting queries. E.g. ['decision', 'raspberry-pi', 'active']"
      }
    },
    "required": ["namespace", "key", "content"]
  }
}
```

**Handler logic:**
1. Validate inputs (namespace and key must be non-empty, content must pass security check)
2. Run security scan on content (reject secrets)
3. Generate UUID if new, reuse existing ID if updating
4. UPSERT into `entries` table (INSERT OR REPLACE using the unique index on namespace+key for state entries)
5. Write to `audit_log`
6. Return: `{ status: "created" | "updated", id, namespace, key, hint }` where `hint` lists other keys in the same namespace

### `memory_read`

```json
{
  "name": "memory_read",
  "description": "Retrieve a specific state entry by namespace and key. Returns the full content, tags, and timestamps. Returns a clear 'not found' message if the entry doesn't exist (not an error).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "namespace": {
        "type": "string",
        "description": "The namespace to read from"
      },
      "key": {
        "type": "string",
        "description": "The key of the state entry to read"
      }
    },
    "required": ["namespace", "key"]
  }
}
```

**Handler logic:**
1. Query `entries` WHERE namespace = ? AND key = ? AND entry_type = 'state'
2. If found: return `{ found: true, id, namespace, key, content, tags, created_at, updated_at }`
3. If not found: return `{ found: false, namespace, key, message: "No state entry found...", hint }` where `hint` suggests similar namespaces or keys if any exist (use FTS5 to find near matches)

### `memory_query`

```json
{
  "name": "memory_query",
  "description": "Search across memories using full-text search. Supports filtering by namespace prefix, entry type, and tags. Use this to find information when you don't know the exact namespace/key.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search terms. FTS5 syntax supported (e.g. 'raspberry AND pi', 'architecture OR design')"
      },
      "namespace": {
        "type": "string",
        "description": "Optional. Filter to a namespace or namespace prefix (e.g. 'projects/' matches all project namespaces)"
      },
      "entry_type": {
        "type": "string",
        "enum": ["state", "log"],
        "description": "Optional. Filter by entry type."
      },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional. Filter to entries that have ALL of these tags."
      },
      "limit": {
        "type": "number",
        "description": "Max results to return. Default 10, max 50."
      }
    },
    "required": ["query"]
  }
}
```

**Handler logic:**
1. Build FTS5 query from search terms
2. Apply namespace filter: if `namespace` ends with `/`, use `LIKE 'prefix%'`; otherwise exact match
3. Apply entry_type filter if provided
4. Apply tags filter: parse JSON tags column and check all requested tags are present
5. Limit results (default 10, max 50)
6. Return: array of `{ id, namespace, key, entry_type, content_preview (first 500 chars), tags, created_at, updated_at, relevance_score }` sorted by FTS5 rank

### `memory_log`

```json
{
  "name": "memory_log",
  "description": "Append a chronological log entry. Log entries are immutable and timestamped. Use this for recording decisions, events, status changes, and session summaries.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "namespace": {
        "type": "string",
        "description": "The namespace to log to"
      },
      "content": {
        "type": "string",
        "description": "The log entry content. Be specific — include what was decided and why."
      },
      "tags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional tags"
      }
    },
    "required": ["namespace", "content"]
  }
}
```

**Handler logic:**
1. Validate inputs, run security scan
2. Generate UUID, set `entry_type = 'log'`, `key = NULL`
3. INSERT into `entries`
4. Write to `audit_log`
5. Return: `{ status: "logged", id, namespace, timestamp }`

### `memory_list`

```json
{
  "name": "memory_list",
  "description": "Browse memory contents. Without a namespace: shows all namespaces with entry counts. With a namespace: shows all state keys and log count in that namespace.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "namespace": {
        "type": "string",
        "description": "Optional. If provided, list contents of this namespace. If omitted, list all namespaces."
      }
    },
    "required": []
  }
}
```

**Handler logic:**

If namespace is omitted:
```sql
SELECT namespace, 
       SUM(CASE WHEN entry_type = 'state' THEN 1 ELSE 0 END) as state_count,
       SUM(CASE WHEN entry_type = 'log' THEN 1 ELSE 0 END) as log_count
FROM entries 
GROUP BY namespace 
ORDER BY namespace;
```

If namespace is provided:
- List all state entries: `SELECT key, substr(content, 1, 100) as preview, tags, updated_at FROM entries WHERE namespace = ? AND entry_type = 'state' ORDER BY key`
- Count log entries: `SELECT COUNT(*) as log_count, MIN(created_at) as earliest, MAX(created_at) as latest FROM entries WHERE namespace = ? AND entry_type = 'log'`

### `memory_delete`

```json
{
  "name": "memory_delete",
  "description": "Delete a specific state entry by namespace+key, or all entries in a namespace. Returns what will be affected. Use with care.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "namespace": {
        "type": "string",
        "description": "The namespace to delete from"
      },
      "key": {
        "type": "string",
        "description": "Optional. If provided, delete only this state entry. If omitted, delete ALL entries (state and log) in the namespace."
      },
      "confirm": {
        "type": "boolean",
        "description": "Must be true to execute the delete. If false or omitted, returns a preview of what would be deleted without actually deleting."
      }
    },
    "required": ["namespace"]
  }
}
```

**Handler logic:**
1. If `confirm` is not `true`: query and return what would be deleted (counts, keys, date ranges) WITHOUT deleting
2. If `confirm` is `true`: execute the delete, write to `audit_log`, return confirmation
3. If `key` is provided: only delete the specific state entry
4. If `key` is omitted: delete all entries in the namespace (both state and log)

## Security Module (`security.ts`)

### Secret Detection

Before any write operation, scan the content for common secret patterns:

```typescript
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,                    // OpenAI/Anthropic API keys
  /ghp_[a-zA-Z0-9]{36,}/,                   // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/,                   // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/,           // GitHub fine-grained PATs
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/,        // Bearer tokens
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,// Private keys
  /-----BEGIN\s+CERTIFICATE-----/,           // Certificates
  /AKIA[0-9A-Z]{16}/,                        // AWS access keys
  /password\s*[:=]\s*['"][^'"]{8,}['"]/i,    // Inline passwords
  /secret\s*[:=]\s*['"][^'"]{8,}['"]/i,      // Inline secrets
];
```

If a pattern matches, reject the write and return:
```json
{
  "error": "security_violation",
  "message": "Content appears to contain a secret or credential (matched pattern: API key). Secrets should never be stored in memory. Remove the sensitive content and try again."
}
```

### Input Validation

- `namespace`: must match `/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/` (no spaces, no special chars, no leading slash)
- `key`: must match `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` (simple slug)
- `content`: max 100,000 characters (generous but bounded)
- `tags`: each tag must match `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`, max 20 tags per entry

## Configuration

Via environment variables:

```bash
# Database location (default: ~/.munin-memory/memory.db)
MUNIN_MEMORY_DB_PATH=~/.munin-memory/memory.db

# Log level (default: info)
MUNIN_MEMORY_LOG_LEVEL=info  # debug | info | warn | error

# Max content size in characters (default: 100000)
MUNIN_MEMORY_MAX_CONTENT_SIZE=100000
```

## MCP Server Setup (`index.ts`)

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// 1. Initialize database (create tables if not exist)
// 2. Register all 6 tools with their schemas and handlers
// 3. Start stdio transport
// 4. Handle graceful shutdown (close DB connection)
```

The server communicates over stdio (stdin/stdout), which is the standard MCP transport for Claude Code and Claude Desktop.

## Claude Code Integration

To use with Claude Code, add to `~/.claude/claude_code_config.json` (or the project's `.mcp.json`):

```json
{
  "mcpServers": {
    "munin-memory": {
      "command": "node",
      "args": ["/path/to/munin-memory/dist/index.js"],
      "env": {
        "MUNIN_MEMORY_DB_PATH": "~/.munin-memory/memory.db"
      }
    }
  }
}
```

## CLAUDE.md File

The project should include a `CLAUDE.md` file that Claude Code reads when working on this project. It should contain:

```markdown
# Munin Memory — CLAUDE.md

## What this project is
Munin Memory is an MCP server that provides persistent memory for Claude across conversations.
It is part of the Hugin & Munin personal AI system. See prd.md for full context.

## How to build
npm install
npm run build    # Compiles TypeScript to dist/

## How to test
npm test         # Runs vitest

## How to run locally
node dist/index.js

## Key design decisions
- SQLite + FTS5 for storage and search (no vector DB, no external services)
- better-sqlite3 for synchronous database access (simpler with MCP stdio)
- All writes are validated against secret patterns before storage
- State entries (mutable) and log entries (append-only) are the two fundamental types
- Namespaces are hierarchical strings separated by /

## Code style
- TypeScript strict mode
- No classes unless genuinely needed — prefer functions and modules
- Error messages should be clear and actionable for an LLM reading them
- Keep dependencies minimal
```

## Testing Strategy

### Unit tests (`db.test.ts`)
- Create/read/update/delete state entries
- Append and retrieve log entries
- FTS5 search with various queries
- Namespace listing and counting
- Edge cases: empty namespaces, very long content, special characters in content

### Unit tests (`tools.test.ts`)
- Each MCP tool handler with valid inputs
- Each MCP tool handler with invalid inputs (bad namespace format, missing required fields)
- Upsert behavior (write same namespace+key twice)
- Delete with and without confirm flag

### Unit tests (`security.test.ts`)
- Each secret pattern is detected
- Clean content passes validation
- Namespace and key format validation
- Content size limits

### Integration test
- Full MCP server startup, tool registration, and a complete workflow:
  write → read → query → log → list → delete

## Build & Publish

```json
{
  "name": "munin-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^latest",
    "better-sqlite3": "^latest",
    "uuid": "^latest"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^latest",
    "@types/node": "^latest",
    "typescript": "^latest",
    "vitest": "^latest",
    "tsx": "^latest"
  }
}
```

No need to publish to npm for v1. Install locally, point Claude Code at the compiled output.

## Raspberry Pi Profiles

Munin Memory keeps the same MCP contract and SQLite portability across machines, but Raspberry Pi deployment should no longer be described as a single trivial migration path.

Current direction:

- `zero-appliance` — Raspberry Pi Zero 2 W class hardware, core memory and lexical search first
- `full-node` — Raspberry Pi 4/5 or stronger hardware, public-remote deployment and local semantic features

What remains stable across profiles:

1. the database format
2. the MCP tool contract
3. local-first storage semantics

What may differ by profile:

1. deployment packaging
2. public-remote surface area
3. whether semantic and hybrid search are enabled locally

The historical "clone the repo, install dependencies, copy the DB, and optionally swap transports" path is still a reasonable developer migration or stronger-hardware deployment story. It is not the right description of a Pi Zero appliance product. For that direction, the project is explicitly treating Pi Zero 2 W as a constrained profile that needs hardware validation before promising feature parity.
