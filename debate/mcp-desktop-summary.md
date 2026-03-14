# Debate Summary: mcp-remote vs Native Connector for Claude Desktop

**Date:** 2026-03-05
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Topic:** How to fix Claude Desktop chat mode failing to use Munin Memory MCP tools

## Problem

Claude Desktop "chat" mode MCP tool calls fail with 400 — the `mcp-session-id` header is missing on `tools/call` requests after a successful handshake. "Cowork" mode works fine with the same `mcp-remote` configuration.

## Claude's Original Position

Replace `mcp-remote` with Claude Desktop's native connector (Settings > Connectors), using OAuth 2.1 instead of Bearer + CF Access headers. Phased rollout with dual registration.

## Key Debate Outcomes

### Concessions accepted by both sides

1. **Root cause is unproven.** The logs show a session lifecycle mismatch but don't prove whether `mcp-remote`, Claude Desktop chat mode, or both are responsible.
2. **Native connectors might inherit the same bug** if Desktop chat mode itself is the layer losing session state.
3. **"Zero-risk" was oversold.** Phase 1 adds credential footprint and dual registration creates uninterpretable experiments.
4. **`onsessionclosed` has a real bug** — deletes map entry but doesn't call `server.close()`, unlike `evictSession()`. Fix independently.

### Codex's key insight — accepted by Claude

**Stateless HTTP mode is the right fix to try first.** The MCP SDK supports stateless Streamable HTTP (`sessionIdGenerator: undefined`). Munin is a strong candidate because:
- Tool-only server (no resources/prompts/sampling)
- All handlers use shared process/database state, not per-session state
- Server already creates fresh MCP Server per session (transport bookkeeping only)

Stateless mode directly removes the failing requirement (`mcp-session-id` header) and would fix all clients, not just Desktop.

### Defenses accepted by Codex

1. Server logs do prove *where* the failure manifests (missing session header on tools/call)
2. Chat mode is not fully containerized (HTTP requests do reach the server)

### Unresolved / caveats

1. **Stateless mode is not trivial** — SDK requires fresh transport per request; current architecture is built around long-lived transport/session pairs. Implementation delta is real.
2. **Observability is weak** — logs don't record auth mechanism, client identity, or connector source. Needs improvement regardless of transport mode.
3. **Session-based hardening (caps, idle TTL) needs replacement** with request-scoped equivalents in stateless mode. Rate limiter is already global, so that's fine.

## Final Verdict (both sides agree)

**Build and test a minimal stateless HTTP branch against Claude Desktop chat mode before touching connector configuration.**

If stateless mode works → deploy it (fixes all clients, no config changes needed).
If stateless mode fails → the problem is almost certainly on the client side, and native connector investigation becomes the fallback.

## Action Items

| # | Action | Owner | Priority |
|---|--------|-------|----------|
| 1 | Investigate SDK stateless HTTP mode — read docs, prototype branch | Claude/Magnus | High |
| 2 | Fix `onsessionclosed` to call `server.close()` | Claude/Magnus | Medium |
| 3 | Add auth mechanism + client identity to request logs | Claude/Magnus | Low |
| 4 | If stateless works, deploy to Pi and test all 4 platforms | Claude/Magnus | High (after #1) |
| 5 | If stateless fails, test native connector without dual registration | Claude/Magnus | Fallback |

## All Debate Files

- `debate/mcp-remote-vs-native-prompt.md` — Problem statement
- `debate/mcp-desktop-claude-draft.md` — Claude's original proposal
- `debate/mcp-desktop-claude-self-review.md` — Claude's self-critique
- `debate/mcp-desktop-codex-critique.md` — Codex Round 1 critique
- `debate/mcp-desktop-claude-response-1.md` — Claude's response
- `debate/mcp-desktop-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/mcp-desktop-critique-log.json` — Structured critique log
- `debate/mcp-desktop-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~3m             | gpt-5.4       |
