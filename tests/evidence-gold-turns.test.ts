import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenSession, makeSyntheticEntryId } from "../benchmark/adapters/longmemeval/build.js";
import { prepareGoldTurns, prepareGoldTurnsCli, validateGoldTurns, type GoldTurnSourceBindings } from "../benchmark/evidence-metric/gold-turns.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const shaBytes = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const query = { id: "longmemeval-s-q1", expected_ids: [makeSyntheticEntryId("s", "q1", "session_1")] };
const messages = [
  { role: "user", content: "  What is 東京?\nPlease tell me.  ", has_answer: true },
  { role: "assistant", content: "  It is a city.\n  ", has_answer: false },
  { role: "user", content: "A second labeled turn.", has_answer: true },
];
const content = flattenSession("session_1", "2023/01/02", messages);
const entries = new Map([[query.expected_ids[0]!, { content }]]);
const raw = [{
  question_id: "q1", answer_session_ids: ["session_1"], haystack_session_ids: ["session_1"],
  haystack_dates: ["2023/01/02"], haystack_sessions: [messages],
}];
const bindings: GoldTurnSourceBindings = { dataset_sha256: sha("dataset"), snapshot_sha256: sha("snapshot"), queries_sha256: sha("queries") };

describe("LongMemEval gold-turn artifact", () => {
  it("prepares exact UTF-16 message ranges and validates them", () => {
    const artifact = prepareGoldTurns(raw, [query], entries, bindings);
    expect(artifact).toEqual({
      schema_version: 1, coordinate_system: "utf16_code_units", source: bindings,
      queries: [{ query_id: query.id, entries: [{ entry_id: query.expected_ids[0], content_sha256: sha(content), turns: [
        { message_index: 0, start: content.indexOf("What is 東京?\nPlease tell me."), end: content.indexOf("What is 東京?\nPlease tell me.") + "What is 東京?\nPlease tell me.".length },
        { message_index: 2, start: content.indexOf("A second labeled turn."), end: content.indexOf("A second labeled turn.") + "A second labeled turn.".length },
      ] }] }],
    });
    expect(validateGoldTurns(artifact, [query], entries, bindings).queriesById.get(query.id)?.entries[0]?.turns).toHaveLength(2);
  });

  it("includes expected entries without labels as empty turn lists", () => {
    const unlabelled = messages.map((message) => ({ ...message, has_answer: false }));
    const item = [{ ...raw[0]!, haystack_sessions: [unlabelled] }];
    const unlabelledContent = flattenSession("session_1", "2023/01/02", unlabelled);
    const artifact = prepareGoldTurns(item, [query], new Map([[query.expected_ids[0]!, { content: unlabelledContent }]]), bindings);
    expect(artifact.queries[0]?.entries[0]?.turns).toEqual([]);
  });

  it("binds raw messages by order even when message text resembles a later role line", () => {
    const trickyMessages = [
      { role: "user", content: "intro\nassistant: repeated text", has_answer: true },
      { role: "assistant", content: "repeated text", has_answer: true },
    ];
    const trickyContent = flattenSession("session_1", "2023/01/02", trickyMessages);
    const item = [{ ...raw[0]!, haystack_sessions: [trickyMessages] }];
    const artifact = prepareGoldTurns(item, [query], new Map([[query.expected_ids[0]!, { content: trickyContent }]]), bindings);
    const turns = artifact.queries[0]!.entries[0]!.turns;
    expect(trickyContent.slice(turns[0]!.start, turns[0]!.end)).toBe(trickyMessages[0]!.content.trim());
    expect(trickyContent.slice(turns[1]!.start, turns[1]!.end)).toBe(trickyMessages[1]!.content.trim());
  });

  it("allows duplicate non-gold haystack sessions while binding the unique expected session", () => {
    const ignored = [{ role: "user", content: "unlabeled" }];
    const item = [{ ...raw[0]!, haystack_session_ids: ["extra", "extra", "session_1"],
      haystack_dates: ["2023/01/01", "2023/01/01", "2023/01/02"], haystack_sessions: [ignored, ignored, messages] }];
    expect(() => prepareGoldTurns(item, [query], entries, bindings)).not.toThrow();
  });

  it("creates an exclusive artifact from real files without mutating the snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-gold-turns-"));
    try {
      const rawPath = join(dir, "raw.json"); const queryPath = join(dir, "queries.jsonl"); const snapshotPath = join(dir, "snapshot.db"); const outputPath = join(dir, "gold.json");
      const rawItem = [{ ...raw[0]!, answer_session_ids: ["session_1"] }];
      writeFileSync(rawPath, JSON.stringify(rawItem)); writeFileSync(queryPath, `${JSON.stringify(query)}\n`);
      const db = new Database(snapshotPath);
      db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
      db.prepare("INSERT INTO entries (id, content) VALUES (?, ?)").run(query.expected_ids[0], content);
      db.close();
      const snapshotSha = shaBytes(readFileSync(snapshotPath));
      prepareGoldTurnsCli(["--raw", rawPath, "--queries", queryPath, "--snapshot", snapshotPath, "--out", outputPath], shaBytes(readFileSync(rawPath)));
      expect(existsSync(outputPath)).toBe(true);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(shaBytes(readFileSync(snapshotPath))).toBe(snapshotSha);
      expect(["-wal", "-shm", "-journal"].some((suffix) => existsSync(snapshotPath + suffix))).toBe(false);
      expect(() => prepareGoldTurnsCli(["--raw", rawPath, "--queries", queryPath, "--snapshot", snapshotPath, "--out", rawPath], shaBytes(readFileSync(rawPath)))).toThrow(/alias/);
      expect(() => prepareGoldTurnsCli(["--raw", rawPath, "--queries", queryPath, "--snapshot", snapshotPath, "--out", outputPath], shaBytes(readFileSync(rawPath)))).toThrow(/overwrite/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["existing file", "dangling symlink"])("refuses an output collision (%s) without altering sources or targets", (collision) => {
    const dir = mkdtempSync(join(tmpdir(), "munin-gold-collision-"));
    try {
      const rawPath = join(dir, "raw.json"); const queryPath = join(dir, "queries.jsonl"); const snapshotPath = join(dir, "snapshot.db"); const outputPath = join(dir, "gold.json");
      writeFileSync(rawPath, JSON.stringify(raw)); writeFileSync(queryPath, `${JSON.stringify(query)}\n`);
      const db = new Database(snapshotPath);
      db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
      db.prepare("INSERT INTO entries (id, content) VALUES (?, ?)").run(query.expected_ids[0], content);
      db.close();
      const inputPaths = [rawPath, queryPath, snapshotPath];
      const originalBytes = inputPaths.map((path) => readFileSync(path));
      const missingTarget = join(dir, "must-stay-absent.json");
      if (collision === "existing file") writeFileSync(outputPath, "preserve existing artifact\n");
      else symlinkSync(missingTarget, outputPath);
      expect(() => prepareGoldTurnsCli(["--raw", rawPath, "--queries", queryPath, "--snapshot", snapshotPath, "--out", outputPath], shaBytes(originalBytes[0]!))).toThrow("Output already exists; refusing overwrite");
      inputPaths.forEach((path, index) => expect(readFileSync(path).equals(originalBytes[index]!)).toBe(true));
      if (collision === "existing file") expect(readFileSync(outputPath, "utf8")).toBe("preserve existing artifact\n");
      else {
        expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(outputPath)).toBe(missingTarget);
        expect(existsSync(missingTarget)).toBe(false);
      }
      expect(["-wal", "-shm", "-journal"].some((suffix) => existsSync(snapshotPath + suffix))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses snapshots with sidecars before opening SQLite", () => {
    const dir = mkdtempSync(join(tmpdir(), "munin-gold-sidecar-"));
    try {
      const rawPath = join(dir, "raw.json"); const queryPath = join(dir, "queries.jsonl"); const snapshotPath = join(dir, "snapshot.db"); const outputPath = join(dir, "gold.json");
      writeFileSync(rawPath, "[]"); writeFileSync(queryPath, "{}\n"); writeFileSync(snapshotPath, "snapshot"); writeFileSync(`${snapshotPath}-wal`, "keep");
      expect(() => prepareGoldTurnsCli(["--raw", rawPath, "--queries", queryPath, "--snapshot", snapshotPath, "--out", outputPath], shaBytes(Buffer.from("[]")))).toThrow(/sidecar/);
      expect(readFileSync(snapshotPath, "utf8")).toBe("snapshot"); expect(readFileSync(`${snapshotPath}-wal`, "utf8")).toBe("keep");
      expect(existsSync(outputPath)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ["mismatched flattened content", new Map([[query.expected_ids[0]!, { content: `${content}!` }]])],
    ["missing expected entry", new Map<string, { content: string }>()],
  ])("rejects %s", (_label, suppliedEntries) => {
    expect(() => prepareGoldTurns(raw, [query], suppliedEntries, bindings)).toThrow();
  });

  it("rejects tampered offsets, hashes, ranges, and query coverage", () => {
    const artifact = prepareGoldTurns(raw, [query], entries, bindings);
    const offset = structuredClone(artifact);
    offset.queries[0]!.entries[0]!.turns[0]!.end += 1;
    expect(() => validateGoldTurns(offset, [query], entries, bindings)).toThrow();
    const digest = structuredClone(artifact);
    digest.queries[0]!.entries[0]!.content_sha256 = sha("wrong");
    expect(() => validateGoldTurns(digest, [query], entries, bindings)).toThrow();
    const overlap = structuredClone(artifact);
    overlap.queries[0]!.entries[0]!.turns[1]!.start -= 1;
    expect(() => validateGoldTurns(overlap, [query], entries, bindings)).toThrow();
    expect(() => validateGoldTurns({ ...artifact, queries: [] }, [query], entries, bindings)).toThrow();
  });

  it("requires the source pins and strict artifact shape", () => {
    const artifact = prepareGoldTurns(raw, [query], entries, bindings);
    expect(() => validateGoldTurns({ ...artifact, extra: true }, [query], entries, bindings)).toThrow();
    expect(() => validateGoldTurns(artifact, [query], entries, { ...bindings, snapshot_sha256: "bad" })).toThrow();
  });
});
