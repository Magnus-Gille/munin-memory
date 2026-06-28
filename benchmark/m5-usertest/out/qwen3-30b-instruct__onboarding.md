# M5 User-Test: qwen3-30b-instruct — Onboarding Flow

**Scenario:** onboarding  
**Grade:** PASS (full-onboarding)  
**Duration:** 21.0s  
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
  "namespace": "testing/qwen3-30b-instruct",
  "content": "Chose SQLite+FTS5 over Postgres because of ARM/edge deployment constraints",
  "tags": [
    "decision",
    "preference",
    "architecture"
  ]
}
```
**Result:**
```
{"ok":true,"action":"log","status":"logged","id":"3faa6c21-6086-4e09-94c9-8eff6ece8774","namespace":"testing/qwen3-30b-instruct","timestamp":"2026-06-28T20:31:21.801Z","timestamp_local":"Sun, 28 Jun, 22:31 CEST","classification":"internal","provenance":{"principal_id":"owner","owner_principal_id":"owner"}}
```

### Step 2: `memory_query`
```json
{
  "query": "decision about SQLite+FTS5 vs Postgres",
  "namespace": "testing/qwen3-30b-instruct",
  "tags": [
    "decision"
  ],
  "limit": 5,
  "search_mode": "hybrid"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"3faa6c21-6086-4e09-94c9-8eff6ece8774","namespace":"testing/qwen3-30b-instruct","key":null,"entry_type":"log","content_preview":"Chose SQLite+FTS5 over Postgres because of ARM/edge deployment constraints","tags":["decision","preference","architecture","classification:internal"],"created_at":"2026-06-28T20:31:21.801Z","updated_at":"2026-06-28T20:31:21.801Z","updated_at_local":"Sun, 28 Jun, 22:31 CEST","classification":"internal","provenance":{"principa
```

### Step 3: Model content
UX Note: The experience with Munin Memory was smooth and intuitive. Starting with `memory_orient` provided immediate context, including project status, namespace conventions, and actionable insights. Recording the decision via `memory_log` was straightforward, and the system correctly tagged it as a `decision` with relevant metadata. Retrieving the decision using `memory_query` with natural language phrasing worked reliably, even though hybrid search fell back to lexical due to disabled embeddings — a minor but expected limitation. The tooling enforces good practices (e.g., logging decisions b

## Final Output

UX Note: The experience with Munin Memory was smooth and intuitive. Starting with `memory_orient` provided immediate context, including project status, namespace conventions, and actionable insights. Recording the decision via `memory_log` was straightforward, and the system correctly tagged it as a `decision` with relevant metadata. Retrieving the decision using `memory_query` with natural language phrasing worked reliably, even though hybrid search fell back to lexical due to disabled embeddings — a minor but expected limitation. The tooling enforces good practices (e.g., logging decisions before updating state) and maintains clarity between mutable state and immutable history. Overall, it feels like a well-designed, frictionless system for persistent, structured memory.
