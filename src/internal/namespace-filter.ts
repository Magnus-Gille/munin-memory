export type NamespaceFilterScope = "prefix" | "subtree";

const NAMESPACE_RANGE_HIGH_SENTINEL = "\uffff";

function namespaceRangeUpperBound(prefix: string): string {
  // Namespace filters are literal path prefixes, not pattern syntax. An
  // exclusive upper bound on the same literal prefix keeps matching
  // case-sensitive under SQLite's default BINARY collation and stays friendly
  // to the namespace indexes, unlike LIKE which is ASCII case-insensitive.
  return `${prefix}${NAMESPACE_RANGE_HIGH_SENTINEL}`;
}

export function namespaceFilterScope(namespace: string | null | undefined): NamespaceFilterScope | undefined {
  if (typeof namespace !== "string" || namespace.length === 0) return undefined;
  return namespace.endsWith("/") ? "prefix" : "subtree";
}

export function buildNamespacePrefixRangeFilter(
  column: string,
  prefix: string,
): { clause: string; params: string[] } {
  return {
    clause: `(${column} >= ? AND ${column} < ?)`,
    params: [prefix, namespaceRangeUpperBound(prefix)],
  };
}

export function buildNamespaceSubtreeFilter(
  column: string,
  namespace: string,
): { clause: string; params: string[]; scope: NamespaceFilterScope } {
  const scope = namespaceFilterScope(namespace);
  if (scope === "prefix") {
    const range = buildNamespacePrefixRangeFilter(column, namespace);
    return { ...range, scope };
  }

  const descendantPrefix = `${namespace}/`;
  const descendantRange = buildNamespacePrefixRangeFilter(column, descendantPrefix);
  return {
    clause: `(${column} = ? OR ${descendantRange.clause})`,
    params: [namespace, ...descendantRange.params],
    scope: "subtree",
  };
}

export function matchesNamespaceSubtree(entryNamespace: string, filter: string): boolean {
  if (filter.endsWith("/")) return entryNamespace.startsWith(filter);
  return entryNamespace === filter || entryNamespace.startsWith(`${filter}/`);
}
