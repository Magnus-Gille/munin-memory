import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  loadQueriesWithSource,
  loadQueries,
  computeQuerySetChecksum,
  crossCheckManifest,
  runBenchmark,
} from "../benchmark/runner.js";
import { initDatabase, writeState } from "../src/db.js";
import type { QuerySetSource, BenchmarkQuery } from "../benchmark/types.js";

const sha256Hex = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");

/**
 * Build a JSONL fixture string from minimal query records. Each line is a
 * fully-typed BenchmarkQuery — the loader rejects rows missing required
 * fields, so the fixture has to include them all.
 */
function jsonl(records: Array<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const SAMPLE_QUERY = {
  id: "q1",
  query: "alpha",
  category: "broad-orientation",
  search_mode: "lexical",
  source: "manual",
};

describe("loadQueriesWithSource", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-instr-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns SHA-256 over the raw bytes, matching shasum -a 256", () => {
    const path = join(tmp, "q.jsonl");
    const text = jsonl([SAMPLE_QUERY]);
    writeFileSync(path, text);
    const expected = sha256Hex(readFileSync(path));

    const { source } = loadQueriesWithSource(path);
    expect(source.sha256).toBe(expected);
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("populates filename, path, bytes, and record_count", () => {
    const path = join(tmp, "queries.jsonl");
    const text = jsonl([SAMPLE_QUERY, { ...SAMPLE_QUERY, id: "q2" }]);
    writeFileSync(path, text);

    const { queries, source } = loadQueriesWithSource(path);
    expect(queries).toHaveLength(2);
    expect(source.filename).toBe("queries.jsonl");
    expect(source.path).toBe(path);
    expect(source.record_count).toBe(2);
    expect(source.bytes).toBe(Buffer.byteLength(text));
    expect(source.manifest_match).toBe("manifest_not_provided");
  });

  it("returns 0 records (not error) for an empty file with the empty-string SHA", () => {
    const path = join(tmp, "empty.jsonl");
    writeFileSync(path, "");
    const { queries, source } = loadQueriesWithSource(path);
    expect(queries).toEqual([]);
    expect(source.record_count).toBe(0);
    expect(source.bytes).toBe(0);
    // SHA-256("") well-known constant
    expect(source.sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("skips blank lines and // comment lines", () => {
    const path = join(tmp, "with-comments.jsonl");
    const text = [
      "// comment header",
      "",
      JSON.stringify(SAMPLE_QUERY),
      "   ",
      JSON.stringify({ ...SAMPLE_QUERY, id: "q2" }),
      "",
    ].join("\n");
    writeFileSync(path, text);

    const { queries, source } = loadQueriesWithSource(path);
    expect(queries.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(source.record_count).toBe(2);
  });

  it("parse-error message includes file:line and SHA prefix", () => {
    const path = join(tmp, "bad.jsonl");
    const text = JSON.stringify(SAMPLE_QUERY) + "\n{ this is not json\n";
    writeFileSync(path, text);
    const sha = sha256Hex(readFileSync(path));

    expect(() => loadQueriesWithSource(path)).toThrow(
      new RegExp(`${path}:2.*sha256=${sha.slice(0, 12)}`),
    );
  });

  it("missing required field message includes id when known and SHA prefix", () => {
    const path = join(tmp, "no-query.jsonl");
    writeFileSync(path, JSON.stringify({ id: "qX", category: "x", search_mode: "lexical" }) + "\n");
    const sha = sha256Hex(readFileSync(path));

    expect(() => loadQueriesWithSource(path)).toThrow(
      new RegExp(`"qX".*"query".*sha256=${sha.slice(0, 12)}`),
    );
  });

  it("loadQueries returns the same query objects without lineage metadata", () => {
    const path = join(tmp, "q.jsonl");
    writeFileSync(path, jsonl([SAMPLE_QUERY]));
    const direct = loadQueries(path);
    const { queries } = loadQueriesWithSource(path);
    expect(direct).toEqual(queries);
  });
});

describe("computeQuerySetChecksum", () => {
  const src = (filename: string, sha: string): QuerySetSource => ({
    path: `/anywhere/${filename}`,
    filename,
    record_count: 1,
    sha256: sha,
    bytes: 100,
    manifest_match: "manifest_not_provided",
  });

  const A = src("a.jsonl", "a".repeat(64));
  const B = src("b.jsonl", "b".repeat(64));

  it("is deterministic across input order", () => {
    expect(computeQuerySetChecksum([A, B])).toBe(computeQuerySetChecksum([B, A]));
  });

  it("changes when any source SHA changes", () => {
    const before = computeQuerySetChecksum([A, B]);
    const Bp = { ...B, sha256: "c".repeat(64) };
    expect(computeQuerySetChecksum([A, Bp])).not.toBe(before);
  });

  it("changes when filename changes even if SHA is unchanged", () => {
    const before = computeQuerySetChecksum([A]);
    const renamed = { ...A, filename: "renamed.jsonl" };
    expect(computeQuerySetChecksum([renamed])).not.toBe(before);
  });

  it("distinguishes 'no sources' from 'one source' at the byte level", () => {
    const empty = computeQuerySetChecksum([]);
    const single = computeQuerySetChecksum([A]);
    expect(empty).not.toBe(single);
    // SHA-256("\n") is the canonical fingerprint of "no sources" under the
    // trailing-newline convention (lines.join("\n") + "\n" with empty
    // lines = "" + "\n" = "\n"). Pinning it ensures the convention is
    // stable across releases.
    expect(empty).toBe(sha256Hex("\n"));
  });

  it("returns a lowercase 64-hex SHA-256", () => {
    expect(computeQuerySetChecksum([A, B])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("crossCheckManifest", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-manifest-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const src = (filename: string, sha: string): QuerySetSource => ({
    path: join(tmp, filename),
    filename,
    record_count: 1,
    sha256: sha,
    bytes: 100,
    manifest_match: "manifest_not_provided",
  });

  it("marks 'matched' on basename+SHA agreement and copies manifest_source_id", () => {
    const sha = "a".repeat(64);
    const manifestPath = join(tmp, "retrieval-v1.manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ sources: [{ id: "pinned-set-1", filename: "q.jsonl", sha256: sha }] }),
    );
    const { updated, warnings } = crossCheckManifest([src("q.jsonl", sha)], manifestPath);

    expect(updated[0].manifest_match).toBe("matched");
    expect(updated[0].manifest_source_id).toBe("pinned-set-1");
    expect(warnings).toEqual([]);
  });

  it("warns and marks 'filename_match_sha_mismatch' when SHA differs", () => {
    const manifestPath = join(tmp, "m.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        sources: [{ id: "pinned-set-1", filename: "q.jsonl", sha256: "a".repeat(64) }],
      }),
    );
    const local = src("q.jsonl", "b".repeat(64));
    const { updated, warnings } = crossCheckManifest([local], manifestPath);

    expect(updated[0].manifest_match).toBe("filename_match_sha_mismatch");
    expect(updated[0].manifest_source_id).toBe("pinned-set-1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/SHA mismatch on q\.jsonl/);
  });

  it("marks 'unmatched' when basename is absent from the manifest", () => {
    const manifestPath = join(tmp, "m.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ sources: [{ id: "x", filename: "other.jsonl", sha256: "a".repeat(64) }] }),
    );
    const { updated, warnings } = crossCheckManifest(
      [src("q.jsonl", "b".repeat(64))],
      manifestPath,
    );

    expect(updated[0].manifest_match).toBe("unmatched");
    expect(updated[0].manifest_source_id).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns once and returns copies when the manifest file is missing", () => {
    const { updated, warnings } = crossCheckManifest(
      [src("q.jsonl", "a".repeat(64))],
      join(tmp, "nope.json"),
    );
    expect(updated[0].manifest_match).toBe("manifest_not_provided");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Manifest cross-check skipped/);
  });

  it("warns and degrades gracefully when the manifest is malformed JSON", () => {
    const manifestPath = join(tmp, "broken.json");
    writeFileSync(manifestPath, "{ not json");
    const { updated, warnings } = crossCheckManifest(
      [src("q.jsonl", "a".repeat(64))],
      manifestPath,
    );
    expect(updated[0].manifest_match).toBe("manifest_not_provided");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/parse error/);
  });

  it("does not mutate the input array", () => {
    const manifestPath = join(tmp, "m.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ sources: [{ id: "x", filename: "q.jsonl", sha256: "a".repeat(64) }] }),
    );
    const input = [src("q.jsonl", "a".repeat(64))];
    const snapshot = JSON.parse(JSON.stringify(input));
    crossCheckManifest(input, manifestPath);
    expect(input).toEqual(snapshot);
  });

  it("matches SHA case-insensitively (manifest uppercase vs file lowercase)", () => {
    const sha = "deadbeef".repeat(8);
    const manifestPath = join(tmp, "m.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ sources: [{ id: "set", filename: "q.jsonl", sha256: sha.toUpperCase() }] }),
    );
    const { updated, warnings } = crossCheckManifest([src("q.jsonl", sha)], manifestPath);
    expect(updated[0].manifest_match).toBe("matched");
    expect(warnings).toEqual([]);
  });
});

describe("runBenchmark (end-to-end report shape)", () => {
  let tmp: string;
  let dbPath: string;
  let queryPath: string;

  // Build a tiny snapshot DB with a handful of state entries whose IDs are
  // pinned so the queries below have meaningful ground truth.
  const ENTRIES: Array<{ namespace: string; key: string; content: string; tags: string[] }> = [
    { namespace: "projects/alpha", key: "status", content: "alpha project active phase", tags: ["status", "active"] },
    { namespace: "projects/alpha", key: "decision", content: "alpha team chose sqlite over postgres", tags: ["decision"] },
    { namespace: "projects/beta", key: "status", content: "beta project blocked waiting on infra", tags: ["status", "blocked"] },
    { namespace: "people/sara", key: "context", content: "sara prefers terse status updates", tags: ["preference"] },
    { namespace: "meta/notes", key: "x", content: "unrelated note about cabbages", tags: [] },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "runner-e2e-"));
    dbPath = join(tmp, "snapshot.db");
    queryPath = join(tmp, "queries.jsonl");

    // Stand up a real schema so the runner can open it readonly.
    const db = initDatabase(dbPath);
    const idMap = new Map<string, string>();
    for (const e of ENTRIES) {
      const r = writeState(db, e.namespace, e.key, e.content, e.tags);
      if (r.status === "success") {
        idMap.set(`${e.namespace}::${e.key}`, r.entry.id);
      }
    }
    db.close();

    // One lexical query per entry → 5 total. Each pins the exact entry id
    // so `expected_ids` is meaningful.
    const queries: BenchmarkQuery[] = [
      {
        id: "alpha-status",
        query: "alpha project active",
        category: "project-status",
        search_mode: "lexical",
        source: "manual",
        expected_ids: [idMap.get("projects/alpha::status")!],
      },
      {
        id: "alpha-decision",
        query: "sqlite postgres",
        category: "decision-lookup",
        search_mode: "lexical",
        source: "manual",
        expected_ids: [idMap.get("projects/alpha::decision")!],
      },
      {
        id: "beta-status",
        query: "beta blocked infra",
        category: "project-status",
        search_mode: "lexical",
        source: "manual",
        expected_ids: [idMap.get("projects/beta::status")!],
      },
      {
        id: "sara-context",
        query: "sara terse updates",
        category: "person-context",
        search_mode: "lexical",
        source: "manual",
        expected_ids: [idMap.get("people/sara::context")!],
      },
      {
        id: "no-hit",
        query: "rutabaga",
        category: "broad-orientation",
        search_mode: "lexical",
        source: "manual",
        expected_ids: ["nonexistent"],
      },
    ];
    writeFileSync(queryPath, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("produces a v2 report whose timing invariants hold (per-query, overall, per-mode)", async () => {
    const { queries, source } = loadQueriesWithSource(queryPath);
    const report = await runBenchmark(dbPath, queries, {
      querySetSources: [source],
      manifestPath: null, // no manifest in this fixture
    });

    // Shape — v3 fields present and consistent.
    expect(report.report_schema_version).toBe(3);
    expect(report.runner_mode).toBe("raw");
    expect(report.snapshot_schema_version).toBeGreaterThan(0);
    expect(report.query_count).toBe(5);
    expect(report.evaluation_count).toBe(5);
    expect(report.query_set_sources).toHaveLength(1);
    expect(report.query_set_sources[0].sha256).toBe(source.sha256);
    expect(report.query_set_checksum).toMatch(/^[0-9a-f]{64}$/);

    // Per-query duration plumbing — every entry finite and non-negative.
    expect(report.queries).toHaveLength(5);
    for (const q of report.queries) {
      expect(Number.isFinite(q.duration_ms)).toBe(true);
      expect(q.duration_ms).toBeGreaterThanOrEqual(0);
    }

    // overall_duration consistency.
    const sumPerQuery = report.queries.reduce((s, q) => s + q.duration_ms, 0);
    // total_ms is rounded to 0.01 ms; allow a tiny tolerance for rounding.
    expect(report.overall_duration.total_ms).toBeCloseTo(sumPerQuery, 1);
    expect(report.overall_duration.p50_ms).not.toBeNull();
    expect(report.overall_duration.p95_ms).not.toBeNull();
    expect(report.overall_duration.p95_ms!).toBeGreaterThanOrEqual(report.overall_duration.p50_ms!);

    // Bucket key alignment: every key in by_search_mode_duration is also
    // a key in by_search_mode and vice versa. Both are bucketed on the
    // *requested* mode, which keeps recall and latency comparable.
    const recallKeys = Object.keys(report.by_search_mode).sort();
    const durationKeys = Object.keys(report.by_search_mode_duration).sort();
    expect(durationKeys).toEqual(recallKeys);
    expect(recallKeys).toEqual(["lexical"]); // sanity for this fixture

    // by_search_mode_duration totals must equal the sum of in-bucket per-query durations.
    const lexicalSum = report.queries
      .filter((q) => q.search_mode === "lexical")
      .reduce((s, q) => s + q.duration_ms, 0);
    expect(report.by_search_mode_duration.lexical.total_ms).toBeCloseTo(lexicalSum, 1);

    // Per-category duration also present and consistent.
    expect(report.by_category.length).toBeGreaterThan(0);
    for (const cat of report.by_category) {
      expect(cat.duration.p50_ms).not.toBeNull();
      expect(cat.duration.p95_ms).not.toBeNull();
      expect(cat.duration.p95_ms!).toBeGreaterThanOrEqual(cat.duration.p50_ms!);
      const inCat = report.queries.filter((q) => {
        const qDef = queries.find((qq) => qq.id === q.query_id)!;
        return qDef.category === cat.category;
      });
      expect(cat.duration.total_ms).toBeCloseTo(
        inCat.reduce((s, q) => s + q.duration_ms, 0),
        1,
      );
    }

    // Scoring fields present (regression guard against scorer/runner drift).
    expect(report.overall.recallAt20).toBeGreaterThanOrEqual(report.overall.recallAt5);
    expect(report.overall.recallAt10).toBeGreaterThanOrEqual(report.overall.recallAt5);
  }, 30_000);

  it("warns when querySetSources is omitted and emits an untracked checksum", async () => {
    const { queries } = loadQueriesWithSource(queryPath);
    const report = await runBenchmark(dbPath, queries, { manifestPath: null });
    expect(report.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringContaining("query_set_sources not tracked"),
      ]),
    );
    expect(report.query_set_sources).toEqual([]);
    // Untracked runs collapse to a known constant — sha256("\n"). Documented
    // in benchmark/README.md and pinned by computeQuerySetChecksum tests above.
    expect(report.query_set_checksum).toBe(sha256Hex("\n"));
  }, 30_000);
});
