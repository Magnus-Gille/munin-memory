import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BenchmarkQuery } from "../benchmark/types.js";
import {
  loadScorecardContract,
  preflightScorecardQueries,
  runScorecard,
  validateScorecardAnswerQualityReport,
  validateScorecardRetrievalReport,
  validateScorecardContract,
} from "../benchmark/scorecard/run.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("Phase A scorecard contract", () => {
  it("loads a versioned contract with explicit unpublished limitations", () => {
    const { contract, sha256 } = loadScorecardContract();

    expect(contract.contract_schema_version).toBe(1);
    expect(contract.contract_id).toBe("munin-longmemeval-s-e2e-v1");
    expect(contract.dataset.expected_full_question_count).toBe(500);
    expect(contract.profiles.smoke.publication_eligible).toBe(false);
    expect(contract.profiles.full.publication_eligible).toBe(false);
    expect(contract.context_budget.retrieved_token_budget).toBeNull();
    expect(contract.context_budget.limitation).toMatch(/not yet enforced/i);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an incomplete full query set before any model call", () => {
    const query: BenchmarkQuery = {
      id: "q-1",
      query: "What happened?",
      source: "derived",
      category: "longmemeval/test",
      search_mode: "hybrid",
      expected_ids: ["entry-1"],
      reference_answer: "Something happened",
    };

    expect(() => preflightScorecardQueries([query], "full", 500)).toThrow(
      /expected exactly 500 questions/i,
    );
  });

  it("rejects schema drift and any publication-eligible foundation profile", () => {
    const { contract } = loadScorecardContract();
    expect(() => validateScorecardContract({
      ...contract,
      contract_schema_version: 2,
    })).toThrow(/unsupported.*schema/i);
    expect(() => validateScorecardContract({
      ...contract,
      profiles: {
        ...contract.profiles,
        smoke: { ...contract.profiles.smoke, publication_eligible: true },
      },
    })).toThrow(/must not be publication eligible/i);
  });

  it("rejects unsupported execution config and malformed model knobs", () => {
    const { contract } = loadScorecardContract();
    type MutableProfile = {
      granularity: unknown;
      runner_mode: unknown;
      search_mode: unknown;
      serialization: unknown;
      limit: unknown;
      reader: { model: unknown; temperature: unknown; max_output_tokens: unknown };
    };
    type MutableContract = { profiles: { smoke: MutableProfile; full: MutableProfile } };
    const mutateAndValidate = (mutate: (value: MutableContract) => void) => {
      const candidate = structuredClone(contract) as unknown as MutableContract;
      mutate(candidate);
      return () => validateScorecardContract(candidate);
    };

    expect(mutateAndValidate((value) => { value.profiles.smoke.granularity = "round"; }))
      .toThrow(/session granularity/i);
    expect(mutateAndValidate((value) => { value.profiles.full.search_mode = "semantic"; }))
      .toThrow(/production-ranker hybrid/i);
    expect(mutateAndValidate((value) => { value.profiles.smoke.runner_mode = "production_ranker"; }))
      .toThrow(/deterministic.*lexical.*raw/i);
    expect(mutateAndValidate((value) => { value.profiles.full.serialization = "boundary"; }))
      .toThrow(/linear serialization/i);
    expect(mutateAndValidate((value) => { value.profiles.smoke.limit = null; }))
      .toThrow(/deterministic.*fixture/i);
    expect(mutateAndValidate((value) => { value.profiles.full.reader.model = "  "; }))
      .toThrow(/model must be a non-empty string/i);
    expect(mutateAndValidate((value) => { value.profiles.full.reader.temperature = Number.NaN; }))
      .toThrow(/finite number/i);
    expect(mutateAndValidate((value) => { value.profiles.full.reader.max_output_tokens = 0; }))
      .toThrow(/positive safe integer/i);
  });

  it("rejects a query set with missing reference answers", () => {
    const query: BenchmarkQuery = {
      id: "q-1",
      query: "What happened?",
      source: "derived",
      category: "longmemeval/test",
      search_mode: "lexical",
      expected_ids: ["entry-1"],
    };

    expect(() => preflightScorecardQueries([query], "smoke", 1)).toThrow(
      /missing reference_answer.*q-1/i,
    );
  });

  it("rejects missing question dates and duplicate IDs", () => {
    const valid: BenchmarkQuery = {
      id: "q-1",
      query: "What happened?",
      source: "derived",
      category: "longmemeval/test",
      search_mode: "lexical",
      expected_ids: ["entry-1"],
      reference_answer: "Something happened",
      question_date: "2026/07/22 12:00",
      scope_namespace: "benchmarks/longmemeval/s/q/q-1",
    };

    expect(() => preflightScorecardQueries([
      { ...valid, question_date: undefined },
    ], "smoke", 1)).toThrow(/missing question_date.*q-1/i);
    expect(() => preflightScorecardQueries([
      valid,
      { ...valid },
    ], "smoke", 2)).toThrow(/duplicate query IDs.*q-1/i);
  });
});

describe("deterministic scorecard smoke", () => {
  it("runs both shipped harnesses offline and can never be publication eligible", async () => {
    mkdirSync(resolve("benchmark/generated"), { recursive: true });
    mkdirSync(resolve("benchmark/reports"), { recursive: true });
    const artifactDir = mkdtempSync(
      resolve("benchmark/generated/scorecard-test-"),
    );
    const reportDir = mkdtempSync(
      resolve("benchmark/reports/scorecard-test-"),
    );
    tempDirs.push(artifactDir, reportDir);

    const { report, reportPath } = await runScorecard({
      profile: "smoke",
      artifactDir,
      reportDir,
    });

    expect(report.report_kind).toBe("munin_agent_memory_scorecard");
    expect(report.report_schema_version).toBe(1);
    expect(report.profile).toBe("deterministic_pipeline_smoke");
    expect(report.publication_eligible).toBe(false);
    expect(report.publication_status).toBe("unpublished_foundation");
    expect(report.retrieval.report_schema_version).toBe(3);
    expect(report.answer_quality.report_kind).toBe("answer_quality");
    expect(report.answer_quality.report_schema_version).toBe(2);
    expect(report.answer_quality.answer_temperature).toBe(0);
    expect(report.answer_quality.answer_max_output_tokens).toBe(128);
    expect(report.answer_quality.judge_temperature).toBe(0);
    expect(report.answer_quality.judge_max_output_tokens).toBe(128);
    expect(report.retrieval.query_count).toBe(2);
    expect(report.answer_quality.query_count).toBe(2);
    expect(report.answer_quality.skipped_no_reference).toBe(0);
    expect(report.answer_quality.overall_accuracy).toBe(1);
    expect(report.answer_quality.judge_parse_failures).toBe(0);
    expect(report.retrieval.query_set_sources[0].sha256).toBe(
      report.answer_quality.query_set_sources[0].sha256,
    );
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not a publishable quality result/i),
        expect.stringMatching(/token budget/i),
      ]),
    );

    const persisted = JSON.parse(readFileSync(reportPath, "utf-8")) as {
      publication_eligible: boolean;
      profile: string;
    };
    expect(persisted.publication_eligible).toBe(false);
    expect(persisted.profile).toBe("deterministic_pipeline_smoke");

    expect(() => validateScorecardAnswerQualityReport(
      { ...report.answer_quality, judge_parse_failures: 1 },
      "smoke",
      2,
      "lexical",
    )).toThrow(/malformed judge responses/i);
    expect(() => validateScorecardAnswerQualityReport(
      {
        ...report.answer_quality,
        results: [
          { ...report.answer_quality.results[0], answer_error: "provider unavailable" },
          ...report.answer_quality.results.slice(1),
        ],
      },
      "smoke",
      2,
      "lexical",
    )).toThrow(/reader\/judge execution failures/i);
    expect(() => validateScorecardRetrievalReport(
      {
        ...report.retrieval,
        queries: [
          { ...report.retrieval.queries[0], actual_mode: "lexical" },
          ...report.retrieval.queries.slice(1),
        ],
      },
      "smoke",
      2,
      "hybrid",
      "raw",
    )).toThrow(/retrieval mode degraded/i);
  });
});
