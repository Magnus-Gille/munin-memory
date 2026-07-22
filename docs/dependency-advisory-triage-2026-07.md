# Dependency advisory triage — 2026-07-22

This note records the production-only `npm audit` review performed against
Munin Memory v0.5.0 after schema v20 shipped. It distinguishes compatible
remediation from advisories whose published fix is outside the declaring
package's supported range. Residual upstream work is tracked in issue #236.

## Remediated with compatible overrides

| Package | Advisory class | Resolution |
|---|---|---|
| `body-parser` | Invalid limits can disable size enforcement | Override to `^2.3.0`, within Express's declared `^2.2.1` range. |
| `fast-uri` | Host confusion during URI parsing/canonicalization | Override to `^3.1.4`, within Ajv's declared major line. |
| `protobufjs` | Infinite loop while parsing malicious `.proto` options | Override to `^7.6.5`, within the ONNX dependency's declared major line. |

These overrides must continue to pass the full test, typecheck, build, and
benchmark gates because they affect runtime dependency trees even where Munin
does not call the vulnerable surface directly.

## Upstream-blocked advisories

### `@hono/node-server`

The MCP SDK v1.29.0 declares `@hono/node-server ^1.19.9`; npm reports the fix
for the Windows encoded-backslash static-file traversal in v2.0.5 or later.
Forcing that major would put the SDK outside its tested dependency contract.
Munin supports macOS and Linux and does not expose Hono's static-file server, so
the affected path is not reachable in the supported deployment. Keep the SDK
current and adopt its compatible fix when upstream moves to the v2 line.

### `sharp`

Transformers v4.2.0 declares `sharp ^0.34.5`; the libvips advisory is fixed in
Sharp v0.35.0 or later. Munin imports Transformers only to construct the
`feature-extraction` text-embedding pipeline in `src/embeddings.ts`; it accepts
no image input and no Munin code path invokes Sharp or libvips. Forcing an
unsupported Sharp major would risk the embedding runtime for an unreachable
image-processing path. Adopt the first Transformers release that declares a
fixed Sharp line, then rerun the embedding and ARM64 deployment gates.

## Review rule

Re-run `npm audit --omit=dev` whenever the MCP SDK or Transformers changes. Do
not describe the repository as having zero advisories until compatible upstream
releases remove both residual findings.
