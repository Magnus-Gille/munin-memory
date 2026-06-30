import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRACKED_PATTERNS,
  REFERENCE_NAMESPACE_PATTERNS,
  UNTRACKED_NAMESPACE_MIN_ENTRIES,
  namespaceMatchesAnyPattern,
  trackedPatternsToSqlLike,
  isTrackedNamespace,
  detectUntrackedNamespaces,
} from "../src/internal/retrieval-shared.js";

// ---------------------------------------------------------------------------
// trackedPatternsToSqlLike — the glob→SQL translator (bug-prone string handling)
// ---------------------------------------------------------------------------

describe("trackedPatternsToSqlLike", () => {
  it("default patterns reproduce the historical projects/clients filter", () => {
    const { clause, params } = trackedPatternsToSqlLike(DEFAULT_TRACKED_PATTERNS, "namespace");
    expect(clause).toBe("(namespace LIKE ? ESCAPE '\\' OR namespace LIKE ? ESCAPE '\\')");
    expect(params).toEqual(["projects/%", "clients/%"]);
  });

  it("empty patterns match nothing", () => {
    expect(trackedPatternsToSqlLike([], "namespace")).toEqual({ clause: "0", params: [] });
  });

  it("a '*' pattern short-circuits to match everything", () => {
    expect(trackedPatternsToSqlLike(["*", "projects/*"], "namespace")).toEqual({ clause: "1", params: [] });
  });

  it("exact (non-wildcard) patterns use equality", () => {
    const { clause, params } = trackedPatternsToSqlLike(["home/today"], "ns");
    expect(clause).toBe("(ns = ?)");
    expect(params).toEqual(["home/today"]);
  });

  it("escapes LIKE metacharacters in a prefix", () => {
    const { params } = trackedPatternsToSqlLike(["a_b/*"], "namespace");
    expect(params).toEqual(["a\\_b/%"]);
  });

  it("interpolates the caller-supplied column verbatim", () => {
    const { clause } = trackedPatternsToSqlLike(["projects/*"], "e.namespace");
    expect(clause).toBe("(e.namespace LIKE ? ESCAPE '\\')");
  });
});

// ---------------------------------------------------------------------------
// namespaceMatchesAnyPattern / isTrackedNamespace
// ---------------------------------------------------------------------------

describe("namespaceMatchesAnyPattern / isTrackedNamespace", () => {
  it("isTrackedNamespace defaults to projects/clients (unchanged behavior)", () => {
    expect(isTrackedNamespace("projects/x")).toBe(true);
    expect(isTrackedNamespace("clients/y")).toBe(true);
    expect(isTrackedNamespace("notes/z")).toBe(false);
  });

  it("honors custom patterns", () => {
    expect(isTrackedNamespace("papers/x", ["papers/*"])).toBe(true);
    expect(isTrackedNamespace("projects/x", ["papers/*"])).toBe(false);
  });

  it("matches exact, prefix, and wildcard", () => {
    expect(namespaceMatchesAnyPattern("anything", ["*"])).toBe(true);
    expect(namespaceMatchesAnyPattern("a/b", ["a/b"])).toBe(true);
    expect(namespaceMatchesAnyPattern("a/b/c", ["a/b/*"])).toBe(true);
    expect(namespaceMatchesAnyPattern("a/b/c", ["a/b"])).toBe(false);
    expect(namespaceMatchesAnyPattern("x", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectUntrackedNamespaces — convention-level proposal source (ADR 0001 layer-2)
// ---------------------------------------------------------------------------

function entry(namespace: string, id: string, updated_at = "2026-06-29T00:00:00.000Z") {
  return { id, namespace, updated_at };
}

describe("detectUntrackedNamespaces", () => {
  it("surfaces a top-level cluster with >= min entries outside the tracked set", () => {
    const entries = [
      entry("recipes/dinner", "r1"),
      entry("recipes/lunch", "r2"),
      entry("recipes/breakfast", "r3"),
    ];
    const out = detectUntrackedNamespaces(entries, [...DEFAULT_TRACKED_PATTERNS]);
    expect(out).toHaveLength(1);
    expect(out[0].prefix).toBe("recipes");
    expect(out[0].pattern).toBe("recipes/*");
    expect(out[0].entry_count).toBe(3);
    expect(out[0].namespaces.sort()).toEqual(["recipes/breakfast", "recipes/dinner", "recipes/lunch"]);
    expect(out[0].source_entry_ids.length).toBeGreaterThan(0);
  });

  it("aggregates entries under one top-level prefix (single bare namespace, multiple keys) — bare-only excluded (fix #2)", () => {
    // A cluster composed ONLY of bare-prefix entries ("recipes" with no slash) is
    // excluded: crystallizing "recipes/*" would NOT match the bare "recipes" entry,
    // leaving the proposal irresolvable. Mixed clusters (bare + sub-paths) are included.
    const entries = [entry("recipes", "r1"), entry("recipes", "r2"), entry("recipes", "r3")];
    expect(detectUntrackedNamespaces(entries, [...DEFAULT_TRACKED_PATTERNS])).toHaveLength(0);
  });

  it("does not surface a cluster below the entry threshold", () => {
    const entries = [entry("recipes/dinner", "r1"), entry("recipes/lunch", "r2")];
    const out = detectUntrackedNamespaces(entries, [...DEFAULT_TRACKED_PATTERNS]);
    expect(out).toHaveLength(0);
  });

  it("excludes tracked namespaces", () => {
    const entries = [
      entry("projects/a", "p1"),
      entry("projects/b", "p2"),
      entry("projects/c", "p3"),
    ];
    expect(detectUntrackedNamespaces(entries, [...DEFAULT_TRACKED_PATTERNS])).toHaveLength(0);
  });

  it("excludes reference namespaces (meta, people, decisions, ...)", () => {
    const entries = [
      entry("meta/a", "m1"),
      entry("meta/b", "m2"),
      entry("meta/c", "m3"),
      entry("people/x", "pe1"),
      entry("people/y", "pe2"),
      entry("people/z", "pe3"),
      entry("decisions/d1", "d1"),
      entry("decisions/d2", "d2"),
      entry("decisions/d3", "d3"),
    ];
    expect(detectUntrackedNamespaces(entries, [...DEFAULT_TRACKED_PATTERNS])).toHaveLength(0);
  });

  it("stops surfacing a cluster once its pattern is added to tracked_patterns (crystallized)", () => {
    const entries = [
      entry("recipes/dinner", "r1"),
      entry("recipes/lunch", "r2"),
      entry("recipes/breakfast", "r3"),
    ];
    const crystallized = [...DEFAULT_TRACKED_PATTERNS, "recipes/*"];
    expect(detectUntrackedNamespaces(entries, crystallized)).toHaveLength(0);
  });

  it("sorts by entry_count desc then prefix asc", () => {
    const entries = [
      entry("hobby/a", "h1"),
      entry("hobby/b", "h2"),
      entry("hobby/c", "h3"),
      entry("recipes/a", "r1"),
      entry("recipes/b", "r2"),
      entry("recipes/c", "r3"),
      entry("recipes/d", "r4"),
    ];
    const out = detectUntrackedNamespaces(entries, [...DEFAULT_TRACKED_PATTERNS]);
    expect(out.map((c) => c.prefix)).toEqual(["recipes", "hobby"]);
  });

  it("exposes the standard reference allowlist and entry threshold", () => {
    expect(REFERENCE_NAMESPACE_PATTERNS).toContain("meta/*");
    expect(REFERENCE_NAMESPACE_PATTERNS).toContain("users/*");
    expect(UNTRACKED_NAMESPACE_MIN_ENTRIES).toBe(3);
  });

  // fix #2: bare (single-segment, no slash) namespaces — exclusion + hasBare flag
  it("excludes clusters whose entries are ALL bare (no sub-path) — crystallize would be inconsistent", () => {
    const bare = [entry("recipes", "r1"), entry("recipes", "r2"), entry("recipes", "r3")];
    expect(detectUntrackedNamespaces(bare, [...DEFAULT_TRACKED_PATTERNS])).toHaveLength(0);
  });

  it("includes mixed clusters (bare + sub-paths) and sets hasBare:true for dual-pattern suggestion", () => {
    const mixed = [
      entry("recipes", "r0"),
      entry("recipes/dinner", "r1"),
      entry("recipes/lunch", "r2"),
      entry("recipes/breakfast", "r3"),
    ];
    const out = detectUntrackedNamespaces(mixed, [...DEFAULT_TRACKED_PATTERNS]);
    expect(out).toHaveLength(1);
    expect(out[0].hasBare).toBe(true);
    expect(out[0].entry_count).toBe(4);
  });
});
