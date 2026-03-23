# Debate: Health, Scalability & Open-Source Readiness

**Date:** 2026-03-23
**Participants:** Claude Opus 4.6 (assessment + synthesis) vs Codex GPT-5.4 (adversarial review)
**Trigger:** Magnus asked for health check, scalability assessment, and open-source readiness evaluation

## Context

Munin Memory has been running in production on a Raspberry Pi 5 for 2+ months. Usage is accelerating — ~400 entries across 115 namespaces, with ~60 task entries/week from Hugin automation. The question: does the architecture hold, and is it ready for broader open-source release?

## Current Health (Consensus)

| Metric | Value | Verdict |
|--------|-------|---------|
| Tests | 301/301 passing | Good |
| Code:Test ratio | 1:1.12 (4121:4632 LOC) | Excellent |
| Build | Clean, zero warnings | Good |
| npm audit | 0 vulnerabilities | Good |
| TypeScript strict | Yes, zero `any` types | Excellent |
| Schema | v3, no pending migrations | Good |
| Growth rate | ~60 entries/week (accelerating) | Monitor |

## Scalability: Where It Breaks

### Agreed breaking points

Both models agree: architecture is sound for single-user use up to ~10-20K entries. Beyond that, specific bottlenecks emerge.

**Codex assessment:**
- 20K is "still functioning" territory, not "comfortable headroom"
- Breakage shows as latency spikes, WAL checkpoint stalls, and embedding lag — not RAM crashes
- SD card I/O is the biggest hidden risk (write amplification and wear)
- ~200MB embedding model on 4GB Pi is non-trivial once Node + page cache + OS counted
- FTS5 triggers add steady write tax that compounds with growth

**Claude assessment:**
- N+1 semantic search (loop of `getEntry()` calls) is the first thing that will bite
- `memory_orient` unbounded dashboard degrades past 50-100 projects
- ReDoS potential in security.ts on 100KB+ payloads (low probability)
- At current growth (~60/week), 5K entries reached in ~18 months — plenty of runway

### Specific bottlenecks by entry count

| Scale | Status | Key risks |
|-------|--------|-----------|
| ~400 (now) | Comfortable | None |
| 5K | Fine | FTS queries slow slightly |
| 10K | Watchful | Hybrid search 2-5s, orient dashboard large |
| 20K | Ceiling | Embedding backlog 30-60min, WAL checkpoint stalls on SD |
| 100K+ | Redesign needed | Need batch semantic search, pagination, possibly PostgreSQL |

### Missed issues (Codex additions)

1. WAL on SD card under bursty writes creates checkpoint pauses
2. FTS5 triggers add per-write overhead that compounds
3. Embedding model memory (~200MB) on 4GB Pi — pressure when combined with Node heap
4. SD card random I/O is a reliability risk (wear) not just performance

## Open-Source Readiness

### "Personal use" tier: YES (consensus)

Both models agree the project clears the bar:
- MIT license
- README with getting started guide
- Comprehensive documentation (CLAUDE.md, prd.md, technical-spec.md)
- 301 tests, 1:1+ code-to-test ratio
- npm metadata complete
- Design rationale documented (10 debate summaries)

### Gaps for broader release

| Gap | Impact | Status |
|-----|--------|--------|
| No CI/CD | Medium | Task submitted to Pi |
| No README maturity label | Medium | Task submitted to Pi |
| 7 outdated deps | Low | Task submitted to Pi |
| sqlite-vec alpha | Medium | Label as experimental (in README task) |
| No CONTRIBUTING.md | Low | Future |
| No Docker | Medium for adoption | Future |
| No coverage reporting | Low | Future |
| No multi-user story | N/A for v1 | Document as single-user |

### "Team production" tier requirements (Codex)

Would need: CI, coverage visibility, upgrade/migration docs, backup/restore docs, release/versioning policy, support matrix, explicit security posture, row-level access control, per-user OAuth scoping.

## Dependency Risk

**Codex verdict:**
- `sqlite-vec 0.1.7-alpha.2` is the real red flag — acceptable for personal use if labeled experimental
- `better-sqlite3` one major behind — moderate risk (maintenance/security inertia)
- MCP SDK one minor behind — low risk with stable tests
- Ship with this stack for personal use; don't market as production-grade without de-risking vector storage or making it optional

## SQLite vs PostgreSQL: Consensus

**Both agree: SQLite is correct for v1.** It matches the sovereign, self-hosted, low-ops philosophy. PostgreSQL is the right move only if/when committing to multi-user team deployment — a v2 concern.

## Actions Taken

Three sequenced tasks submitted to Hugin (Pi):
1. `tasks/20260323-104051-munin-ci-pipeline` — GitHub Actions CI
2. `tasks/20260323-104051-munin-readme-positioning` — README maturity + CI badge
3. `tasks/20260323-104051-munin-dep-updates` — Conservative dependency updates
