import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkQuery } from "../benchmark/types.js";
import {
  loadScorecardContract,
  bootstrapMeanInterval,
  preflightScorecardQueries,
  runScorecard,
  validateScorecardAnswerQualityReport,
  validateScorecardRetrievalReport,
  validateScorecardContract,
  withScorecardRetry,
} from "../benchmark/scorecard/run.js";
import { runDeterministicTrustLanes } from "../benchmark/scorecard/trust-lanes.js";
import { validatePublicationReport } from "../benchmark/scorecard/publish.js";
import { OpenRouterHttpError } from "../src/internal/openrouter.js";
import type { MuninAgentMemoryScorecardReport } from "../benchmark/scorecard/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("Phase A scorecard contract", () => {
  it("loads the publication-candidate v2 contract with enforced evidence gates", () => {
    const { contract, sha256 } = loadScorecardContract();

    expect(contract.contract_schema_version).toBe(2);
    expect(contract.contract_id).toBe("munin-longmemeval-s-e2e-v2");
    expect(contract.dataset.expected_full_question_count).toBe(500);
    expect(contract.profiles.smoke.publication_eligible).toBe(false);
    expect(contract.profiles.full.publication_eligible).toBe(true);
    expect(contract.context_budget.retrieved_token_budget).toBe(8192);
    expect(contract.context_budget.estimator).toBe("utf8_bytes_div4_ceil_v1");
    expect(contract.profiles.full.reader.model).toBe("anthropic/claude-haiku-4.5");
    expect(contract.profiles.full.judge.model).toBe("anthropic/claude-sonnet-4.5");
    expect(contract.uncertainty).toMatchObject({
      method: "deterministic_bootstrap_percentile_95",
      confidence: 0.95,
      resamples: 2000,
      seed: 227,
    });
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
      contract_schema_version: 3,
    })).toThrow(/unsupported.*schema/i);
    expect(() => validateScorecardContract({
      ...contract,
      profiles: {
        ...contract.profiles,
        full: { ...contract.profiles.full, publication_eligible: false },
      },
    })).toThrow(/full profile must be publication eligible/i);
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

  it("computes deterministic uncertainty intervals", () => {
    const first = bootstrapMeanInterval([1, 1, 0, 1, 0], {
      confidence: 0.95,
      resamples: 2000,
      seed: 227,
    });
    const second = bootstrapMeanInterval([1, 1, 0, 1, 0], {
      confidence: 0.95,
      resamples: 2000,
      seed: 227,
    });

    expect(first).toEqual(second);
    expect(first.point_estimate).toBe(0.6);
    expect(first.lower).toBeGreaterThanOrEqual(0);
    expect(first.upper).toBeLessThanOrEqual(1);
    expect(first.lower).toBeLessThanOrEqual(first.point_estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.point_estimate);
  });

  it("runs deterministic authorization and poison-structure lanes", async () => {
    const report = await runDeterministicTrustLanes();

    expect(report.authorization.status).toBe("pass");
    expect(report.instruction_shaped_content.status).toBe("pass");
    expect(report.overall_pass).toBe(true);
  });

  it("retries explicit 429/503 and narrow fetch transport failures", async () => {
    const delays: number[] = [];
    const retries: Array<{ reason: string; attempt: number }> = [];
    const transient = vi.fn()
      .mockRejectedValueOnce(new OpenRouterHttpError(429, "rate limited", 2500))
      .mockRejectedValueOnce(new OpenRouterHttpError(503, "unavailable"))
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockResolvedValue({
        choices: [{ message: { content: "ok" } }],
      });
    const retried = withScorecardRetry(transient, {
      maxAttempts: 4,
      wait: async (delayMs) => { delays.push(delayMs); },
      onRetry: (event) => { retries.push(event); },
    });
    const call = {
      model: "test/model",
      messages: [{ role: "user" as const, content: "test" }],
    };

    await expect(retried(call)).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });
    expect(transient).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([2500, 2000, 4000]);
    expect(retries).toEqual([
      { reason: "http_429", attempt: 1 },
      { reason: "http_503", attempt: 2 },
      { reason: "transport_terminated", attempt: 3 },
    ]);

    for (const error of [
      new OpenRouterHttpError(401, "unauthorized"),
      new OpenRouterHttpError(408, "timeout"),
      new Error("terminated"),
      new TypeError("invalid_argument"),
    ]) {
      const noRetryCall = vi.fn().mockRejectedValue(error);
      const noRetry = withScorecardRetry(noRetryCall, {
        maxAttempts: 4,
        wait: async () => undefined,
      });
      await expect(noRetry(call)).rejects.toThrow();
      expect(noRetryCall).toHaveBeenCalledTimes(1);
    }
  });

  it("caps a provider Retry-After delay so a bad header cannot stall the run", async () => {
    const delays: number[] = [];
    const capped = vi.fn()
      .mockRejectedValueOnce(new OpenRouterHttpError(429, "rate limited", 100_000_000))
      .mockResolvedValue({
        choices: [{ message: { content: "ok" } }],
      });
    const retried = withScorecardRetry(capped, {
      maxAttempts: 2,
      wait: async (delayMs) => { delays.push(delayMs); },
    });

    await expect(retried({
      model: "test/model",
      messages: [{ role: "user" as const, content: "test" }],
    })).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });
    expect(delays).toEqual([60_000]);
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
    expect(report.report_schema_version).toBe(2);
    expect(report.profile).toBe("deterministic_pipeline_smoke");
    expect(report.publication_eligible).toBe(false);
    expect(report.publication_status).toBe("pipeline_smoke");
    expect(report.retrieval.report_schema_version).toBe(3);
    expect(report.answer_quality.report_kind).toBe("answer_quality");
    expect(report.answer_quality.report_schema_version).toBe(3);
    expect(report.answer_quality.answer_temperature).toBe(0);
    expect(report.answer_quality.answer_max_output_tokens).toBe(128);
    expect(report.answer_quality.judge_temperature).toBe(0);
    expect(report.answer_quality.judge_max_output_tokens).toBe(128);
    expect(report.retrieval.query_count).toBe(2);
    expect(report.answer_quality.query_count).toBe(2);
    expect(report.answer_quality.skipped_no_reference).toBe(0);
    expect(report.answer_quality.overall_accuracy).toBe(1);
    expect(report.answer_quality.judge_parse_failures).toBe(0);
    expect(report.evidence.trust_lanes.authorization.status).toBe("pass");
    expect(report.evidence.trust_lanes.instruction_shaped_content.status).toBe("pass");
    expect(report.evidence.environment.node_version).toBe(process.version);
    expect(report.evidence.stage_duration_ms.total).toBeGreaterThanOrEqual(0);
    expect(report.evidence.resources.peak_rss_bytes).toBeGreaterThan(0);
    expect(report.evidence.disk.total_artifact_bytes).toBeGreaterThan(0);
    expect(report.evidence.cost_usd).toBe(0);
    expect(report.evidence.retries).toEqual({
      total: 0,
      http_429: 0,
      http_503: 0,
      transport_fetch_failed: 0,
      transport_terminated: 0,
    });
    expect(report.evidence.artifacts.reused_existing).toBe(false);
    expect(report.uncertainty.answer_accuracy.point_estimate).toBe(1);
    expect(report.retrieval.query_set_sources[0].sha256).toBe(
      report.answer_quality.query_set_sources[0].sha256,
    );
    expect(report.retrieval.snapshot_path).not.toContain(process.cwd());
    expect(report.answer_quality.snapshot_path).not.toContain(process.cwd());
    expect(report.retrieval.query_set_sources[0].path).not.toContain(process.cwd());
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not a publishable quality result/i),
        expect.stringMatching(/fixture-specific/i),
      ]),
    );

    const persisted = JSON.parse(readFileSync(reportPath, "utf-8")) as {
      publication_eligible: boolean;
      profile: string;
    };
    expect(persisted.publication_eligible).toBe(false);
    expect(persisted.profile).toBe("deterministic_pipeline_smoke");
    expect(() => validatePublicationReport(report)).toThrow(
      /not an eligible.*publication candidate/i,
    );

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

    const resumed = await runScorecard({
      profile: "smoke",
      artifactDir,
      reportDir,
    });
    expect(resumed.report.evidence.artifacts.reused_existing).toBe(true);
    expect(resumed.report.limitations).toContain(
      "Generated benchmark artifacts were reused after exact provenance validation; ingestion and embedding durations cover only this resumed process, not the original artifact build.",
    );
  });

  it("revalidates raw full-run evidence instead of trusting aggregate counters", async () => {
    mkdirSync(resolve("benchmark/generated"), { recursive: true });
    mkdirSync(resolve("benchmark/reports"), { recursive: true });
    const artifactDir = mkdtempSync(
      resolve("benchmark/generated/scorecard-publication-test-"),
    );
    const reportDir = mkdtempSync(
      resolve("benchmark/reports/scorecard-publication-test-"),
    );
    tempDirs.push(artifactDir, reportDir);
    const { report: smoke } = await runScorecard({
      profile: "smoke",
      artifactDir,
      reportDir,
    });
    const retrievalTemplate = smoke.retrieval.queries[0]!;
    const answerTemplate = smoke.answer_quality.results[0]!;
    const candidate = structuredClone(smoke) as MuninAgentMemoryScorecardReport;
    candidate.profile = "longmemeval_s_full_on_demand";
    candidate.publication_status = "publication_candidate";
    candidate.publication_eligible = true;
    candidate.retrieval.runner_mode = "production_ranker";
    candidate.retrieval.runner_mode_requested = "production_ranker";
    candidate.retrieval.query_count = 500;
    candidate.retrieval.evaluation_count = 500;
    candidate.retrieval.queries = Array.from({ length: 500 }, (_, index) => ({
      ...retrievalTemplate,
      query_id: `publication-q-${index}`,
      search_mode: "hybrid",
      actual_mode: undefined,
    }));
    candidate.answer_quality.runner_mode = "production_ranker";
    candidate.answer_quality.search_mode = "hybrid";
    candidate.answer_quality.answer_model = "anthropic/claude-haiku-4.5";
    candidate.answer_quality.judge_model = "anthropic/claude-sonnet-4.5";
    candidate.answer_quality.query_count = 500;
    candidate.answer_quality.results = Array.from({ length: 500 }, (_, index) => ({
      ...answerTemplate,
      query_id: `publication-q-${index}`,
      effective_search_mode: "hybrid",
      answer_call: {
        ...answerTemplate.answer_call!,
        requested_model: "anthropic/claude-haiku-4.5",
      },
      judge_call: {
        ...answerTemplate.judge_call!,
        requested_model: "anthropic/claude-sonnet-4.5",
      },
      answer_usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
      judge_usage: { prompt_tokens: 8, completion_tokens: 3, cost: 0.002 },
    }));
    candidate.answer_quality.total_usage = {
      prompt_tokens: 9000,
      completion_tokens: 2500,
      cost: 1.5,
    };
    candidate.answer_quality.execution_identity.requested_answer_model =
      "anthropic/claude-haiku-4.5";
    candidate.answer_quality.execution_identity.requested_judge_model =
      "anthropic/claude-sonnet-4.5";
    candidate.answer_quality.usage_accounting = {
      expected_calls: 1000,
      usage_reported_calls: 1000,
      cost_reported_calls: 1000,
    };
    candidate.answer_quality.execution_identity.missing_identity_calls = 0;
    candidate.evidence.environment.git_dirty = false;
    candidate.evidence.environment.git_commit = "a".repeat(40);
    candidate.evidence.trust_lanes.live_poison = {
      status: "pass",
      expected_fact: "ORIOLE",
      forbidden_attacker_value: "PWNED",
      answer: "ORIOLE",
      call_identity: {
        requested_model: "test/model",
        response_model: "test/model",
        provider: "test-provider",
        generation_id: "poison-generation",
      },
      usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.004 },
    };
    candidate.evidence.trust_lanes.overall_pass = true;
    candidate.evidence.cost_usd = 1.504;

    expect(validatePublicationReport(candidate)).toBe(candidate);

    const explicitlyDegraded = structuredClone(candidate);
    explicitlyDegraded.retrieval.queries[237]!.actual_mode = "lexical";
    expect(() => validatePublicationReport(explicitlyDegraded)).toThrow(
      /degraded or non-hybrid/i,
    );

    const missingRawCost = structuredClone(candidate);
    delete missingRawCost.answer_quality.results[237]!.judge_usage!.cost;
    expect(() => validatePublicationReport(missingRawCost)).toThrow(
      /publication-q-237.*judge.*cost/i,
    );

    const wrongContract = structuredClone(candidate);
    wrongContract.contract_sha256 = "0".repeat(64);
    expect(() => validatePublicationReport(wrongContract)).toThrow(
      /contract hash/i,
    );
  });
});
