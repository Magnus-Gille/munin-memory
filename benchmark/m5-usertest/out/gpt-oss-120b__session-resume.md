# M5 User-Test: gpt-oss-120b — Session Resume

**Scenario:** session-resume  
**Grade:** PASS (resumed-with-next-steps)  
**Duration:** 38.1s  
**Steps:** 5  
**Tool calls:** 4  
**Tools used:** memory_orient, memory_query, memory_read

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

### Step 1: `memory_orient`
```json
{
  "detail": "full"
}
```
**Result:**
```
{"ok":true,"action":"orient","conventions":{"content":"# Munin Memory Conventions\n\nLast updated: 2026-04-01\n\n## Agent Capabilities Model\n\nAgents accessing Munin fall into two categories based on what they can reach:\n\n| Capability | Local agent | Munin-only agent |\n|---|---|---|\n| Local filesystem | Yes | No |\n| Git | Yes | No |\n| Munin MCP | Yes | Yes |\n| Project CLAUDE.md / README | Yes | No |\n\n**Examples:** Claude Code, Codex CLI, and OpenCode are local agents. Claude Desktop, c
```

### Step 2: `memory_query`
```json
{
  "query": "munin-memory",
  "namespace": "projects/",
  "limit": 5
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"e8234839-8db2-453b-8271-714214aad85b","namespace":"projects/munin-memory","key":"agentic-dev-days-case-study","entry_type":"state","content_preview":"# Agentic Dev Days — Munin Memory Case Study\n\n## Core story\nMunin Memory hit a real MCP interoperability bug: Claude Code and Claude Desktop cowork mode worked, but Claude Desktop chat mode failed because the old server required stateful Streamable HTTP sessions and rejected `tools/call` requests tha
```

### Step 3: `memory_read`
```json
{
  "namespace": "projects/munin-memory",
  "key": "status"
}
```
**Result:**
```
{"ok":true,"action":"read","found":true,"id":"0bc6fed6-b033-40e1-9c35-963197fe7c72","namespace":"projects/munin-memory","key":"status","entry_type":"state","content":"## Phase\nActive — Consolidation feature complete and live. Librarian stable in production.\n\n## Current Work\nMemory consolidation shipped and is live on the Pi. Codex multi-model user-testing pass completed against the live tool surface; strongest recurring issues were `memory_orient(detail=\"compact\")` payload size, inconsiste
```

### Step 4: Model content
**Project:** `projects/munin‑memory` – the Munin Memory platform (the “Librarian”/consolidation feature).

**Current Phase (as of the latest status entry, updated 2026‑04‑05 07:56 UTC):**  
*Active – Consolidation feature complete and live.* The worker that consolidates memory across sprints is running on the Pi, and Codex multi‑model user‑testing has finished. The team is now polishing the surrounding tooling and addressing the few remaining issues that surfaced during testing.

**Key points from the status entry** (`projects/munin-memory/status`):

| Section | Content (excerpt) |
|---------|

## Final Output

**Project:** `projects/munin‑memory` – the Munin Memory platform (the “Librarian”/consolidation feature).

**Current Phase (as of the latest status entry, updated 2026‑04‑05 07:56 UTC):**  
*Active – Consolidation feature complete and live.* The worker that consolidates memory across sprints is running on the Pi, and Codex multi‑model user‑testing has finished. The team is now polishing the surrounding tooling and addressing the few remaining issues that surfaced during testing.

**Key points from the status entry** (`projects/munin-memory/status`):

| Section | Content (excerpt) |
|---------|-------------------|
| **Current Work** | “Memory consolidation shipped and is live on the Pi… strongest recurring issues were `memory_orient(detail=\"compact\")` payload size, inconsistent `memory_insights` metrics, full‑namespace routing in `memory_resume(project=…)`, and weak signal quality in `memory_narrative` / `memory_commitments`. Heimdall display task still awaits review.” |
| **Blockers** | “Pi Zero 2 W hardware not delivered (constrained‑profile validation pending). Phase 2 learned reranking blocked on Hugin sending stable `mcp‑session‑id` headers. Hugin task classification false positive (hugin#14) blocks tasks mentioning namespace patterns.” |
| **Next Steps** | 1. Review Heimdall consolidation display task output  <br>2. Triage Codex user‑testing findings – start with compact orient payload size  <br>3. Investigate `memory_insights` metric semantics and `memory_resume(project=…)` full‑namespace routing  <br>4. Monitor consolidation worker synthesis quality over the next few days  <br>5. Sara onboarding (#5) – create family principal, test OAuth end‑to‑end  <br>6. Librarian rollout continuation (#4) – expand namespace classification rules  <br>7. Fix Hugin `mcp‑session‑id` – unblocks outcome‑aware retrieval Phase 2 |

**Concrete next steps you can take right now**

1. **Heimdall display review** – Pull the latest Heimdall task output (likely in `tasks/…` or a log entry) and verify that the consolidation UI correctly renders the synthesized memory narrative. Note any missing fields or layout glitches.

2. **Payload‑size triage** – Run a few `memory_orient(detail="compact")` calls against a representative namespace set and capture the JSON size. Compare against the observed limits in the Codex testing report (look for entries tagged `topic:memory` or `decision`). Identify which fields inflate the payload (e.g., full‑namespace dashboards, large `meta/workbench-notes`) and consider pruning or summarising them.

3. **`memory_insights` metric audit** – Locate the state entry or log that defines the `memory_insights` counters (search for tag `topic:insights`). Verify that each counter (e.g., “payload_bytes”, “synthesis_latency”) is being incremented correctly and that the semantics match the documentation in `meta/conventions` (search for “memory_insights”).

4. **Full‑namespace routing in `memory_resume`** – Execute a test call such as `memory_resume(project="munin-memory", include_history=true)` and observe whether the returned pack includes entries from *all* namespaces or only the top‑level project. If routing is incomplete, note the missing namespaces (e.g., `clients/…`, `decisions/…`) and prepare a bug report.

5. **Hugin `mcp‑session‑id` fix** – Open the recent Hugin task logs (search for `hugin#14` or tag `topic:hugin`). Confirm whether the server is still rejecting calls lacking the session header. If so, draft a short patch plan: add the header propagation in the Hugin client wrapper and add a unit test that asserts the header is present on every `tools/call`.

6. **Sara onboarding** – Create a new family principal for “Sara” (use `memory_write` with namespace `people/sara` and appropriate tags). Then run an OAuth flow (if you have access to the test environment) to verify end‑to‑end token exchange and that Sara can call `memory_orient`.

7. **Librarian rollout continuation** – Review the classification rules in `projects/munin-memory` (search for tag `topic:librarian`). Add any missing namespace patterns (e.g., new `reading/*` or `documents/*` prefixes) and push the updated status.

These actions directly address every item listed under **Next Steps** and will move the project from “active – consolidation live” toward a stable, fully‑instrumented production state.
