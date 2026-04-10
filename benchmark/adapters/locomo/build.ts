import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../../../src/db.js";
import type { SearchMode } from "../../../src/types.js";
import type { BenchmarkQuery } from "../../types.js";

export type LocomoGranularity = "session" | "dialog";

export interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

export interface LocomoQa {
  question: string;
  answer: string | number | null | undefined;
  evidence: string[];
  category: number;
}

export interface LocomoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: string | LocomoTurn[];
}

export interface LocomoSample {
  sample_id: string;
  qa: LocomoQa[];
  conversation: LocomoConversation;
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
    granularity: LocomoGranularity;
    sample_count: number;
    entry_count: number;
    query_count: number;
    skipped_queries_no_evidence: number;
    skipped_queries_dangling_evidence: number;
    skipped_queries_adversarial: number;
    dangling_evidence_pointers: number;
  };
}

export interface BuildOptions {
  granularity: LocomoGranularity;
  searchMode: SearchMode;
  inputPath: string;
  dbPath: string;
  queryPath: string;
  provenancePath: string;
  limit?: number;
  includeAdversarial?: boolean;
}

export interface BuildMetadata {
  adapter: "locomo";
  granularity: LocomoGranularity;
  search_mode: SearchMode;
  include_adversarial: boolean;
  generated_at: string;
  input_path: string;
  db_path: string;
  query_path: string;
  id_scheme: string;
  limit?: number;
  stats: ConvertResult["stats"];
}

// LoCoMo question category codes (from the upstream release):
// 1 = single-hop factual, 2 = temporal reasoning, 3 = multi-hop,
// 4 = open-domain knowledge, 5 = adversarial (unanswerable)
export function mapLocomoCategory(category: number): string {
  switch (category) {
    case 1: return "locomo/single-hop";
    case 2: return "locomo/temporal";
    case 3: return "locomo/multi-hop";
    case 4: return "locomo/open-domain";
    case 5: return "locomo/adversarial";
    default: return `locomo/category-${category}`;
  }
}

function parseArgs(argv: string[]): BuildOptions {
  const args = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    args.set(key, next);
    i += 1;
  }

  const granularity = (args.get("granularity") ?? "session") as LocomoGranularity;
  const searchMode = (args.get("search-mode") ?? "lexical") as SearchMode;
  const includeAdversarial = flags.has("include-adversarial");
  const defaultInput = "benchmark/data/raw/locomo/locomo10.json";
  const granularitySuffix = granularity === "session" ? "locomo" : `locomo-${granularity}`;
  const queryBase = searchMode === "lexical"
    ? `benchmark/generated/${granularitySuffix}`
    : `benchmark/generated/${granularitySuffix}-${searchMode}`;

  return {
    granularity,
    searchMode,
    includeAdversarial,
    inputPath: resolve(args.get("input") ?? defaultInput),
    dbPath: resolve(args.get("db") ?? `${queryBase}.db`),
    queryPath: resolve(args.get("queries") ?? `${queryBase}.jsonl`),
    provenancePath: resolve(args.get("provenance") ?? `${queryBase}.provenance.json`),
    limit: args.has("limit") ? Number(args.get("limit")) : undefined,
  };
}

export function makeSessionEntryId(sampleId: string, sessionNumber: number): string {
  return `locomo:${sampleId}:session-${sessionNumber}`;
}

export function makeDialogEntryId(sampleId: string, diaId: string): string {
  return `locomo:${sampleId}:dialog:${diaId}`;
}

function normalizeKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "entry";
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9, sept: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * LoCoMo session timestamps look like "1:56 pm on 8 May, 2023".
 * Convert to an ISO string; fall back to a sentinel if parsing fails.
 */
export function normalizeDateToIso(raw: string | undefined): string {
  if (!raw) return "2023-01-01T00:00:00.000Z";
  const trimmed = raw.trim();
  // Match "H(H):MM am|pm on D Month(,) YYYY"
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?\s*on\s*(\d{1,2})\s+(\w+),?\s+(\d{4})$/i);
  if (!match) return "2023-01-01T00:00:00.000Z";
  const [, hourStr, minuteStr, meridiemRaw, dayStr, monthStr, yearStr] = match;
  let hour = Number(hourStr);
  const minute = Number(minuteStr);
  const meridiem = meridiemRaw?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const month = MONTHS[monthStr.toLowerCase()];
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!month || Number.isNaN(day) || Number.isNaN(year)) {
    return "2023-01-01T00:00:00.000Z";
  }
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00.000Z`;
}

interface ParsedSession {
  sessionNumber: number;
  dateTimeRaw: string | undefined;
  dateTimeIso: string;
  turns: LocomoTurn[];
}

function parseSessions(conversation: LocomoConversation): ParsedSession[] {
  const sessions: ParsedSession[] = [];
  for (const key of Object.keys(conversation)) {
    const match = key.match(/^session_(\d+)$/);
    if (!match) continue;
    const sessionNumber = Number(match[1]);
    const turns = conversation[key] as LocomoTurn[];
    if (!Array.isArray(turns) || turns.length === 0) continue;
    const dateTimeRaw = conversation[`session_${sessionNumber}_date_time`] as string | undefined;
    sessions.push({
      sessionNumber,
      dateTimeRaw,
      dateTimeIso: normalizeDateToIso(dateTimeRaw),
      turns,
    });
  }
  sessions.sort((a, b) => a.sessionNumber - b.sessionNumber);
  return sessions;
}

function flattenSession(
  sampleId: string,
  speakers: { a: string; b: string },
  session: ParsedSession,
): string {
  const lines: string[] = [];
  lines.push(`Sample: ${sampleId}`);
  lines.push(`Session: ${session.sessionNumber}`);
  if (session.dateTimeRaw) {
    lines.push(`Date: ${session.dateTimeRaw}`);
  }
  lines.push(`Participants: ${speakers.a}, ${speakers.b}`);
  lines.push("Conversation:");
  for (const turn of session.turns) {
    lines.push(`${turn.speaker} (${turn.dia_id}): ${turn.text.trim()}`);
  }
  return lines.join("\n");
}

function flattenDialogTurn(
  sampleId: string,
  speakers: { a: string; b: string },
  session: ParsedSession,
  turn: LocomoTurn,
): string {
  const lines: string[] = [];
  lines.push(`Sample: ${sampleId}`);
  lines.push(`Session: ${session.sessionNumber}`);
  if (session.dateTimeRaw) {
    lines.push(`Date: ${session.dateTimeRaw}`);
  }
  lines.push(`Dialog ID: ${turn.dia_id}`);
  lines.push(`Participants: ${speakers.a}, ${speakers.b}`);
  lines.push(`${turn.speaker}: ${turn.text.trim()}`);
  return lines.join("\n");
}

function evidenceSessionNumber(diaId: string): number | null {
  const match = diaId.match(/^D(\d+):/);
  return match ? Number(match[1]) : null;
}

export function convertLocomoDataset(
  samples: LocomoSample[],
  granularity: LocomoGranularity = "session",
  searchMode: SearchMode = "lexical",
  limit?: number,
  includeAdversarial = false,
): ConvertResult {
  const sliced = typeof limit === "number" ? samples.slice(0, limit) : samples;
  const namespace = `benchmarks/locomo/${granularity === "session" ? "sessions" : "dialogs"}`;
  const entryMap = new Map<string, SyntheticEntry>();
  const queries: BenchmarkQuery[] = [];

  let skippedNoEvidence = 0;
  let skippedDanglingEvidence = 0;
  let skippedAdversarial = 0;
  let danglingEvidencePointers = 0;

  for (const sample of sliced) {
    const speakers = {
      a: sample.conversation.speaker_a,
      b: sample.conversation.speaker_b,
    };
    const sessions = parseSessions(sample.conversation);

    // --- Corpus entries ---
    for (const session of sessions) {
      if (granularity === "session") {
        const entryId = makeSessionEntryId(sample.sample_id, session.sessionNumber);
        if (entryMap.has(entryId)) continue;
        entryMap.set(entryId, {
          id: entryId,
          namespace,
          key: normalizeKey(`${sample.sample_id}-session-${session.sessionNumber}`),
          content: flattenSession(sample.sample_id, speakers, session),
          tags: [
            "source:external",
            "type:benchmark-session",
            "dataset:locomo",
            `sample:${sample.sample_id}`,
            "granularity:session",
          ],
          created_at: session.dateTimeIso,
        });
      } else {
        for (const turn of session.turns) {
          const entryId = makeDialogEntryId(sample.sample_id, turn.dia_id);
          if (entryMap.has(entryId)) continue;
          entryMap.set(entryId, {
            id: entryId,
            namespace,
            key: normalizeKey(`${sample.sample_id}-${turn.dia_id}`),
            content: flattenDialogTurn(sample.sample_id, speakers, session, turn),
            tags: [
              "source:external",
              "type:benchmark-dialog",
              "dataset:locomo",
              `sample:${sample.sample_id}`,
              "granularity:dialog",
            ],
            created_at: session.dateTimeIso,
          });
        }
      }
    }

    // --- QA queries ---
    for (const qa of sample.qa) {
      if (!qa.evidence || qa.evidence.length === 0) {
        skippedNoEvidence += 1;
        continue;
      }
      if (qa.category === 5 && !includeAdversarial) {
        skippedAdversarial += 1;
        continue;
      }

      let expectedIds: string[];
      if (granularity === "session") {
        const seen = new Set<string>();
        expectedIds = [];
        for (const ev of qa.evidence) {
          const sessionNum = evidenceSessionNumber(ev);
          if (sessionNum === null) {
            danglingEvidencePointers += 1;
            continue;
          }
          const entryId = makeSessionEntryId(sample.sample_id, sessionNum);
          if (!entryMap.has(entryId)) {
            danglingEvidencePointers += 1;
            continue;
          }
          if (!seen.has(entryId)) {
            seen.add(entryId);
            expectedIds.push(entryId);
          }
        }
      } else {
        const seen = new Set<string>();
        expectedIds = [];
        for (const ev of qa.evidence) {
          const entryId = makeDialogEntryId(sample.sample_id, ev);
          if (!entryMap.has(entryId)) {
            danglingEvidencePointers += 1;
            continue;
          }
          if (!seen.has(entryId)) {
            seen.add(entryId);
            expectedIds.push(entryId);
          }
        }
      }

      if (expectedIds.length === 0) {
        skippedDanglingEvidence += 1;
        continue;
      }

      const answerText = qa.answer === undefined || qa.answer === null ? "" : String(qa.answer);
      queries.push({
        id: `locomo-${sample.sample_id}-${queries.length}`,
        query: qa.question,
        source: "derived",
        category: mapLocomoCategory(qa.category),
        search_mode: searchMode,
        expected_ids: expectedIds,
        notes: answerText
          ? `LoCoMo ${sample.sample_id} cat ${qa.category}; answer=${answerText}`
          : `LoCoMo ${sample.sample_id} cat ${qa.category}; no reference answer`,
      });
    }
  }

  return {
    entries: Array.from(entryMap.values()),
    queries,
    stats: {
      granularity,
      sample_count: sliced.length,
      entry_count: entryMap.size,
      query_count: queries.length,
      skipped_queries_no_evidence: skippedNoEvidence,
      skipped_queries_dangling_evidence: skippedDanglingEvidence,
      skipped_queries_adversarial: skippedAdversarial,
      dangling_evidence_pointers: danglingEvidencePointers,
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

export function buildLocomoArtifacts(options: BuildOptions): ConvertResult {
  mkdirSync(dirname(options.dbPath), { recursive: true });
  mkdirSync(dirname(options.queryPath), { recursive: true });
  mkdirSync(dirname(options.provenancePath), { recursive: true });

  const samples = JSON.parse(readFileSync(options.inputPath, "utf-8")) as LocomoSample[];
  const converted = convertLocomoDataset(
    samples,
    options.granularity,
    options.searchMode,
    options.limit,
    options.includeAdversarial ?? false,
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
    adapter: "locomo",
    granularity: options.granularity,
    search_mode: options.searchMode,
    include_adversarial: options.includeAdversarial ?? false,
    generated_at: new Date().toISOString(),
    input_path: options.inputPath,
    db_path: options.dbPath,
    query_path: options.queryPath,
    id_scheme: options.granularity === "session"
      ? "locomo:<sample_id>:session-<n>"
      : "locomo:<sample_id>:dialog:<dia_id>",
    limit: options.limit,
    stats: converted.stats,
  };
  writeFileSync(options.provenancePath, JSON.stringify(metadata, null, 2), "utf-8");

  return converted;
}

function printSummary(result: ConvertResult, options: BuildOptions): void {
  console.log("Built LoCoMo benchmark artifacts");
  console.log(`  Gran:       ${options.granularity}`);
  console.log(`  Mode:       ${options.searchMode}`);
  console.log(`  Input:      ${options.inputPath}`);
  console.log(`  DB:         ${options.dbPath}`);
  console.log(`  Queries:    ${options.queryPath}`);
  console.log(`  Meta:       ${options.provenancePath}`);
  console.log(`  Samples:    ${result.stats.sample_count}`);
  console.log(`  Entries:    ${result.stats.entry_count}`);
  console.log(`  Queries:    ${result.stats.query_count}`);
  if (result.stats.skipped_queries_no_evidence > 0) {
    console.log(`  Skipped:    ${result.stats.skipped_queries_no_evidence} qa with no evidence`);
  }
  if (result.stats.skipped_queries_dangling_evidence > 0) {
    console.log(`  Skipped:    ${result.stats.skipped_queries_dangling_evidence} qa with only dangling evidence`);
  }
  if (result.stats.skipped_queries_adversarial > 0) {
    console.log(`  Skipped:    ${result.stats.skipped_queries_adversarial} adversarial (category 5) qa`);
  }
  if (result.stats.dangling_evidence_pointers > 0) {
    console.log(`  Dangling:   ${result.stats.dangling_evidence_pointers} evidence pointers dropped`);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
})();

if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const result = buildLocomoArtifacts(options);
  printSummary(result, options);
}
