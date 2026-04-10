import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../../../src/db.js";
import type { SearchMode } from "../../../src/types.js";
import type { BenchmarkQuery } from "../../types.js";

export type LongMemEvalGranularity = "session" | "round";

export interface LongMemEvalMessage {
  role: string;
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalMessage[][];
}

export interface SyntheticEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  created_at: string;
}

export interface ConvertResult {
  entries: SyntheticEntry[];
  queries: BenchmarkQuery[];
  stats: {
    split: string;
    granularity: LongMemEvalGranularity;
    item_count: number;
    entry_count: number;
    query_count: number;
    skipped_queries_missing_answer_sessions: number;
    deduped_sessions: number;
    evidence_round_fallbacks: number;
  };
}

export interface BuildOptions {
  split: string;
  granularity: LongMemEvalGranularity;
  searchMode: SearchMode;
  inputPath: string;
  dbPath: string;
  queryPath: string;
  provenancePath: string;
  limit?: number;
}

export interface BuildMetadata {
  adapter: "longmemeval";
  split: string;
  granularity: LongMemEvalGranularity;
  search_mode: SearchMode;
  generated_at: string;
  input_path: string;
  db_path: string;
  query_path: string;
  id_scheme: string;
  limit?: number;
  stats: ConvertResult["stats"];
}

function parseArgs(argv: string[]): BuildOptions {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, value);
    i += 1;
  }

  const split = args.get("split") ?? "s";
  const granularity = (args.get("granularity") ?? "session") as LongMemEvalGranularity;
  const searchMode = (args.get("search-mode") ?? "lexical") as SearchMode;
  const defaultInput = split === "m"
    ? "benchmark/data/raw/longmemeval/longmemeval_m_cleaned.json"
    : "benchmark/data/raw/longmemeval/longmemeval_s_cleaned.json";
  const suffix = granularity === "session"
    ? `longmemeval-${split}`
    : `longmemeval-${split}-${granularity}`;
  const queryBase = searchMode === "lexical"
    ? `benchmark/generated/${suffix}`
    : `benchmark/generated/${suffix}-${searchMode}`;

  return {
    split,
    granularity,
    searchMode,
    inputPath: resolve(args.get("input") ?? defaultInput),
    dbPath: resolve(args.get("db") ?? `${queryBase}.db`),
    queryPath: resolve(args.get("queries") ?? `${queryBase}.jsonl`),
    provenancePath: resolve(args.get("provenance") ?? `${queryBase}.provenance.json`),
    limit: args.has("limit") ? Number(args.get("limit")) : undefined,
  };
}

export function makeSyntheticEntryId(split: string, sessionId: string): string {
  return `longmemeval:${split}:${sessionId}`;
}

export function makeSyntheticRoundEntryId(split: string, sessionId: string, roundIndex: number): string {
  return `longmemeval:${split}:round:${sessionId}:${roundIndex}`;
}

function normalizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function normalizeDateToIso(raw: string): string {
  const match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})$/);
  if (!match) {
    return "2023-01-01T00:00:00.000Z";
  }
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00.000Z`;
}

export function flattenSession(
  sessionId: string,
  sessionDate: string | undefined,
  messages: LongMemEvalMessage[],
): string {
  const lines: string[] = [];
  lines.push(`Session ID: ${sessionId}`);
  if (sessionDate) {
    lines.push(`Session Date: ${sessionDate}`);
  }
  lines.push("Conversation:");
  for (const message of messages) {
    const role = message.role || "unknown";
    const hasAnswerSuffix =
      typeof message.has_answer === "boolean"
        ? ` [has_answer=${message.has_answer ? "true" : "false"}]`
        : "";
    lines.push(`${role}${hasAnswerSuffix}: ${message.content.trim()}`);
  }
  return lines.join("\n");
}

export function mapQuestionCategory(questionType: string): string {
  return `longmemeval/${questionType}`;
}

interface SessionRound {
  roundIndex: number;
  messages: LongMemEvalMessage[];
  hasAnswer: boolean;
}

function chunkSessionIntoRounds(messages: LongMemEvalMessage[]): SessionRound[] {
  const rounds: SessionRound[] = [];
  let i = 0;

  while (i < messages.length) {
    const current = messages[i];
    const next = messages[i + 1];
    let roundMessages: LongMemEvalMessage[];

    if (current?.role === "user" && next?.role === "assistant") {
      roundMessages = [current, next];
      i += 2;
    } else {
      roundMessages = current ? [current] : [];
      i += 1;
    }

    rounds.push({
      roundIndex: rounds.length,
      messages: roundMessages,
      hasAnswer: roundMessages.some((message) => message.has_answer === true),
    });
  }

  return rounds;
}

function flattenRound(
  sessionId: string,
  sessionDate: string | undefined,
  roundIndex: number,
  messages: LongMemEvalMessage[],
): string {
  const lines: string[] = [];
  lines.push(`Session ID: ${sessionId}`);
  if (sessionDate) {
    lines.push(`Session Date: ${sessionDate}`);
  }
  lines.push(`Round Index: ${roundIndex}`);
  lines.push("Round:");
  for (const message of messages) {
    const role = message.role || "unknown";
    const hasAnswerSuffix =
      typeof message.has_answer === "boolean"
        ? ` [has_answer=${message.has_answer ? "true" : "false"}]`
        : "";
    lines.push(`${role}${hasAnswerSuffix}: ${message.content.trim()}`);
  }
  return lines.join("\n");
}

export function convertLongMemEvalDataset(
  items: LongMemEvalItem[],
  split: string,
  granularity: LongMemEvalGranularity = "session",
  searchMode: SearchMode = "lexical",
  limit?: number,
): ConvertResult {
  const sliced = typeof limit === "number" ? items.slice(0, limit) : items;
  const namespace = `benchmarks/longmemeval/${split}/${granularity === "session" ? "sessions" : "rounds"}`;
  const entryMap = new Map<string, SyntheticEntry>();
  const queries: BenchmarkQuery[] = [];
  let skippedQueries = 0;
  let dedupedSessions = 0;
  let evidenceRoundFallbacks = 0;

  for (const item of sliced) {
    for (let i = 0; i < item.haystack_session_ids.length; i += 1) {
      const sessionId = item.haystack_session_ids[i];
      const messages = item.haystack_sessions[i] ?? [];
      const sessionDate = item.haystack_dates[i];
      if (granularity === "session") {
        const entryId = makeSyntheticEntryId(split, sessionId);
        if (entryMap.has(entryId)) {
          dedupedSessions += 1;
          continue;
        }

        entryMap.set(entryId, {
          id: entryId,
          namespace,
          key: normalizeKey(sessionId),
          content: flattenSession(sessionId, sessionDate, messages),
          tags: [
            "source:external",
            "type:benchmark-session",
            `dataset:longmemeval`,
            `dataset_split:${split}`,
            "granularity:session",
          ],
          created_at: normalizeDateToIso(sessionDate ?? item.question_date),
        });
      } else {
        const rounds = chunkSessionIntoRounds(messages);
        for (const round of rounds) {
          const entryId = makeSyntheticRoundEntryId(split, sessionId, round.roundIndex);
          if (entryMap.has(entryId)) {
            continue;
          }
          entryMap.set(entryId, {
            id: entryId,
            namespace,
            key: normalizeKey(`${sessionId}-round-${round.roundIndex}`),
            content: flattenRound(sessionId, sessionDate, round.roundIndex, round.messages),
            tags: [
              "source:external",
              "type:benchmark-round",
              `dataset:longmemeval`,
              `dataset_split:${split}`,
              "granularity:round",
            ],
            created_at: normalizeDateToIso(sessionDate ?? item.question_date),
          });
        }
      }
    }

    const expectedIds = granularity === "session"
      ? item.answer_session_ids
        .map((sessionId) => makeSyntheticEntryId(split, sessionId))
        .filter((entryId) => entryMap.has(entryId))
      : (() => {
        const result: string[] = [];
        let usedFallback = false;
        for (let i = 0; i < item.answer_session_ids.length; i += 1) {
          const answerSessionId = item.answer_session_ids[i];
          const sessionIndex = item.haystack_session_ids.findIndex((id) => id === answerSessionId);
          if (sessionIndex === -1) continue;
          const rounds = chunkSessionIntoRounds(item.haystack_sessions[sessionIndex] ?? []);
          const answerRounds = rounds.filter((round) => round.hasAnswer);
          const chosenRounds = answerRounds.length > 0 ? answerRounds : rounds;
          if (answerRounds.length === 0 && rounds.length > 0) {
            usedFallback = true;
          }
          for (const round of chosenRounds) {
            const entryId = makeSyntheticRoundEntryId(split, answerSessionId, round.roundIndex);
            if (entryMap.has(entryId)) {
              result.push(entryId);
            }
          }
        }
        if (usedFallback) {
          evidenceRoundFallbacks += 1;
        }
        return result;
      })();

    if (expectedIds.length === 0) {
      skippedQueries += 1;
      continue;
    }

    queries.push({
      id: `longmemeval-${split}-${item.question_id}`,
      query: item.question,
      source: "derived",
      category: mapQuestionCategory(item.question_type),
      search_mode: searchMode,
      expected_ids: expectedIds,
      notes: `LongMemEval ${split} question ${item.question_id}; answer=${item.answer}`,
    });
  }

  return {
    entries: Array.from(entryMap.values()),
    queries,
    stats: {
      split,
      granularity,
      item_count: sliced.length,
      entry_count: entryMap.size,
      query_count: queries.length,
      skipped_queries_missing_answer_sessions: skippedQueries,
      deduped_sessions: dedupedSessions,
      evidence_round_fallbacks: evidenceRoundFallbacks,
    },
  };
}

function resetDbFiles(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function insertSyntheticEntries(db: Database.Database, entries: SyntheticEntry[]): void {
  const insert = db.prepare(`
    INSERT INTO entries (
      id, namespace, key, entry_type, content, tags,
      agent_id, owner_principal_id, created_at, updated_at,
      valid_until, classification, embedding_status, embedding_model
    ) VALUES (?, ?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((rows: SyntheticEntry[]) => {
    for (const entry of rows) {
      insert.run(
        entry.id,
        entry.namespace,
        entry.key,
        entry.content,
        JSON.stringify(entry.tags),
        "benchmark-adapter",
        "benchmark-adapter",
        entry.created_at,
        entry.created_at,
        null,
        "public",
        "pending",
        null,
      );
    }
  });

  tx(entries);
}

export function buildLongMemEvalArtifacts(options: BuildOptions): ConvertResult {
  mkdirSync(dirname(options.dbPath), { recursive: true });
  mkdirSync(dirname(options.queryPath), { recursive: true });
  mkdirSync(dirname(options.provenancePath), { recursive: true });

  const items = JSON.parse(readFileSync(options.inputPath, "utf-8")) as LongMemEvalItem[];
  const converted = convertLongMemEvalDataset(
    items,
    options.split,
    options.granularity,
    options.searchMode,
    options.limit,
  );

  resetDbFiles(options.dbPath);
  const db = initDatabase(options.dbPath);
  try {
    insertSyntheticEntries(db, converted.entries);
  } finally {
    db.close();
  }

  const jsonl = converted.queries.map((query) => JSON.stringify(query)).join("\n");
  writeFileSync(options.queryPath, `${jsonl}\n`, "utf-8");

  const metadata: BuildMetadata = {
    adapter: "longmemeval",
    split: options.split,
    granularity: options.granularity,
    search_mode: options.searchMode,
    generated_at: new Date().toISOString(),
    input_path: options.inputPath,
    db_path: options.dbPath,
    query_path: options.queryPath,
    id_scheme: options.granularity === "session"
      ? "longmemeval:<split>:<session_id>"
      : "longmemeval:<split>:round:<session_id>:<round_index>",
    limit: options.limit,
    stats: converted.stats,
  };
  writeFileSync(options.provenancePath, JSON.stringify(metadata, null, 2), "utf-8");

  return converted;
}

function printSummary(result: ConvertResult, options: BuildOptions): void {
  console.log("Built LongMemEval benchmark artifacts");
  console.log(`  Split:   ${options.split}`);
  console.log(`  Gran:    ${options.granularity}`);
  console.log(`  Mode:    ${options.searchMode}`);
  console.log(`  Input:   ${options.inputPath}`);
  console.log(`  DB:      ${options.dbPath}`);
  console.log(`  Queries: ${options.queryPath}`);
  console.log(`  Meta:    ${options.provenancePath}`);
  console.log(`  Items:   ${result.stats.item_count}`);
  console.log(`  Entries: ${result.stats.entry_count}`);
  console.log(`  Queries: ${result.stats.query_count}`);
  if (result.stats.skipped_queries_missing_answer_sessions > 0) {
    console.log(
      `  Skipped: ${result.stats.skipped_queries_missing_answer_sessions} queries with no answer sessions in haystack`,
    );
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
})();

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const result = buildLongMemEvalArtifacts(options);
  printSummary(result, options);
}
