# Debate Index

| Date | Topic | Rounds | Key decision | Critique points | Self-review catch rate |
|------|-------|--------|--------------|----------------|-----------------------|
| 2026-03-06 | [Claude information handoffs](claude-information-handoffs-summary.md) | 2 | Default to `CLAUDE.md` + Munin; use handoff files only when needed; build `ask-claude` before any routing skill | 7 | 4/7 (57%) |
| 2026-03-05 | [Usability improvement plan](usability-improvement-summary.md) | synth | All 7 items implemented: log browsing, compact status, key discovery, drift visibility, demo filtering, tag governance, agent-neutral | — | — |
| 2026-02-09 | [v1 spec review](resolution.md) | 2 | 11 spec amendments adopted | — | — |
| 2026-02-13 | [Expansion plan (Features 0-5)](expansion-resolution.md) | 2 | Implementation order + debate outcomes | — | — |
| 2026-02-16 | [meta/conventions improvement](conventions-summary.md) | 2 | Session Handshake as centerpiece; compact playbook; tag vocabulary | 14 | 2/14 (14%) |
| 2026-02-16 | [Cloudflare Tunnel security](tunnel-security-summary.md) | 2 | 5-layer defense; go-live gate on e2e auth test; session hardening | 13 | 3/13 (23%) |
| 2026-02-21 | [stdio-bridge evaluation](stdio-bridge-summary.md) | 2 | Rewrite with SDK transports instead of hand-rolled SSE/HTTP | 10 | 2/10 (20%) |
| 2026-02-21 | [Time Machine over Tailscale](tm-tailscale-summary.md) | 1 | Fresh sparsebundle via Tailscale IP; never delete sparsebundle control files | 5 | — |
| 2026-02-24 | [Bridge session auto-reconnect](bridge-reconnect-summary.md) | 2 | Transport-identity-scoped reconnect; configurable idle TTL; liveness test | 11 | 1/11 (9%) |
| 2026-02-25 | [OAuth 2.1 security review](oauth-security-summary.md) | 2 | Server-side auth transaction binding; redirect_uri validation in approve+exchange; atomic token ops | 12 | 4/12 (33%) |
| 2026-02-25 | [Session orientation & workbench](workbench-summary.md) | 2 | Workbench as rebuildable cache; listNamespaces needs timestamps; read-only handshake; two tiers | 13 | 5/13 (38%) |
| 2026-02-26 | [Memory conventions & two-layer state model](memory-conventions-summary.md) | 2 | Two data layers + dashboard; read-before-write protocol; structured status template; log-first discipline | 14 | 5/14 (36%) |
| 2026-02-26 | [Ortelius collaboration opportunity](ortelius-collab-summary.md) | 2 | Proceed to meeting with concrete engagement question; force specificity on scope/ownership | 13 | 0/13 (0%) |
| 2026-03-05 | [mcp-remote vs native connector](mcp-desktop-summary.md) | 2 | Try stateless HTTP mode first; fix onsessionclosed leak; native connector is fallback | 12 | 4/12 (33%) |
| 2026-03-12 | [Computed dashboard architecture](computed-dashboard-summary.md) | 2 | Replace manual workbench with computed dashboard; add CAS overwrite protection; drop auto-log; hybrid curated overlay | 16 | 4/16 (25%) |
| 2026-03-13 | [Jarvis architecture (Munin+Mímir+Hugin)](jarvis-architecture-summary.md) | 2 | Two services + one worker; validate remote fetch first; no AI summary for private docs; fix tag syntax; define document identity | 20 | 4/20 (20%) |
| 2026-03-15 | [Skills in Munin](skills-in-munin-summary.md) | 2 | Original rejected; start with one sub-artifact experiment, not a system | 17 | 4/17 (24%) |
| 2026-03-27 | [Usability fix priority](usability-priority-summary.md) | 2 | Compact conventions (#3) before task noise (#1); single-source-of-truth constraint | 6 | 1/6 (17%) |
| 2026-03-27 | [Munin discoverability](munin-discoverability-summary.md) | 2 | Data-driven reference index in orient, not hardcoded in compactConventions(); conditional loading | 7 | 2/7 (29%) |
| 2026-03-27 | [Docs location: where does "way of working" live?](docs-location-summary.md) | 2 | 3-layer structure: README framing + repo concepts (durable only) + Munin runtime conventions | 10 | 3/10 (30%) |
| 2026-03-27 | [Feature wishlist (memory_history, since filter, flags, compact)](feature-wishlist-summary.md) | 2 | Ship memory_history (audit_log MCP tool) first; caller context plumbing prerequisite for orient diff; attention via meta/attention convention | 14 | 4/14 (29%) |
| 2026-03-27 | [Debate self-improvement mechanisms](debate-self-improvement-summary.md) | 2 | Harden Step 2 with topic-specific checklist + mandatory draft sections; use existing impact field before adding new metrics | 13 | 2/13 (15%) |
| 2026-04-01 | [Multi-principal Phase 1](multi-principal-p1-summary.md) | 2 | Input-level auth for aggregate tools; owner-only shared delete; add oauth_client_id column; specify agent token flow | 18 | 0/18 (0%) |
| 2026-04-01 | [munin-admin CLI](admin-cli-summary.md) | 2 | Add rotate-token; audit all mutations; refuse missing DB; strict expires-at; owner guard; --json everywhere | 15 | 3/15 (20%) |
| 2026-04-02 | [Librarian architecture](librarian-summary.md) | 2 | Pre-synthesis filtering for derived tools; DB-driven namespace floors; transport attestation via dedicated credentials; mandatory audit before enforcement | 15 | 2/15 (13%) |
| 2026-04-07 | [MemPalace research spike](mempalace-spike-summary.md) | 2 | Scenario C confirmed but import list not justified; benchmark before tuning; KG demoted; Munin-native eval harness is the real next step | 13 | 4/13 (31%) |
| 2026-04-08 | [Telemetry & autonomous improvement](telemetry-summary.md) | 1* | Full proposal rejected; minimal Layer 1 only (tool_calls table + status aggregates); no automation; 30-day review gate | 11 | 5/11 (45%) |
