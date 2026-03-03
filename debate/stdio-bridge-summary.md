# Debate Summary: stdio-bridge.mjs

**Date:** 2026-02-21
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.3-codex)
**Rounds:** 2
**Topic:** Evaluating the custom stdio-to-HTTP bridge as replacement for mcp-remote

## Outcome

**Consensus: The bridge correctly fixes the immediate concurrency bug (one session per process), but should be rewritten using the MCP SDK's `StreamableHTTPClientTransport` rather than shipping incremental fixes to the hand-rolled SSE/HTTP handling.**

## Concessions Accepted by Both Sides

1. The per-process architecture is the correct fix for the shared-session multiplexing bug
2. The custom SSE parser has correctness issues (multi-line data, silent drops, buffered-not-streaming)
3. Missing fetch timeout is critical (blocks entire serial queue)
4. Signal handlers should route through cleanup
5. The V1/V2 split is inconsistent — if SSE correctness is conceded as broken, deferring the structural fix is unjustified

## Defenses Accepted by Codex

1. The bridge was never claimed to be a complete MCP Streamable HTTP implementation — "purpose-built for munin-memory" framing is fair

## Unresolved Disagreements

1. **Backpressure significance**: Claude considers it practically irrelevant; Codex flags it as relevant for planned autonomous multi-session use. Low severity either way.

## New Issues from Round 2

1. Proposed V1 fixes were incomplete (conceded multi-line SSE but didn't list it in the fix plan)
2. Startup auth validation could break CF-only deployments
3. Timeout value should be configurable, not hardcoded

## Action Items

| # | Action | Owner |
|---|--------|-------|
| 1 | **Rewrite bridge using SDK transports** (`StreamableHTTPClientTransport` + `StdioServerTransport`) | Next session |
| 2 | Make timeout configurable via env var (e.g., `MUNIN_REQUEST_TIMEOUT_MS`) | Next session |
| 3 | Route SIGINT/SIGTERM through cleanup with idempotency guard | Next session |
| 4 | Keep current bridge as-is for immediate use until SDK rewrite is ready | — |

## Key Insight

The MCP SDK (`@modelcontextprotocol/sdk`) is already a project dependency. Using its client transport gives spec-compliant SSE parsing, session lifecycle management, and content-type negotiation for free. Hand-rolling these in ~120 lines was a false economy — the bridge is simple but the protocol is not.

## Debate Files

- `debate/stdio-bridge-snapshot.mjs` — Code snapshot
- `debate/stdio-bridge-claude-draft.md` — Claude's initial assessment
- `debate/stdio-bridge-claude-self-review.md` — Claude's self-critique
- `debate/stdio-bridge-codex-critique.md` — Codex Round 1 critique
- `debate/stdio-bridge-claude-response-1.md` — Claude's response
- `debate/stdio-bridge-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/stdio-bridge-critique-log.json` — Structured critique log
- `debate/stdio-bridge-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.3-codex |
| Codex R2   | ~1m             | gpt-5.3-codex |
