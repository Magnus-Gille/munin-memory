import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareRuns, makeSmokeRun, parseFixture, parseRun, sealFixture,
  type Fixture, type RecordedRun,
} from "../benchmark/bilingual-eval/index.js";

function fixture(): Fixture {
  return parseFixture(JSON.parse(readFileSync(new URL(
    "../benchmark/bilingual-eval/synthetic.candidates.json", import.meta.url,
  ), "utf8")));
}
function run(data = fixture()): RecordedRun { return makeSmokeRun(data, "raw_hybrid"); }
function changedFixture(change: (data: Fixture) => void): Fixture {
  const data = fixture();
  change(data);
  return sealFixture(data);
}

describe("bilingual evaluation foundation", () => {
  it("validates a candidate-only bank covering all directions and proposal categories", () => {
    const data = fixture();
    for (const direction of ["sv-sv", "en-en", "sv-en", "en-sv"]) {
      const cases = data.cases.filter(item => item.direction === direction);
      expect(cases).toHaveLength(4);
      expect(new Set(cases.map(item => item.category))).toEqual(new Set(["decision", "status", "preference"]));
    }
    expect(data.review.status).toBe("candidate");
    expect(data.review.reviewer).toBeNull();
  });
  it("rejects unknown fields, mutated hashes, missing directions and false human-review claims", () => {
    expect(() => parseFixture({ ...fixture(), surprise: true })).toThrow(/unknown/);
    const tampered = fixture(); tampered.cases[0].query += " changed";
    expect(() => parseFixture(tampered)).toThrow(/hash/);
    expect(() => parseFixture(changedFixture(data => { data.cases = data.cases.slice(4); }))).toThrow(/direction/);
    expect(() => parseFixture(changedFixture(data => { data.review.status = "human_reviewed"; }))).toThrow(/review/);
  });
  it("rejects dangling labels and invalid source spans", () => {
    expect(() => parseFixture(changedFixture(data => { data.cases[0].labels.relevant_ids = ["missing"]; }))).toThrow(/label|evidence/);
    expect(() => parseFixture(changedFixture(data => { data.cases[0].labels.evidence[0].end = 100000; }))).toThrow(/span/);
  });
  it("requires exactly one result per case and unique ranked IDs", () => {
    const data = fixture();
    for (const mutate of [
      (value: RecordedRun) => { value.results.pop(); },
      (value: RecordedRun) => { value.results[1] = value.results[0]; },
      (value: RecordedRun) => { value.results[0].case_id = "unknown"; },
      (value: RecordedRun) => { value.results[0].ranked_ids.push(value.results[0].ranked_ids[0]); },
    ]) {
      const value = run(data); mutate(value);
      expect(() => parseRun(value, data)).toThrow(/case|duplicate/);
    }
  });
  it("rejects provenance drift and combined embedding/fusion changes", () => {
    const data = fixture(); const baseline = run(data);
    for (const mutate of [
      (value: RecordedRun) => { value.fixed_clock = "2026-10-18T00:00:00.000Z"; },
      (value: RecordedRun) => { value.token_budget += 1; },
      (value: RecordedRun) => { value.hashes.queries = "0".repeat(64); },
      (value: RecordedRun) => { value.ranker_revision += "-changed"; },
      (value: RecordedRun) => { value.embedding.revision += "-changed"; value.fusion.k += 1; },
    ]) {
      const candidate = run(data); mutate(candidate);
      expect(() => compareRuns(data, baseline, candidate, "embedding")).toThrow(/binding|incomparable/);
    }
    const candidate = run(data); candidate.embedding.revision = "stub-revision-b";
    expect(compareRuns(data, baseline, candidate, "embedding").status).toBe("incomplete");
    expect(() => compareRuns(data, baseline, candidate, "fusion")).toThrow(/incomparable/);
  });
  it("scores retained evidence, not an entry ID whose evidence was truncated", () => {
    const data = fixture(); const baseline = run(data); const candidate = run(data);
    const span = candidate.results[0].retained[0];
    span.end -= 1; span.text = span.text.slice(0, -1);
    const report = compareRuns(data, baseline, candidate, "repeat");
    expect(report.candidate.metrics.overall.recall).toBe(1);
    expect(report.candidate.metrics.overall.complete_evidence).toBe(15 / 16);
    const forged = run(data); forged.results[0].retained[0].text = "invented";
    expect(() => parseRun(forged, data)).toThrow(/retained/);
    const smallBudget = changedFixture(value => { value.token_budget = 1; });
    expect(() => parseRun(run(smallBudget), smallBudget)).toThrow(/budget/);
  });
  it("reports gained/lost cases and deterministic paired uncertainty by ID rather than row order", () => {
    const data = fixture(); const baseline = run(data); const candidate = run(data);
    baseline.results[0] = { ...baseline.results[0], ranked_ids: [], retained: [] };
    candidate.results[1] = { ...candidate.results[1], ranked_ids: [], retained: [] };
    candidate.results[2].ranked_ids.unshift(data.cases[2].labels.hard_negative_ids[0]);
    candidate.results.reverse();
    const report = compareRuns(data, baseline, candidate, "repeat");
    expect(report.gained).toEqual([data.cases[0].id]);
    expect(report.lost).toEqual([data.cases[1].id]);
    expect(report.candidate.metrics.overall.hard_negative_rate).toBe(1 / 16);
    expect(report.uncertainty.overall.recall.point).toBe(0);
    expect(report).toEqual(compareRuns(data, baseline, candidate, "repeat"));
    const identical = compareRuns(data, run(data), run(data), "repeat");
    expect(identical.uncertainty.overall.mrr).toMatchObject({ point: 0, lower: 0, upper: 0 });
  });
  it("retains each run's provenance and result-bound digest in the saved report", () => {
    const data = fixture(); const baseline = run(data); const candidate = run(data);
    const original = compareRuns(data, baseline, candidate, "repeat");
    const changed = run(data); changed.embedding.revision = "stub-revision-new";
    const revised = compareRuns(data, baseline, changed, "embedding");
    expect(revised.baseline.provenance).toMatchObject({
      acquisition: baseline.acquisition, embedding: baseline.embedding, fusion: baseline.fusion,
      ranker_revision: baseline.ranker_revision,
    });
    expect(revised.candidate.provenance.embedding.revision).toBe("stub-revision-new");
    expect(revised.baseline.digest).toBe(original.baseline.digest);
    expect(revised.candidate.digest).not.toBe(original.candidate.digest);
    expect(revised.fixed_clock).toBe(data.fixed_clock);
    expect(revised.top_k).toBe(data.top_k);
    expect(revised.token_budget).toBe(data.token_budget);
    expect(revised.baseline.metrics).toEqual(original.baseline.metrics);
    expect(revised.candidate.metrics).toEqual(original.candidate.metrics);
    expect(revised.status).toBe("incomplete");
    expect(revised.publication_eligible).toBe(false);
  });
  it("keeps perfect offline smoke incomplete and publication-ineligible in every recorded mode", () => {
    const data = fixture();
    for (const mode of ["lexical", "semantic", "raw_hybrid", "production_hybrid"] as const) {
      const value = makeSmokeRun(data, mode);
      const report = compareRuns(data, value, value, "repeat");
      expect(report.publication_eligible).toBe(false);
      expect(report.status).toBe("incomplete");
      expect(report.pending).toEqual(expect.arrayContaining(["human_review", "held_out_bank", "live_model_runs", "hardware_measurements", "threshold_review"]));
    }
  });
});
