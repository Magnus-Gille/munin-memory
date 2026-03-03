# Expansion Plan Debate — Resolution

## Participants
- **Claude (Opus 4.6)** — architect
- **Codex (GPT-5.3)** — adversarial reviewer

## Summary

2 rounds of debate. 14 original findings. All resolved below.

---

## Final Decisions

### 1. vec0 schema must be joinable to entries — ACCEPTED (refined)

The expansion plan's sample query (`SELECT id, distance FROM entries_vec`) is invalid. vec0 does support TEXT metadata columns, so there are two viable approaches:

**Option A (preferred): Use vec0 metadata column**
```sql
CREATE VIRTUAL TABLE entries_vec USING vec0(
  entry_id TEXT,
  embedding float[384]
);
```
Simpler, no join needed. Integrity enforced in application code.

**Option B: Mapping table with cascade + trigger**
```sql
CREATE VIRTUAL TABLE entries_vec USING vec0(embedding float[384]);

CREATE TABLE embedding_map (
  vec_rowid INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE
);

-- Prevent orphaned vector rows
CREATE TRIGGER embedding_map_ad AFTER DELETE ON embedding_map BEGIN
  DELETE FROM entries_vec WHERE rowid = old.vec_rowid;
END;
```

**Decision:** Try Option A first at implementation time. Fall back to Option B if metadata column limitations surface (e.g., lack of UNIQUE enforcement). Codex's R2 note about orphan cleanup via trigger is accepted regardless of approach.

### 2. Migration framework is a prerequisite (Feature 0) — ACCEPTED

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

Ordered migrations run at startup, transaction-wrapped, skip already-applied versions. Must be implemented before any schema changes from Features 2–5.

### 3. Hybrid search uses Reciprocal Rank Fusion — ACCEPTED

Drop the naive `0.6 FTS + 0.4 vector` formula. Use RRF:
```
RRF_score(d) = 1/(k + rank_fts(d)) + 1/(k + rank_vec(d))
```
Where `k = 60` (standard constant). Both FTS and vector results contribute equally via rank position, avoiding the BM25 "lower is better" vs cosine "higher is better" mismatch.

### 4. Writes are async-from-embedding — ACCEPTED

- Write entry to DB first (synchronous, transactional, fast)
- Generate embedding after write, outside transaction
- If embedding fails, mark `embedding_status = 'failed'` and continue
- Background `setInterval` retries pending embeddings
- Query path gracefully handles entries without embeddings

Column on entries: `embedding_status TEXT DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'generated', 'failed'))`

### 5. Model versioning via column, not registry — ACCEPTED (with guard)

- Add `embedding_model TEXT` column to track which model generated each embedding
- Store fully qualified model revision (e.g., `"Xenova/all-MiniLM-L6-v2@v1.0.0"`), not just alias
- On model change: invalidate all embeddings where `embedding_model != current_model` and re-backfill
- Registry table deferred unless dual-model cutover or per-namespace policies are needed

**Codex R2 refinement:** Use full model revision string to prevent silent drift. Accepted.

### 6. ARM64 runtime hardening — ACCEPTED

- Preload embedding model at server startup (before accepting connections)
- Pin model to local cache path via `TRANSFORMERS_CACHE` env var
- Disable remote downloads in production: `{ local_files_only: true }`
- Circuit breaker: N consecutive failures → disable embeddings → FTS-only fallback → manual restart or health check to re-enable

### 7. Backfill uses small throttled batches — ACCEPTED

- Batch size: 25 entries
- Inter-batch delay: 200ms (configurable)
- Idempotent: skip entries where `embedding_status = 'generated'`
- Controllable via `MUNIN_EMBEDDINGS_BACKFILL=true|false`
- Runs as background `setInterval`, not a burst

### 8. Session lifecycle uses server-generated IDs — ACCEPTED (with inactivity tracking)

- Conversation sessions ≠ transport sessions (a single MCP connection may span multiple conversations)
- `memory_session_start()` auto-generates and returns a `session_id`
- `memory_session_end(session_id)` is optional
- Add `last_seen_at` column, updated on session-scoped activity
- Stale sessions: timeout on inactivity (`now - last_seen_at > 24h`), not just age since start
- Cleanup on next `memory_session_start()`, no daemon

**Codex R2 refinement:** Timeout on `last_seen_at` inactivity, not `started_at` age. Accepted.

### 9. Replace handshake nudge with memory_status tool — ACCEPTED

New tool: `memory_status()` → returns live counters:
- Unread notification count
- Last session timestamp
- Total entry count by type
- Embedding system status (enabled/disabled, model loaded, pending count)

No handshake nudge in `serverInfo`. System prompt instructions can suggest calling `memory_status` at conversation start.

### 10. Notifications: bounded growth + proper indexes — ACCEPTED

Schema updates:
- Add `expires_at TEXT` (default: 30 days from creation)
- Replace `read INTEGER DEFAULT 0` with `read_at TEXT DEFAULT NULL`
- Hard cap: max 1000 notifications per subscriber (delete oldest when exceeded)
- Action CHECK: `CHECK(action IN ('write', 'update', 'delete', 'log'))`

Indexes:
- `(subscriber_id, read_at, created_at DESC)` — unread queries
- `(expires_at)` — cleanup
- `(namespace)` — subscription fanout on write

Cleanup: expired notifications pruned on `memory_notifications` call or periodic interval.

### 11. Single search tool with search_mode parameter — ACCEPTED

Extend `memory_query` with:
```json
{
  "search_mode": {
    "type": "string",
    "enum": ["lexical", "semantic", "hybrid"],
    "description": "Search mode. Default: lexical (FTS5). Semantic: vector KNN. Hybrid: RRF fusion."
  }
}
```

No separate `memory_semantic_search` tool. When embeddings are disabled, `semantic` and `hybrid` degrade to `lexical` with a warning in the response.

### 12. Bulk import: always atomic, per-item status — ACCEPTED

- Validate all entries before inserting any
- Single transaction (always atomic)
- Response: `{ imported: number, entries: [{id, namespace, key, status}], embedding_status: "queued" | "disabled" }`
- No `atomic` toggle — partial imports create more problems than they solve
- Embedding generation queued in background

### 13. Defer Grafana, stage monitoring — ACCEPTED

1. Start with structured JSON logging (pino) + `/health` + `/health/ready`
2. Add Prometheus `/metrics` endpoint when operational needs justify it
3. Defer Grafana until concrete dashboard needs arise
4. Focus on observability through logs and health endpoints first

### 14. Backup pipeline: verify + encrypt — ACCEPTED

Full pipeline:
1. SQLite `.backup` command (not file copy)
2. `PRAGMA integrity_check` on backup file
3. GPG encrypt before offsite transfer
4. Daily local + NAS, weekly to Cloudflare R2
5. Monthly automated restore drill (restore to temp path + integrity check)

---

## Feature 2 Split Decision

Codex recommends splitting Feature 2 into 2a (pipeline) and 2b (hybrid search). Claude argues shipping together.

**Compromise:** Ship as one feature, but enforce two internal release gates:
1. **Gate 1:** Embedding pipeline stable (write-time embedding, backfill working, `search_mode: semantic` functional)
2. **Gate 2:** Hybrid search enabled (`search_mode: hybrid` with RRF)

Both gates controlled by feature flags. Gate 2 only enabled after Gate 1 is validated on RPi.

---

## Updated Feature Order

| Phase | Feature | Key Changes from Original Plan |
|-------|---------|-------------------------------|
| 0 | Migration framework | NEW — prerequisite for all schema changes |
| 1 | Cloudflare Tunnel | Unchanged |
| 2 | Semantic search (full) | Two internal gates; vec0 schema fixed; RRF; async embeddings |
| 3 | Session context | Server-generated IDs; `memory_status` tool; inactivity timeout |
| 4 | Bulk import | Always atomic; per-item status; embedding queued |
| 5 | Subscriptions | Bounded notifications; proper indexes; action CHECK |

---

## Updated Tool List (after all features)

| Tool | Source |
|------|--------|
| `memory_write` | Existing |
| `memory_read` | Existing |
| `memory_get` | Existing |
| `memory_query` | Extended — add `search_mode` parameter |
| `memory_log` | Existing |
| `memory_list` | Existing |
| `memory_delete` | Existing |
| `memory_status` | NEW — live system counters |
| `memory_context_summary` | NEW — session briefing |
| `memory_session_start` | NEW — begin conversation session |
| `memory_session_end` | NEW — end conversation session |
| `memory_bulk_import` | NEW — batch entry import |
| `memory_subscribe` | NEW — namespace subscription |
| `memory_unsubscribe` | NEW — remove subscription |
| `memory_notifications` | NEW — read notifications |

---

## Assumptions Confirmed

1. Single-process Node server, no external job runner. Background tasks via `setInterval`.
2. `memory_context_summary` runs synchronously in tool call path.
3. Writes must never fail due to embedding issues. Write-first, embed-later.
