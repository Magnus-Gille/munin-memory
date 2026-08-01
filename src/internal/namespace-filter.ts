export type NamespaceFilterScope = "prefix" | "subtree";
export type BareNamespaceMode = "exact" | "subtree";

export interface NamespaceSelector {
  kind: "exact" | "prefix";
  value: string;
}

const MAX_UNICODE_SCALAR = 0x10FFFF;
const SURROGATE_START = 0xD800;
const SURROGATE_END = 0xDFFF;

function nextUnicodeScalar(codePoint: number): number | null {
  if (codePoint >= MAX_UNICODE_SCALAR) return null;
  const next = codePoint + 1;
  return next >= SURROGATE_START && next <= SURROGATE_END
    ? SURROGATE_END + 1
    : next;
}

export function namespacePrefixSuccessor(prefix: string): string | null {
  if (prefix.length === 0) return null;

  const codePoints = Array.from(prefix);
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index].codePointAt(0)!;
    const successor = nextUnicodeScalar(codePoint);
    if (successor === null) continue;
    return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(successor)}`;
  }

  return null;
}

export function namespaceFilterScope(namespace: string | null | undefined): NamespaceFilterScope | undefined {
  if (typeof namespace !== "string" || namespace.length === 0) return undefined;
  return namespace.endsWith("/") ? "prefix" : "subtree";
}

export function namespaceFilterToSelectors(
  namespace: string | null | undefined,
  bareMode: BareNamespaceMode = "subtree",
): NamespaceSelector[] | undefined {
  if (typeof namespace !== "string" || namespace.length === 0) return undefined;
  if (namespace.endsWith("/")) return [{ kind: "prefix", value: namespace }];
  if (bareMode === "exact") return [{ kind: "exact", value: namespace }];
  return normalizeNamespaceSelectors([
    { kind: "exact", value: namespace },
    { kind: "prefix", value: `${namespace}/` },
  ]);
}

export function buildNamespacePrefixRangeFilter(
  column: string,
  prefix: string,
): { clause: string; params: string[] } {
  if (prefix.length === 0) {
    return { clause: "1", params: [] };
  }

  // SQLite's BINARY collation compares UTF-8 byte sequences lexicographically.
  // The smallest exclusive upper bound for a literal prefix is therefore the
  // next Unicode scalar sequence in that same lexicographic order, not
  // `prefix + U+FFFF`, which fails for supplementary-plane descendants.
  const upperBound = namespacePrefixSuccessor(prefix);
  if (upperBound === null) {
    // Every code point in the prefix is already maximal, so no higher finite
    // Unicode string can share a smaller earlier byte. In that corner case,
    // `>= prefix` is already exact for the prefix language.
    return {
      clause: `(${column} >= ?)`,
      params: [prefix],
    };
  }

  return {
    clause: `(${column} >= ? AND ${column} < ?)`,
    params: [prefix, upperBound],
  };
}

export function buildNamespaceSubtreeFilter(
  column: string,
  namespace: string,
): { clause: string; params: string[]; scope?: NamespaceFilterScope } {
  const scope = namespaceFilterScope(namespace);
  if (scope === undefined) {
    return { clause: "1", params: [] };
  }
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

export function matchesNamespaceSelector(entryNamespace: string, selector: NamespaceSelector): boolean {
  return selector.kind === "exact"
    ? entryNamespace === selector.value
    : entryNamespace.startsWith(selector.value);
}

export function matchesNamespaceSelectors(
  entryNamespace: string,
  selectors: readonly NamespaceSelector[],
): boolean {
  return selectors.some((selector) => matchesNamespaceSelector(entryNamespace, selector));
}

export function normalizeNamespaceSelectors(
  selectors: readonly NamespaceSelector[],
): NamespaceSelector[] {
  const deduped = new Map<string, NamespaceSelector>();
  for (const selector of selectors) {
    if (selector.value.length === 0) continue;
    deduped.set(`${selector.kind}:${selector.value}`, selector);
  }

  const prefixes = [...deduped.values()]
    .filter((selector): selector is NamespaceSelector & { kind: "prefix" } => selector.kind === "prefix")
    .sort((left, right) => left.value.length - right.value.length);
  const keptPrefixes: NamespaceSelector[] = [];
  for (const prefix of prefixes) {
    if (keptPrefixes.some((selector) => prefix.value.startsWith(selector.value))) continue;
    keptPrefixes.push(prefix);
  }

  const exacts = [...deduped.values()]
    .filter((selector): selector is NamespaceSelector & { kind: "exact" } => selector.kind === "exact")
    .filter((selector) => !keptPrefixes.some((prefix) => selector.value.startsWith(prefix.value)))
    .sort((left, right) => left.value.localeCompare(right.value));

  return [...keptPrefixes, ...exacts];
}

function intersectNamespaceSelector(
  left: NamespaceSelector,
  right: NamespaceSelector,
): NamespaceSelector | null {
  if (left.kind === "exact" && right.kind === "exact") {
    return left.value === right.value ? left : null;
  }
  if (left.kind === "exact" && right.kind === "prefix") {
    return left.value.startsWith(right.value) ? left : null;
  }
  if (left.kind === "prefix" && right.kind === "exact") {
    return right.value.startsWith(left.value) ? right : null;
  }
  if (left.value.startsWith(right.value)) return left;
  if (right.value.startsWith(left.value)) return right;
  return null;
}

export function intersectNamespaceSelectors(
  left: readonly NamespaceSelector[] | null,
  right: readonly NamespaceSelector[] | null,
): NamespaceSelector[] | null {
  if (left === null) return right === null ? null : normalizeNamespaceSelectors(right);
  if (right === null) return normalizeNamespaceSelectors(left);

  const intersections: NamespaceSelector[] = [];
  for (const leftSelector of left) {
    for (const rightSelector of right) {
      const intersection = intersectNamespaceSelector(leftSelector, rightSelector);
      if (intersection) intersections.push(intersection);
    }
  }
  return normalizeNamespaceSelectors(intersections);
}

export function resolveNamespaceSelectorScope(
  namespace: string | null | undefined,
  bareMode: BareNamespaceMode,
  namespaceSelectors?: readonly NamespaceSelector[] | null,
): readonly NamespaceSelector[] | null | undefined {
  const requestedSelectors = namespaceFilterToSelectors(namespace, bareMode);
  if (namespaceSelectors === undefined) return requestedSelectors;
  if (requestedSelectors === undefined) return namespaceSelectors;
  if (namespaceSelectors === null) return requestedSelectors;
  return intersectNamespaceSelectors(namespaceSelectors, requestedSelectors);
}

export function buildNamespaceSelectorFilter(
  column: string,
  selectors: readonly NamespaceSelector[],
): { clause: string; params: string[] } {
  const normalized = normalizeNamespaceSelectors(selectors);
  if (normalized.length === 0) {
    return { clause: "0", params: [] };
  }

  const clauses: string[] = [];
  const params: string[] = [];
  for (const selector of normalized) {
    if (selector.kind === "exact") {
      clauses.push(`${column} = ?`);
      params.push(selector.value);
      continue;
    }
    const filter = buildNamespacePrefixRangeFilter(column, selector.value);
    clauses.push(filter.clause);
    params.push(...filter.params);
  }

  return {
    clause: `(${clauses.join(" OR ")})`,
    params,
  };
}
