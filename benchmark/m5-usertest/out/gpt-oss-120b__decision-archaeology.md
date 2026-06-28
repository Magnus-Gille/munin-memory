# M5 User-Test: gpt-oss-120b — Decision Archaeology

**Scenario:** decision-archaeology  
**Grade:** PASS (reformulated)  
**Duration:** 25.6s  
**Steps:** 8  
**Tool calls:** 7  
**Tools used:** memory_orient, memory_query, memory_get

## Transcript

### Step 0: `memory_orient`
```json
{
  "detail": "compact"
}
```
**Result:**
```
{"ok":true,"action":"orient","conventions":{"content":"# Quick Reference (compact)\nFull conventions: memory_read(\"meta/conventions\", \"conventions\") — last updated 2026-04-01\n\n## Key Rules\n- **Handshake:** memory_orient first, then memory_read for specifics, memory_query for search.\n- **Read vs get:** `memory_read` uses namespace+key. `memory_get` uses an entry UUID from query results.\n- **State entries** = current truth (mutable). **Log entries** = chronological (append-only).\n- **Wri
```

### Step 1: `memory_query`
```json
{
  "query": "Munin universal task store TASKS.md decision",
  "namespace": "decisions",
  "limit": 20,
  "search_mode": "lexical"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[],"total":0,"redacted_count":0,"query":"Munin universal task store TASKS.md decision","search_mode":"lexical","retrieval":{"reranked":true,"relaxed_lexical":false,"fallback_reason":null,"recency_applied":true,"search_recency_weight":0.2,"expired_filtered_count":0,"serialization":"linear"}}
```

### Step 2: `memory_query`
```json
{
  "query": "Munin task store",
  "limit": 20,
  "search_mode": "lexical"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"097a02c3-05a3-4d99-a6f8-0d7b1cf8c605","namespace":"actions","key":"pending","entry_type":"state","content_preview":"## From tasks/20260406-200100-subscription-math\n- [ ] **Reconcile co-op 4 break-even figure in localbench-site** — The code-validated figure is 5.5 months (~6), not ~7 as stated in existing research docs and site copy. When the localbench-site repo is created (see earlier action), update any co-op 4 break-even references from \"~7 mont
```

### Step 3: `memory_get`
```json
{
  "id": "48f85a2f-c611-4c22-9737-5538071ee927"
}
```
**Result:**
```
{"ok":true,"action":"get","found":true,"id":"48f85a2f-c611-4c22-9737-5538071ee927","namespace":"documents/debate","key":"munin-tasks-summary-md","entry_type":"state","content":"## munin-tasks-summary.md\n\n- **Source:** https://mimir.gille.ai/files/mgc/debate/munin-tasks-summary.md\n- **Local:** ~/mimir/mgc/debate/munin-tasks-summary.md\n- **Type:** Markdown\n- **Size:** 4162 (4.1 KB)\n- **Modified:** 2026-03-08\n- **SHA-256:** 74d62901656913064b8d79302250c7841b1ab25ad809b23778777f135b16a8f2\n\n
```

### Step 4: `memory_query`
```json
{
  "query": "Munin",
  "tags": [
    "decision"
  ],
  "limit": 20,
  "search_mode": "lexical"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"163a4697-3330-412e-94f7-99a0cdb7c93d","namespace":"research/qmd-analysis","key":"munin-relevance","entry_type":"state","content_preview":"# QMD Patterns Relevant to Munin/Mimir\n\n## High-Value Ideas for Munin (Memory Consolidation & Retrieval)\n\n### 1. Strong Signal Bypass — Adaptive Computation\nQMD's BM25 probe checks if the top result is decisive (score ≥ 0.85, gap ≥ 0.15) before invoking expensive LLM expansion. If clear match, skip the whole e
```

### Step 5: `memory_query`
```json
{
  "query": "TASKS.md",
  "limit": 20,
  "search_mode": "lexical"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"fac8d565-9e12-4556-a173-06e8c4eaf7d1","namespace":"projects/hackathon-mariefred-2026","key":"status","entry_type":"state","content_preview":"**Phase:** Ready — event tomorrow 2026-03-28\n\n**Current work:** All prep done. slides.html complete (27 slides, Swiss modernist design, presenter notes).\n\n**Blockers:** None\n\n**Next:** Run the event. Venue TBD (see TASKS.md). Slides at events/claude-code-hackathon-2026/slides.html.","tags":["active","type:
```

### Step 6: `memory_get`
```json
{
  "id": "44b9a81f-6982-492f-be57-fbf2475dee5c"
}
```
**Result:**
```
{"ok":true,"action":"get","found":true,"id":"44b9a81f-6982-492f-be57-fbf2475dee5c","namespace":"projects/mgc","key":"status","entry_type":"state","content":"## MGC Business Content Folder\n\n**Phase:** Maintenance — task migration to Munin complete, working well.\n\nThis is ~/mimir/mgc/, the business content folder. Not a code project. Syncs to Pi via rsync. Contains customer folders, events, internal docs, capture inbox.\n\nTask IDs designed, TASKS.md files deprecated in favor of Munin tasks/ n
```

### Step 7: ERROR
LLM API 429: {"error":{"message":"Rate limit reached for the tpm window. Retry after 7s.","type":"rate_limit_error","code":"rate_limit_exceeded","param":null}}
