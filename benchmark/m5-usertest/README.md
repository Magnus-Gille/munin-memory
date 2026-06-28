# M5 User-Test Harness

Lets a LOCAL M5 model genuinely user-test Munin Memory by calling its real
MCP tools through an autonomous agent loop. Captures the full transcript (tool
calls + real Munin responses) and a candid UX report from the model.

## What it does

1. Spawns a local Munin server over stdio, pointed at a **throwaway copy** of
   the committed fixture `benchmark/fixtures/memory-snapshot-2026-04-07.db`.
   The user's real `~/.munin-memory/memory.db` is never touched.
2. Fetches the real Munin tool schemas and exposes a curated subset to the model:
   `memory_orient`, `memory_write`, `memory_update_status`, `memory_log`,
   `memory_read`, `memory_query`, `memory_list`.
3. Runs an agent loop where the model: orients, records a decision with
   rationale into `testing/<model>`, retrieves it, then writes a UX report.
4. Writes per-model output to `benchmark/m5-usertest/out/`:
   - `<model>.json` — full transcript + metadata
   - `<model>.md` — human-readable tool calls + UX report

## Requirements

- Node.js 20+
- `M5_API_KEY` environment variable (bearer token for the M5 gateway)

## Usage

```bash
# Get your M5 API key from the macOS Keychain
M5_API_KEY=$(m5-auth) node benchmark/m5-usertest/run.mjs \
  --models qwen3-30b-instruct

# Multiple models
M5_API_KEY=$(m5-auth) node benchmark/m5-usertest/run.mjs \
  --models qwen3-30b-instruct,gpt-oss-120b \
  --max-steps 14

# Override the M5 base URL
M5_API_KEY=$(m5-auth) node benchmark/m5-usertest/run.mjs \
  --models qwen3-30b-instruct \
  --base http://100.76.72.59:8080/v1
```

## CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--models` | (required) | Comma-separated M5 model IDs |
| `--base` | `http://100.76.72.59:8080/v1` | M5 gateway base URL |
| `--max-steps` | `12` | Maximum agent loop steps per model |

## Auth note

Set `M5_API_KEY` via `$(m5-auth)` which reads the bearer token from the macOS
Keychain (service `hs-m5`, account `owner`). Never hardcode the key.

## Network / Cloudflare-UA note

The default base URL (`http://100.76.72.59:8080/v1`) is the **M5 Tailnet
endpoint**, which bypasses Cloudflare Access. The harness always sends a
browser `User-Agent` (`Chrome/126`) to avoid Cloudflare WAF 1010 rejections
that occur with the default Node/undici UA when going through the public
gateway.

## Fixture DB

The harness copies `benchmark/fixtures/memory-snapshot-2026-04-07.db` to a
temp path before spawning Munin. This gives the model real content to orient
against. The temp DB is left on disk after the run (in `$TMPDIR`) for
debugging; it is not cleaned up automatically.

## This is NOT CI

This harness is a standalone dev/eval tool. It is not wired into CI, not
imported by any production code, and not covered by `npm test`. Run it
manually when you want to evaluate a model's Munin UX perception.
