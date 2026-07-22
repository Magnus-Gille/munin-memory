import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  buildLongMemEvalArtifacts,
  convertLongMemEvalDataset,
  LONGMEMEVAL_ARTIFACT_SCHEMA_VERSION,
  makeSyntheticEntryId,
  makeSyntheticRoundEntryId,
  normalizeNsSegment,
} from "../benchmark/adapters/longmemeval/build.js";
import { canReuseExistingArtifacts } from "../benchmark/adapters/longmemeval/run.js";
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

describe("normalizeNsSegment", () => {
  it("replaces slashes and special chars with hyphens", () => {
    expect(normalizeNsSegment("a/b")).toBe("a-b");
    expect(normalizeNsSegment("a-b")).toBe("a-b");
    expect(normalizeNsSegment("q 001")).toBe("q-001");
  });

  it("collision guard: throws when two question_ids normalize to the same segment", () => {
    // "a/b" and "a-b" both normalize to "a-b" — that would silently merge their haystacks.
    const item1: LongMemEvalItem = {
      question_id: "a/b",
      question_type: "single-session-user",
      question: "Q1?",
      answer: "A1",
      question_date: "2023/01/01 00:00",
      answer_session_ids: [],
      haystack_session_ids: [],
      haystack_sessions: [],
      haystack_dates: [],
    };
    const item2: LongMemEvalItem = {
      question_id: "a-b",
      question_type: "single-session-user",
      question: "Q2?",
      answer: "A2",
      question_date: "2023/01/01 00:00",
      answer_session_ids: [],
      haystack_session_ids: [],
      haystack_sessions: [],
      haystack_dates: [],
    };

    expect(() => convertLongMemEvalDataset([item1, item2], "test")).toThrow(
      /normalizeNsSegment collision/,
    );
  });
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

  it("preserves every gold answer and question date as structured query metadata", () => {
    const items = loadFixture();
    const result = convertLongMemEvalDataset(items, "s");

    expect(result.queries).toHaveLength(items.length);
    for (const [index, query] of result.queries.entries()) {
      expect(query.reference_answer).toBe(String(items[index].answer));
      expect(query.question_date).toBe(items[index].question_date);
      expect(query.notes).not.toContain("answer=");
    }
  });

  it("normalizes numeric gold answers for the answer-quality harness", () => {
    const item = structuredClone(loadFixture()[0]);
    item.answer = 42;

    const result = convertLongMemEvalDataset([item], "s");

    expect(result.queries[0].reference_answer).toBe("42");
  });

  it("keeps has_answer ground-truth labels out of model-visible corpus content", () => {
    const sessionResult = convertLongMemEvalDataset(loadFixture(), "s", "session");
    const roundResult = convertLongMemEvalDataset(loadFixture(), "s", "round");

    for (const entry of [...sessionResult.entries, ...roundResult.entries]) {
      expect(entry.content).not.toContain("has_answer");
    }
  });

  it("uses has_answer only to select evidence rounds, never as model-visible text", () => {
    const item = structuredClone(loadFixture()[0]);
    item.haystack_sessions[1] = [
      { role: "user", content: "Distractor round", has_answer: false },
      { role: "assistant", content: "No answer here", has_answer: false },
      { role: "user", content: "The actual evidence", has_answer: true },
      { role: "assistant", content: "Confirmed evidence", has_answer: true },
    ];

    const result = convertLongMemEvalDataset([item], "s", "round");

    expect(result.queries[0].expected_ids).toEqual([
      makeSyntheticRoundEntryId("s", item.question_id, item.answer_session_ids[0], 1),
    ]);
    expect(result.entries.every((entry) => !entry.content.includes("has_answer"))).toBe(true);
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

  it("versions generated artifacts and invalidates reuse when source bytes change", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-longmemeval-reuse-"));
    tempDirs.push(dir);
    const inputPath = join(dir, "input.json");
    const dbPath = join(dir, "longmemeval-s.db");
    const queryPath = join(dir, "longmemeval-s.jsonl");
    const provenancePath = join(dir, "longmemeval-s.provenance.json");
    writeFileSync(inputPath, JSON.stringify(loadFixture()), "utf-8");

    buildLongMemEvalArtifacts({
      split: "s",
      inputPath,
      dbPath,
      queryPath,
      provenancePath,
    });
    const metadata = JSON.parse(readFileSync(provenancePath, "utf-8"));
    const options = {
      split: "s",
      granularity: "session" as const,
      searchMode: "lexical" as const,
      inputPath,
      dbPath,
      queryPath,
      provenancePath,
      reportDir: dir,
      reuseExisting: true,
      runnerMode: "raw" as const,
    };

    expect(metadata.artifact_schema_version).toBe(LONGMEMEVAL_ARTIFACT_SCHEMA_VERSION);
    expect(metadata.input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canReuseExistingArtifacts(options, metadata)).toBe(true);

    const staleMetadata = {
      ...metadata,
      artifact_schema_version: LONGMEMEVAL_ARTIFACT_SCHEMA_VERSION + 1,
    };
    expect(canReuseExistingArtifacts(options, staleMetadata)).toBe(false);

    writeFileSync(inputPath, `${JSON.stringify(loadFixture())}\n`, "utf-8");
    expect(canReuseExistingArtifacts(options, metadata)).toBe(false);
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
