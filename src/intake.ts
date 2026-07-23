import type Database from "better-sqlite3";
import type {
  Entry,
  IntakeFlag,
  IntakeMetadata,
  IntakeResult,
  RedundancyInfo,
  RelatedKeyRef,
} from "./types.js";
import { nowUTC } from "./db.js";

const INTAKE_EVALUATOR_VERSION = 1;
const MAX_RELATED_KEYS = 10;
const MAX_CANDIDATES = 100;
const MAX_ANALYZED_CHARS = 8_000;
const MAX_NAMESPACE_DEPTH = 3;
const LOW_RELEVANCE_THRESHOLD = 0.3;
const OVERLAP_THRESHOLD = 0.5;
const CONSOLIDATION_THRESHOLD = 0.75;
const MIN_OVERLAP_TOKENS = 4;
const TAG_NOVELTY_THRESHOLD = 0.5;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "how", "in", "is", "it", "its", "no", "not", "of",
  "on", "or", "our", "that", "the", "their", "then", "there", "these",
  "they", "this", "to", "was", "we", "what", "when", "which", "who",
  "will", "with", "you", "your",
]);

export interface EvaluateIntakeInput {
  namespace: string;
  key: string | null;
  content: string;
  tags: string[];
  /**
   * Current entries authorized for the caller before evaluation starts.
   * Hidden entries must never be supplied because even aggregate scores can
   * disclose their existence.
   */
  candidates: Entry[];
  now?: string;
}

export interface PersistedIntake {
  entry_id: string;
  status: "accepted" | "flagged";
  flags: IntakeFlag[];
  score: number;
  related_keys: RelatedKeyRef[];
  redundancy_flag: RedundancyInfo | null;
  evaluated_at: string;
  evaluator_version: number;
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[intake] ignored malformed stored tags: ${message}`);
    return [];
  }
}

function tokens(text: string): Set<string> {
  const normalized = text
    .slice(0, MAX_ANALYZED_CHARS)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  return new Set(
    normalized
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function computeRelevanceScore(
  content: string,
  key: string | null,
  tags: string[],
): number {
  const analyzedContent = content.slice(0, MAX_ANALYZED_CHARS);
  const significant = tokens(analyzedContent).size;
  const richness = Math.min(significant / 12, 1) * 0.5;
  const length = Math.min(analyzedContent.trim().length / 160, 1) * 0.2;
  let structure = 0;
  if (/^#{1,6}\s/m.test(analyzedContent)) structure += 0.05;
  if (/^[-*]\s/m.test(analyzedContent)) structure += 0.05;
  if (/```/.test(analyzedContent)) structure += 0.05;
  const keyQuality = key && key.length >= 3 && key.length <= 80 ? 0.1 : 0;
  const tagQuality = tags.length > 0 && tags.length <= 10 ? 0.05 : 0;
  return Math.min(richness + length + structure + keyQuality + tagQuality, 1);
}

function contentSimilarity(
  left: Set<string>,
  right: Set<string>,
): { intersection: number; similarity: number } {
  if (left.size === 0 || right.size === 0) {
    return { intersection: 0, similarity: 0 };
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const containment = intersection / Math.min(left.size, right.size);
  return { intersection, similarity: Math.max(jaccard, containment) };
}

function addRelated(
  related: RelatedKeyRef[],
  seen: Set<string>,
  entry: Entry,
  relationship: "content_overlap" | "same_tags",
): void {
  if (related.length >= MAX_RELATED_KEYS) return;
  const identity = `${entry.namespace}\u0000${entry.key ?? ""}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  related.push({
    namespace: entry.namespace,
    key: entry.key,
    relationship,
  });
}

export function evaluateIntake(input: EvaluateIntakeInput): IntakeResult {
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
  const flags: IntakeFlag[] = [];
  const relatedKeys: RelatedKeyRef[] = [];
  const relatedSeen = new Set<string>();
  const contentTokens = tokens(input.content);
  let redundancy: RedundancyInfo | null = null;

  const duplicate = input.key === null
    ? undefined
    : candidates.find((entry) => entry.key === input.key);
  if (duplicate) {
    flags.push({
      check: "duplicate_key",
      severity: "info",
      message: `This write updates existing key "${input.key}" in "${input.namespace}".`,
      related_entry_id: duplicate.id,
    });
  }

  for (const entry of candidates) {
    if (input.key !== null && entry.key === input.key) continue;
    const overlap = contentSimilarity(contentTokens, tokens(entry.content));
    if (
      overlap.intersection >= MIN_OVERLAP_TOKENS
      && overlap.similarity >= OVERLAP_THRESHOLD
    ) {
      addRelated(relatedKeys, relatedSeen, entry, "content_overlap");
      flags.push({
        check: "content_overlap",
        severity: "warning",
        message: `Content overlaps with existing entry "${entry.key ?? "(log)"}" in "${entry.namespace}".`,
        related_entry_id: entry.id,
      });
      if (
        overlap.similarity >= CONSOLIDATION_THRESHOLD
        && (!redundancy || overlap.similarity > redundancy.similarity)
      ) {
        redundancy = {
          existing_key: entry.key,
          similarity: overlap.similarity,
        };
        flags.push({
          check: "consolidation_candidate",
          severity: "warning",
          message: `High overlap with "${entry.key ?? "(log)"}"; review whether the entries should be consolidated.`,
          related_entry_id: entry.id,
        });
      }
    }
  }

  if (input.tags.length > 0 && candidates.length >= 2) {
    const vocabulary = new Set(candidates.flatMap((entry) => parseTags(entry.tags)));
    if (vocabulary.size > 0) {
      const novelTags = input.tags.filter((tag) => !vocabulary.has(tag));
      if (
        novelTags.length > 0
        && novelTags.length / input.tags.length >= TAG_NOVELTY_THRESHOLD
      ) {
        flags.push({
          check: "tag_inconsistency",
          severity: "info",
          message: `Tags [${novelTags.join(", ")}] are new to namespace "${input.namespace}".`,
        });
      }
    }
  }

  if (input.tags.length > 0) {
    const inputTags = new Set(input.tags);
    for (const entry of candidates) {
      if (input.key !== null && entry.key === input.key) continue;
      const entryTags = parseTags(entry.tags);
      if (entryTags.some((tag) => inputTags.has(tag))) {
        addRelated(relatedKeys, relatedSeen, entry, "same_tags");
      }
    }
  }

  const relevanceScore = computeRelevanceScore(
    input.content,
    input.key,
    input.tags,
  );
  if (relevanceScore < LOW_RELEVANCE_THRESHOLD) {
    flags.push({
      check: "low_relevance",
      severity: "warning",
      message: `Content is sparse (advisory score ${relevanceScore.toFixed(2)}); verify it is useful durable memory.`,
    });
  }

  const depth = input.namespace.split("/").length;
  if (depth > MAX_NAMESPACE_DEPTH) {
    flags.push({
      check: "namespace_depth",
      severity: "info",
      message: `Namespace "${input.namespace}" has ${depth} levels; consider a flatter durable convention.`,
    });
  }

  const metadata: IntakeMetadata = {
    intake_score: relevanceScore,
    intake_mode: "advisory",
    related_keys: relatedKeys,
    redundancy_flag: redundancy,
    intake_timestamp: input.now ?? nowUTC(),
  };
  return {
    status: flags.length === 0 ? "accepted" : "flagged",
    flags,
    metadata,
  };
}

export function persistIntake(
  db: Database.Database,
  entryId: string,
  result: IntakeResult,
): void {
  if (result.status === "rejected") {
    throw new Error("Rejected intake results cannot be persisted for stored entries.");
  }
  db.prepare(
    `INSERT INTO entry_intake
       (entry_id, status, flags, score, related_keys, redundancy_flag,
        evaluated_at, evaluator_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       status = excluded.status,
       flags = excluded.flags,
       score = excluded.score,
       related_keys = excluded.related_keys,
       redundancy_flag = excluded.redundancy_flag,
       evaluated_at = excluded.evaluated_at,
       evaluator_version = excluded.evaluator_version`,
  ).run(
    entryId,
    result.status,
    JSON.stringify(result.flags),
    result.metadata.intake_score,
    JSON.stringify(result.metadata.related_keys),
    result.metadata.redundancy_flag
      ? JSON.stringify(result.metadata.redundancy_flag)
      : null,
    result.metadata.intake_timestamp,
    INTAKE_EVALUATOR_VERSION,
  );
}

export function getPersistedIntake(
  db: Database.Database,
  entryId: string,
): PersistedIntake | null {
  const row = db.prepare(
    `SELECT entry_id, status, flags, score, related_keys, redundancy_flag,
            evaluated_at, evaluator_version
     FROM entry_intake
     WHERE entry_id = ?`,
  ).get(entryId) as {
    entry_id: string;
    status: "accepted" | "flagged";
    flags: string;
    score: number;
    related_keys: string;
    redundancy_flag: string | null;
    evaluated_at: string;
    evaluator_version: number;
  } | undefined;
  if (!row) return null;
  return {
    ...row,
    flags: JSON.parse(row.flags) as IntakeFlag[],
    related_keys: JSON.parse(row.related_keys) as RelatedKeyRef[],
    redundancy_flag: row.redundancy_flag
      ? JSON.parse(row.redundancy_flag) as RedundancyInfo
      : null,
  };
}
