# M5 User-Test: gemma4 — Onboarding Flow

**Scenario:** onboarding  
**Grade:** PASS (full-onboarding)  
**Duration:** 36.9s  
**Steps:** 4  
**Tool calls:** 3  
**Tools used:** memory_orient, memory_log, memory_query

## Transcript

### Step 0: `memory_orient`
```json
{
  "detail": "standard"
}
```
**Result:**
```
{"ok":true,"action":"orient","conventions":{"content":"# Quick Reference (compact)\nFull conventions: memory_read(\"meta/conventions\", \"conventions\") — last updated 2026-04-01\n\n## Key Rules\n- **Handshake:** memory_orient first, then memory_read for specifics, memory_query for search.\n- **Read vs get:** `memory_read` uses namespace+key. `memory_get` uses an entry UUID from query results.\n- **State entries** = current truth (mutable). **Log entries** = chronological (append-only).\n- **Wri
```

### Step 1: `memory_log`
```json
{
  "content": "chose SQLite+FTS5 over Postgres because of ARM/edge deployment constraints",
  "namespace": "testing/gemma4",
  "tags": [
    "decision"
  ]
}
```
**Result:**
```
{"ok":true,"action":"log","status":"logged","id":"7be14b1f-4f8c-41dc-87e0-33718f5f5e54","namespace":"testing/gemma4","timestamp":"2026-06-28T20:21:34.357Z","timestamp_local":"Sun, 28 Jun, 22:21 CEST","classification":"internal","provenance":{"principal_id":"owner","owner_principal_id":"owner"}}
```

### Step 2: `memory_query`
```json
{
  "namespace": "testing/gemma4",
  "query": "SQLite+FTS5"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"7be14b1f-4f8c-41dc-87e0-33718f5f5e54","namespace":"testing/gemma4","key":null,"entry_type":"log","content_preview":"chose SQLite+FTS5 over Postgres because of ARM/edge deployment constraints","tags":["decision","classification:internal"],"created_at":"2026-06-28T20:21:34.357Z","updated_at":"2026-06-28T20:21:34.357Z","updated_at_local":"Sun, 28 Jun, 22:21 CEST","classification":"internal","provenance":{"principal_id":"owner","owner_principal_id":"owne
```

### Step 3: Model content
The evaluation of Munin Memory is complete.

**UX Note:**
The tool is highly structured and robust. The `memory_orient` call is an excellent "handshake" that prevents the common LLM mistake of guessing namespace conventions. The distinction between `memory_log` (immutable history) and `memory_write` (mutable state) provides a clear mental model for managing long-term context. The retrieval via `memory_query` was precise, and the system's self-documenting nature (e.g., providing fallback warnings when embeddings are disabled) makes it very developer-friendly for agentic workflows.

## Final Output

The evaluation of Munin Memory is complete.

**UX Note:**
The tool is highly structured and robust. The `memory_orient` call is an excellent "handshake" that prevents the common LLM mistake of guessing namespace conventions. The distinction between `memory_log` (immutable history) and `memory_write` (mutable state) provides a clear mental model for managing long-term context. The retrieval via `memory_query` was precise, and the system's self-documenting nature (e.g., providing fallback warnings when embeddings are disabled) makes it very developer-friendly for agentic workflows.
