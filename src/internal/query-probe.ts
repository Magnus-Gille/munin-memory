// Internal-only marker used by the MCP query snapshot builder to opt a storage
// helper into the bounded query probe (500 exact candidates plus one sentinel).
// It is intentionally not part of the exported query option interfaces or the
// public storage contract.
const QUERY_PROBE_MARKER = Symbol("munin-memory.query-probe");

export function withQueryProbeLimit<T extends object>(options: T): T {
  return { ...options, [QUERY_PROBE_MARKER]: true } as T;
}

export function hasQueryProbeLimit(options: object): boolean {
  return (options as { [QUERY_PROBE_MARKER]?: unknown })[QUERY_PROBE_MARKER] === true;
}
