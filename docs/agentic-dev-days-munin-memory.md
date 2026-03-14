# Agentic Dev Days: Munin Memory Case Study

## One-line summary

Munin Memory is a self-hosted MCP memory server that hit a real cross-client interoperability bug: some Claude interfaces worked, one failed, and the correct fix turned out to be a server-side stateless HTTP refactor rather than a client patch.

## The situation

- Munin Memory ran over MCP Streamable HTTP.
- Claude Code worked.
- Claude Desktop cowork mode worked.
- Claude Desktop chat mode failed.
- The failing symptom was that `tools/call` requests arrived without `mcp-session-id` and got rejected.

## Why some interfaces worked before

The old server implementation was stateful.

That meant a client had to:

1. Send `initialize`
2. Receive `mcp-session-id`
3. Include `mcp-session-id` on later requests like `tools/call`

Interfaces that preserved that session contract kept working. The failing interface apparently did not.

This is why the system looked partially healthy: auth was fine, but transport state handling differed between clients.

## The tempting wrong fix

The easy reaction would have been:

- patch the failing client
- patch `mcp-remote`
- or flip a simple SDK option to “disable sessions”

That would have been the wrong level of fix.

## What the Claude/Codex debate changed

The adversarial debate in:

- [debate/mcp-desktop-summary.md](/Users/magnus/repos/munin-memory/debate/mcp-desktop-summary.md)
- [debate/mcp-desktop-codex-critique.md](/Users/magnus/repos/munin-memory/debate/mcp-desktop-codex-critique.md)
- [debate/mcp-desktop-codex-rebuttal-1.md](/Users/magnus/repos/munin-memory/debate/mcp-desktop-codex-rebuttal-1.md)

surfaced the key architectural point:

**Stateless mode in the MCP SDK is not a one-line toggle. A stateless transport must be fresh per request.**

That changed the implementation plan from “adjust session settings” to “restructure the HTTP handler.”

The debate also clarified:

- fixing the client would be weaker because the client behavior was outside repo control
- Munin is a strong candidate for stateless HTTP because it is tool-only and does not need server-side session state
- the existing `onsessionclosed` path had a cleanup asymmetry that disappeared once the stateful path was removed

## The actual fix

The server was changed so that `/mcp` now:

- creates a fresh `StreamableHTTPServerTransport` per POST request
- sets `sessionIdGenerator: undefined`
- creates a fresh MCP `Server` per request
- handles the request
- closes the server

Consequences:

- `mcp-session-id` is no longer required
- Claude Desktop chat mode can work without special client changes
- the old session map, session sweeps, session caps, and lifecycle hooks are gone

Also changed:

- `GET` and `DELETE` on `/mcp` now return `405`
- request logs now include `authType` and `clientId`

Implementation reference:

- [src/index.ts](/Users/magnus/repos/munin-memory/src/index.ts)

## Why not fix the client instead

- The failing client behavior was not fully under local control.
- A client-specific fix would have left the server brittle for future clients.
- The server-side stateless refactor removed an unnecessary compatibility requirement entirely.
- Root cause at the client layer was uncertain; the server-side fix worked regardless of whether the fault was in Claude Desktop chat mode, `mcp-remote`, or both.

## Production issue discovered during deploy

After deploy, the Pi still had production config drift:

- `MUNIN_OAUTH_ISSUER_URL` was missing, so OAuth metadata reported `http://localhost:3030`
- systemd was binding the service to `0.0.0.0` instead of `127.0.0.1`

This mattered because:

- web/mobile OAuth needs the public issuer URL
- the origin service should only listen locally behind the reverse proxy

That second point had already been captured in:

- [debate/tunnel-security-summary.md](/Users/magnus/repos/munin-memory/debate/tunnel-security-summary.md)

## Final production state

On the Pi:

- service binds `127.0.0.1:3030`
- reverse proxy exposes the public endpoint
- OAuth issuer is `https://munin-memory.gille.ai`
- local and public health checks pass

## The presentation takeaway

This is a good agentic engineering story because the important learning was not just “AI wrote code.”

The stronger story is:

1. Multiple agents were used adversarially, not just collaboratively.
2. The debate prevented a shallow but wrong fix.
3. The final solution improved interoperability across clients by simplifying the server contract.
4. Production validation still mattered: code fix plus deploy fix were both required.

## Phrases worth using live

- “The bug was not auth, it was transport state.”
- “Some clients honored the stateful MCP session contract; one important interface apparently did not.”
- “Stateless mode was the right fix, but only once we realized the SDK required a fresh transport per request.”
- “Without the debate, I likely would have shipped a shallow toggle instead of the correct architectural change.”
- “The final fix was split across architecture and operations: stateless HTTP in code, correct issuer and bind settings on the Pi.”

## Demo-friendly version

Short version for stage use:

“Munin Memory worked from Claude Code and one Desktop path, but failed from another Desktop path because the server required `mcp-session-id` and that client path did not preserve it. A Claude/Codex adversarial debate changed the fix from a superficial client or config patch to a proper stateless HTTP refactor. After deploy, there was also a real ops issue: the Pi still advertised `localhost` as the OAuth issuer. Fixing both gave a clean cross-client setup and a stronger talk story about agentic engineering as design pressure, not just code generation.”
