# M5 User-Test: qwen3-30b-instruct — Decision Archaeology

**Scenario:** decision-archaeology  
**Grade:** FAIL (no-result-opened)  
**Duration:** 6.8s  
**Steps:** 3  
**Tool calls:** 2  
**Tools used:** memory_orient, memory_query

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

### Step 1: `memory_query`
```json
{
  "query": "decision to use Munin as universal task store phasing out TASKS.md",
  "namespace": "decisions",
  "tags": [
    "decision"
  ],
  "search_mode": "hybrid",
  "include_expired": false,
  "explain": false
}
```
**Result:**
```
{"ok":true,"action":"query","results":[],"total":0,"redacted_count":0,"query":"decision to use Munin as universal task store phasing out TASKS.md","search_mode":"hybrid","search_mode_actual":"lexical","warning":"Hybrid search unavailable (Embeddings disabled via MUNIN_EMBEDDINGS_ENABLED=false). Falling back to lexical search.","retrieval":{"reranked":true,"relaxed_lexical":false,"fallback_reason":"hybrid_unavailable","recency_applied":true,"search_recency_weight":0.2,"expired_filtered_count":0,"
```

### Step 2: ERROR
LLM API 429: {"error":{"message":"Rate limit reached for the tpm window. Retry after 7s.","type":"rate_limit_error","code":"rate_limit_exceeded","param":null}}
