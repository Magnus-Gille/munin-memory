# Debate Summary: Cloudflare Tunnel Security Architecture

**Date:** 2026-02-16
**Participants:** Claude (Opus 4.6), Codex (GPT-5.3)
**Rounds:** 2
**Topic:** Security architecture for exposing Munin Memory to the public internet via Cloudflare Tunnel

## Agreed Architecture

**5-layer defense model:**
1. **Cloudflare Tunnel** — outbound-only connection from Pi, no exposed origin IP, no open ports
2. **Cloudflare Access** — Service Token auth at edge (validated before traffic reaches origin)
3. **Bearer token** — application-level auth (defense in depth, independent credential)
4. **Application hardening** — body size limits, timeouts, session caps, DNS rebinding protection, rate limiting, structured logging
5. **Pi-level hardening** — localhost binding, firewall, systemd sandboxing

## Concessions accepted by both sides

1. **Session exhaustion is critical** — unbounded session Map needs cap + idle TTL + absolute lifetime + eviction strategy (not just static cap)
2. **Server timeouts missing** — add `requestTimeout`, `headersTimeout`, body read deadline. Do NOT increase `keepAliveTimeout` (Codex caught this as a regression)
3. **DNS rebinding protection missing** — enable MCP SDK's host/origin validation
4. **systemd hardening needed** — add `ProtectSystem`, `ProtectHome`, `NoNewPrivileges`, `PrivateTmp`, `ReadWritePaths`
5. **Go-live gate** — must run end-to-end auth test proving Cloudflare Access enforced on POST, GET/SSE (including reconnect), and DELETE before deploying

## Defenses accepted by Codex

1. **Keep Bearer token alongside Cloudflare Access** — defense in depth is worth the minimal ops cost
2. **Defer RBAC/agent identity to v2** — acceptable while single-user, but structured logging should be audit-ready

## Unresolved / Refined

1. **Session cap design** — static cap of 10 can be exploited as lockout vector. Need eviction of oldest idle session when cap reached, plus absolute session lifetime (e.g., 4 hours)
2. **SSE reconnection and headers** — SSE reconnect creates new HTTP GET requests that must include CF-Access headers. Must be verified in testing, not assumed
3. **PRD v2 alignment** — deferred, but structured request logging is the bridge

## Critical go-live requirements (must pass before deployment)

- [ ] End-to-end test: CF Access enforced on POST /mcp (initialize)
- [ ] End-to-end test: CF Access enforced on GET /mcp (SSE stream)
- [ ] End-to-end test: CF Access enforced on GET /mcp (SSE reconnection)
- [ ] End-to-end test: CF Access enforced on DELETE /mcp (session cleanup)
- [ ] End-to-end test: Missing/invalid Access credentials → 403 (never reaches origin)
- [ ] End-to-end test: Valid Access + invalid Bearer → 401 (origin rejects)
- [ ] Verify: direct IP access to Pi:3030 blocked by firewall
- [ ] Verify: session cap + TTL + eviction working
- [ ] Verify: request logging captures tool names and session IDs

## Implementation phases (revised from draft)

### Phase 1: Application hardening (before any tunnel work)
1. Session management: cap (10) + idle TTL (30min) + absolute lifetime (4hr) + eviction of oldest idle on cap
2. Server timeouts: `requestTimeout=30s`, `headersTimeout=10s`, body read timeout in parseJsonBody
3. Request body size limit (1MB)
4. DNS rebinding protection via SDK options
5. Structured request logging (timestamp, method, tool name, session ID, status)
6. Security response headers (`X-Content-Type-Options: nosniff`, `Cache-Control: no-store`)
7. Simple rate limiter (60 req/min)

### Phase 2: Pi-level hardening
1. Change `MUNIN_HTTP_HOST` to `127.0.0.1` (localhost only)
2. Harden `munin-memory.service` (ProtectSystem, ProtectHome, NoNewPrivileges, etc.)
3. Firewall: block inbound 3030 from non-localhost

### Phase 3: Cloudflare Tunnel
1. Install `cloudflared` on Pi
2. Create tunnel → `<your-domain>` → `localhost:3030`
3. Run `cloudflared` as systemd service under dedicated user
4. Verify origin is unreachable directly

### Phase 4: Cloudflare Access
1. Create Access Application for `<your-domain>` (covers all paths including /health)
2. Create Service Token(s) — one per MCP client
3. Add Access Policy: require valid Service Token
4. **Run go-live test matrix** (all MCP request types, all auth combinations)
5. Update MCP client configs with CF-Access headers

### Phase 5: MCP client migration
1. Update Claude Code config: `claude mcp add-json` with new URL + headers
2. Update Claude Desktop config with new URL + headers
3. Verify both environments work end-to-end
4. Decommission direct LAN access (remove old MCP config pointing to Pi LAN address)

## All debate files

- `debate/tunnel-security-snapshot.md`
- `debate/tunnel-security-claude-draft.md`
- `debate/tunnel-security-claude-self-review.md`
- `debate/tunnel-security-codex-critique.md`
- `debate/tunnel-security-claude-response-1.md`
- `debate/tunnel-security-codex-rebuttal-1.md`
- `debate/tunnel-security-summary.md`
- `debate/tunnel-security-critique-log.json`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.3-codex |
| Codex R2   | ~2m             | gpt-5.3-codex |
