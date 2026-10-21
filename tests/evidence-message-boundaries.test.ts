import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { flattenSession, makeSyntheticEntryId, type LongMemEvalMessage } from "../benchmark/adapters/longmemeval/build.js";
import {
  prepareMessageBoundaries,
  prepareMessageBoundariesCli,
  validateMessageBoundaries,
  type MessageBoundaryArtifact,
  type MessageBoundarySourceBindings,
} from "../benchmark/evidence-metric/message-boundaries.js";

const pins: MessageBoundarySourceBindings = { dataset_sha256: "a".repeat(64), snapshot_sha256: "b".repeat(64) };

interface FixtureQuestion {
  question_id: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalMessage[][];
  answer: string;
  answer_session_ids: string[];
}

function fixtureQuestion(): FixtureQuestion {
  return {
    question_id: "q/1",
    haystack_session_ids: ["s-2", "s-1", "s-2"],
    haystack_dates: ["2024/01/02 (Tue) 13:45", "2024/01/03 (Wed) 14:15", "2099/12/31 (Thu) 23:59"],
    haystack_sessions: [
      [
        { role: "user", content: "  Hello 🔬\nassistant: this is still user content  ", has_answer: true },
        { role: "assistant", content: "The literal line says\nuser: hello; keep it intact." },
      ],
      [{ role: "user", content: "Second session." }],
      [{ role: "assistant", content: "This duplicate must be ignored." }],
    ],
    answer: "answer is not an input",
    answer_session_ids: ["s-1"],
  };
}

function snapshotEntries(raw: FixtureQuestion[]): Map<string, { content: string }> {
  const result = new Map<string, { content: string }>();
  for (const question of raw) {
    const seen = new Set<string>();
    for (let index = 0; index < question.haystack_session_ids.length; index += 1) {
      const sessionId = question.haystack_session_ids[index]!;
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      result.set(makeSyntheticEntryId("s", question.question_id, sessionId), {
        content: flattenSession(sessionId, question.haystack_dates[index], question.haystack_sessions[index]!),
      });
    }
  }
  return result;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "munin-message-boundaries-"));
}

function writeSnapshot(path: string, entries: Map<string, { content: string }>): void {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO entries (id, content) VALUES (?, ?)");
    for (const [id, entry] of entries) insert.run(id, entry.content);
  } finally {
    db.close();
  }
}

describe("LongMemEval message-boundary artifact", () => {
  it("builds label-blind, first-occurrence boundaries for every source message", () => {
    const raw = [fixtureQuestion()];
    const entries = snapshotEntries(raw);
    const artifact = prepareMessageBoundaries(raw, entries, pins);
    const changedLabels = structuredClone(raw);
    changedLabels[0]!.answer = "different answer";
    changedLabels[0]!.answer_session_ids = ["s-2"];
    changedLabels[0]!.haystack_sessions[0]![0]!.has_answer = false;
    changedLabels[0]!.haystack_sessions[1]![0]!.has_answer = true;
    expect(prepareMessageBoundaries(changedLabels, entries, pins)).toEqual(artifact);

    expect(artifact.entries.map((entry) => entry.entry_id)).toEqual([...entries.keys()].sort());
    expect(artifact.entries).toHaveLength(2);
    const firstSessionId = makeSyntheticEntryId("s", "q/1", "s-2");
    const first = artifact.entries.find((entry) => entry.entry_id === firstSessionId)!;
    expect(first.messages).toHaveLength(2);
    expect(first.prefix_end).toBe(first.messages[0]![0]);
    expect(entries.get(firstSessionId)!.content.slice(0, first.prefix_end).endsWith("\n")).toBe(true);
    expect(entries.get(firstSessionId)!.content.slice(first.messages[0]![0], first.messages[0]![2]))
      .toBe("user: Hello 🔬\nassistant: this is still user content");
    expect(entries.get(firstSessionId)!.content.slice(first.messages[1]![0], first.messages[1]![2]))
      .toBe("assistant: The literal line says\nuser: hello; keep it intact.");
    expect(first.messages[1]![0]).toBe(first.messages[0]![2] + 1);
    expect(first.messages[0]![2]).toBeLessThan(first.messages[1]![0]);
    const duplicateContent = flattenSession("s-2", "2099/12/31 (Thu) 23:59", raw[0]!.haystack_sessions[2]!);
    expect(entries.get(firstSessionId)!.content).not.toBe(duplicateContent);
  });

  it("supports empty sessions and validates exact ID, hash, tuple, and pin bindings", () => {
    const raw = [fixtureQuestion()];
    raw[0]!.haystack_session_ids.push("empty");
    raw[0]!.haystack_dates.push("2024/01/04 (Thu) 15:00");
    raw[0]!.haystack_sessions.push([]);
    const entries = snapshotEntries(raw);
    const artifact = prepareMessageBoundaries(raw, entries, pins);
    const emptyId = makeSyntheticEntryId("s", "q/1", "empty");
    const empty = artifact.entries.find((entry) => entry.entry_id === emptyId)!;
    expect(empty.messages).toEqual([]);
    expect(empty.prefix_end).toBe(entries.get(emptyId)!.content.length);
    expect(validateMessageBoundaries(artifact, entries, pins).entriesById.size).toBe(3);

    const missing = structuredClone(artifact);
    missing.entries.pop();
    expect(() => validateMessageBoundaries(missing, entries, pins)).toThrow(/exactly cover/);
    const extraSnapshotEntry = new Map(entries);
    extraSnapshotEntry.set("not-in-source", { content: "extra" });
    expect(() => prepareMessageBoundaries(raw, extraSnapshotEntry, pins)).toThrow(/exactly cover/);
    const changedHash = structuredClone(artifact);
    changedHash.entries[0]!.content_sha256 = "c".repeat(64);
    expect(() => validateMessageBoundaries(changedHash, entries, pins)).toThrow(/content hash/);
    const badTuple = structuredClone(artifact);
    badTuple.entries.find((entry) => entry.messages.length > 0)!.messages[0]![1] += 1;
    expect(() => validateMessageBoundaries(badTuple, entries, pins)).toThrow(/Invalid message boundaries/);
    expect(() => validateMessageBoundaries(artifact, entries, { ...pins, dataset_sha256: "c".repeat(64) }))
      .toThrow(/source pin mismatch/);
  });

  it("requires exact flattened source content and accepts UTF-16 safe code-point edges", () => {
    const raw = [fixtureQuestion()];
    const entries = snapshotEntries(raw);
    const id = makeSyntheticEntryId("s", "q/1", "s-2");
    entries.set(id, { content: `${entries.get(id)!.content}!` });
    expect(() => prepareMessageBoundaries(raw, entries, pins)).toThrow(/flattenSession content mismatch/);

    const restored = snapshotEntries(raw);
    const artifact = prepareMessageBoundaries(raw, restored, pins);
    const entry = artifact.entries.find((candidate) => candidate.entry_id === id)!;
    expect(entry.messages.every((tuple) => tuple.every(Number.isSafeInteger))).toBe(true);
    const invalidSplit = structuredClone(artifact);
    const firstTuple = invalidSplit.entries.find((candidate) => candidate.entry_id === id)!.messages[0]!;
    firstTuple[2] -= 1;
    expect(() => validateMessageBoundaries(invalidSplit, restored, pins)).toThrow(/Invalid message boundaries/);
  });

  it("prepares from a detached read-only snapshot, pins both inputs, and writes compact mode-0600 output", () => {
    const directory = tempDir();
    try {
      const rawPath = join(directory, "raw.json");
      const snapshotPath = join(directory, "snapshot.db");
      const outPath = join(directory, "boundaries.json");
      const raw = [fixtureQuestion()];
      const rawBytes = Buffer.from(JSON.stringify(raw));
      writeFileSync(rawPath, rawBytes);
      const entries = snapshotEntries(raw);
      writeSnapshot(snapshotPath, entries);
      const rawHash = hash(readFileSync(rawPath));
      const snapshotHash = hash(readFileSync(snapshotPath));

      prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", outPath], rawHash);

      expect((statSync(outPath).mode & 0o777).toString(8)).toBe("600");
      const saved = JSON.parse(readFileSync(outPath, "utf8")) as MessageBoundaryArtifact;
      expect(saved.entries).toHaveLength(entries.size);
      expect(saved.source).toEqual({ dataset_sha256: rawHash, snapshot_sha256: snapshotHash });
      expect(readFileSync(rawPath)).toEqual(rawBytes);
      expect(hash(readFileSync(snapshotPath))).toBe(snapshotHash);
      expect(existsSync(`${snapshotPath}-wal`)).toBe(false);
      expect(existsSync(`${snapshotPath}-shm`)).toBe(false);
      expect(existsSync(`${snapshotPath}-journal`)).toBe(false);
      expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", outPath], rawHash))
        .toThrow(/already exists/);
      expect(hash(readFileSync(outPath))).toBe(hash(Buffer.from(`${JSON.stringify(saved)}\n`)));
      const wrongPinOutput = join(directory, "wrong-pin.json");
      expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", wrongPinOutput], "c".repeat(64)))
        .toThrow(/pinned public source/);
      expect(existsSync(wrongPinOutput)).toBe(false);
      const changedRawPath = join(directory, "changed-raw.json");
      writeFileSync(changedRawPath, Buffer.concat([rawBytes, Buffer.from(" ")]));
      expect(() => prepareMessageBoundariesCli(["--raw", changedRawPath, "--snapshot", snapshotPath, "--out", join(directory, "changed.json")], rawHash))
        .toThrow(/pinned public source/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects input aliases, symlinks, WAL snapshots, and preserves existing output bytes", () => {
    const directory = tempDir();
    try {
      const rawPath = join(directory, "raw.json");
      const snapshotPath = join(directory, "snapshot.db");
      const outPath = join(directory, "existing.json");
      const raw = [fixtureQuestion()];
      writeFileSync(rawPath, JSON.stringify(raw));
      const entries = snapshotEntries(raw);
      writeSnapshot(snapshotPath, entries);
      const rawHash = hash(readFileSync(rawPath));
      const snapshotHash = hash(readFileSync(snapshotPath));
      const sentinel = Buffer.from("preserve me\n");
      writeFileSync(outPath, sentinel);
      expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", rawPath], rawHash))
        .toThrow(/alias/);
      expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", outPath], rawHash))
        .toThrow(/already exists/);
      expect(readFileSync(outPath)).toEqual(sentinel);

      const symlink = join(directory, "raw-link.json");
      symlinkSync(rawPath, symlink);
      expect(() => prepareMessageBoundariesCli(["--raw", symlink, "--snapshot", snapshotPath, "--out", join(directory, "other.json")], rawHash))
        .toThrow(/regular file/);
      const danglingTarget = join(directory, "missing-target.json");
      const danglingOutput = join(directory, "dangling-output.json");
      symlinkSync(danglingTarget, danglingOutput);
      expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", danglingOutput], rawHash))
        .toThrow(/already exists/);
      expect(existsSync(danglingTarget)).toBe(false);

      writeFileSync(`${snapshotPath}-wal`, "sidecar");
      expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", join(directory, "wal.json")], rawHash))
        .toThrow(/SQLite sidecar/);
      expect(hash(readFileSync(rawPath))).toBe(rawHash);
      expect(hash(readFileSync(snapshotPath))).toBe(snapshotHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects raw dataset mutation during preparation before creating output", () => {
    const directory = tempDir();
    try {
      const rawPath = join(directory, "raw.json");
      const snapshotPath = join(directory, "snapshot.db");
      const outPath = join(directory, "boundaries.json");
      const raw = [fixtureQuestion()];
      const initialRaw = Buffer.from(JSON.stringify(raw));
      writeFileSync(rawPath, initialRaw);
      const entries = snapshotEntries(raw);
      writeSnapshot(snapshotPath, entries);
      const pinnedRawHash = hash(initialRaw);
      const snapshotHash = hash(readFileSync(snapshotPath));
      const originalClose = Database.prototype.close;
      let changed = false;
      const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: InstanceType<typeof Database>) {
        originalClose.call(this);
        if (!changed) {
          changed = true;
          writeFileSync(rawPath, Buffer.concat([initialRaw, Buffer.from(" ")]));
        }
      });
      try {
        expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", outPath], pinnedRawHash))
          .toThrow(/input changed while/);
      } finally {
        closeSpy.mockRestore();
      }
      expect(changed).toBe(true);
      expect(existsSync(outPath)).toBe(false);
      expect(hash(readFileSync(rawPath))).not.toBe(pinnedRawHash);
      expect(hash(readFileSync(snapshotPath))).toBe(snapshotHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a SQLite sidecar created during preparation before creating output", () => {
    const directory = tempDir();
    try {
      const rawPath = join(directory, "raw.json");
      const snapshotPath = join(directory, "snapshot.db");
      const outPath = join(directory, "boundaries.json");
      const walPath = `${snapshotPath}-wal`;
      const raw = [fixtureQuestion()];
      const rawBytes = Buffer.from(JSON.stringify(raw));
      writeFileSync(rawPath, rawBytes);
      const entries = snapshotEntries(raw);
      writeSnapshot(snapshotPath, entries);
      const pinnedRawHash = hash(rawBytes);
      const snapshotHash = hash(readFileSync(snapshotPath));
      const originalClose = Database.prototype.close;
      let created = false;
      const closeSpy = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: InstanceType<typeof Database>) {
        originalClose.call(this);
        if (!created) {
          created = true;
          writeFileSync(walPath, "created during preparation");
        }
      });
      try {
        expect(() => prepareMessageBoundariesCli(["--raw", rawPath, "--snapshot", snapshotPath, "--out", outPath], pinnedRawHash))
          .toThrow(/SQLite sidecar/);
      } finally {
        closeSpy.mockRestore();
      }
      expect(created).toBe(true);
      expect(existsSync(outPath)).toBe(false);
      expect(readFileSync(rawPath)).toEqual(rawBytes);
      expect(hash(readFileSync(snapshotPath))).toBe(snapshotHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
