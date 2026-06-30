import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRACKED_PATTERNS,
  namespaceMatchesAnyPattern,
  trackedPatternsToSqlLike,
  isTrackedNamespace,
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
