# Five-minute quick start

Status: canonical local installation and first-success path for macOS and Linux.

## Outcome

From a fresh checkout, one command installs locked dependencies, builds Munin,
checks the local environment, creates an owner-only database/config directory,
generates client examples, and verifies a complete MCP write-to-resume flow:

```bash
git clone https://github.com/Magnus-Gille/munin-memory.git
cd munin-memory
./scripts/quickstart.sh
```

The default is deliberately local stdio plus lexical search. It downloads no
embedding model, opens no network port, and needs no bearer credential. After
first success, enable a hardware profile and embeddings if desired.

The command fails before starting a service when it finds an unsupported Node
or OS version, an unknown profile, missing build output, unavailable SQLite
FTS5, unsafe/unwritable or symbolic-link data/config/database paths, an occupied HTTP port, an empty
embedding model override, or HTTP mode without a configured bearer credential.
Credential values are never displayed or written into generated examples.

## What success proves

The verifier launches the built server and connects the official MCP client over
stdio. It therefore covers process startup, initialization, transport, tool
schemas, persistence, shutdown, and read-back. It:

1. performs the required `memory_orient` handshake;
2. reads `memory_status`;
3. creates an isolated state entry under `onboarding/quickstart`;
4. appends a milestone log;
5. retrieves the context with `memory_resume`; and
6. reads the new state back and verifies its content.

The database defaults to `~/.munin-memory/memory.db`. Generated examples and a
machine-readable `last-run.json` report are written under
`~/.config/munin-memory/`, all with owner-only permissions.

## Connect a client

The quick start generates four artifacts:

- `codex.toml`: merge its tables into `~/.codex/config.toml`;
- `claude-code.txt`: run the contained `claude mcp add-json` command;
- `claude-desktop.json`: merge the `munin-memory` entry into the existing
  `mcpServers` object;
- `streamable-http.json`: generic HTTP shape with the literal placeholder
  `<MUNIN_API_KEY>`.

Do not replace a client's entire existing configuration with an example. Merge
only the Munin entry, restart the client, call `memory_orient`, and then inspect
`onboarding/quickstart` with `memory_resume` or `memory_list`.

## Optional modes

Run preflight without creating configs or memory:

```bash
./scripts/quickstart.sh --preflight-only
```

Select and validate an appliance profile:

```bash
./scripts/quickstart.sh --profile zero-appliance
```

The generated local examples intentionally use lexical-first settings. After
verification, edit the chosen client entry to set
`MUNIN_EMBEDDINGS_ENABLED`, `MUNIN_SEMANTIC_ENABLED`, and
`MUNIN_HYBRID_ENABLED` to `true`, add `MUNIN_PROFILE`, and restart the client.
The first semantic start may download model data.

HTTP preflight checks port and auth before startup but never prints the token:

```bash
MUNIN_API_KEY="$(openssl rand -hex 32)" \
  ./scripts/quickstart.sh --transport http --server-url http://127.0.0.1:3030/mcp
```

Store the key in a permission-restricted environment or credential file. Put it
into a real client's secure credential surface in place of the generated
placeholder; never commit it.

## Automated smoke test

```bash
npm run quickstart:smoke
```

The smoke test creates a temporary HOME-independent data/config root, builds the
CLI, runs the complete lexical-first flow, checks the five-minute budget and
owner-only artifact modes, and deletes only its temporary directory. The same
flow is also covered through Vitest against a fresh database.

## Measurement record

`last-run.json` records install, cold-start, and total duration plus resident
memory, database size, and checkout/data/config disk footprint. It contains no
credential values.

Measured 2026-07-22 on macOS with Node 26.5.0, a warm npm package cache, and a
fresh data/config directory:

| Mode | Install | MCP cold start and six-step check | Total | RSS | Database | Checkout + dependencies + data/config |
|---|---:|---:|---:|---:|---:|---:|
| lexical-first, profile unset | 4.0 s | 265 ms | 4.29 s | 80.0 MiB | 432 KiB | 502 MiB |

These numbers are evidence for that machine, not a universal promise. CI runs
the isolated Linux smoke lane. Appliance RAM evidence for `zero-appliance`,
`zero-plus`, and `full-node` remains in
[`appliance-profiles.md`](appliance-profiles.md); the quick start defaults to
lexical mode specifically so model download time and semantic working-set size
cannot prevent first success.

## Upgrade, rollback, and uninstall

The database and generated client examples live outside the source checkout, so
normal code upgrades do not replace them:

```bash
cp ~/.munin-memory/memory.db ~/.munin-memory/memory.db.pre-upgrade
git pull --ff-only
npm ci
npm run build
./scripts/quickstart.sh --preflight-only
```

Stop any running Munin process before copying the live database directly; the
documented SQLite-safe backup path remains authoritative for services. Keep the
production `.env` and database outside release directories. For rollback,
restore the previous code/tag, run its locked `npm ci && npm run build`, and
point it at the unchanged database only when that release supports the active
schema. Forward-only migrations mean a database backup—not a code checkout—is
the rollback boundary for schema changes.

To uninstall the local code, remove the checkout and the Munin entry from each
client. Retain `~/.munin-memory` and `~/.config/munin-memory` unless data erasure
is intentional. Deleting either directory is separate, explicit, and not part
of the uninstall command.
