#!/usr/bin/env node
/** Optional LongMemEval source annotations. Evaluation consumes only this offsets-only artifact. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { flattenSession, makeSyntheticEntryId, type LongMemEvalItem, type LongMemEvalMessage } from "../adapters/longmemeval/build.js";
import type { BenchmarkQuery } from "../types.js";

export interface GoldTurnRange { message_index: number; start: number; end: number }
export interface GoldTurnEntry { entry_id: string; content_sha256: string; turns: GoldTurnRange[] }
export interface GoldTurnQuery { query_id: string; entries: GoldTurnEntry[] }
export interface GoldTurnSourceBindings { dataset_sha256: string; snapshot_sha256: string; queries_sha256: string }
export interface GoldTurnArtifact {
  schema_version: 1;
  coordinate_system: "utf16_code_units";
  source: GoldTurnSourceBindings;
  queries: GoldTurnQuery[];
}
export interface ValidatedGoldTurns { artifact: GoldTurnArtifact; queriesById: ReadonlyMap<string, GoldTurnQuery> }
export type GoldEntriesById = ReadonlyMap<string, { content: string }> | Readonly<Record<string, { content: string }>>;
type BoundSession = { sessionId: string; sessionDate?: string; messages: LongMemEvalMessage[] };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has missing or unexpected fields`);
}
function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}
function contentFor(entries: GoldEntriesById, id: string): string | undefined {
  const map = entries as ReadonlyMap<string, { content: string }>;
  const value = typeof map.get === "function" ? map.get(id) : (entries as Readonly<Record<string, { content: string }>>)[id];
  return value && typeof value.content === "string" ? value.content : undefined;
}
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function expectedIds(query: BenchmarkQuery): string[] {
  if (!Array.isArray(query.expected_ids)) throw new Error(`Missing expected_ids for ${query.id}`);
  return query.expected_ids;
}
function queryInputs(queries: BenchmarkQuery[]): void {
  if (!Array.isArray(queries) || queries.length === 0) throw new Error("Queries must be a nonempty array");
  const seen = new Set<string>();
  for (const query of queries) {
    if (!query || typeof query.id !== "string" || !query.id) throw new Error("Queries require unique IDs and nonempty unique expected_ids");
    const ids = expectedIds(query);
    if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length
      || seen.has(query.id)) throw new Error("Queries require unique IDs and nonempty unique expected_ids");
    seen.add(query.id);
  }
}
function validateBindings(value: GoldTurnSourceBindings): GoldTurnSourceBindings {
  const bindings = object(value, "Source bindings");
  exactKeys(bindings, ["dataset_sha256", "snapshot_sha256", "queries_sha256"], "Source bindings");
  sha(bindings.dataset_sha256, "dataset_sha256"); sha(bindings.snapshot_sha256, "snapshot_sha256"); sha(bindings.queries_sha256, "queries_sha256");
  return bindings as unknown as GoldTurnSourceBindings;
}
function sessionFor(item: LongMemEvalItem, sessionId: string): BoundSession {
  if (!Array.isArray(item.haystack_session_ids) || !Array.isArray(item.haystack_sessions) || !Array.isArray(item.haystack_dates)
    || item.haystack_session_ids.length !== item.haystack_sessions.length || item.haystack_dates.length !== item.haystack_session_ids.length) {
    throw new Error(`Malformed session arrays for question ${item.question_id}`);
  }
  const positions = item.haystack_session_ids.flatMap((id, index) => id === sessionId ? [index] : []);
  if (positions.length !== 1) throw new Error(`Expected exactly one raw source session ${sessionId} for ${item.question_id}`);
  const index = positions[0]!; const messages = item.haystack_sessions[index]; const sessionDate = item.haystack_dates[index];
  if (!Array.isArray(messages) || (sessionDate !== undefined && typeof sessionDate !== "string")) throw new Error(`Malformed raw source session ${sessionId}`);
  return { sessionId, sessionDate, messages };
}
function rawBindings(rawData: unknown, queries: BenchmarkQuery[]): Map<string, Map<string, BoundSession>> {
  if (!Array.isArray(rawData)) throw new Error("Raw LongMemEval dataset must be an array");
  const items = rawData as LongMemEvalItem[]; const rawByQuestion = new Map<string, LongMemEvalItem>();
  for (const item of items) {
    if (!item || typeof item.question_id !== "string" || !item.question_id || rawByQuestion.has(item.question_id)
      || !Array.isArray(item.answer_session_ids) || item.answer_session_ids.some((id) => typeof id !== "string" || !id)
      || new Set(item.answer_session_ids).size !== item.answer_session_ids.length) throw new Error("Malformed or duplicate raw question/session binding");
    if (!Array.isArray(item.haystack_session_ids) || item.haystack_session_ids.some((id) => typeof id !== "string" || !id)) throw new Error(`Malformed haystack session IDs for ${item.question_id}`);
    rawByQuestion.set(item.question_id, item);
  }
  const result = new Map<string, Map<string, BoundSession>>();
  for (const query of queries) {
    const ids = expectedIds(query);
    const prefix = "longmemeval-s-";
    if (!query.id.startsWith(prefix)) throw new Error(`Unexpected LongMemEval query ID: ${query.id}`);
    const questionId = query.id.slice(prefix.length); const item = rawByQuestion.get(questionId);
    if (!item) throw new Error(`No raw dataset question for ${query.id}`);
    const expected = item.answer_session_ids.map((sessionId) => makeSyntheticEntryId("s", questionId, sessionId));
    if (expected.length !== ids.length || expected.some((id, index) => ids[index] !== id)) {
      throw new Error(`Raw answer sessions do not exactly match expected IDs for ${query.id}`);
    }
    const sessions = new Map<string, BoundSession>();
    for (const [index, entryId] of ids.entries()) sessions.set(entryId, sessionFor(item, item.answer_session_ids[index]!));
    result.set(query.id, sessions);
  }
  if (rawByQuestion.size !== queries.length) throw new Error("Raw dataset and frozen queries must cover the same questions exactly");
  return result;
}
function rangesFor(content: string, session: BoundSession, queryId: string): GoldTurnRange[] {
  const result: GoldTurnRange[] = []; const header = [`Session ID: ${session.sessionId}`];
  if (session.sessionDate) header.push(`Session Date: ${session.sessionDate}`);
  header.push("Conversation:");
  let cursor = header.join("\n").length + 1;
  const { messages } = session;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || typeof message.role !== "string" || typeof message.content !== "string"
      || (message.has_answer !== undefined && typeof message.has_answer !== "boolean")) throw new Error(`Malformed message in ${queryId}`);
    const role = message.role || "unknown"; const trimmed = message.content.trim(); const prefix = `${role}: `;
    const start = cursor + prefix.length; const end = start + trimmed.length;
    if (message.has_answer === true) {
      if (trimmed.length === 0) throw new Error(`Labeled message has empty trimmed content in ${queryId}`);
      result.push({ message_index: messageIndex, start, end });
    }
    cursor = end + (messageIndex < messages.length - 1 ? 1 : 0);
    if (content.slice(start - prefix.length, end) !== prefix + trimmed) throw new Error(`Cannot bind raw message range to flattened source in ${queryId}`);
  }
  return result;
}

/**
 * Validate artifact structure and snapshot binding without reopening the public source dataset.
 * Upstream label truth is established by prepareGoldTurns and bound later by the artifact hash.
 */
export function validateGoldTurns(value: unknown, queries: BenchmarkQuery[], entriesById: GoldEntriesById, sourceBindings: GoldTurnSourceBindings): ValidatedGoldTurns {
  queryInputs(queries); const pins = validateBindings(sourceBindings); const root = object(value, "Gold-turn artifact");
  exactKeys(root, ["schema_version", "coordinate_system", "source", "queries"], "Gold-turn artifact");
  if (root.schema_version !== 1 || root.coordinate_system !== "utf16_code_units") throw new Error("Unsupported gold-turn artifact schema/coordinate system");
  const source = object(root.source, "Artifact source"); exactKeys(source, ["dataset_sha256", "snapshot_sha256", "queries_sha256"], "Artifact source");
  for (const key of ["dataset_sha256", "snapshot_sha256", "queries_sha256"] as const) {
    sha(source[key], `source.${key}`);
    if (source[key] !== pins[key]) throw new Error(`Gold-turn ${key} source pin mismatch`);
  }
  if (!Array.isArray(root.queries) || root.queries.length !== queries.length) throw new Error("Gold-turn queries must exactly cover the frozen query set");
  const queriesById = new Map<string, GoldTurnQuery>();
  for (const [queryIndex, query] of queries.entries()) {
    const ids = expectedIds(query);
    const rawQuery = object(root.queries[queryIndex], "Gold-turn query"); exactKeys(rawQuery, ["query_id", "entries"], "Gold-turn query");
    if (rawQuery.query_id !== query.id || !Array.isArray(rawQuery.entries) || rawQuery.entries.length !== ids.length) throw new Error(`Gold-turn query/expected-ID coverage mismatch for ${query.id}`);
    const seen = new Set<string>(); const normalizedEntries: GoldTurnEntry[] = []; let previousExpectedIndex = -1;
    for (const rawEntry of rawQuery.entries) {
      const entry = object(rawEntry, "Gold-turn entry"); exactKeys(entry, ["entry_id", "content_sha256", "turns"], "Gold-turn entry");
      if (typeof entry.entry_id !== "string" || seen.has(entry.entry_id)) throw new Error(`Duplicate or invalid entry annotation in ${query.id}`);
      const expectedIndex = ids.indexOf(entry.entry_id);
      if (expectedIndex < 0 || expectedIndex <= previousExpectedIndex) throw new Error(`Gold-turn expected IDs must be exact and canonical in ${query.id}`);
      previousExpectedIndex = expectedIndex; seen.add(entry.entry_id);
      const content = contentFor(entriesById, entry.entry_id);
      if (content === undefined) throw new Error(`Snapshot entry missing for gold-turn annotation ${entry.entry_id}`);
      sha(entry.content_sha256, "content_sha256");
      if (entry.content_sha256 !== digest(content)) throw new Error(`Snapshot content hash mismatch for ${entry.entry_id}`);
      if (!Array.isArray(entry.turns)) throw new Error(`turns must be an array for ${entry.entry_id}`);
      let previousMessage = -1; let previousEnd = -1;
      const turns = entry.turns.map((rawTurn) => {
        const turn = object(rawTurn, "Gold-turn range"); exactKeys(turn, ["message_index", "start", "end"], "Gold-turn range");
        if (!Number.isSafeInteger(turn.message_index) || (turn.message_index as number) < 0 || (turn.message_index as number) <= previousMessage
          || !Number.isSafeInteger(turn.start) || !Number.isSafeInteger(turn.end) || (turn.start as number) < 0
          || (turn.end as number) <= (turn.start as number) || (turn.end as number) > content.length || (turn.start as number) < previousEnd) {
          throw new Error(`Invalid, overlapping or unordered gold-turn range for ${entry.entry_id}`);
        }
        const start = turn.start as number; const end = turn.end as number;
        const lineStart = content.lastIndexOf("\n", start - 1) + 1;
        if (!content.slice(lineStart, start).endsWith(": ") || (end < content.length && content[end] !== "\n")) {
          throw new Error("Gold-turn range must span complete message content excluding role prefix and separator");
        }
        if (start > 0 && start < content.length && /[\uD800-\uDBFF]/.test(content[start - 1]!) && /[\uDC00-\uDFFF]/.test(content[start]!)) throw new Error("Range start splits a UTF-16 surrogate pair");
        if (end > 0 && end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!) && /[\uDC00-\uDFFF]/.test(content[end]!)) throw new Error("Range end splits a UTF-16 surrogate pair");
        previousMessage = turn.message_index as number; previousEnd = end;
        return { message_index: previousMessage, start, end };
      });
      normalizedEntries.push({ entry_id: entry.entry_id, content_sha256: entry.content_sha256, turns });
    }
    if (seen.size !== ids.length) throw new Error(`Missing expected gold-turn entry for ${query.id}`);
    queriesById.set(query.id, { query_id: query.id, entries: normalizedEntries });
  }
  const artifact: GoldTurnArtifact = {
    schema_version: 1, coordinate_system: "utf16_code_units", source: pins,
    queries: [...queriesById.values()],
  };
  return { artifact, queriesById };
}

/** Build canonical offsets from upstream labels, requiring exact session flattening in the frozen snapshot. */
export function prepareGoldTurns(rawData: unknown, queries: BenchmarkQuery[], entriesById: GoldEntriesById, sourceBindings: GoldTurnSourceBindings): GoldTurnArtifact {
  queryInputs(queries); const pins = validateBindings(sourceBindings); const sessions = rawBindings(rawData, queries);
  const artifact: GoldTurnArtifact = {
    schema_version: 1, coordinate_system: "utf16_code_units", source: pins,
    queries: queries.map((query) => ({ query_id: query.id, entries: expectedIds(query).map((entryId) => {
      const bound = sessions.get(query.id)?.get(entryId); const content = contentFor(entriesById, entryId);
      if (!bound || content === undefined) throw new Error(`Missing raw source or snapshot entry for ${query.id}/${entryId}`);
      const flattened = flattenSession(bound.sessionId, bound.sessionDate, bound.messages);
      if (flattened !== content) throw new Error(`flattenSession content mismatch for ${query.id}/${entryId}`);
      return { entry_id: entryId, content_sha256: digest(content), turns: rangesFor(content, bound, query.id) };
    }) })),
  };
  return validateGoldTurns(artifact, queries, entriesById, pins).artifact;
}

const HASHED_DATASET_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
function hashFile(path: string): string {
  const fd = openSync(path, "r");
  try { const hash = createHash("sha256"); const chunk = Buffer.alloc(1024 * 1024); let count: number; while ((count = readSync(fd, chunk, 0, chunk.length, null)) !== 0) hash.update(chunk.subarray(0, count)); return hash.digest("hex"); }
  finally { closeSync(fd); }
}
function parseCli(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]; if (!flag?.startsWith("--")) throw new Error("Expected --raw, --queries, --snapshot, and --out options");
    const key = flag.slice(2); const value = argv[++i];
    if (!["raw", "queries", "snapshot", "out"].includes(key) || !value || value.startsWith("--") || args[key]) throw new Error(`Invalid or duplicate option ${flag}`);
    args[key] = value;
  }
  for (const key of ["raw", "queries", "snapshot", "out"]) if (!args[key] || !isAbsolute(args[key]!)) throw new Error(`--${key} must be an absolute path`);
  return args;
}
function assertInputFile(path: string): string {
  const info = lstatSync(path); if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Input must be a regular file: ${path}`);
  return realpathSync(path);
}
function assertNoSnapshotSidecars(snapshotPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) if (existsSync(snapshotPath + suffix)) throw new Error(`Snapshot has a SQLite sidecar: ${suffix}`);
}
function assertOutputPath(path: string, inputs: string[]): string {
  const output = resolve(path); let current = dirname(output);
  while (true) {
    const info = lstatSync(current); if (info.isSymbolicLink()) throw new Error("Output path cannot use symlink parents");
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const parent = realpathSync(dirname(output)); const canonical = resolve(parent, output.slice(dirname(output).length + 1));
  if (inputs.includes(canonical) || inputs.includes(output)) throw new Error("Output must not alias an input");
  if (!statSync(parent).isDirectory()) throw new Error("Output parent must be a directory");
  return canonical;
}
function parseQueryLines(bytes: Buffer): BenchmarkQuery[] {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("Frozen query JSONL must end with a newline");
  return text.slice(0, -1).split("\n").map((line, index) => {
    if (!line.trim()) throw new Error(`Blank frozen query line ${index + 1}`);
    return JSON.parse(line) as BenchmarkQuery;
  });
}
function readSnapshotEntries(snapshotPath: string, queries: BenchmarkQuery[]): Map<string, { content: string }> {
  for (const suffix of ["-wal", "-shm", "-journal"]) if (existsSync(snapshotPath + suffix)) throw new Error(`Snapshot has a SQLite sidecar: ${suffix}`);
  const fd = openSync(snapshotPath, "r");
  try { const header = Buffer.alloc(100); if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" || header[18] !== 1 || header[19] !== 1) throw new Error("Snapshot must be a detached DELETE-mode SQLite file"); }
  finally { closeSync(fd); }
  const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON"); const ids = [...new Set(queries.flatMap((query) => query.expected_ids))];
    const select = db.prepare("SELECT id, content FROM entries WHERE id = ?"); const result = new Map<string, { content: string }>();
    for (const id of ids) {
      const row = select.get(id) as { id: string; content: string } | undefined;
      if (!row || typeof row.content !== "string") throw new Error(`Expected entry missing from snapshot: ${id}`);
      result.set(row.id, { content: row.content });
    }
    return result;
  } finally { db.close(); }
}
export function prepareGoldTurnsCli(argv = process.argv.slice(2), pinnedDatasetSha256 = HASHED_DATASET_SHA256): void {
  const args = parseCli(argv); const inputPaths = [assertInputFile(args.raw!), assertInputFile(args.queries!), assertInputFile(args.snapshot!)];
  const identities = inputPaths.map((path) => { const info = statSync(path); return `${info.dev}:${info.ino}`; });
  if (new Set(identities).size !== inputPaths.length) throw new Error("Raw dataset, query file, and snapshot must be distinct files");
  const output = assertOutputPath(args.out!, inputPaths);
  assertNoSnapshotSidecars(inputPaths[2]!);
  const startingHashes = inputPaths.map(hashFile);
  if (startingHashes[0] !== pinnedDatasetSha256) throw new Error("Raw dataset SHA-256 differs from the pinned LongMemEval-S source");
  const [rawBytes, queryBytes] = [readFileSync(inputPaths[0]!), readFileSync(inputPaths[1]!)];
  const rawReadSha = createHash("sha256").update(rawBytes).digest("hex");
  const queryReadSha = createHash("sha256").update(queryBytes).digest("hex");
  if (rawReadSha !== startingHashes[0] || queryReadSha !== startingHashes[1]) throw new Error("An input changed while it was being read");
  const queries = parseQueryLines(queryBytes); const entries = readSnapshotEntries(inputPaths[2]!, queries);
  const pins: GoldTurnSourceBindings = { dataset_sha256: rawReadSha, queries_sha256: queryReadSha, snapshot_sha256: startingHashes[2]! };
  const artifact = prepareGoldTurns(JSON.parse(rawBytes.toString("utf8")) as LongMemEvalItem[], queries, entries, pins);
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  assertNoSnapshotSidecars(inputPaths[2]!);
  if (inputPaths.some((path, index) => hashFile(path) !== startingHashes[index])) throw new Error("An input changed during gold-turn preparation");
  let outFd: number;
  try { outFd = openSync(output, "wx", 0o600); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Output already exists; refusing overwrite", { cause: error });
    throw error;
  }
  try { writeFileSync(outFd, json, "utf8"); } finally { closeSync(outFd); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { prepareGoldTurnsCli(); }
  catch (error) { process.stderr.write(`Gold-turn preparation failed: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; }
}
