# Bridge Session Auto-Reconnect — Debate Summary

**Date:** 2026-02-24
**Participants:** Claude (Opus 4.6), Codex (GPT-5.3)
**Rounds:** 2

## Problem
The munin-memory bridge (stdio-to-HTTP proxy) permanently loses connectivity when the server-side session expires after 30 minutes of inactivity. No reconnection logic exists.

## Agreed concessions (both sides)

1. **Fatal onclose race is real** — calling `close()` on old transport triggers `onclose` → `cleanup()` → `process.exit(0)`. Must use transport-identity-scoped close suppression during reconnect, not just a global boolean flag.
2. **Idle TTL should be configurable** via env var (`MUNIN_SESSION_IDLE_TTL_MS`), not hardcoded to 2 hours. Keep 30-minute default; tune from observed usage.
3. **Liveness regression test is mandatory** — must prove reconnect doesn't reach `process.exit`.
4. **Handler ownership needs one canonical rule** — `reconnect()` must deterministically own `httpClient.onmessage` cleanup in a `finally` block, not split across promise callbacks and outer function.

## Defenses accepted by Codex

1. Bridge send path is POST-only, so GET/DELETE session-error handling on the server is irrelevant for reconnect trigger detection.
2. Capability drift has low current impact — server is tools-only, `createMcpServer()` always registers the same tools regardless of client capabilities.

## Unresolved / refined during debate

1. **Error classification**: Final position is broader substring matching on 400 (covering "not initialized" AND "no valid session") plus 404 always. Codex correctly noted the response was internally inconsistent, but the final concrete matcher is sound.
2. **Hardcoded init params**: Accepted as non-equivalent but adequate for this codebase. Documented as a known tradeoff, not a guarantee.
3. **Inbound message loss during cutover**: Acknowledged as theoretical. Send ordering is serialized; inbound messages from the old transport during the ~ms close window are unlikely but possible. Accepted as low-risk.

## Final design (incorporating all debate findings)

### Server (`src/index.ts`)
- Make `SESSION_IDLE_TTL_MS` configurable via `MUNIN_SESSION_IDLE_TTL_MS` env var, default 30 min

### Bridge (`src/bridge.ts`)
- **Transport factory** with handler wiring
- **Transport-identity-scoped onclose**: check `client === httpClient` before calling `cleanup()`
- **`isSessionExpiredError()`**: match `StreamableHTTPError` with code 404, or code 400 + message containing "not initialized" or "no valid session"
- **`reconnect()`**: detach old handlers → close old transport → create new → start → MCP handshake (initialize + initialized) → restore `onmessage = forwardToStdio` in `finally` block
- **`processSendQueue()`**: on session-expired error, reconnect + retry once per message
- **Non-session errors** (network, auth, rate limit): forward to Claude Code as-is (current behavior, correct)

### Tests (`tests/bridge.test.ts`)
- `isSessionExpiredError` unit tests (all variants)
- Liveness test: reconnect does NOT trigger `process.exit`
- Reconnection flow: first send → session error → reconnect → retry succeeds
- Reconnect failure: error forwarded to stdio, no crash

## Action items
1. Implement bridge reconnect per final design above
2. Add configurable idle TTL to server
3. Write bridge tests
4. Deploy to Pi
5. Test with a real Claude Code session

## All debate files
- `debate/bridge-reconnect-snapshot.md`
- `debate/bridge-reconnect-claude-draft.md`
- `debate/bridge-reconnect-claude-self-review.md`
- `debate/bridge-reconnect-codex-critique.md`
- `debate/bridge-reconnect-claude-response-1.md`
- `debate/bridge-reconnect-codex-round2.md`
- `debate/bridge-reconnect-critique-log.json`
- `debate/bridge-reconnect-summary.md`

## Costs
| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~4m             | gpt-5.3-codex |
| Codex R2   | ~2m             | gpt-5.3-codex |
