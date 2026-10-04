# Dependency advisory triage — 2026-10-04

Issue #356 follows the production-only audit of release
`47e44dfc21346b70bc56a2c7a83b89724e448b16`. The clean locked installation reports
eight affected package nodes: four high and four moderate. Their `via` fields
contain 24 distinct GHSA IDs. Transformers and ONNX Runtime inherit findings
from children; these are not eight independently demonstrated Munin exploits.

## Remediation boundary

Keep the direct SDK, Transformers, ONNX Runtime and application APIs unchanged.
Raise six transitive dependency floors, including a new `qs` override, and
regenerate the affected lock entries. No authentication, authorization, body
limits, memory semantics, embedding defaults, or coverage floors change.

| Package | Previous locked version | Fixed floor | Dependency path |
|---|---|---|---|
| `adm-zip` | 0.6.0 | 0.6.1 | Transformers → ONNX Runtime native installer |
| `fast-uri` | 3.1.5 | 3.1.8 | MCP SDK → Ajv URI/schema resolver |
| `hono` | 4.13.1 | 4.13.7 | MCP SDK / Hono Node adapter |
| `ip-address` | 10.5.0 | 10.7.1 | MCP SDK OAuth routes → express-rate-limit |
| `qs` | 6.15.2 | 6.16.0 | Express / body-parser form parsing |
| `sharp` | 0.35.3 | 0.35.4 | Transformers native image utility import |

The floors cover the union of the reported ranges, not only one advisory per
package. The lockfile records the exact tested releases above those floors.
In particular, fast-uri 3.1.7 fixes port injection but remains affected by the
later [host-normalization advisory](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj).

## Source-to-sink review

- **Archive input:** `onnxruntime-node/script/install-utils.js` downloads native
  NuGet packages, opens them with `AdmZip`, and extracts selected entries. Treat
  downloaded archives as an installation input boundary. Munin's inference
  calls do not accept ZIP uploads. A clean native install remains a required
  compatibility check.
- **URI/schema input:** the SDK's Ajv provider compiles schemas using fast-uri.
  Server tool schemas originate in `TOOL_DEFINITIONS`; the bridge's SDK client
  can also validate output schemas supplied by the remote server. Updating the
  resolver covers both uses. The regression test rejects delimiter-containing
  ports through `serialize` and `normalize` while preserving ordinary HTTPS
  normalization and relative resolution. This demonstrates the library fix,
  not a demonstrated Munin SSRF path.
- **HTTP form input:** the SDK OAuth handlers and Munin consent route use
  `express.urlencoded({ extended: false })`; body-parser still calls `qs.parse`
  with depth zero and parameter limits. `/mcp` instead uses Munin's bounded
  manual JSON parser. Preserve both legitimate OAuth forms and those bounds.
- **Client IP input:** SDK OAuth routes enable express-rate-limit by default.
  Its `ipKeyGenerator` uses `node:net.isIPv6` before constructing an `Address6`,
  then performs IPv4-mapped conversion or IPv6 subnet normalization. Preserve
  those rate-limit keys and proxy behavior. Munin's own `/mcp` limiter is separate.
- **Hono input:** Munin serves HTTP with Express and does not invoke Hono JSX,
  static generation or `parseBody`. Those installed APIs still receive fixes;
  this review does not claim that every SDK subpath is unreachable.
- **Native embedding input:** `src/embeddings.ts` dynamically imports
  Transformers and constructs only a `feature-extraction` pipeline, passing
  stored/query text. Transformers imports Sharp even for text-only use, so
  successful text inference must be verified, not assumed from the absence of
  image uploads. No Munin route supplies images to the libheif decoder.

## Compatibility exceptions

`fast-uri`, Hono, ip-address and qs fit their locked parents' declared ranges.
The repository already shipped overrides outside ONNX Runtime's `adm-zip
^0.5.16`, Transformers' `sharp ^0.34.5`, and the SDK's `@hono/node-server
^1.19.9` declarations. This patch keeps those existing override families rather
than adding another parent/API upgrade. The adm-zip and Sharp updates stay
within the already deployed 0.6.x and 0.35.x families. Sharp's Node >=20.9
requirement is unchanged from the previously locked release.

These exceptions require clean installation, native import and real text
inference evidence on macOS and Linux ARM64. A successful mocked pipeline alone
does not prove compatibility. Updating the parent SDK/Transformers/ONNX family
to remove overrides is separate from fixing this audit snapshot.

## Advisory inventory

The dated audit contained these IDs; rerun the full audit before publication
and after deployment because the advisory database changes independently.

- `adm-zip`: GHSA-vwc7-r8mq-g2x9, GHSA-7q85-xj36-vmfc,
  GHSA-rcw4-f5rp-g42v, GHSA-j5f4-cc29-5x44, GHSA-p634-w6r4-rjp2,
  GHSA-c6fg-446q-cg94, GHSA-8238-w5pm-2374.
- `fast-uri`: GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc,
  GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-qw65-cvwx-89v3,
  GHSA-hrr3-gc8f-f4qj.
- `hono`: GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc,
  GHSA-crvj-82cr-hjcx, GHSA-hxh3-vqpv-xpqv.
- `ip-address`: GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc,
  GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw.
- `qs`: GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g.
- `sharp`: GHSA-rgj7-g3m4-5g8c.

The July note and #236 describe an older snapshot. The current audit covers
more package families and a newer Sharp/libheif advisory; revalidate residual
upstream constraints rather than copying the old reachability conclusion.

## Verification contract

The clean pre-patch audit must fail; URI delimiter regressions must fail while
ordinary URI controls pass. After remediation, require a clean locked install,
zero production audit findings, passing URI regressions, full local gates,
OAuth/HTTP/profile/embedding suites, frozen lexical and hybrid benchmarks,
real text inference, Linux ARM64 evidence and independent candidate review.
No audit suppression or forced broad update substitutes for those checks.
