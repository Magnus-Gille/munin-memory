import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  buildLongMemEvalArtifacts,
  convertLongMemEvalDataset,
  makeSyntheticEntryId,
  makeSyntheticRoundEntryId,
} from "../benchmark/adapters/longmemeval/build.js";
import { queryEntriesLexicalScored } from "../src/db.js";
import type { LongMemEvalItem } from "../benchmark/adapters/longmemeval/build.js";

const fixturePath = join(
  __dirname,
  "..",
  "benchmark",
  "adapters",
  "longmemeval",
  "fixtures",
  "sample-longmemeval.json",
);

function loadFixture(): LongMemEvalItem[] {
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as LongMemEvalItem[];
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("LongMemEval adapter", () => {
  it("converts sample data into stable expected ids", () => {
    const result = convertLongMemEvalDataset(loadFixture(), "s");

    expect(result.stats.item_count).toBe(2);
    expect(result.stats.entry_count).toBe(4);
    expect(result.stats.query_count).toBe(2);
    // 3-arg: (split, questionId, sessionId)
    expect(result.queries[0].expected_ids).toEqual([makeSyntheticEntryId("s", "q-001", "answer_280352e9")]);
    expect(result.queries[1].category).toBe("longmemeval/temporal-reasoning");
    expect(result.queries[0].search_mode).toBe("lexical");
  });

  it("converts sample data into round-granularity evidence ids", () => {
    const result = convertLongMemEvalDataset(loadFixture(), "s", "round");

    expect(result.stats.item_count).toBe(2);
    expect(result.stats.granularity).toBe("round");
    expect(result.stats.entry_count).toBe(4);
    expect(result.stats.query_count).toBe(2);
    // 4-arg: (split, questionId, sessionId, roundIndex)
    expect(result.queries[0].expected_ids).toEqual([makeSyntheticRoundEntryId("s", "q-001", "answer_280352e9", 0)]);
    expect(result.queries[1].expected_ids).toEqual([makeSyntheticRoundEntryId("s", "q-002", "answer_4be1b6b4_1", 0)]);
  });

  it("each query carries a scope_namespace matching its question", () => {
    const result = convertLongMemEvalDataset(loadFixture(), "s");

    expect(result.queries[0].scope_namespace).toBe("benchmarks/longmemeval/s/q/q-001");
    expect(result.queries[1].scope_namespace).toBe("benchmarks/longmemeval/s/q/q-002");
  });

  it("two different questions produce entries in two different namespaces", () => {
    const result = convertLongMemEvalDataset(loadFixture(), "s");

    const ns0 = result.queries[0].scope_namespace!;
    const ns1 = result.queries[1].scope_namespace!;
    expect(ns0).not.toBe(ns1);

    // entries for q-001 are only in ns0
    const q001Entries = result.entries.filter((e) => e.namespace === ns0);
    const q002Entries = result.entries.filter((e) => e.namespace === ns1);
    expect(q001Entries.length).toBeGreaterThan(0);
    expect(q002Entries.length).toBeGreaterThan(0);

    // no entry is in both namespaces
    const q001Ids = new Set(q001Entries.map((e) => e.id));
    const q002Ids = new Set(q002Entries.map((e) => e.id));
    for (const id of q001Ids) {
      expect(q002Ids.has(id)).toBe(false);
    }
  });

  it("builds a synthetic benchmark db that lexical retrieval can query", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-longmemeval-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "longmemeval-s.db");
    const queryPath = join(dir, "longmemeval-s.jsonl");
    const provenancePath = join(dir, "longmemeval-s.provenance.json");

    const result = buildLongMemEvalArtifacts({
      split: "s",
      inputPath: fixturePath,
      dbPath,
      queryPath,
      provenancePath,
    });

    expect(result.stats.query_count).toBe(2);
    expect(readFileSync(queryPath, "utf-8")).toContain("Business Administration degree");

    const db = new Database(dbPath, { readonly: true });
    const hits = queryEntriesLexicalScored(db, {
      query: "Business Administration degree",
      limit: 5,
      includeExpired: true,
    });
    db.close();

    expect(hits.length).toBeGreaterThan(0);
    // 3-arg id: (split, questionId, sessionId)
    expect(hits[0].entry.id).toBe(makeSyntheticEntryId("s", "q-001", "answer_280352e9"));
  });

  it("builds a round-granularity benchmark db that lexical retrieval can query", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-longmemeval-round-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "longmemeval-s-round.db");
    const queryPath = join(dir, "longmemeval-s-round.jsonl");
    const provenancePath = join(dir, "longmemeval-s-round.provenance.json");

    const result = buildLongMemEvalArtifacts({
      split: "s",
      granularity: "round",
      inputPath: fixturePath,
      dbPath,
      queryPath,
      provenancePath,
    });

    expect(result.stats.query_count).toBe(2);
    expect(result.stats.granularity).toBe("round");

    const db = new Database(dbPath, { readonly: true });
    const hits = queryEntriesLexicalScored(db, {
      query: "GPS system not functioning correctly",
      limit: 5,
      includeExpired: true,
    });
    db.close();

    expect(hits.length).toBeGreaterThan(0);
    // 4-arg id: (split, questionId, sessionId, roundIndex)
    expect(hits[0].entry.id).toBe(makeSyntheticRoundEntryId("s", "q-002", "answer_4be1b6b4_1", 0));
  });
});
