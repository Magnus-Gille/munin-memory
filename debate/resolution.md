# Debate Resolution — Spec Amendments

## Participants
- **Claude (Opus 4.6)** — architect
- **Codex (GPT-5.3)** — adversarial reviewer

## Summary

2 rounds of debate. 11 original findings. All resolved below.

---

## Final Decisions

### 1. UPSERT: Use ON CONFLICT, not REPLACE — ACCEPTED
Use `INSERT ... ON CONFLICT(namespace, key) WHERE entry_type='state' DO UPDATE SET content=excluded.content, tags=excluded.tags, updated_at=excluded.updated_at`. Preserves `id`, `created_at`, and `rowid`.

**Codex R2 refinement:** Ensure the `ON CONFLICT` clause references the partial unique index correctly (the `WHERE entry_type='state'` condition). Accepted — will verify at implementation time.

### 2. Wrap mutations in transactions — ACCEPTED
Every mutating operation (write, log, delete) wraps both the `entries` mutation and `audit_log` insert in a single `db.transaction()` call.

### 3. WAL mode + pragmas at DB init — ACCEPTED
```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
```

### 4. Tags: keep JSON, drop useless index, add composites — AGREED
- Drop `idx_entries_tags` (useless on JSON column)
- Add `(namespace, entry_type, key)` composite index
- Add `(namespace, entry_type, created_at DESC)` composite index
- Keep tags as JSON column; normalize to join table in v2 if needed

**Codex R2 caveat:** Apply tag filtering BEFORE applying `limit` (over-fetch from FTS, filter, then cap). Accepted.

### 5. CHECK constraints for data integrity — ACCEPTED (strengthened)
```sql
CHECK(
  (entry_type = 'state' AND key IS NOT NULL) OR
  (entry_type = 'log' AND key IS NULL)
)
```
Tags column: `tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array')`

### 6. Timestamps: UTC ISO 8601 via `nowUTC()` — AGREED
- All timestamps generated via single `nowUTC()` function returning `new Date().toISOString()`
- No user-supplied timestamps
- **Codex R2 correction:** My claim about FTS indexing timestamps was wrong (timestamps aren't in the FTS table). Struck from rationale.
- Add tests verifying timestamp format consistency

### 7. FTS lifecycle: minimal rebuild path in v1 — ACCEPTED (upgraded from deferred)
Codex convinced me. Include an executable `rebuildFTS()` function in `db.ts` that runs `INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`. Callable for maintenance. Scheduled optimize/vacuum deferred to v1.1.

### 8. Add `memory_get` tool for full entry retrieval — ACCEPTED
New tool: `memory_get(id: string)` → returns full entry regardless of type.

### 9. Delete flow: add lightweight delete token — ACCEPTED (upgraded)
Codex's R2 argument is sound: accepting WAL for concurrency while claiming "single caller" for delete safety is contradictory.

Implementation: `memory_delete` without `confirm` returns a preview + `delete_token` (short random string). Calling `memory_delete` with the `delete_token` executes. Token is ephemeral (not persisted — just held in server memory with short TTL).

### 10. Escape LIKE wildcards in namespace prefix search — ACCEPTED
Escape `_` and `%` in namespace prefix before LIKE query. Use `LIKE ? ESCAPE '\'`.

### 11. Unicode FTS tokenizer — DEFERRED
English/Swedish only in v1. Default `unicode61` tokenizer is sufficient. Revisit if multilingual content is stored.

---

## New Tool: `memory_get`

```json
{
  "name": "memory_get",
  "description": "Retrieve a single memory entry by its ID. Returns the full content regardless of entry type (state or log). Use this when memory_query returns a relevant result and you need the complete content.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "The UUID of the entry to retrieve"
      }
    },
    "required": ["id"]
  }
}
```

## Updated Schema

```sql
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('state', 'log')),
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  agent_id TEXT DEFAULT 'default',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (entry_type = 'state' AND key IS NOT NULL) OR
    (entry_type = 'log' AND key IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_ns_key
  ON entries(namespace, key) WHERE entry_type = 'state';

CREATE INDEX IF NOT EXISTS idx_entries_ns_type_key
  ON entries(namespace, entry_type, key);

CREATE INDEX IF NOT EXISTS idx_entries_ns_type_created
  ON entries(namespace, entry_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_created
  ON entries(created_at);
```

## Updated MCP Tools List (7 total)

1. `memory_write` — store/update state entry
2. `memory_read` — retrieve state entry by namespace+key
3. `memory_get` — retrieve any entry by ID (NEW)
4. `memory_query` — full-text search with filters
5. `memory_log` — append chronological log entry
6. `memory_list` — browse namespaces and contents
7. `memory_delete` — delete with token-based confirmation
