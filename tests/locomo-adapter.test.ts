import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  buildLocomoArtifacts,
  convertLocomoDataset,
  makeDialogEntryId,
  makeSessionEntryId,
  normalizeDateToIso,
} from "../benchmark/adapters/locomo/build.js";
import { queryEntriesLexicalScored } from "../src/db.js";
import type { LocomoSample } from "../benchmark/adapters/locomo/build.js";

const fixturePath = join(
  __dirname,
  "..",
  "benchmark",
  "adapters",
  "locomo",
  "fixtures",
  "sample-locomo.json",
);

function loadFixture(): LocomoSample[] {
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as LocomoSample[];
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

describe("LoCoMo adapter", () => {
  it("parses LoCoMo-style datetime strings into ISO timestamps", () => {
    expect(normalizeDateToIso("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(normalizeDateToIso("10:15 am on 20 May, 2023")).toBe("2023-05-20T10:15:00.000Z");
    expect(normalizeDateToIso("12:00 am on 1 January, 2024")).toBe("2024-01-01T00:00:00.000Z");
    expect(normalizeDateToIso("12:30 pm on 15 June 2023")).toBe("2023-06-15T12:30:00.000Z");
  });

  it("converts fixture into stable session-level entries and queries", () => {
    const result = convertLocomoDataset(loadFixture(), "session");

    // 3 sessions in the fixture.
    expect(result.stats.sample_count).toBe(1);
    expect(result.stats.entry_count).toBe(3);

    // 5 QAs in the fixture: 1 has no evidence, 1 is adversarial (cat 5).
    // Session mode keeps the remaining 3.
    expect(result.stats.query_count).toBe(3);
    expect(result.stats.skipped_queries_no_evidence).toBe(1);
    expect(result.stats.skipped_queries_adversarial).toBe(1);

    expect(result.queries[0].expected_ids).toEqual([
      makeSessionEntryId("fixture-01", 1),
    ]);
    expect(result.queries[0].category).toBe("locomo/temporal");
    expect(result.queries[0].search_mode).toBe("lexical");

    // Multi-hop crosses sessions 1 and 2 → both should appear.
    expect(result.queries[1].expected_ids).toEqual([
      makeSessionEntryId("fixture-01", 1),
      makeSessionEntryId("fixture-01", 2),
    ]);
    expect(result.queries[1].category).toBe("locomo/multi-hop");
  });

  it("converts fixture into dialog-granularity entries with exact evidence pointers", () => {
    const result = convertLocomoDataset(loadFixture(), "dialog");

    // 3 sessions × their turn counts = 14 dialog entries in the fixture.
    expect(result.stats.granularity).toBe("dialog");
    expect(result.stats.entry_count).toBeGreaterThanOrEqual(13);

    expect(result.queries[0].expected_ids).toEqual([
      makeDialogEntryId("fixture-01", "D1:3"),
    ]);
    expect(result.queries[1].expected_ids).toEqual([
      makeDialogEntryId("fixture-01", "D1:7"),
      makeDialogEntryId("fixture-01", "D2:3"),
    ]);
  });

  it("includes adversarial queries when the flag is set", () => {
    const result = convertLocomoDataset(loadFixture(), "session", "lexical", undefined, true);
    expect(result.stats.skipped_queries_adversarial).toBe(0);
    expect(result.stats.query_count).toBe(4);
    const adversarial = result.queries.find((q) => q.category === "locomo/adversarial");
    expect(adversarial).toBeDefined();
  });

  it("builds a synthetic session-level DB that lexical retrieval can query", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-locomo-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "locomo.db");
    const queryPath = join(dir, "locomo.jsonl");
    const provenancePath = join(dir, "locomo.provenance.json");

    const result = buildLocomoArtifacts({
      granularity: "session",
      searchMode: "lexical",
      inputPath: fixturePath,
      dbPath,
      queryPath,
      provenancePath,
    });

    expect(result.stats.query_count).toBe(3);
    expect(readFileSync(queryPath, "utf-8")).toContain("LGBTQ support group");

    const db = new Database(dbPath, { readonly: true });
    const hits = queryEntriesLexicalScored(db, {
      query: "LGBTQ support group",
      limit: 5,
      includeExpired: true,
    });
    db.close();

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.id).toBe(makeSessionEntryId("fixture-01", 1));
  });

  it("builds a dialog-granularity DB that retrieves the exact evidence turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-locomo-dialog-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "locomo-dialog.db");
    const queryPath = join(dir, "locomo-dialog.jsonl");
    const provenancePath = join(dir, "locomo-dialog.provenance.json");

    buildLocomoArtifacts({
      granularity: "dialog",
      searchMode: "lexical",
      inputPath: fixturePath,
      dbPath,
      queryPath,
      provenancePath,
    });

    const db = new Database(dbPath, { readonly: true });
    const hits = queryEntriesLexicalScored(db, {
      query: "stillness camping inspired",
      limit: 5,
      includeExpired: true,
    });
    db.close();

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.id).toBe(makeDialogEntryId("fixture-01", "D3:2"));
  });
});
