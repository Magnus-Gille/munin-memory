import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, getById, initDatabase, writeState } from "../../src/db.js";
import { DEFAULT_SEARCH_RECENCY_WEIGHT } from "../../src/internal/reranker.js";
import { aggregateScores, scoreQuery } from "../scorer.js";
import { runBenchmark } from "../runner.js";
import type { BenchmarkQuery, BenchmarkReport, RunnerMode } from "../types.js";
import { generateDecisionFixture } from "./generator.js";
import { withEvaluationClock } from "./clock.js";
import {
  DECISION_EVAL_CONTRACT_ID,
  DECISION_EVAL_SCHEMA_VERSION,
  type ContinuousEvalModeReport,
  type ContinuousEvalQueryResult,
  type ContinuousEvalReport,
  type DecisionFact,
  type DecisionFixture,
  type DecisionFixtureQuestion,
  type DecisionQuestionVariant,
  type KnownContinuousEvalWarning,
} from "./types.js";

export interface RunContinuousEvalOptions {
  seed?: number;
}

interface PreparedQuery {
  benchmarkQuery: BenchmarkQuery;
  fixtureQuestion: DecisionFixtureQuestion;
  expectedCorpusRef: string;
}

const RUNNER_MODES: readonly RunnerMode[] = ["raw", "production_ranker"];
const VARIANTS: readonly DecisionQuestionVariant[] = ["keyword", "swedish-natural-language"];
const KNOWN_SQLITE_VEC_WARNING_PREFIX = "sqlite-vec unavailable — ran lexical-only.";

function canonicalFixtureBytes(fixture: DecisionFixture): Buffer {
  return Buffer.from(`${JSON.stringify(fixture)}\n`, "utf8");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertUniqueRefs(fixture: DecisionFixture): void {
  const rowRefs = new Set<string>();
  for (const row of fixture.corpus_rows) {
    if (rowRefs.has(row.corpus_ref)) {
      throw new Error(`Fixture contains duplicate corpus reference ${row.corpus_ref}`);
    }
    rowRefs.add(row.corpus_ref);
  }
  const factRefs = new Set(fixture.facts.map((fact) => fact.correct_evidence_id));
  if (factRefs.size !== fixture.facts.length) {
    throw new Error("Fixture facts contain duplicate correct evidence references");
  }
  for (const fact of fixture.facts) {
    if (!rowRefs.has(fact.correct_evidence_id)) {
      throw new Error(`Fixture fact ${fact.case_id} references missing evidence ${fact.correct_evidence_id}`);
    }
  }
}

async function materializeFixture(
  dbPath: string,
  fixture: DecisionFixture,
  omittedCorpusRefs: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const db = initDatabase(dbPath);
  const actualIdByRef = new Map<string, string>();
  try {
    for (const row of fixture.corpus_rows) {
      if (omittedCorpusRefs.has(row.corpus_ref)) continue;
      const writeResult = await withEvaluationClock(row.timestamp, async () => {
        if (row.write_api === "appendLog") {
          return appendLog(db, row.namespace, row.content, row.tags, "continuous-eval");
        }
        return writeState(db, row.namespace, row.key!, row.content, row.tags, "continuous-eval");
      });
      if (!writeResult.id) {
        throw new Error(`Failed to materialize ${row.corpus_ref}: status=${"status" in writeResult ? writeResult.status : "missing_id"}`);
      }
      if (actualIdByRef.has(row.corpus_ref)) {
        throw new Error(`Materialized duplicate corpus reference ${row.corpus_ref}`);
      }
      actualIdByRef.set(row.corpus_ref, writeResult.id);
    }
  } finally {
    db.close();
  }
  return actualIdByRef;
}

function prepareQueries(fixture: DecisionFixture, actualIdByRef: ReadonlyMap<string, string>): PreparedQuery[] {
  const factByCase = new Map(fixture.facts.map((fact) => [fact.case_id, fact] as const));
  return fixture.questions.map((question) => {
    const fact = factByCase.get(question.case_id);
    if (!fact) throw new Error(`Question ${question.id} has no structured fact`);
    const expectedCorpusRef = fact.correct_evidence_id;
    if (question.expected_corpus_refs.length !== 1 || question.expected_corpus_refs[0] !== expectedCorpusRef) {
      throw new Error(`Question ${question.id} label does not match fact ${question.case_id}`);
    }
    const expectedId = actualIdByRef.get(expectedCorpusRef);
    if (!expectedId) throw new Error(`Question ${question.id} evidence was not materialized`);
    return {
      fixtureQuestion: question,
      expectedCorpusRef,
      benchmarkQuery: {
        id: question.id,
        query: question.query,
        source: "synthetic",
        category: "decision-lookup",
        search_mode: "lexical",
        expected_ids: [expectedId],
      },
    };
  });
}

function assertRunnerReport(
  report: BenchmarkReport,
  mode: RunnerMode,
  questionCount: number,
  expectedEntryCount: number,
  preparedQueries: readonly PreparedQuery[],
): KnownContinuousEvalWarning[] {
  if (report.runner_mode_requested !== mode || report.runner_mode !== mode) {
    throw new Error(
      `Runner mode mismatch: requested=${mode}, reported=${report.runner_mode_requested}, effective=${report.runner_mode}`,
    );
  }
  if (report.query_count !== questionCount || report.evaluation_count !== questionCount || report.queries.length !== questionCount) {
    throw new Error(
      `Runner count mismatch: expected ${questionCount}, got query_count=${report.query_count}, evaluation_count=${report.evaluation_count}, query_rows=${report.queries.length}`,
    );
  }
  if (report.entry_count !== expectedEntryCount) {
    throw new Error(`Runner corpus count mismatch: expected ${expectedEntryCount}, got ${report.entry_count}`);
  }
  const preparedById = new Map(preparedQueries.map((prepared) => [prepared.benchmarkQuery.id, prepared]));
  const seenQueryIds = new Set<string>();
  for (const result of report.queries) {
    const prepared = preparedById.get(result.query_id);
    if (!prepared || seenQueryIds.has(result.query_id)) {
      throw new Error(`Runner returned an unexpected or duplicate query id ${result.query_id}`);
    }
    seenQueryIds.add(result.query_id);
    if (result.search_mode !== "lexical" || (result.actual_mode !== undefined && result.actual_mode !== "lexical")) {
      throw new Error(`Query ${result.query_id} did not execute in lexical mode`);
    }
    const expectedIds = prepared.benchmarkQuery.expected_ids ?? [];
    if (result.expected_ids.length !== expectedIds.length || result.expected_ids.some((id, index) => id !== expectedIds[index])) {
      throw new Error(`Runner changed expected evidence IDs for ${result.query_id}`);
    }
  }
  if (seenQueryIds.size !== questionCount) throw new Error("Runner omitted one or more questions");

  if (mode === "production_ranker" && report.search_recency_weight !== DEFAULT_SEARCH_RECENCY_WEIGHT) {
    throw new Error(`Production ranker recency weight changed: expected ${DEFAULT_SEARCH_RECENCY_WEIGHT}, got ${report.search_recency_weight}`);
  }
  if (mode === "raw" && report.search_recency_weight !== null) {
    throw new Error(`Raw mode unexpectedly reported recency weight ${report.search_recency_weight}`);
  }

  const knownWarnings: KnownContinuousEvalWarning[] = [];
  for (const warning of report.warnings ?? []) {
    if (warning.startsWith(KNOWN_SQLITE_VEC_WARNING_PREFIX)) {
      knownWarnings.push("sqlite_vec_unavailable_lexical_only");
      continue;
    }
    throw new Error(`Unexpected benchmark warning: ${warning}`);
  }
  return knownWarnings;
}

function aggregateVariantScores(
  report: BenchmarkReport,
  preparedQueries: readonly PreparedQuery[],
): Record<DecisionQuestionVariant, ReturnType<typeof aggregateScores>> {
  const resultById = new Map(report.queries.map((result) => [result.query_id, result] as const));
  const output = {} as Record<DecisionQuestionVariant, ReturnType<typeof aggregateScores>>;
  for (const variant of VARIANTS) {
    const scores = preparedQueries
      .filter((prepared) => prepared.fixtureQuestion.variant === variant)
      .map((prepared) => {
        const result = resultById.get(prepared.benchmarkQuery.id);
        if (!result) throw new Error(`Missing result for ${prepared.benchmarkQuery.id}`);
        return result.scores;
      });
    if (scores.length === 0) throw new Error(`Fixture contains no ${variant} questions`);
    output[variant] = aggregateScores(scores);
  }
  return output;
}

function normalizeModeReport(
  report: BenchmarkReport,
  mode: RunnerMode,
  preparedQueries: readonly PreparedQuery[],
  actualIdByRef: ReadonlyMap<string, string>,
  knownWarnings: KnownContinuousEvalWarning[],
): ContinuousEvalModeReport {
  const corpusRefByActualId = new Map([...actualIdByRef.entries()].map(([ref, id]) => [id, ref] as const));
  const preparedById = new Map(preparedQueries.map((prepared) => [prepared.benchmarkQuery.id, prepared] as const));
  const perCase: ContinuousEvalQueryResult[] = report.queries.map((result) => {
    const prepared = preparedById.get(result.query_id);
    if (!prepared) throw new Error(`No prepared label for returned query ${result.query_id}`);
    const rankedRefs = result.result_ids.map((id) => {
      const ref = corpusRefByActualId.get(id);
      if (!ref) throw new Error(`Runner returned unmapped entry for ${result.query_id}`);
      return ref;
    });
    const rankIndex = rankedRefs.indexOf(prepared.expectedCorpusRef);
    return {
      query_id: result.query_id,
      case_id: prepared.fixtureQuestion.case_id,
      variant: prepared.fixtureQuestion.variant,
      expected_corpus_ref: prepared.expectedCorpusRef,
      ranked_corpus_refs: rankedRefs,
      rank: rankIndex < 0 ? null : rankIndex + 1,
      scores: result.scores,
    };
  });
  return {
    runner_mode: mode,
    effective_search_mode: "lexical",
    search_recency_weight: report.search_recency_weight,
    overall: report.overall,
    by_variant: aggregateVariantScores(report, preparedQueries),
    per_case: perCase,
    known_warnings: [...new Set(knownWarnings)],
  };
}

function buildMetrics(modes: ContinuousEvalReport["modes"]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const mode of RUNNER_MODES) {
    const report = modes[mode];
    const buckets = {
      overall: report.overall,
      keyword: report.by_variant.keyword,
      swedish_natural_language: report.by_variant["swedish-natural-language"],
    };
    for (const [bucketName, scores] of Object.entries(buckets)) {
      metrics[`${mode}.${bucketName}.recall_at_1`] = scores.recallAt1;
      metrics[`${mode}.${bucketName}.recall_at_5`] = scores.recallAt5;
      metrics[`${mode}.${bucketName}.mrr`] = scores.mrr;
    }
  }
  return metrics;
}

function assertZeroRecall(scores: ReturnType<typeof aggregateScores>, label: string): void {
  if (scores.recallAt1 !== 0 || scores.recallAt5 !== 0 || scores.recallAt10 !== 0 || scores.recallAt20 !== 0 || scores.mrr !== 0) {
    throw new Error(`${label} evidence-removal control did not collapse recall and MRR`);
  }
}

/**
 * Score the evidence-removed run on corpus refs, not DB IDs: every question must
 * still return results, and none may be a removed evidence row. Returns the
 * minimum number of results returned for any question.
 */
export function assertEvidenceRemoved(
  perCase: readonly ContinuousEvalQueryResult[],
  evidenceRefs: ReadonlySet<string>,
  label: string,
): number {
  let minResults = Number.POSITIVE_INFINITY;
  for (const result of perCase) {
    if (result.ranked_corpus_refs.length === 0) {
      throw new Error(`${label} evidence-removal control returned no results for ${result.query_id}`);
    }
    if (result.ranked_corpus_refs.some((ref) => evidenceRefs.has(ref))) {
      throw new Error(`${label} evidence-removal control returned a removed evidence row for ${result.query_id}`);
    }
    minResults = Math.min(minResults, result.ranked_corpus_refs.length);
  }
  if (!Number.isFinite(minResults)) throw new Error(`${label} evidence-removal control scored no questions`);
  return minResults;
}

/** Confirm a gold row read back from the database is the decision the fact describes. */
export function assertGoldRow(
  fact: DecisionFact,
  row: { namespace: string; entry_type: string; content: string },
): void {
  if (row.namespace !== fact.namespace) {
    throw new Error(`Gold row for ${fact.case_id} has the wrong namespace`);
  }
  if (row.entry_type !== "log") {
    throw new Error(`Gold row for ${fact.case_id} is not a log entry`);
  }
  if (!row.content.includes(fact.chosen_option)) {
    throw new Error(`Gold row for ${fact.case_id} does not contain the chosen option`);
  }
  if (!row.content.includes(fact.rejected_option)) {
    throw new Error(`Gold row for ${fact.case_id} does not contain the rejected option`);
  }
  if (!row.content.includes(fact.case_id)) {
    throw new Error(`Gold row for ${fact.case_id} does not contain its case id`);
  }
}

function verifyGoldRows(
  dbPath: string,
  fixture: DecisionFixture,
  actualIdByRef: ReadonlyMap<string, string>,
): number {
  const db = initDatabase(dbPath);
  try {
    for (const fact of fixture.facts) {
      const id = actualIdByRef.get(fact.correct_evidence_id);
      const row = id ? getById(db, id) : null;
      if (!row) throw new Error(`Gold row for ${fact.case_id} was not found in the database`);
      assertGoldRow(fact, row);
    }
  } finally {
    db.close();
  }
  return fixture.facts.length;
}

function assertOracleScores(scores: ReturnType<typeof aggregateScores>, questionCount: number): void {
  if (
    scores.recallAt1 !== 1 ||
    scores.recallAt5 !== 1 ||
    scores.recallAt10 !== 1 ||
    scores.recallAt20 !== 1 ||
    scores.ndcgAt5 !== 1 ||
    scores.ndcgAt20 !== 1 ||
    scores.mrr !== 1 ||
    questionCount === 0
  ) {
    throw new Error("Direct-ID scorer oracle control failed");
  }
}

/** Run the fixed lexical retrieval fixture without reading or changing live memory. */
export async function runContinuousEval(
  options: RunContinuousEvalOptions = {},
): Promise<ContinuousEvalReport> {
  const fixture = generateDecisionFixture(options.seed);
  assertUniqueRefs(fixture);
  const fixtureBytes = canonicalFixtureBytes(fixture);
  const fixtureSha256 = sha256(fixtureBytes);
  const questionCount = fixture.questions.length;
  if (questionCount !== 24) throw new Error(`Decision fixture denominator changed: expected 24, got ${questionCount}`);

  const querySetSources = [{
    path: `generated://${DECISION_EVAL_CONTRACT_ID}/${fixtureSha256}`,
    filename: `decision-fixture-${fixtureSha256.slice(0, 12)}.json`,
    record_count: questionCount,
    sha256: fixtureSha256,
    bytes: fixtureBytes.byteLength,
    manifest_match: "manifest_not_provided" as const,
  }];
  const tempDir = await mkdtemp(join(tmpdir(), "munin-continuous-eval-"));
  try {
    const positiveDbPath = join(tempDir, "positive.db");
    const positiveIdByRef = await materializeFixture(positiveDbPath, fixture);
    const goldRowCount = verifyGoldRows(positiveDbPath, fixture, positiveIdByRef);
    const preparedQueries = prepareQueries(fixture, positiveIdByRef);
    if (preparedQueries.length !== questionCount) throw new Error("Prepared query denominator changed");
    const benchmarkQueries = preparedQueries.map((prepared) => prepared.benchmarkQuery);
    const positiveModeReports = {} as ContinuousEvalReport["modes"];

    for (const mode of RUNNER_MODES) {
      const report = await withEvaluationClock(fixture.fixed_now, async () => runBenchmark(
        positiveDbPath,
        benchmarkQueries,
        {
          runnerMode: mode,
          manifestPath: null,
          querySetSources,
        },
      ));
      const knownWarnings = assertRunnerReport(
        report,
        mode,
        questionCount,
        fixture.corpus_rows.length,
        preparedQueries,
      );
      positiveModeReports[mode] = normalizeModeReport(
        report,
        mode,
        preparedQueries,
        positiveIdByRef,
        knownWarnings,
      );
    }

    const evidenceRefs = new Set(fixture.facts.map((fact) => fact.correct_evidence_id));
    const expectedNegativeEntryCount = fixture.corpus_rows.length - evidenceRefs.size;
    const negativeDbPath = join(tempDir, "evidence-removed.db");
    const negativeIdByRef = await materializeFixture(negativeDbPath, fixture, evidenceRefs);
    if (negativeIdByRef.size !== expectedNegativeEntryCount) {
      throw new Error(`Evidence-removal corpus count mismatch: expected ${expectedNegativeEntryCount}, got ${negativeIdByRef.size}`);
    }
    if ([...evidenceRefs].some((ref) => negativeIdByRef.has(ref))) {
      throw new Error("Evidence-removal control retained a required evidence row");
    }

    const negativeScores = {} as Record<RunnerMode, ReturnType<typeof aggregateScores>>;
    const negativeMinResults = {} as Record<RunnerMode, number>;
    for (const mode of RUNNER_MODES) {
      const report = await withEvaluationClock(fixture.fixed_now, async () => runBenchmark(
        negativeDbPath,
        benchmarkQueries,
        {
          runnerMode: mode,
          manifestPath: null,
          querySetSources,
        },
      ));
      const knownWarnings = assertRunnerReport(
        report,
        mode,
        questionCount,
        expectedNegativeEntryCount,
        preparedQueries,
      );
      // Normalize every retrieved negative-control ID too; unmapped results fail closed.
      // Gold IDs differ between databases, so the falsifiable check scores on corpus refs.
      const negativeReport = normalizeModeReport(report, mode, preparedQueries, negativeIdByRef, knownWarnings);
      negativeMinResults[mode] = assertEvidenceRemoved(negativeReport.per_case, evidenceRefs, mode);
      assertZeroRecall(report.overall, mode);
      negativeScores[mode] = report.overall;
    }

    const scorerOracleScores = aggregateScores(preparedQueries.map((prepared) => {
      const expectedIds = prepared.benchmarkQuery.expected_ids ?? [];
      return scoreQuery({ resultIds: [...expectedIds], expectedIds: [...expectedIds] });
    }));
    assertOracleScores(scorerOracleScores, questionCount);

    const modes = positiveModeReports;
    return {
      schema_version: DECISION_EVAL_SCHEMA_VERSION,
      status: "measured",
      contract_id: DECISION_EVAL_CONTRACT_ID,
      fixture_sha256: fixtureSha256,
      seed: fixture.seed,
      question_count: questionCount,
      modes,
      metrics: buildMetrics(modes),
      controls: {
        evidence_removed: {
          passed: true,
          question_count: questionCount,
          removed_evidence_count: evidenceRefs.size,
          min_results_per_question: negativeMinResults,
          raw: negativeScores.raw,
          production_ranker: negativeScores.production_ranker,
        },
        gold_integrity: {
          passed: true,
          checked_row_count: goldRowCount,
        },
        scorer_oracle: {
          passed: true,
          question_count: questionCount,
          scores: scorerOracleScores,
        },
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
