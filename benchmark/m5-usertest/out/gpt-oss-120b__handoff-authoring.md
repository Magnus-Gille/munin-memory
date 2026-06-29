# M5 User-Test: gpt-oss-120b — Handoff Authoring

**Scenario:** handoff-authoring  
**Grade:** PASS (handoff-produced)  
**Duration:** 55.1s  
**Steps:** 6  
**Tool calls:** 5  
**Tools used:** memory_handoff, memory_narrative, memory_query, memory_read

## Transcript

### Step 0: `memory_handoff`
```json
{
  "namespace": "projects/munin-memory",
  "limit": 10
}
```
**Result:**
```
{"ok":true,"action":"handoff","found":true,"namespace":"projects/munin-memory","current_state":{"namespace":"projects/munin-memory","summary":"[active] ## Phase\nActive — Consolidation feature complete and live. Librarian stable in production.\n\n## Current Work\nMemory consolidation shipped and is live on the Pi. Codex multi-model user-testing pass completed against the live tool surface; strongest recurring issues were `memory_orient(detail=\"compact\"...","updated_at":"2026-04-05T07:56:12.759
```

### Step 1: `memory_narrative`
```json
{
  "namespace": "projects/munin-memory",
  "limit": 15,
  "include_sources": true
}
```
**Result:**
```
{"ok":true,"action":"narrative","namespace":"projects/munin-memory","summary":"Narrative view for projects/munin-memory: 3 signals derived from current status, recent logs, and audit history. Most recent activity: 2026-04-07T05:32:53.855Z.","signals":[{"category":"blocker_age","severity":"high","summary":"Blocker context has been unchanged for 84 days.","reason":"Current status is blocked or still lists blockers, and the status has not been refreshed recently.","source_entry_ids":["0bc6fed6-b033
```

### Step 2: `memory_query`
```json
{
  "query": "open work munin-memory",
  "namespace": "projects/munin-memory",
  "limit": 20,
  "search_mode": "hybrid"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"aa458bd5-9018-483f-aa91-5cfe463ca13c","namespace":"projects/munin-memory","key":"synthesis","entry_type":"state","content_preview":"# Munin Memory Status Summary\n\n## Phase\n\nActive — Consolidation feature complete and live. Librarian stable in production.\n\n## Current Work\n\nMemory consolidation has been shipped and is now live on the Pi, utilizing OpenRouter with `google/gemini-2.5-flash-lite` and ZDR enforcement. The initial synthesis for `pro
```

### Step 3: `memory_read`
```json
{
  "namespace": "projects/munin-memory",
  "key": "synthesis"
}
```
**Result:**
```
{"ok":true,"action":"read","found":true,"id":"aa458bd5-9018-483f-aa91-5cfe463ca13c","namespace":"projects/munin-memory","key":"synthesis","entry_type":"state","content":"# Munin Memory Status Summary\n\n## Phase\n\nActive — Consolidation feature complete and live. Librarian stable in production.\n\n## Current Work\n\nMemory consolidation has been shipped and is now live on the Pi, utilizing OpenRouter with `google/gemini-2.5-flash-lite` and ZDR enforcement. The initial synthesis for `projects/mu
```

### Step 4: `memory_query`
```json
{
  "query": "Blocker",
  "namespace": "projects/munin-memory",
  "limit": 20
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"49eef8eb-6550-4493-915c-f45a11f1a05d","namespace":"projects/munin-memory","key":"insights-analysis-20260331","entry_type":"state","content_preview":"# Outcome-Aware Retrieval — Phase 1 Signal Analysis\n\n**Date:** 2026-03-31\n**Period covered:** 2026-03-27 → 2026-03-31 (≈4 days)\n**Analyst:** Hugin research agent (huginmunin)\n\n---\n\n## 1. Raw Numbers\n\n| Metric | Value |\n|--------|-------|\n| Total retrieval events | 9,866 |\n| Events from `memo
```

### Step 5: Model content
**Munin‑Memory Project – Handoff Brief**  
*Prepared from the source‑backed hand‑off pack (memory_handoff) and supporting narrative (memory_narrative). All statements are directly traceable to stored entries – no invented content.*

---

## 1. Current Phase  
**Active – Consolidation feature complete and live. Librarian stable in production.**  
*Source:* `projects/munin‑memory` synthesis entry (ID **aa458bd5‑9018‑483f‑aa91‑5cfe463ca13c**, updated 2026‑04‑07 05:32 UTC).  

The consolidation worker is running on the Pi, using OpenRouter (`google/gemini‑2.5‑flash‑lite`) with ZDR enforcement. The

## Final Output

**Munin‑Memory Project – Handoff Brief**  
*Prepared from the source‑backed hand‑off pack (memory_handoff) and supporting narrative (memory_narrative). All statements are directly traceable to stored entries – no invented content.*

---

## 1. Current Phase  
**Active – Consolidation feature complete and live. Librarian stable in production.**  
*Source:* `projects/munin‑memory` synthesis entry (ID **aa458bd5‑9018‑483f‑aa91‑5cfe463ca13c**, updated 2026‑04‑07 05:32 UTC).  

The consolidation worker is running on the Pi, using OpenRouter (`google/gemini‑2.5‑flash‑lite`) with ZDR enforcement. The Librarian slice is enabled in production after a full security review.

---

## 2. What Was Recently Completed  

| Date | Milestone | Source |
|------|-----------|--------|
| **2026‑04‑07** | Deep‑dive research on MemPalace (finding complementarity & three integration ideas) | Log ID **20ae570c‑3831‑4179‑aec7‑26635b4348aa** |
| **2026‑04‑06** | Published popular summary of Phase‑2 consolidation research on Heimdall `/read` page (covers consolidation gap, depth‑synthesis experiment, cross‑reference discovery) | Log ID **4474c8f6‑8fe2‑457d‑a790‑3a8e210a609a** |
| **2026‑04‑05** | Codex multi‑model user‑testing against live tool surface (identified payload‑size, `memory_insights`, routing, and signal‑quality issues) | Log ID **500af32f‑8ed5‑481e‑ab90‑d2cbfd566fe3** |
| **2026‑04‑04** | Memory‑consolidation feature complete (4‑sprint delivery, schema migration v12, first synthesis produced) | Log ID **4858f0b4‑dfcb‑4a45‑b83f‑63a7c782efba** |
| **2026‑04‑04** | Librarian security review finished – critical issue fixed, three low‑severity residuals patched; production enablement completed | Log ID **eb485738‑9967‑47f7‑bfe2‑7ec2560fe439** |
| **2026‑04‑04** | Consolidation engineering plan created – background worker architecture chosen, schema v12 defined | Log ID **a6aa6f76‑2a4b‑458a‑8018‑21328b63ac86** |
| **2026‑04‑04** | Phase‑2 depth‑synthesis experiment (Claude‑generated summaries) – 8× Jaccard coverage improvement | Log ID **34b96a08‑afeb‑4b89‑beb3‑3213f1ec2fe3** |
| **2026‑04‑03** | Sleep‑consolidation spike experiment (tested temporal‑staleness, cross‑namespace drift) – negative result for staleness hypothesis | Log ID **…** (part of audit timeline) |

---

## 3. Open Work / Outstanding Items  

| Area | Action Needed | Reason / Blocker | Source |
|------|---------------|------------------|--------|
| **Hardware** | Acquire and provision a **Pi Zero 2 W** for the consolidation worker (currently pending delivery) | Listed under “Blockers” in synthesis entry (truncated after “Pi Zero 2 W Hardware Delivery: Pending d…”) | Synthesis entry ID **aa458bd5‑…** |
| **Payload Size** | Reduce `memory_orient(detail="compact")` payloads (synthesis + cross‑reference payloads) to stay within model limits | Identified in Codex user‑testing report (payload‑size issue) | Log ID **500af32f‑…** |
| **`memory_insights` Metrics** | Stabilise and standardise the `memory_insights` output (inconsistent values observed) | Codex testing flagged “inconsistent `memory_insights` metrics” | Log ID **500af32f‑…** |
| **Routing / `memory_resume`** | Fix “full‑namespace routing” bugs in `memory_resume(project=…)` calls | Codex testing flagged “full‑namespace routing” issue | Log ID **500af32f‑…** |
| **Signal Quality** | Improve signal strength in `memory_narrative` and `memory_commitments` (weak signals reported) | Codex testing flagged “weak signal quality” | Log ID **500af32f‑…** |
| **Librarian Consumer Leak** | Close remaining leakage paths where consumer transport receives classified content via `memory_query` preview, `memory_list` preview, and `memory_history` audit detail | Security review logs (IDs **4e071a57‑…** and **cf38ad50‑…**) identified three blocking issues; two have been fixed, one residual remains in preview paths. | Log ID **4e071a57‑…**, **cf38ad50‑…** |
| **Cross‑Reference Cleanup** | Review and resolve orphaned cross‑references discovered in Phase‑2 analysis (significant number of “orphaned and meaningful” refs) | Mentioned in Heimdall summary and synthesis entry | Synthesis entry ID **aa458bd5‑…** |
| **Documentation** | Publish the full **MemPalace deep‑dive report** and **Codex user‑testing report** to the shared docs folder, and link them from the project README | Reports exist in internal paths (`documents/mempalace-deepdive`, `docs/codex-user-testing-report-2026-04-05.md`) but are not yet referenced in public docs. | Synthesis entry ID **aa458bd5‑…** |

---

## 4. Key Decisions (most recent, limited to 5)  

| Date (UTC) | Decision Summary | Source |
|------------|------------------|--------|
| **2026‑04‑06** | Published a popular summary of Phase‑2 consolidation research to Heimdall `/read`. | Log ID **4474c8f6‑8fe2‑457d‑a790‑3a8e210a609a**
