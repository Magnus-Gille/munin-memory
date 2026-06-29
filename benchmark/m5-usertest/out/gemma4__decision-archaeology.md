# M5 User-Test: gemma4 — Decision Archaeology

**Scenario:** decision-archaeology  
**Grade:** PASS (found-first-try)  
**Duration:** 32.0s  
**Steps:** 4  
**Tool calls:** 3  
**Tools used:** memory_orient, memory_query, memory_get

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
  "query": "Munin task store TASKS.md",
  "search_mode": "hybrid"
}
```
**Result:**
```
{"ok":true,"action":"query","results":[{"id":"bf20d0a2-2a09-435d-8099-758825e7c218","namespace":"decisions/memory-architecture","key":null,"entry_type":"log","content_preview":"**Decision: Munin as universal task store, phasing out TASKS.md files**\n\nContext: Magnus felt task/memory state was drifting across too many layers (Munin, MEMORY.md, STATUS.md, TASKS.md files, CLAUDE.md). Interviewed on needs and preferences.\n\nKey principles decided:\n1. **Munin is the universal memory** — tool-agnos
```

### Step 2: `memory_get`
```json
{
  "id": "bf20d0a2-2a09-435d-8099-758825e7c218"
}
```
**Result:**
```
{"ok":true,"action":"get","found":true,"id":"bf20d0a2-2a09-435d-8099-758825e7c218","namespace":"decisions/memory-architecture","key":null,"entry_type":"log","content":"**Decision: Munin as universal task store, phasing out TASKS.md files**\n\nContext: Magnus felt task/memory state was drifting across too many layers (Munin, MEMORY.md, STATUS.md, TASKS.md files, CLAUDE.md). Interviewed on needs and preferences.\n\nKey principles decided:\n1. **Munin is the universal memory** — tool-agnostic, acce
```

### Step 3: Model content
I found the relevant decision entry in the `decisions/memory-architecture` namespace.

### **Decision: Munin as Universal Task Store (Phasing out `TASKS.md`)**

**Rationale:**
The decision was driven by the need to prevent "state drift" across multiple layers of memory (Munin, `MEMORY.md`, `STATUS.md`, `TASKS.md`, and `CLAUDE.md`). Because Magnus uses multiple AI tools (Claude, ChatGPT, Codex, OpenCode, etc.) across different devices, repository-based files like `TASKS.md` are only accessible via Claude Code. **Munin was chosen as the universal layer because it is the only memory store reachab

## Final Output

I found the relevant decision entry in the `decisions/memory-architecture` namespace.

### **Decision: Munin as Universal Task Store (Phasing out `TASKS.md`)**

**Rationale:**
The decision was driven by the need to prevent "state drift" across multiple layers of memory (Munin, `MEMORY.md`, `STATUS.md`, `TASKS.md`, and `CLAUDE.md`). Because Magnus uses multiple AI tools (Claude, ChatGPT, Codex, OpenCode, etc.) across different devices, repository-based files like `TASKS.md` are only accessible via Claude Code. **Munin was chosen as the universal layer because it is the only memory store reachable from all interfaces**, ensuring a single, tool-agnostic source of truth.

**Key Implementation Principles:**
* **Universal Memory:** Munin serves as the canonical source for tasks, organized in the `tasks/` namespace into four categories: *commitments*, *projects*, *admin*, and *events*.
* **Scoped Local Files:** Files like `MEMORY.md` and `STATUS.md` were retained but strictly limited to tool-specific tips and session resumption; they no longer contain tasks, decisions, or project status.
* **Phased Deprecation of `TASKS.md`:**
    * **Phase 1 (Completed):** All tasks migrated to Munin; `TASKS.md` files made read-only.
    * **Phase 2:** Validation of task accessibility from all AI interfaces.
    * **Phase 3:** Deletion of the files and updating of agent skills.
* **Separation of Decisions:** Project-specific choices remain in their respective project namespaces, while reusable learnings are extracted and shared across the broader architecture.
