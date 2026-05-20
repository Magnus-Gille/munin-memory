/**
 * Pure scoring functions for retrieval evaluation.
 * No database dependency — takes result IDs and expected IDs, returns metrics.
 */

export interface ScoringInput {
  resultIds: string[];
  expectedIds: string[];
  /** Optional: ideal rank for each expected ID (1-indexed). Used for NDCG grading. */
  idealRanking?: Record<string, number>;
}

export interface ScoringResult {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  ndcgAt5: number;
  ndcgAt20: number;
  mrr: number;
}

/**
 * Recall at k: fraction of expected entries that appear in the top-k results.
 */
export function recallAtK(resultIds: string[], expectedIds: string[], k: number): number {
  if (expectedIds.length === 0) return 0; // no ground truth = no score
  const topK = new Set(resultIds.slice(0, k));
  const found = expectedIds.filter((id) => topK.has(id)).length;
  return found / expectedIds.length;
}

/**
 * Mean Reciprocal Rank: 1 / rank of the first relevant result.
 * Returns 0 if no relevant result is found.
 */
export function mrr(resultIds: string[], expectedIds: string[]): number {
  const expectedSet = new Set(expectedIds);
  for (let i = 0; i < resultIds.length; i++) {
    if (expectedSet.has(resultIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Discounted Cumulative Gain at k.
 * Uses graded relevance if idealRanking is provided, otherwise binary relevance.
 */
function dcgAtK(
  resultIds: string[],
  expectedIds: string[],
  k: number,
  idealRanking?: Record<string, number>,
): number {
  const expectedSet = new Set(expectedIds);
  let dcg = 0;
  const topK = resultIds.slice(0, k);
  const maxRank = idealRanking ? Math.max(...Object.values(idealRanking)) : 0;

  for (let i = 0; i < topK.length; i++) {
    if (!expectedSet.has(topK[i])) continue;

    // Relevance grade: if idealRanking provided, higher-ranked items get higher grades
    let relevance: number;
    if (idealRanking && idealRanking[topK[i]] !== undefined) {
      // Invert rank to grade: rank 1 → highest grade, rank N → grade 1
      relevance = maxRank - idealRanking[topK[i]] + 1;
    } else {
      relevance = 1; // binary
    }

    dcg += relevance / Math.log2(i + 2); // i+2 because i is 0-indexed, log2(1)=0
  }

  return dcg;
}

/**
 * Normalized Discounted Cumulative Gain at k.
 * Compares actual DCG to ideal DCG (perfect ranking of relevant items).
 */
export function ndcgAtK(
  resultIds: string[],
  expectedIds: string[],
  k: number,
  idealRanking?: Record<string, number>,
): number {
  if (expectedIds.length === 0) return 0; // no ground truth = no score

  const actualDcg = dcgAtK(resultIds, expectedIds, k, idealRanking);

  // Ideal ordering: sort expected IDs by their ideal rank (or arbitrary for binary)
  let idealOrder: string[];
  if (idealRanking) {
    idealOrder = [...expectedIds].sort(
      (a, b) => (idealRanking[a] ?? Infinity) - (idealRanking[b] ?? Infinity),
    );
  } else {
    idealOrder = [...expectedIds];
  }

  const idealDcg = dcgAtK(idealOrder, expectedIds, k, idealRanking);
  if (idealDcg === 0) return 0;

  return actualDcg / idealDcg;
}

/**
 * Compute all standard retrieval metrics for a single query.
 */
export function scoreQuery(input: ScoringInput): ScoringResult {
  return {
    recallAt1: recallAtK(input.resultIds, input.expectedIds, 1),
    recallAt5: recallAtK(input.resultIds, input.expectedIds, 5),
    recallAt10: recallAtK(input.resultIds, input.expectedIds, 10),
    recallAt20: recallAtK(input.resultIds, input.expectedIds, 20),
    ndcgAt5: ndcgAtK(input.resultIds, input.expectedIds, 5, input.idealRanking),
    ndcgAt20: ndcgAtK(input.resultIds, input.expectedIds, 20, input.idealRanking),
    mrr: mrr(input.resultIds, input.expectedIds),
  };
}

/**
 * Aggregate scores across multiple queries (macro-average).
 */
export function aggregateScores(scores: ScoringResult[]): ScoringResult {
  if (scores.length === 0) {
    return {
      recallAt1: 0,
      recallAt5: 0,
      recallAt10: 0,
      recallAt20: 0,
      ndcgAt5: 0,
      ndcgAt20: 0,
      mrr: 0,
    };
  }
  const sum = scores.reduce(
    (acc, s) => ({
      recallAt1: acc.recallAt1 + s.recallAt1,
      recallAt5: acc.recallAt5 + s.recallAt5,
      recallAt10: acc.recallAt10 + s.recallAt10,
      recallAt20: acc.recallAt20 + s.recallAt20,
      ndcgAt5: acc.ndcgAt5 + s.ndcgAt5,
      ndcgAt20: acc.ndcgAt20 + s.ndcgAt20,
      mrr: acc.mrr + s.mrr,
    }),
    {
      recallAt1: 0,
      recallAt5: 0,
      recallAt10: 0,
      recallAt20: 0,
      ndcgAt5: 0,
      ndcgAt20: 0,
      mrr: 0,
    },
  );
  const n = scores.length;
  return {
    recallAt1: sum.recallAt1 / n,
    recallAt5: sum.recallAt5 / n,
    recallAt10: sum.recallAt10 / n,
    recallAt20: sum.recallAt20 / n,
    ndcgAt5: sum.ndcgAt5 / n,
    ndcgAt20: sum.ndcgAt20 / n,
    mrr: sum.mrr / n,
  };
}

/**
 * Compute p50 and p95 of a sorted-ascending number array.
 *
 * Algorithm parity with `src/db.ts:computeP95`:
 *   `idx = clamp(0, n-1, ceil(p * n) - 1)`.
 *
 * Same nearest-rank index for both percentiles — no median-of-two
 * averaging — so PR 0's `memory_status` p95 numbers and the
 * benchmark's `overall_duration` numbers are computed identically.
 * Drift is caught by the parity test in tests/runner-instrumentation.test.ts
 * which imports BOTH this and `computeP95` and checks identical output.
 *
 * Returns nulls for an empty input. Caller is responsible for
 * sorting ascending.
 */
export function percentilesFromDurations(
  sortedAsc: number[],
): { p50_ms: number | null; p95_ms: number | null; total_ms: number } {
  const n = sortedAsc.length;
  if (n === 0) {
    return { p50_ms: null, p95_ms: null, total_ms: 0 };
  }
  const p50Idx = Math.max(0, Math.min(n - 1, Math.ceil(0.5 * n) - 1));
  const p95Idx = Math.max(0, Math.min(n - 1, Math.ceil(0.95 * n) - 1));
  let total = 0;
  for (const d of sortedAsc) total += d;
  return {
    p50_ms: sortedAsc[p50Idx],
    p95_ms: sortedAsc[p95Idx],
    total_ms: total,
  };
}
