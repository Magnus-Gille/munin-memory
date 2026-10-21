#!/usr/bin/env node
/** Label-free UTF-16 message boundaries for the complete LongMemEval-S session corpus. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { flattenSession, makeSyntheticEntryId, type LongMemEvalMessage } from "../adapters/longmemeval/build.js";

export type MessageBoundaryTuple = [number, number, number];
export interface MessageBoundaryEntry {
  entry_id: string;
  content_sha256: string;
  prefix_end: number;
  messages: MessageBoundaryTuple[];
}
export interface MessageBoundarySourceBindings { dataset_sha256: string; snapshot_sha256: string }
export interface MessageBoundaryArtifact {
  schema_version: 1;
  coordinate_system: "utf16_code_units";
  source: MessageBoundarySourceBindings;
  entries: MessageBoundaryEntry[];
}

const HASHED_DATASET_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";

interface RawLongMemEvalQuestion {
  question_id: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalMessage[][];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unexpected fields`);
  }
}

function validateBindings(value: MessageBoundarySourceBindings): MessageBoundarySourceBindings {
  const bindings = object(value, "Source bindings");
  exactKeys(bindings, ["dataset_sha256", "snapshot_sha256"], "Source bindings");
  for (const key of ["dataset_sha256", "snapshot_sha256"] as const) {
    if (typeof bindings[key] !== "string" || !/^[a-f0-9]{64}$/.test(bindings[key] as string)) {
      throw new Error(`${key} must be a lowercase SHA-256 digest`);
    }
  }
  return bindings as unknown as MessageBoundarySourceBindings;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contentFor(entries: ReadonlyMap<string, { content: string }>, id: string): string | undefined {
  const value = entries.get(id);
  return value && typeof value.content === "string" ? value.content : undefined;
}

function isSurrogateBoundary(content: string, offset: number): boolean {
  return offset <= 0 || offset >= content.length
    || !(/[\uD800-\uDBFF]/.test(content[offset - 1]!) && /[\uDC00-\uDFFF]/.test(content[offset]!));
}

function rangeError(entryId: string): Error {
  return new Error(`Invalid message boundaries for ${entryId}`);
}

function validateEntry(entry: MessageBoundaryEntry, content: string): void {
  if (entry.content_sha256 !== digest(content)) throw new Error(`Snapshot content hash mismatch for ${entry.entry_id}`);
  if (!Number.isSafeInteger(entry.prefix_end) || entry.prefix_end < 0 || entry.prefix_end > content.length
    || !isSurrogateBoundary(content, entry.prefix_end)) throw rangeError(entry.entry_id);

  if (!Array.isArray(entry.messages)) throw rangeError(entry.entry_id);
  if (entry.messages.length === 0) {
    if (entry.prefix_end !== content.length || !content.slice(0, entry.prefix_end).endsWith("Conversation:")) throw rangeError(entry.entry_id);
    return;
  }
  if (entry.prefix_end < 1 || content[entry.prefix_end - 1] !== "\n"
    || !content.slice(0, entry.prefix_end - 1).endsWith("Conversation:")) throw rangeError(entry.entry_id);

  let previousEnd = -1;
  for (let index = 0; index < entry.messages.length; index += 1) {
    const tuple = entry.messages[index];
    if (!Array.isArray(tuple) || tuple.length !== 3) throw rangeError(entry.entry_id);
    const [start, contentStart, end] = tuple;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(contentStart) || !Number.isSafeInteger(end)
      || start < 0 || contentStart < start || end < contentStart || end > content.length
      || (index === 0 ? start !== entry.prefix_end : start !== previousEnd + 1)
      || !isSurrogateBoundary(content, start) || !isSurrogateBoundary(content, contentStart) || !isSurrogateBoundary(content, end)) {
      throw rangeError(entry.entry_id);
    }
    const rolePrefix = content.slice(start, contentStart);
    if (!rolePrefix.endsWith(": ") || rolePrefix.includes("\n") || rolePrefix.includes("\r")) throw rangeError(entry.entry_id);
    if (index === entry.messages.length - 1 ? end !== content.length : content[end] !== "\n") throw rangeError(entry.entry_id);
    previousEnd = end;
  }
}

/** Validate one boundary record against the content before a consumer uses its offsets. */
export function validateMessageBoundaryEntry(entry: MessageBoundaryEntry, content: string): void {
  validateEntry(entry, content);
}

/** Validate canonical all-corpus coverage and content/offset bindings against the frozen snapshot. */
export function validateMessageBoundaries(
  value: unknown,
  entriesById: ReadonlyMap<string, { content: string }>,
  sourceBindings: MessageBoundarySourceBindings,
): { artifact: MessageBoundaryArtifact; entriesById: ReadonlyMap<string, MessageBoundaryEntry> } {
  const pins = validateBindings(sourceBindings);
  const root = object(value, "Message-boundary artifact");
  exactKeys(root, ["schema_version", "coordinate_system", "source", "entries"], "Message-boundary artifact");
  if (root.schema_version !== 1 || root.coordinate_system !== "utf16_code_units") {
    throw new Error("Unsupported message-boundary artifact schema/coordinate system");
  }
  const source = validateBindings(root.source as MessageBoundarySourceBindings);
  for (const key of ["dataset_sha256", "snapshot_sha256"] as const) {
    if (source[key] !== pins[key]) throw new Error(`Message-boundary ${key} source pin mismatch`);
  }
  if (!Array.isArray(root.entries) || root.entries.length !== entriesById.size) {
    throw new Error("Message-boundary entries must exactly cover the snapshot corpus");
  }

  const normalized: MessageBoundaryEntry[] = [];
  const byId = new Map<string, MessageBoundaryEntry>();
  let priorId: string | undefined;
  for (const rawEntry of root.entries) {
    const candidate = object(rawEntry, "Message-boundary entry");
    exactKeys(candidate, ["entry_id", "content_sha256", "prefix_end", "messages"], "Message-boundary entry");
    if (typeof candidate.entry_id !== "string" || !candidate.entry_id
      || (priorId !== undefined && candidate.entry_id <= priorId)) {
      throw new Error("Message-boundary entries must have unique IDs in ascending order");
    }
    const entry: MessageBoundaryEntry = {
      entry_id: candidate.entry_id,
      content_sha256: candidate.content_sha256 as string,
      prefix_end: candidate.prefix_end as number,
      messages: candidate.messages as MessageBoundaryTuple[],
    };
    const content = contentFor(entriesById, entry.entry_id);
    if (content === undefined) throw new Error(`Snapshot entry missing for message-boundary annotation ${entry.entry_id}`);
    if (typeof entry.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.content_sha256)) {
      throw new Error("content_sha256 must be a lowercase SHA-256 digest");
    }
    validateEntry(entry, content);
    normalized.push(entry);
    byId.set(entry.entry_id, entry);
    priorId = entry.entry_id;
  }
  for (const id of entriesById.keys()) {
    if (!byId.has(id)) throw new Error(`Missing message-boundary entry for ${id}`);
  }

  const artifact: MessageBoundaryArtifact = {
    schema_version: 1,
    coordinate_system: "utf16_code_units",
    source: pins,
    entries: normalized,
  };
  return { artifact, entriesById: byId };
}

function canonicalCorpus(rawData: unknown): Map<string, { sessionId: string; sessionDate?: string; messages: LongMemEvalMessage[] }> {
  if (!Array.isArray(rawData)) throw new Error("Raw LongMemEval dataset must be an array");
  const corpus = new Map<string, { sessionId: string; sessionDate?: string; messages: LongMemEvalMessage[] }>();
  const questions = new Set<string>();
  const segmentToQuestion = new Map<string, string>();

  for (const rawQuestion of rawData) {
    const question = object(rawQuestion, "Raw LongMemEval question") as unknown as RawLongMemEvalQuestion;
    const { question_id: questionId, haystack_session_ids: sessionIds, haystack_dates: dates, haystack_sessions: sessions } = question;
    if (typeof questionId !== "string" || !questionId || questions.has(questionId)
      || !Array.isArray(sessionIds) || !Array.isArray(dates) || !Array.isArray(sessions)
      || sessionIds.length !== dates.length || sessionIds.length !== sessions.length) {
      throw new Error("Malformed or duplicate raw question/session binding");
    }
    questions.add(questionId);
    const questionSegment = questionId.replace(/[^a-zA-Z0-9_-]+/g, "-");
    const collidingQuestion = segmentToQuestion.get(questionSegment);
    if (collidingQuestion !== undefined && collidingQuestion !== questionId) {
      throw new Error(`Question ID normalization collision for ${questionId}`);
    }
    segmentToQuestion.set(questionSegment, questionId);

    const seenSessions = new Set<string>();
    for (let index = 0; index < sessionIds.length; index += 1) {
      const sessionId = sessionIds[index];
      const sessionDate = dates[index];
      const messages = sessions[index];
      if (typeof sessionId !== "string" || !sessionId || (sessionDate !== undefined && typeof sessionDate !== "string")
        || !Array.isArray(messages)) throw new Error(`Malformed source session for ${questionId}`);
      if (seenSessions.has(sessionId)) continue;
      seenSessions.add(sessionId);
      for (const message of messages) {
        if (!message || typeof message.role !== "string" || typeof message.content !== "string") {
          throw new Error(`Malformed source message for ${questionId}/${sessionId}`);
        }
      }
      const entryId = makeSyntheticEntryId("s", questionId, sessionId);
      if (corpus.has(entryId)) throw new Error(`Duplicate synthetic entry ID ${entryId}`);
      corpus.set(entryId, { sessionId, ...(sessionDate === undefined ? {} : { sessionDate }), messages });
    }
  }
  return corpus;
}

/** Build boundaries from source message arrays only; answer labels and gold IDs are never read. */
export function prepareMessageBoundaries(
  rawData: unknown,
  entriesById: ReadonlyMap<string, { content: string }>,
  sourceBindings: MessageBoundarySourceBindings,
): MessageBoundaryArtifact {
  const pins = validateBindings(sourceBindings);
  const corpus = canonicalCorpus(rawData);
  if (corpus.size !== entriesById.size) throw new Error("Raw dataset and snapshot must exactly cover the same corpus entries");

  const entries: MessageBoundaryEntry[] = [];
  for (const entryId of [...corpus.keys()].sort()) {
    const session = corpus.get(entryId)!;
    const content = contentFor(entriesById, entryId);
    if (content === undefined) throw new Error(`Snapshot entry missing for ${entryId}`);
    const flattened = flattenSession(session.sessionId, session.sessionDate, session.messages);
    if (flattened !== content) throw new Error(`flattenSession content mismatch for ${entryId}`);

    const header = [`Session ID: ${session.sessionId}`];
    if (session.sessionDate) header.push(`Session Date: ${session.sessionDate}`);
    header.push("Conversation:");
    const headerLength = header.join("\n").length;
    const prefixEnd = session.messages.length > 0 ? headerLength + 1 : headerLength;
    let cursor = prefixEnd;
    const messages: MessageBoundaryTuple[] = [];
    for (let index = 0; index < session.messages.length; index += 1) {
      const message = session.messages[index]!;
      const role = message.role || "unknown";
      const start = cursor;
      const contentStart = start + role.length + 2;
      const end = contentStart + message.content.trim().length;
      messages.push([start, contentStart, end]);
      cursor = end + (index < session.messages.length - 1 ? 1 : 0);
    }
    entries.push({ entry_id: entryId, content_sha256: digest(content), prefix_end: prefixEnd, messages });
  }

  return validateMessageBoundaries({
    schema_version: 1,
    coordinate_system: "utf16_code_units",
    source: pins,
    entries,
  }, entriesById, pins).artifact;
}

function hashFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, count));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function absoluteRegularFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return realpathSync(path);
}

function parseArgs(argv: string[]): { raw: string; snapshot: string; out: string } {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--raw" && flag !== "--snapshot" && flag !== "--out") throw new Error("Expected --raw, --snapshot, and --out options");
    const value = argv[++index];
    const key = flag.slice(2);
    if (!value || value.startsWith("--") || args[key]) throw new Error(`Invalid or duplicate option ${flag}`);
    args[key] = value;
  }
  if (!args.raw || !args.snapshot || !args.out) throw new Error("Required options: --raw, --snapshot, --out");
  if (![args.raw, args.snapshot, args.out].every(isAbsolute)) throw new Error("--raw, --snapshot, and --out must be absolute paths");
  return { raw: resolve(args.raw), snapshot: resolve(args.snapshot), out: resolve(args.out) };
}

function readSnapshotEntries(snapshotPath: string): Map<string, { content: string }> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(snapshotPath + suffix)) throw new Error(`Snapshot has a SQLite sidecar: ${suffix}`);
  }
  const fd = openSync(snapshotPath, "r");
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) !== 100
      || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
      || header[18] !== 1 || header[19] !== 1) throw new Error("Snapshot must be a detached DELETE-mode SQLite file");
  } finally {
    closeSync(fd);
  }
  const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const rows = db.prepare("SELECT id, content FROM entries ORDER BY id").all() as Array<{ id: string; content: string }>;
    const result = new Map<string, { content: string }>();
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.content !== "string" || result.has(row.id)) {
        throw new Error("Snapshot contains malformed or duplicate entries");
      }
      result.set(row.id, { content: row.content });
    }
    return result;
  } finally {
    db.close();
  }
}

function outputPath(path: string, inputs: string[]): string {
  const output = resolve(path);
  const parent = dirname(output);
  let current = parent;
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error("Output path cannot use symlink parents");
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  if (!statSync(parent).isDirectory()) throw new Error("Output parent must be a directory");
  const canonical = resolve(realpathSync(parent), output.slice(parent.length + 1));
  if (inputs.includes(canonical) || inputs.includes(output)) throw new Error("Output must not alias an input");
  return canonical;
}

export function prepareMessageBoundariesCli(
  argv = process.argv.slice(2),
  pinnedDatasetSha256 = HASHED_DATASET_SHA256,
): void {
  const options = parseArgs(argv);
  const rawPath = absoluteRegularFile(options.raw, "Raw dataset");
  const snapshotPath = absoluteRegularFile(options.snapshot, "Snapshot");
  const outPath = outputPath(options.out, [rawPath, snapshotPath]);
  const rawBytes = readFileSync(rawPath);
  const datasetSha = createHash("sha256").update(rawBytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(pinnedDatasetSha256) || datasetSha !== pinnedDatasetSha256) {
    throw new Error("Raw LongMemEval dataset SHA-256 does not match the pinned public source");
  }
  const snapshotSha = hashFile(snapshotPath);
  const entriesById = readSnapshotEntries(snapshotPath);
  const artifact = prepareMessageBoundaries(JSON.parse(rawBytes.toString("utf8")) as unknown, entriesById, {
    dataset_sha256: datasetSha,
    snapshot_sha256: snapshotSha,
  });
  if (hashFile(rawPath) !== datasetSha || hashFile(snapshotPath) !== snapshotSha) {
    throw new Error("An input changed while message boundaries were being prepared");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(snapshotPath + suffix)) throw new Error(`Snapshot has a SQLite sidecar: ${suffix}`);
  }
  const bytes = `${JSON.stringify(artifact)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(outPath, "wx", 0o600);
    writeFileSync(fd, bytes, "utf8");
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Output already exists; refusing to overwrite", { cause: error });
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    prepareMessageBoundariesCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
