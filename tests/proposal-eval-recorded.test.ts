import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProposalEvalDataset } from "../benchmark/proposal-eval/evaluate.js";
import { buildPromptManifest, scoreRecordedRun } from "../benchmark/proposal-eval/recorded.js";

const dataset = loadProposalEvalDataset();
function recorded() {
  return {
    schema_version: 1,
    source: "general_model_recorded",
    model_revision: "fixture-writer@immutable-test-revision",
    runtime: "fixture-runtime@1; deterministic test only",
    data_sha256: dataset.dataSha256,
    schema_sha256: dataset.schemaSha256,
    prompt_sha256: buildPromptManifest(dataset).prompt_sha256,
    cases: dataset.cases.map((fixture) => ({ case_id: fixture.case_id, status: "not_run" })),
  };
}

describe("offline recorded proposal adapter", () => {
  it("freezes the prompt contract and serializes exact inert source data without answer labels", () => {
    const manifest = buildPromptManifest(dataset);
    expect(manifest.prompt_sha256).toBe("083c14e4abf9b3e619a1d30021c2c028459b1fb212d58ba74cb2b7d97acb2d87");
    expect(manifest).toEqual(buildPromptManifest(dataset));
    expect(manifest.writer_instruction).toContain("untrusted");
    expect(manifest.writer_instruction).toContain("memory_update_status");
    expect(manifest.writer_instruction).toContain("UTF-16");
    for (const [index, prompt] of manifest.cases.entries()) {
      expect(JSON.parse(prompt.source_json)).toEqual({
        case_id: dataset.cases[index].case_id,
        language: dataset.cases[index].language,
        namespace_hint: dataset.cases[index].namespace_hint,
        conversation_text: dataset.cases[index].conversation_text,
        public_prior_state: dataset.cases[index].public_prior_state,
      });
      expect(prompt.source_json).not.toContain('"expected_details"');
      expect(prompt.source_json).not.toContain('"forbidden_candidate_text"');
    }
    const changed = structuredClone(dataset);
    changed.cases[0].conversation_text += '\nUser: preserve "quotes" and /tmp/$(touch never-executed) `literal`.';
    const altered = buildPromptManifest(changed);
    expect(altered.prompt_sha256).not.toBe(manifest.prompt_sha256);
    expect(JSON.parse(altered.cases[0].source_json).conversation_text).toBe(changed.cases[0].conversation_text);
    for (const key of ["dataSha256", "schemaSha256"] as const) {
      expect(buildPromptManifest({ ...dataset, [key]: "0".repeat(64) }).prompt_sha256).not.toBe(manifest.prompt_sha256);
    }
  });

  it("scores raw suggestions itself and keeps partial results pending human review", () => {
    const fixture = dataset.cases[0];
    const run = recorded();
    const input = { ...run, cases: [
      { case_id: fixture.case_id, status: "ok", output: {
        suggestions: [{ action: "memory_log", namespace: fixture.namespace_hint, content: fixture.expected_details[0].detail }],
        candidate_namespaces: [fixture.namespace_hint],
      } },
      ...run.cases.slice(1),
    ] };
    const result = scoreRecordedRun(dataset, input);
    expect(result.status).toBe("not_run");
    expect(result.case_coverage.recorded_case_count).toBe(1);
    expect(result.case_coverage.metric_case_count).toBe(1);
    expect(result.case_coverage.metric_case_denominator).toBe(dataset.cases.length);
    expect(result.cases[0].metrics?.candidate_count).toBe(1);
    expect(result.metadata.model_revision).toBe(input.model_revision);
    expect(result.metadata.runtime).toBe(input.runtime);
    expect(result.publication_eligible).toBe(false);
    expect(result.dataset.human_review_status).toBe("pending");
    expect(result.aggregate_metrics.human_factual_precision_recall).toBe("unmeasured");
    expect(() => scoreRecordedRun(dataset, { ...input, aggregate_metrics: { candidate_count: 999 } })).toThrow();
    expect(() => scoreRecordedRun(dataset, { ...input, cases: [{ ...input.cases[0], metrics: {} }] })).toThrow();
  });

  it("accounts for every scored case in a complete recorded run", () => {
    const run = recorded();
    const result = scoreRecordedRun(dataset, { ...run, cases: run.cases.map((entry) => ({
      case_id: entry.case_id, status: "ok", output: { suggestions: [], candidate_namespaces: [] },
    })) });
    expect(result.status).toBe("ok");
    expect(result.case_coverage.recorded_case_count).toBe(dataset.cases.length);
    expect(result.case_coverage.metric_case_count).toBe(dataset.cases.length);
    expect(result.case_coverage.not_run_case_ids).toEqual([]);
    expect(result.review.actual_model_results_status).toBe("recorded_only");
    expect(result.publication_eligible).toBe(false);
  });

  it("requires exact binding and honest nonempty provenance even for all-not-run inputs", () => {
    const run = recorded();
    const result = scoreRecordedRun(dataset, run);
    expect(result.status).toBe("not_run");
    expect(result.case_coverage.recorded_case_count).toBe(0);
    expect(result.case_coverage.metric_case_count).toBe(0);
    expect(result.cases.every((entry) => entry.metrics === null)).toBe(true);
    for (const key of ["data_sha256", "schema_sha256", "prompt_sha256"] as const) {
      expect(() => scoreRecordedRun(dataset, { ...run, [key]: "0".repeat(64) })).toThrow(/binding/);
    }
    for (const key of ["model_revision", "runtime"] as const) {
      expect(() => scoreRecordedRun(dataset, { ...run, [key]: " " })).toThrow();
    }
    expect(() => scoreRecordedRun(dataset, { ...run, source: "deterministic_baseline" })).toThrow();
    expect(() => scoreRecordedRun(dataset, { ...run, schema_version: 2 })).toThrow();
    expect(() => scoreRecordedRun(dataset, null)).toThrow();
  });

  it("keeps malformed raw output and provider failures explicit without echoing exceptions", () => {
    const run = recorded();
    const result = scoreRecordedRun(dataset, { ...run, source: "hy_memory_recorded", cases: [
      { case_id: run.cases[0].case_id, status: "ok", output: "invalid raw output" },
      { case_id: run.cases[1].case_id, status: "error" },
      ...run.cases.slice(2),
    ] });
    expect(result.status).toBe("error");
    expect(result.cases[0].failures[0].code).toBe("MALFORMED_OUTPUT");
    expect(result.cases[1].failures[0]).toEqual({ case_id: run.cases[1].case_id, code: "PROVIDER_FAILURE", message: "The recorded provider failed for this case; no proposals were scored." });
    expect(result.cases[1].metrics).toBeNull();
    expect(() => scoreRecordedRun(dataset, { ...run, cases: [{ case_id: run.cases[0].case_id, status: "error", error: "secret exception" }] })).toThrow();
    expect(() => scoreRecordedRun(dataset, { ...run, cases: [{ case_id: run.cases[0].case_id, status: "not_run", output: {} }] })).toThrow();
    expect(() => scoreRecordedRun(dataset, { ...run, cases: [{ case_id: run.cases[0].case_id, status: "ok" }] })).toThrow();
  });

  it("reports missing, duplicate and unknown case IDs against the full dataset", () => {
    const run = recorded();
    const result = scoreRecordedRun(dataset, { ...run, cases: [run.cases[0], run.cases[0], { case_id: "unknown", status: "not_run" }] });
    expect(result.status).toBe("error");
    expect(result.case_coverage.missing_case_ids).toEqual(run.cases.slice(1).map((entry) => entry.case_id));
    expect(result.case_coverage.duplicate_case_ids).toEqual([run.cases[0].case_id]);
    expect(result.case_coverage.unknown_case_ids).toEqual(["unknown"]);
    expect(result.failures.map((entry) => entry.code)).toEqual(expect.arrayContaining(["MISSING_CASE_RESULT", "DUPLICATE_CASE_RESULT", "UNKNOWN_CASE_RESULT"]));
  });

  it("prints prompts and reads only an explicitly selected bounded JSON file", () => {
    const cli = "benchmark/proposal-eval/recorded.ts";
    const invoke = (args: string[]) => execFileSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(invoke(["--prompts"]))).toEqual(buildPromptManifest(dataset));
    for (const args of [[], ["--input"], ["--prompts", "extra"], ["--input", "x", "--prompts"]]) expect(() => invoke(args)).toThrow();
    const directory = mkdtempSync(join(tmpdir(), "munin-recorded-test-"));
    try {
      const file = join(directory, "literal $(never-executed) `path`.json");
      writeFileSync(file, JSON.stringify(recorded()));
      expect(JSON.parse(invoke(["--input", file])).case_coverage.metric_case_count).toBe(0);
      writeFileSync(file, " ".repeat(8 * 1024 * 1024 + 1));
      expect(() => invoke(["--input", file])).toThrow(/8 MiB/);
      writeFileSync(file, "{invalid-secret-text");
      try { invoke(["--input", file]); } catch (error) {
        expect(String(error)).not.toContain("invalid-secret-text");
        expect(String(error)).toContain("valid JSON");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
