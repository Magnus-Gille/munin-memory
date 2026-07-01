import type Database from "better-sqlite3";
import type {
  IntakeResult,
  IntakeFlag,
  IntakeMode,
  IntakeMetadata,
  RelatedKeyRef,
  RedundancyInfo,
  Entry,
} from "./types.js";
import { readState, queryEntriesLexicalScored, getNamespaceTagVocabulary, getNamespaceStateEntries, nowUTC } from "./db.js";

// Stopwords for content overlap token extraction
const INTAKE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "he", "her", "his", "how", "i", "in", "is", "it",
  "its", "my", "no", "not", "of", "on", "or", "our", "she", "so",
  "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "to", "us", "was", "we", "what", "when", "which",
  "who", "will", "with", "you", "your",
]);

// BM25 score threshold — FTS5 scores are negative (lower = better match).
// A score below this indicates strong content overlap.
const OVERLAP_SCORE_THRESHOLD = -5.0;

// High-redundancy threshold — very strong overlap suggesting near-duplicate
const HIGH_REDUNDANCY_THRESHOLD = -12.0;

// Max namespace depth before flagging
const MAX_NAMESPACE_DEPTH = 3;

// Minimum fraction of novel tags to trigger tag inconsistency flag
const TAG_NOVELTY_THRESHOLD = 0.5;

// Relevance scoring thresholds
const MIN_TOKEN_COUNT = 5; // minimum meaningful tokens for relevance
const LOW_RELEVANCE_THRESHOLD = 0.3; // below this score = low relevance

/**
 * Extract significant tokens from content for FTS5 overlap queries.
 * Returns the longest/rarest non-stopword tokens to maximize discrimination.
 */
function extractQueryTokens(content: string, maxTokens = 8): string[] {
  const tokens = content
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !INTAKE_STOPWORDS.has(t));

  // Deduplicate and sort by length descending (longer tokens are more discriminating)
  const unique = [...new Set(tokens)];
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, maxTokens);
}

/**
 * Compute a relevance score (0.0–1.0) for an entry based on local signals.
 * Combines token richness, key term density, and content structure.
 * No external LLM calls — purely heuristic.
 */
function computeRelevanceScore(content: string, key: string, tags: string[]): number {
  const allTokens = content
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);

  const significantTokens = allTokens.filter(
    (t) => t.length >= 3 && !INTAKE_STOPWORDS.has(t),
  );
  const uniqueSignificant = new Set(significantTokens);

  // Factor 1: Token richness (0–0.3) — enough meaningful content?
  const tokenRichness = Math.min(uniqueSignificant.size / 20, 1.0) * 0.3;

  // Factor 2: Key term density (0–0.3) — ratio of significant to total tokens
  const density =
    allTokens.length > 0 ? significantTokens.length / allTokens.length : 0;
  const keyTermDensity = Math.min(density / 0.6, 1.0) * 0.3;

  // Factor 3: Structure signals (0–0.2) — markdown headings, lists, code blocks
  let structure = 0;
  if (/^#+\s/m.test(content)) structure += 0.05;
  if (/^[-*]\s/m.test(content)) structure += 0.05;
  if (/```/.test(content)) structure += 0.05;
  if (content.length > 100) structure += 0.05;

  // Factor 4: Metadata quality (0–0.2) — key naming and tag presence
  let metaQuality = 0;
  if (key.length >= 3 && key.length <= 40) metaQuality += 0.1;
  if (tags.length > 0 && tags.length <= 10) metaQuality += 0.1;

  return Math.min(tokenRichness + keyTermDensity + structure + metaQuality, 1.0);
}

/**
 * Find related entries by content overlap and shared tags.
 * Returns references suitable for the related_keys metadata field.
 */
function findRelatedKeys(
  db: Database.Database,
  namespace: string,
  key: string | null,
  content: string,
  tags: string[],
): { relatedKeys: RelatedKeyRef[]; redundancy: RedundancyInfo | null; overlapEntries: Array<{ entry: Entry; score: number }> } {
  const relatedKeys: RelatedKeyRef[] = [];
  const seen = new Set<string>(); // track ns/key pairs to deduplicate
  let redundancy: RedundancyInfo | null = null;
  const overlapEntries: Array<{ entry: Entry; score: number }> = [];

  // 1. Content overlap via FTS5
  const queryTokens = extractQueryTokens(content);
  if (queryTokens.length >= 2) {
    const queryStr = queryTokens.map((t) => `"${t}"`).join(" OR ");
    try {
      const results = queryEntriesLexicalScored(db, {
        query: queryStr,
        namespace,
        limit: 5,
      });

      for (const result of results) {
        if (result.entry.key === key) continue;
        const refKey = `${result.entry.namespace}/${result.entry.key}`;
        if (seen.has(refKey)) continue;

        if (result.score < OVERLAP_SCORE_THRESHOLD) {
          seen.add(refKey);
          overlapEntries.push(result);
          relatedKeys.push({
            namespace: result.entry.namespace,
            key: result.entry.key,
            relationship: "content_overlap",
          });

          // Track the strongest overlap as potential redundancy
          if (result.score < HIGH_REDUNDANCY_THRESHOLD) {
            if (!redundancy || result.score < -Math.abs(1 / (redundancy.similarity + 0.001))) {
              // Normalize BM25 score to 0–1 similarity (closer to 1 = more similar)
              const similarity = Math.min(Math.abs(result.score) / 20, 1.0);
              redundancy = {
                existing_key: result.entry.key,
                similarity,
              };
            }
          }
        }
      }
    } catch {
      // FTS5 query failure should not block intake
    }
  }

  // 2. Same-namespace entries with shared tags
  if (tags.length > 0) {
    try {
      const nsEntries = getNamespaceStateEntries(db, namespace);
      const tagSet = new Set(tags);
      for (const entry of nsEntries) {
        if (entry.key === key) continue;
        const refKey = `${namespace}/${entry.key}`;
        if (seen.has(refKey)) continue;

        const entryTags: string[] = JSON.parse(entry.tags);
        const sharedTags = entryTags.filter((t) => tagSet.has(t));
        if (sharedTags.length >= 1) {
          seen.add(refKey);
          relatedKeys.push({
            namespace,
            key: entry.key,
            relationship: "same_tags",
          });
        }
      }
    } catch {
      // Failure shouldn't block
    }
  }

  // Cap related keys at 10
  return {
    relatedKeys: relatedKeys.slice(0, 10),
    redundancy,
    overlapEntries,
  };
}

/**
 * Detect consolidation candidates: entries that overlap enough to suggest merging.
 */
function detectConsolidation(
  overlapEntries: Array<{ entry: Entry; score: number }>,
  key: string | null,
): IntakeFlag[] {
  const flags: IntakeFlag[] = [];
  for (const { entry, score } of overlapEntries) {
    if (score < HIGH_REDUNDANCY_THRESHOLD) {
      flags.push({
        check: "consolidation_candidate",
        severity: "warning",
        message: `High content overlap with "${entry.key ?? "(log)"}" in "${entry.namespace}". These entries may be candidates for consolidation.`,
        related_entry_id: entry.id,
      });
    }
  }
  return flags;
}

export interface EvaluateIntakeOptions {
  mode: IntakeMode;
  /** For log entries, key is null */
  isLog?: boolean;
}

/**
 * Evaluate an entry against intake criteria before writing.
 *
 * Behavior depends on mode:
 * - strict: rejects redundant/low-relevance entries with explanation
 * - advisory: all writes succeed, response includes audit report
 * - passthrough: no evaluation, returns clean result immediately
 *
 * All checks are local (SQLite queries or string operations).
 * Target latency: <100ms on Pi 5.
 */
export function evaluateIntake(
  db: Database.Database,
  namespace: string,
  key: string,
  content: string,
  tags: string[],
  options?: EvaluateIntakeOptions,
): IntakeResult {
  const mode = options?.mode ?? "advisory";
  const now = nowUTC();

  // Passthrough: skip all evaluation
  if (mode === "passthrough") {
    return {
      status: "accepted",
      flags: [],
      metadata: {
        intake_score: 1.0,
        intake_mode: "passthrough",
        related_keys: [],
        redundancy_flag: null,
        intake_timestamp: now,
      },
    };
  }

  const flags: IntakeFlag[] = [];

  // 1. Duplicate key detection (~0ms — single indexed lookup)
  const existing = key ? readState(db, namespace, key) : null;
  if (existing) {
    const daysSince = Math.floor(
      (Date.now() - new Date(existing.updated_at).getTime()) / (24 * 60 * 60 * 1000),
    );
    flags.push({
      check: "duplicate_key",
      severity: mode === "strict" ? "warning" : "info",
      message: `Overwriting existing entry "${key}" in "${namespace}" (last updated ${daysSince} day${daysSince === 1 ? "" : "s"} ago).`,
      related_entry_id: existing.id,
    });
  }

  // 2. Relational linking + redundancy detection + content overlap
  const { relatedKeys, redundancy, overlapEntries } = findRelatedKeys(
    db, namespace, key, content, tags,
  );

  // Surface content overlap flags
  for (const { entry, score } of overlapEntries) {
    if (score < OVERLAP_SCORE_THRESHOLD) {
      flags.push({
        check: "content_overlap",
        severity: mode === "strict" && score < HIGH_REDUNDANCY_THRESHOLD ? "error" : "warning",
        message: `Content overlaps with existing entry "${entry.key ?? "(log)"}" in "${namespace}". Consider consolidating.`,
        related_entry_id: entry.id,
      });
    }
  }

  // Consolidation detection
  const consolidationFlags = detectConsolidation(overlapEntries, key);
  flags.push(...consolidationFlags);

  // 3. Relevance scoring
  const relevanceScore = computeRelevanceScore(content, key, tags);
  if (relevanceScore < LOW_RELEVANCE_THRESHOLD) {
    flags.push({
      check: "low_relevance",
      severity: mode === "strict" ? "error" : "warning",
      message: `Entry has low relevance score (${relevanceScore.toFixed(2)}). Content may be too sparse or lack meaningful terms.`,
    });
  }

  // 4. Tag consistency check (~10ms — namespace-scoped query)
  if (tags.length > 0) {
    try {
      const vocabulary = getNamespaceTagVocabulary(db, namespace);
      if (vocabulary.length > 0) {
        const existingSet = new Set(vocabulary);
        const novelTags = tags.filter((t) => !existingSet.has(t));
        if (novelTags.length > 0 && novelTags.length / tags.length >= TAG_NOVELTY_THRESHOLD) {
          flags.push({
            check: "tag_inconsistency",
            severity: "info",
            message: `Tags [${novelTags.join(", ")}] are new to namespace "${namespace}". Existing tags: [${vocabulary.slice(0, 10).join(", ")}].`,
          });
        }
      }
    } catch {
      // Tag vocabulary query failure should not block intake evaluation
    }
  }

  // 5. Namespace depth check (~0ms — pure string operation)
  const depth = namespace.split("/").length;
  if (depth > MAX_NAMESPACE_DEPTH) {
    flags.push({
      check: "namespace_depth",
      severity: "info",
      message: `Namespace "${namespace}" has ${depth} levels (max recommended: ${MAX_NAMESPACE_DEPTH}). Consider flatter structure.`,
    });
  }

  // Build metadata
  const metadata: IntakeMetadata = {
    intake_score: relevanceScore,
    intake_mode: mode,
    related_keys: relatedKeys,
    redundancy_flag: redundancy,
    intake_timestamp: now,
  };

  // Strict mode: reject on error-severity flags
  if (mode === "strict") {
    const hasErrors = flags.some((f) => f.severity === "error");
    if (hasErrors) {
      const reasons = flags
        .filter((f) => f.severity === "error")
        .map((f) => f.message);
      return {
        status: "rejected",
        flags,
        metadata,
        rejection_reason: reasons.join(" | "),
      };
    }
  }

  return {
    status: flags.length === 0 ? "accepted" : "flagged",
    flags,
    metadata,
  };
}

/**
 * Evaluate an existing entry retroactively (for memory_audit tool).
 * Does not modify the entry — purely diagnostic.
 */
export function auditEntry(
  db: Database.Database,
  entry: Entry,
): IntakeResult {
  const tags: string[] = JSON.parse(entry.tags);
  return evaluateIntake(db, entry.namespace, entry.key ?? "", entry.content, tags, {
    mode: "advisory",
  });
}

// Re-export constants for testing
export {
  OVERLAP_SCORE_THRESHOLD,
  HIGH_REDUNDANCY_THRESHOLD,
  MAX_NAMESPACE_DEPTH,
  TAG_NOVELTY_THRESHOLD,
  LOW_RELEVANCE_THRESHOLD,
  computeRelevanceScore,
  findRelatedKeys,
  extractQueryTokens,
};
