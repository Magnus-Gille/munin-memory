# Jarvis Architecture Debate — Summary

**Date:** 2026-03-13
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Artifact:** `docs/jarvis-architecture-plan.md`

## Context

Architecture plan for evolving Munin Memory into a three-part personal AI knowledge system ("Jarvis"): Munin (brain/memory on Pi 1), Mímir (file archive on NAS Pi 2), and Hugin (signal-gathering worker). Goal: any agent on any platform can access Magnus's full professional context — projects, clients, documents, people, signals.

## Concessions Accepted by Both Sides

1. **Hugin is a worker, not a peer service.** The architecture is "two services + one worker," not three equal services. Hugin is ETL with idempotency and checkpointing.

2. **Remove `/search` from Mímir.** All search goes through Munin. Mímir is a thin file gateway: serving + directory listing only.

3. **Tag syntax must be fixed.** Current Munin validation rejects `:` in tags. The proposed `client:lofalk` convention is invalid. Must either update regex or adopt hyphens before indexing.

4. **No AI summarization of private customer documents during indexing.** Store extracted text + metadata only. Cloud summarization only for public content. On-demand summarization requires explicit user initiation, not "implicit consent."

5. **rsync without `--delete`.** Add manifest with file hashes and timestamps. Expose sync freshness to Munin.

6. **SHA-256 checksums in Munin document entries.** Integrity model for detecting when files change under a summary.

7. **Build order must start with a validation spike.** Prove remote agent authenticated fetch before building Mímir.

8. **Narrowed Hugin MVP:** RSS/Atom + excerpt capture + dedupe + Munin writeback + daily digest. No X, newsletters, or AI summarization.

## Defenses Accepted by Codex

1. **Three-raven mental model is fine as a mnemonic** — just separate it from deployment topology in documentation.

2. **Mímir is justified as a separate deployment** — files live on Pi 2, serving from Pi 2 is correct.

3. **ChatGPT access is aspirational, not committed scope.**

4. **Lightweight monitoring (heartbeat + Munin health entry) is sufficient for MVP.**

## Unresolved Disagreements

### 1. Success criteria: "any platform deep access" vs "Munin-sufficient"

**Codex position:** The plan cannot simultaneously promise "full document access from mobile" and treat failure of the authenticated fetch path as tolerable. These are two different products. Pick one.

**Claude position:** The 90/10 split is real — most queries are answered by Munin entries alone. But Codex is right that the success criteria as written commit to the full-access version.

**Resolution needed:** After the Step 0 validation spike, rewrite success criteria based on what actually works. If remote fetch fails, downgrade gracefully rather than pretending it doesn't matter.

### 2. Document identity model

**Codex position:** Path-based key + SHA-256 is incomplete. Renames create new keys with same hash; edits keep key but change hash. Neither case tells you if it's the same logical document.

**Claude position:** Acknowledged but not yet resolved. For MVP, path-based keys with checksums are probably sufficient. Full document identity (stable IDs surviving renames) is a v2 concern.

**Resolution needed:** Define the rename/tombstone strategy before bulk indexing. At minimum, document entries should include a `canonical_name` field that doesn't change on path moves.

### 3. Content-size strategy for private documents

**Codex position:** The plan says "no AI summary" for private docs but also says content-size strategy is "summary + first N chars." Without AI summary, what goes in the entry? Truncated text? Chunked entries? A deterministic synopsis?

**Resolution needed:** Pick one before indexing. Recommended: metadata + truncated extracted text (first 10,000 chars). Most documents are under this limit. For longer ones, truncate with a note. Don't chunk — it complicates search and identity.

### 4. Prompt-injection / untrusted content

**Codex position:** Entirely absent from plan and response. Hugin ingests external content, Mímir serves arbitrary documents, Munin stores excerpts. No sanitization, labeling, or separation strategy.

**Resolution needed:** Define a content trust model. At minimum: tag entries with `source:external` vs `source:internal`. Consider truncating/sanitizing HTML before storing excerpts. Hugin-ingested content should never contain instruction-like text that could hijack an agent.

### 5. Cloudflare Access policy for Mímir

**Codex position:** "Bypass" at the edge for a document archive is risky. A leaked Bearer token gives full access to customer documents.

**Resolution needed:** Define the CF Access policy for `mimir.gille.ai`. Options: Service Token (same as Munin MCP), or Bypass with Bearer-only at origin. The sensitivity of customer documents argues for Service Token.

### 6. Sovereignty policy: cloud processing boundary

**Codex position:** "Implicit consent" when a user is in a Claude session is too vague. If sovereignty means data stays on Magnus's hardware, sending private docs to Claude API on demand is still a violation.

**Resolution needed:** Define an explicit policy. Suggested: "Private customer artifacts may be sent to cloud AI only when Magnus explicitly requests it in a conversation. Automated/batch processing of private artifacts must use local-only models or no AI at all."

## Revised Build Order (post-debate)

```
Step 0: Validation & prerequisites (before building anything)
  0a. Spike: test Claude Web/Mobile WebFetch with custom Bearer header
  0b. Decide tag syntax (update Munin regex or adopt hyphens)
  0c. Define content-size strategy (metadata + truncated extracted text)
  0d. Define document identity model (path-based key + SHA-256 + canonical_name)
  0e. Define sovereignty policy for cloud processing
  0f. Result: rewrite success criteria based on spike outcome

Step 1: Mímir (minimal file server on NAS Pi)
  1a. Express static server (~50 lines)
  1b. Bearer auth + path traversal protection
  1c. Cloudflare Tunnel for Pi 2 (with CF Access Service Token)
  1d. rsync from laptop (no --delete, with manifest)
  1e. Health endpoint

Step 2: Index mgc/ into Munin
  2a. Build /index-artifacts skill
  2b. Extract text locally (no AI summarization for private docs)
  2c. Write document entries with Mímir URLs + SHA-256 + canonical_name
  2d. Tag with client-*, person-*, topic-*, type-*
  2e. Update client index entries

Step 3: People profiles + source definitions
  3a. Structured profiles in people/*/profile
  3b. Source definitions in people/*/sources (RSS feeds, blog URLs)
  3c. Cross-reference existing entries with person-* tags

Step 4: Reading queue (independent)

Step 5: Hugin (RSS worker)
  5a. RSS/Atom fetcher + dedupe by URL
  5b. Excerpt capture + Munin writeback (tag: source-external)
  5c. Daily digest generation
  5d. Content trust labeling for ingested content
```

## Key Metrics

- **Total critique points:** 20
- **Self-review catch rate:** 4/20 (20%)
- **Changed:** 12, **Acknowledged:** 8, **Rejected:** 0
- **Critical severity:** 4 (tag syntax, sovereignty in indexing, multi-hop auth, success criteria conflict)

## All Debate Files

- `debate/jarvis-architecture-claude-draft.md`
- `debate/jarvis-architecture-claude-self-review.md`
- `debate/jarvis-architecture-codex-critique.md`
- `debate/jarvis-architecture-claude-response-1.md`
- `debate/jarvis-architecture-codex-rebuttal-1.md`
- `debate/jarvis-architecture-critique-log.json`
- `debate/jarvis-architecture-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~3m             | gpt-5.4       |
