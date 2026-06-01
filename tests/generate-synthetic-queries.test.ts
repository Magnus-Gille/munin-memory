import { describe, it, expect } from "vitest";
import {
  generateSyntheticQueries,
  tokenize,
} from "../scripts/generate-synthetic-queries.js";
import type { Entry } from "../src/types.js";

function entry(over: Partial<Entry> & Pick<Entry, "id" | "namespace">): Entry {
  return {
    id: over.id,
    namespace: over.namespace,
    key: over.key ?? "status",
    entry_type: "state",
    content: over.content ?? "",
    tags: over.tags ?? "[]",
    agent_id: "owner",
    owner_principal_id: "owner",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    valid_until: null,
    classification: "internal",
    embedding_status: "generated",
    embedding_model: null,
  };
}

const CORPUS: Entry[] = [
  entry({
    id: "e-atlas",
    namespace: "projects/atlas",
    key: "status",
    content: "Atlas phase two migration to sqlite wal storage engine underway",
    tags: '["active"]',
  }),
  entry({
    id: "e-borealis",
    namespace: "projects/borealis",
    key: "status",
    content: "Borealis storage engine decision still pending review",
    tags: '["active"]',
  }),
  entry({
    id: "e-oauth",
    namespace: "decisions/auth",
    key: "oauth-pkce",
    content: "OAuth pkce authentication decision finalized for mobile clients",
    tags: '["decision","topic:auth"]',
  }),
];

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and short tokens", () => {
    const toks = tokenize("The Atlas phase-two MIGRATION to SQLite!");
    expect(toks).toContain("atlas");
    expect(toks).toContain("migration");
    expect(toks).toContain("sqlite");
    expect(toks).not.toContain("the"); // stopword
    expect(toks).not.toContain("to"); // too short / stopword
  });
});

describe("generateSyntheticQueries", () => {
  it("returns only well-formed synthetic queries with ground truth", () => {
    const queries = generateSyntheticQueries(CORPUS);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.source).toBe("synthetic");
      expect(q.query.trim().length).toBeGreaterThan(0);
      expect(q.id).toMatch(/^synth-/);
      const hasGroundTruth = (q.expected_ids?.length ?? 0) > 0 || (q.expected_namespaces?.length ?? 0) > 0;
      expect(hasGroundTruth).toBe(true);
    }
  });

  it("creates a rare-term disambiguation query built from terms unique to the target entry", () => {
    const queries = generateSyntheticQueries(CORPUS);
    // For each entry there should be a rare/cross-project query that targets
    // it alone, built only from tokens present in that entry's content.
    for (const [entryId, content] of [
      ["e-atlas", "Atlas phase two migration to sqlite wal storage engine underway"],
      ["e-oauth", "OAuth pkce authentication decision finalized for mobile clients"],
    ] as const) {
      const q = queries.find(
        (x) =>
          (x.category === "cross-project" || x.notes?.includes("rare-term")) &&
          x.expected_ids?.length === 1 &&
          x.expected_ids[0] === entryId,
      );
      expect(q, `rare-term query for ${entryId}`).toBeDefined();
      const contentTokens = new Set(tokenize(content));
      for (const term of q!.query.split(" ")) {
        expect(contentTokens.has(term)).toBe(true);
      }
    }
  });

  it("creates a tag-search query from a distinctive tag", () => {
    const queries = generateSyntheticQueries(CORPUS);
    const tagQ = queries.find((q) => q.category === "tag-search");
    expect(tagQ).toBeDefined();
    expect(tagQ!.expected_ids).toContain("e-oauth");
  });

  it("is deterministic — same corpus yields identical output", () => {
    expect(generateSyntheticQueries(CORPUS)).toEqual(generateSyntheticQueries(CORPUS));
  });

  it("does not emit duplicate ids", () => {
    const ids = generateSyntheticQueries(CORPUS).map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
