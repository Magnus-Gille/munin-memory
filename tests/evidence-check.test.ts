import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CheckDependencies } from "../benchmark/evidence-metric/check.js";
import { RELEASE_TAG } from "../benchmark/evidence-metric/shared-artifacts.js";
import type { GoldTurnArtifact } from "../benchmark/evidence-metric/gold-turns.js";
const REVIEWED_GOLD_TURNS_SHA256 = "47dc2a2e8bdd1af0fb1b3d5aa39e68a4716548b8ad11d5587f06a7eac61a55db";
const reviewedGoldTurns = readFileSync(new URL("../benchmark/evidence-metric/comparisons/longmemeval-s-passages-20261020/gold-turns.json", import.meta.url));
const REVIEWED_MESSAGE_BOUNDARIES_SHA256 = "3868f7c9ab26eb79953caf139b42535e3895de91ef7cb033eabbf5bf17e3aa8f";
const reviewedMessageBoundaries = readFileSync(new URL("../benchmark/evidence-metric/comparisons/longmemeval-s-message-neighbors-20261021/message-boundaries.json", import.meta.url));
let dir: string;
let deps: CheckDependencies;
let output: string;
let artifactDir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "munin-check-"))); artifactDir = join(dir, "inputs"); output = join(dir, "report.json");
  const metadata = join(dir, "baseline.json"); writeFileSync(metadata, "baseline");
  deps = { loadContract: async () => ({ manifest: { schema_version: 1, release_tag: RELEASE_TAG, files: [] }, baseline: metadata, asOf: "2026-10-01T00:00:00.000Z", metadataPaths: [metadata] }), fetchArtifacts: vi.fn(async () => { mkdirSync(artifactDir, { recursive: true }); for (const path of ["snapshot.db", "queries.jsonl", "query-vectors.json"]) writeFileSync(join(artifactDir, path), "fixture"); return { release_tag: RELEASE_TAG, source: "downloaded", files: [] }; }), execute: vi.fn(async (_args, env) => {
    expect(env.MUNIN_SEMANTIC_MAX_DISTANCE).toBeUndefined();
    writeFileSync(output, JSON.stringify({ quality_state: "improved", comparison: { gained_question_ids: ["g1"], lost_question_ids: [] } })); return 0;
  }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const args = () => ["--artifacts-dir", artifactDir, "--output", output];
const writeReviewedGoldTurns = () => { const path = join(dir, "gold-turns.json"); writeFileSync(path, reviewedGoldTurns); return path; };
const writeReviewedMessageBoundaries = () => { const path = join(dir, "message-boundaries.json"); writeFileSync(path, reviewedMessageBoundaries); return path; };
it.each([0, 1, 2] as const)("preserves offline evaluator exit %i and supplies only fixed arguments", async (code) => {
  vi.stubEnv("MUNIN_SEMANTIC_MAX_DISTANCE", "0.001");
  deps.execute = vi.fn(async (_args, env) => { expect(env.MUNIN_SEMANTIC_MAX_DISTANCE).toBeUndefined(); writeFileSync(output, JSON.stringify({ quality_state: code === 1 ? "regressed" : code === 2 ? "invalid" : "improved", comparison: { gained_question_ids: ["g1"], lost_question_ids: code === 1 ? ["l1"] : [], reproduced: code === 1 } })); return code; });
  const summary = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await main(args(), deps)).toBe(code);
  expect(process.env.MUNIN_SEMANTIC_MAX_DISTANCE).toBe("0.001");
  expect(deps.execute).toHaveBeenCalledWith(["--snapshot", join(artifactDir, "snapshot.db"), "--queries", join(artifactDir, "queries.jsonl"), "--vectors", join(artifactDir, "query-vectors.json"), "--as-of", "2026-10-01T00:00:00.000Z", "--baseline", join(dir, "baseline.json"), "--output", output], expect.any(Object));
  expect(summary.mock.calls.flat().join(" ")).toContain("g1");
  expect(JSON.parse(readFileSync(output + ".verification.json", "utf8"))).toMatchObject({ source: "downloaded", release_tag: RELEASE_TAG });
});
it("rejects missing, duplicate and configuration override arguments before downloading", async () => {
  for (const bad of [[], [...args(), "--as-of", "2020"], [...args(), "--baseline", "other"], [...args(), "--output", output]]) expect(await main(bad, deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});
it("reports failed setup as invalid2 without running evaluator or clobbering output", async () => {
  writeFileSync(output, "existing report"); deps.fetchArtifacts = vi.fn(async () => { throw new Error("SHA mismatch"); });
  expect(await main(args(), deps)).toBe(2); expect(deps.execute).not.toHaveBeenCalled(); expect(readFileSync(output, "utf8")).toBe("existing report");
});
it("rejects output colliding with metadata, artifacts or a missing parent before fetch", async () => {
  for (const badOutput of [join(dir, "baseline.json"), join(artifactDir, "manifest.json"), join(dir, "missing", "report.json")]) {
    expect(await main(["--artifacts-dir", artifactDir, "--output", badOutput], deps)).toBe(2);
  }
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});

it("rejects existing verification receipts before downloading", async () => {
  writeFileSync(output + ".verification.json", "preserve");
  expect(await main(args(), deps)).toBe(2); expect(deps.fetchArtifacts).not.toHaveBeenCalled();
  expect(readFileSync(output + ".verification.json", "utf8")).toBe("preserve");
});

it.each(["missing", "malformed", "inconsistent"])("fails closed for child success with a %s report", async (kind) => {
  deps.execute = async () => { if (kind !== "missing") writeFileSync(output, kind === "malformed" ? "{" : JSON.stringify({ quality_state: "regressed", comparison: { gained_question_ids: [], lost_question_ids: ["lost"] } })); return 0; };
  expect(await main(args(), deps)).toBe(2);
});

it("requires a reproduced regression report for evaluator exit1", async () => {
  deps.execute = async () => { writeFileSync(output, JSON.stringify({ quality_state: "regressed", comparison: { gained_question_ids: [], lost_question_ids: ["lost"], reproduced: false } })); return 1; };
  expect(await main(args(), deps)).toBe(2);
});


const packingComparison = () => ({
  strategy: "skip-oversized", control_reproduced: true, regression: true, gained_question_ids: ["gain"], lost_question_ids: ["loss"],
  stages: { retrieval: { all_gold: 2, partial_gold: 1, no_gold: 0 }, legacy_packed: { all_gold: 1, partial_gold: 1, no_gold: 1 }, candidate_packed: { all_gold: 1, partial_gold: 1, no_gold: 1 } },
});
it("forwards an explicit packing comparison after fixed shared input verification", async () => {
  deps.execute = vi.fn(async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", comparison: { gained_question_ids: [], lost_question_ids: [] }, packing_comparison: packingComparison() }));
    return 0;
  });
  expect(await main([...args(), "--packing-comparison", "skip-oversized"], deps)).toBe(0);
  expect(deps.execute).toHaveBeenCalledWith(expect.arrayContaining(["--packing-comparison", "skip-oversized"]), expect.any(Object));
});
it("rejects unsupported packing strategies before downloading", async () => {
  expect(await main([...args(), "--packing-comparison", "invented"], deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});


it.each([
  undefined,
  { ...packingComparison(), strategy: "other" },
  { ...packingComparison(), control_reproduced: false },
  { ...packingComparison(), control_reproduced: undefined },
  { ...packingComparison(), regression: undefined },
  { ...packingComparison(), regression: false },
  { ...packingComparison(), lost_question_ids: [], regression: true },
  { ...packingComparison(), gained_question_ids: "gain" },
  { ...packingComparison(), lost_question_ids: [1] },
  { ...packingComparison(), gained_question_ids: [""] },
  { ...packingComparison(), stages: undefined },
  { ...packingComparison(), stages: { ...packingComparison().stages, retrieval: { all_gold: -1, partial_gold: 1, no_gold: 0 } } },
  { ...packingComparison(), stages: { ...packingComparison().stages, legacy_packed: { all_gold: 1.5, partial_gold: 1, no_gold: 0 } } },
  { ...packingComparison(), stages: { ...packingComparison().stages, candidate_packed: { all_gold: 1, partial_gold: 1 } } },
])("fails closed for malformed requested packing comparison %#", async (packing_comparison) => {
  deps.execute = async () => { writeFileSync(output, JSON.stringify({ quality_state: "unchanged", comparison: { gained_question_ids: [], lost_question_ids: [] }, packing_comparison })); return 0; };
  expect(await main([...args(), "--packing-comparison", "skip-oversized"], deps)).toBe(2);
});
it("preserves invalid2 reports when the requested packing comparison cannot run", async () => {
  deps.execute = async () => { writeFileSync(output, JSON.stringify({ quality_state: "invalid" })); return 2; };
  expect(await main([...args(), "--packing-comparison", "skip-oversized"], deps)).toBe(2);
});

const passageComparison = () => ({
  strategy: "query-passages-v1", control_reproduced: true, coordinate_system: "utf16_code_units", chunk_max_utf8_bytes: 2048,
  lineage: { gold_turns_sha256: REVIEWED_GOLD_TURNS_SHA256, gold_turns_source_sha256: "b".repeat(64), source: { dataset_sha256: "c".repeat(64), snapshot_sha256: "d".repeat(64), queries_sha256: "e".repeat(64) } },
  entry_id_proxy: packingComparison(),
  annotated_message_coverage: {
    metric: "full_original_annotated_message_coverage_v1", eligible_question_count: 2, eligible_question_ids: ["gain", "loss"], excluded_question_ids: ["excluded"], annotated_message_count: 4,
    retrieval: { all_turn_count: 2, all_turn_rate: 1, covered_message_count: 4 },
    legacy_packed: { all_turn_count: 1, all_turn_rate: 0.5, covered_message_count: 2 },
    candidate_packed: { all_turn_count: 1, all_turn_rate: 0.5, covered_message_count: 2 },
    regression: true, gained_question_ids: ["gain"], lost_question_ids: ["loss"],
  },
});
it("forwards the explicit passage strategy and labels while keeping a candidate regression informational", async () => {
  const labels = writeReviewedGoldTurns();
  deps.execute = vi.fn(async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passageComparison() }));
    return 0;
  });
  expect(await main([...args(), "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(0);
  expect(deps.execute).toHaveBeenCalledWith(expect.arrayContaining(["--passage-comparison", "query-passages-v1", "--gold-turns", labels]), expect.any(Object));
});
it("requires paired valid passage arguments and protects label aliases before downloading", async () => {
  const labels = join(dir, "gold-turns.json"); writeFileSync(labels, "preserve");
  for (const extra of [["--gold-turns", labels], ["--passage-comparison", "query-passages-v1"], ["--passage-comparison", "other", "--gold-turns", labels]]) expect(await main([...args(), ...extra], deps)).toBe(2);
  output = labels;
  expect(await main([...args(), "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(readFileSync(labels, "utf8")).toBe("preserve");
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});
it.each([
  undefined,
  { ...passageComparison(), strategy: "other" },
  { ...passageComparison(), control_reproduced: false },
  { ...passageComparison(), coordinate_system: "bytes" },
  { ...passageComparison(), chunk_max_utf8_bytes: 4096 },
  { ...passageComparison(), lineage: undefined },
  { ...passageComparison(), lineage: { ...passageComparison().lineage, gold_turns_sha256: "0".repeat(64) } },
  { ...passageComparison(), entry_id_proxy: undefined },
  { ...passageComparison(), annotated_message_coverage: { ...passageComparison().annotated_message_coverage, eligible_question_count: 3 } },
  { ...passageComparison(), annotated_message_coverage: { ...passageComparison().annotated_message_coverage, candidate_packed: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 2 } } },
  { ...passageComparison(), annotated_message_coverage: { ...passageComparison().annotated_message_coverage, regression: false } },
])("fails closed for malformed requested passage comparison %#", async (passage_comparison) => {
  const labels = writeReviewedGoldTurns();
  deps.execute = async () => { writeFileSync(output, JSON.stringify({ quality_state: "unchanged", comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison })); return 0; };
  expect(await main([...args(), "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
});

it.each(["all-empty turns", "changed offset", "changed source binding", "whitespace"])("rejects unreviewed annotation bytes (%s) before downloading or evaluating", async (change) => {
  const labels = writeReviewedGoldTurns();
  const artifact = JSON.parse(reviewedGoldTurns.toString("utf8")) as GoldTurnArtifact;
  if (change === "all-empty turns") artifact.queries.forEach((query) => query.entries.forEach((entry) => { entry.turns = []; }));
  if (change === "changed offset") artifact.queries.flatMap((query) => query.entries).find((entry) => entry.turns.length > 0)!.turns[0].start++;
  if (change === "changed source binding") artifact.source.dataset_sha256 = "0".repeat(64);
  writeFileSync(labels, change === "whitespace" ? Buffer.concat([reviewedGoldTurns, Buffer.from("\n")]) : JSON.stringify(artifact, null, 2) + "\n");
  deps.execute = vi.fn(async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passageComparison() }));
    return 0;
  });
  expect(await main([...args(), "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
  expect(deps.execute).not.toHaveBeenCalled();
});

it("rechecks reviewed annotations after an asynchronous download before evaluating", async () => {
  const labels = writeReviewedGoldTurns();
  const fetch = deps.fetchArtifacts;
  deps.fetchArtifacts = vi.fn(async (...params) => {
    const receipt = await fetch(...params);
    writeFileSync(labels, Buffer.concat([reviewedGoldTurns, Buffer.from("\n")]));
    return receipt;
  });
  deps.execute = vi.fn(async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passageComparison() }));
    return 0;
  });
  expect(await main([...args(), "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(deps.fetchArtifacts).toHaveBeenCalledOnce();
  expect(deps.execute).not.toHaveBeenCalled();
});

it("requires message comparison, boundaries, passage comparison and gold-turns as a complete option set", async () => {
  const boundaries = join(dir, "message-boundaries.json"); writeFileSync(boundaries, "fixture");
  const labels = writeReviewedGoldTurns();
  for (const extra of [
    ["--message-comparison", "query-message-neighbors-v1"],
    ["--message-boundaries", boundaries],
    ["--message-comparison", "other", "--message-boundaries", boundaries],
    ["--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries],
    ["--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1"],
    ["--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--gold-turns", labels],
  ]) expect(await main([...args(), ...extra], deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});
it("requires the complete prior comparison option set for the frozen core experiment", async () => {
  const boundaries = writeReviewedMessageBoundaries(); const labels = writeReviewedGoldTurns();
  for (const extra of [
    ["--core-comparison", "query-message-cores-v1"],
    ["--core-comparison", "other"],
    ["--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--core-comparison", "query-message-cores-v1"],
    ["--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--gold-turns", labels, "--core-comparison", "query-message-cores-v1"],
  ]) expect(await main([...args(), ...extra], deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});

it("protects the message-boundaries metadata path before fetching shared artifacts", async () => {
  const boundaries = join(dir, "message-boundaries.json"); writeFileSync(boundaries, "preserve");
  const labels = writeReviewedGoldTurns(); output = boundaries;
  const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(readFileSync(boundaries, "utf8")).toBe("preserve");
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join(" ")).toMatch(/collides|fresh report/i);
});

it("rejects changed or emptied message-boundary metadata before fetching", async () => {
  const boundaries = join(dir, "message-boundaries.json"); writeFileSync(boundaries, "unreviewed");
  const labels = writeReviewedGoldTurns();
  const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join(" ")).toContain(REVIEWED_MESSAGE_BOUNDARIES_SHA256);
  writeFileSync(boundaries, "");
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(deps.fetchArtifacts).not.toHaveBeenCalled();
});

function messageBudget(included: number, dropped: number) {
  return { max_estimated_tokens: 8192, estimated_tokens: included ? 4 : 0, estimator: "utf8_bytes_div4_ceil_v1", truncated: dropped > 0, candidate_entry_count: 1, included_entry_count: included, dropped_entry_count: dropped };
}
function messagePair(reference_strategy: "legacy" | "query-passages-v1", referenceRanges: unknown[]) {
  const stages = {
    retrieval: { all_gold: 1, partial_gold: 0, no_gold: 0 },
    reference_packed: { all_gold: 1, partial_gold: 0, no_gold: 0 },
    candidate_packed: { all_gold: 0, partial_gold: 0, no_gold: 1 },
  };
  const coverage = {
    metric: "full_original_annotated_message_coverage_v1", eligible_question_count: 1, eligible_question_ids: ["q1"], excluded_question_ids: [], annotated_message_count: 1,
    retrieval: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 1 },
    reference_packed: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 1 },
    candidate_packed: { all_turn_count: 0, all_turn_rate: 0, covered_message_count: 0 },
    regression: true, gained_question_ids: [], lost_question_ids: ["q1"], gained_message_count: 0, lost_message_count: 1,
  };
  const excluded_labels = { question_count: 0, annotated_message_count: 0, no_positive_entry_count: 0 };
  const summary = {
    query_count: 1,
    entry_id_proxy: { regression: true, gained_question_ids: [], lost_question_ids: ["q1"], any_gold_loss_question_ids: ["q1"], gained_id_count: 0, lost_id_count: 1, stages },
    annotated_message_coverage: coverage, excluded_labels,
  };
  return {
    reference_strategy, ...summary, categories: { evidence: summary },
    queries: [{
      query_id: "q1", category: "evidence", expected_ids: ["e"], retrieved_ids: ["e"], reference_packed_ids: ["e"], candidate_packed_ids: [],
      reference_budget: messageBudget(1, 0), candidate_budget: messageBudget(0, 1), reference_ranges: referenceRanges, candidate_ranges: [],
      retrieval_stage: "all_gold", reference_packed_stage: "all_gold", candidate_packed_stage: "no_gold",
      reference_all_gold: true, candidate_all_gold: false, gained_ids: [], lost_ids: ["e"],
      annotated_messages: {
        eligible: true, gold_turn_count: 1, no_positive_entry_count: 0,
        retrieval_covered_turns: [{ entry_id: "e", message_index: 0 }], reference_covered_turns: [{ entry_id: "e", message_index: 0 }], candidate_covered_turns: [],
        retrieval_all_turns: true, reference_all_turns: true, candidate_all_turns: false,
        gained_turns: [], lost_turns: [{ entry_id: "e", message_index: 0 }],
      },
    }],
  };
}
function messageComparison() {
  const fullRange = [{ entry_id: "e", start: 0, end: 3 }];
  const passage = passageComparison() as Record<string, unknown>;
  passage.lineage = { ...passageComparison().lineage, source: { dataset_sha256: "c".repeat(64), snapshot_sha256: "d".repeat(64), queries_sha256: "e".repeat(64) } };
  passage.queries = [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], candidate_packed_ids: ["e"], candidate_budget: messageBudget(1, 0), candidate_ranges: fullRange }];
  const legacy = messagePair("legacy", fullRange);
  const passages = messagePair("query-passages-v1", fullRange);
  const report = {
    strategy: "query-message-neighbors-v1", control_reproduced: true, coordinate_system: "utf16_code_units",
    metric_limitation: "Full original annotated-message coverage is a conservative proxy.",
    lineage: {
      message_boundaries_sha256: REVIEWED_MESSAGE_BOUNDARIES_SHA256,
      message_boundaries_source_sha256: "a".repeat(64), message_packing_source_sha256: "b".repeat(64), message_comparison_source_sha256: "f".repeat(64),
      source: { dataset_sha256: "c".repeat(64), snapshot_sha256: "d".repeat(64) },
    },
    versus_legacy: legacy, versus_passages: passages,
    queries: [{ query_id: "q1", selected_message_indices: [], candidate_ranges: [], candidate_budget: messageBudget(0, 1), whole_message_conservation: { selected_message_count: 0, partial_message_count: 0 } }],
    whole_message_conservation: { selected_message_count: 0, partial_message_count: 0 },
  };
  return { passage, report };
}

function coreComparison() {
  const { passage, report: sibling } = messageComparison();
  const report = structuredClone(sibling) as Record<string, any>;
  report.strategy = "query-message-cores-v1";
  report.lineage = { ...report.lineage, core_packing_source_sha256: "1".repeat(64), core_comparison_source_sha256: "2".repeat(64) };
  const neighbors = structuredClone(report.versus_passages);
  neighbors.reference_strategy = "query-message-neighbors-v1";
  const summary = neighbors.queries[0].annotated_messages;
  neighbors.entry_id_proxy = {
    regression: false, gained_question_ids: [], lost_question_ids: [], any_gold_loss_question_ids: [], gained_id_count: 0, lost_id_count: 0,
    stages: { retrieval: { all_gold: 1, partial_gold: 0, no_gold: 0 }, reference_packed: { all_gold: 0, partial_gold: 0, no_gold: 1 }, candidate_packed: { all_gold: 0, partial_gold: 0, no_gold: 1 } },
  };
  neighbors.annotated_message_coverage = {
    metric: "full_original_annotated_message_coverage_v1", eligible_question_count: 1, eligible_question_ids: ["q1"], excluded_question_ids: [], annotated_message_count: 1,
    retrieval: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 1 },
    reference_packed: { all_turn_count: 0, all_turn_rate: 0, covered_message_count: 0 },
    candidate_packed: { all_turn_count: 0, all_turn_rate: 0, covered_message_count: 0 },
    regression: false, gained_question_ids: [], lost_question_ids: [], gained_message_count: 0, lost_message_count: 0,
  };
  neighbors.queries[0] = {
    ...neighbors.queries[0], reference_packed_ids: [], reference_packed_stage: "no_gold", reference_all_gold: false,
    reference_budget: messageBudget(0, 1), reference_ranges: [], gained_ids: [], lost_ids: [],
    annotated_messages: { ...summary, reference_covered_turns: [], reference_all_turns: false, gained_turns: [], lost_turns: [] },
  };
  neighbors.categories = { evidence: { query_count: 1, entry_id_proxy: neighbors.entry_id_proxy, annotated_message_coverage: neighbors.annotated_message_coverage, excluded_labels: { question_count: 0, annotated_message_count: 0, no_positive_entry_count: 0 } } };
  report.versus_neighbors = neighbors;
  return { passage, sibling, report };
}

function coreComparisonWithDifferentCandidate() {
  const fixture = coreComparison();
  const selectedRanges = [{ entry_id: "e", start: 0, end: 3 }];
  const selectedTurns = [{ entry_id: "e", message_index: 0 }];
  const selectedBudget = messageBudget(1, 0);
  for (const pair of [fixture.report.versus_legacy, fixture.report.versus_passages, fixture.report.versus_neighbors]) {
    const row = pair.queries[0];
    row.candidate_packed_ids = ["e"]; row.candidate_budget = selectedBudget; row.candidate_ranges = selectedRanges;
    row.candidate_packed_stage = "all_gold"; row.candidate_all_gold = true;
    row.gained_ids = row.reference_packed_ids.includes("e") ? [] : ["e"];
    row.lost_ids = [];
    const annotated = row.annotated_messages;
    annotated.candidate_covered_turns = selectedTurns; annotated.candidate_all_turns = true;
    annotated.gained_turns = annotated.reference_covered_turns.length ? [] : selectedTurns;
    annotated.lost_turns = [];
    pair.entry_id_proxy = {
      regression: false, gained_question_ids: row.gained_ids.length ? ["q1"] : [], lost_question_ids: [],
      any_gold_loss_question_ids: [], gained_id_count: row.gained_ids.length, lost_id_count: 0,
      stages: { retrieval: { all_gold: 1, partial_gold: 0, no_gold: 0 }, reference_packed: { all_gold: row.reference_all_gold ? 1 : 0, partial_gold: 0, no_gold: row.reference_all_gold ? 0 : 1 }, candidate_packed: { all_gold: 1, partial_gold: 0, no_gold: 0 } },
    };
    pair.annotated_message_coverage = {
      metric: "full_original_annotated_message_coverage_v1", eligible_question_count: 1, eligible_question_ids: ["q1"], excluded_question_ids: [], annotated_message_count: 1,
      retrieval: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 1 },
      reference_packed: { all_turn_count: annotated.reference_all_turns ? 1 : 0, all_turn_rate: annotated.reference_all_turns ? 1 : 0, covered_message_count: annotated.reference_covered_turns.length },
      candidate_packed: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 1 },
      regression: false, gained_question_ids: annotated.reference_all_turns ? [] : ["q1"], lost_question_ids: [],
      gained_message_count: annotated.gained_turns.length, lost_message_count: 0,
    };
    const summary = { query_count: 1, entry_id_proxy: pair.entry_id_proxy, annotated_message_coverage: pair.annotated_message_coverage, excluded_labels: { question_count: 0, annotated_message_count: 0, no_positive_entry_count: 0 } };
    pair.categories = { evidence: summary };
  }
  fixture.report.queries[0] = { query_id: "q1", selected_message_indices: [{ entry_id: "e", message_indices: [0] }], candidate_ranges: selectedRanges, candidate_budget: selectedBudget, whole_message_conservation: { selected_message_count: 1, partial_message_count: 0 } };
  fixture.report.whole_message_conservation = { selected_message_count: 1, partial_message_count: 0 };
  return fixture;
}

it("forwards the frozen core experiment and validates all three paired comparisons", async () => {
  const boundaries = writeReviewedMessageBoundaries(); const labels = writeReviewedGoldTurns();
  const { passage, sibling, report } = coreComparisonWithDifferentCandidate();
  deps.execute = vi.fn(async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], packed_ids: ["e"], budget: messageBudget(1, 0) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passage, message_comparison: sibling, core_comparison: report }));
    return 0;
  });
  const coreArgs = () => [...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels, "--core-comparison", "query-message-cores-v1"];
  expect(await main(coreArgs(), deps)).toBe(0);
  expect(deps.execute).toHaveBeenCalledWith(expect.arrayContaining(["--core-comparison", "query-message-cores-v1"]), expect.any(Object));

  const badThirdPair = structuredClone(report);
  badThirdPair.versus_neighbors.queries[0].reference_ranges = [{ entry_id: "e", start: 0, end: 2 }];
  deps.execute = vi.fn(async () => { writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], packed_ids: ["e"], budget: messageBudget(1, 0) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passage, message_comparison: sibling, core_comparison: badThirdPair })); return 0; });
  output = join(dir, "tampered-third-pair.json");
  expect(await main(coreArgs(), deps)).toBe(2);
  expect(deps.execute).toHaveBeenCalledOnce();

  output = join(dir, "missing-core-comparison.json");
  deps.execute = vi.fn(async () => { writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], packed_ids: ["e"], budget: messageBudget(1, 0) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passage, message_comparison: sibling })); return 0; });
  expect(await main(coreArgs(), deps)).toBe(2);
  expect(deps.execute).toHaveBeenCalledOnce();

  output = join(dir, "bad-core-source-pin.json");
  const badPin = structuredClone(report); badPin.lineage.core_packing_source_sha256 = "not-a-sha";
  deps.execute = vi.fn(async () => { writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], packed_ids: ["e"], budget: messageBudget(1, 0) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passage, message_comparison: sibling, core_comparison: badPin })); return 0; });
  expect(await main(coreArgs(), deps)).toBe(2);
  expect(deps.execute).toHaveBeenCalledOnce();
});

it("forwards the pinned message experiment while its losses remain outside the primary exit policy", async () => {
  const boundaries = writeReviewedMessageBoundaries(); const labels = writeReviewedGoldTurns();
  const { passage, report } = messageComparison();
  deps.execute = vi.fn(async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], packed_ids: ["e"], budget: messageBudget(1, 0) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passage, message_comparison: report }));
    return 0;
  });
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(0);
  expect(deps.execute).toHaveBeenCalledWith(expect.arrayContaining(["--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries]), expect.any(Object));
});

it.each(["gain", "loss"] as const)("validates multi-gold %s IDs in expected order when retrieval order differs", async (direction) => {
  const boundaries = writeReviewedMessageBoundaries(); const labels = writeReviewedGoldTurns();
  const { passage, report } = messageComparison();
  const expected = ["e1", "e2"]; const retrieved = ["e2", "e1"];
  const fullRanges = retrieved.map((entry_id) => ({ entry_id, start: 0, end: 3 }));
  const turns = expected.map((entry_id) => ({ entry_id, message_index: 0, start: 0, end: 3 }));
  const referenceIds = direction === "loss" ? retrieved : [];
  const candidateIds = direction === "gain" ? retrieved : [];
  const referenceRanges = referenceIds.length ? fullRanges : [];
  const candidateRanges = candidateIds.length ? fullRanges : [];
  const budget = (included: number) => ({ ...messageBudget(included, 2 - included), candidate_entry_count: 2 });
  for (const pair of [report.versus_legacy, report.versus_passages]) {
    Object.assign(pair.entry_id_proxy, {
      regression: direction === "loss", gained_question_ids: direction === "gain" ? ["q1"] : [], lost_question_ids: direction === "loss" ? ["q1"] : [], any_gold_loss_question_ids: direction === "loss" ? ["q1"] : [],
      gained_id_count: direction === "gain" ? 2 : 0, lost_id_count: direction === "loss" ? 2 : 0,
      stages: { retrieval: { all_gold: 1, partial_gold: 0, no_gold: 0 }, reference_packed: { all_gold: referenceIds.length ? 1 : 0, partial_gold: 0, no_gold: referenceIds.length ? 0 : 1 }, candidate_packed: { all_gold: candidateIds.length ? 1 : 0, partial_gold: 0, no_gold: candidateIds.length ? 0 : 1 } },
    });
    Object.assign(pair.annotated_message_coverage, {
      annotated_message_count: 2, retrieval: { all_turn_count: 1, all_turn_rate: 1, covered_message_count: 2 },
      reference_packed: { all_turn_count: referenceIds.length ? 1 : 0, all_turn_rate: referenceIds.length ? 1 : 0, covered_message_count: referenceIds.length },
      candidate_packed: { all_turn_count: candidateIds.length ? 1 : 0, all_turn_rate: candidateIds.length ? 1 : 0, covered_message_count: candidateIds.length },
      regression: direction === "loss", gained_question_ids: direction === "gain" ? ["q1"] : [], lost_question_ids: direction === "loss" ? ["q1"] : [], gained_message_count: direction === "gain" ? 2 : 0, lost_message_count: direction === "loss" ? 2 : 0,
    });
    Object.assign(pair.queries[0], {
      expected_ids: expected, retrieved_ids: retrieved, reference_packed_ids: referenceIds, candidate_packed_ids: candidateIds,
      reference_budget: budget(referenceIds.length), candidate_budget: budget(candidateIds.length), reference_ranges: referenceRanges, candidate_ranges: candidateRanges,
      reference_packed_stage: referenceIds.length ? "all_gold" : "no_gold", candidate_packed_stage: candidateIds.length ? "all_gold" : "no_gold", reference_all_gold: referenceIds.length > 0, candidate_all_gold: candidateIds.length > 0,
      gained_ids: direction === "gain" ? expected : [], lost_ids: direction === "loss" ? expected : [],
      annotated_messages: { eligible: true, gold_turn_count: 2, no_positive_entry_count: 0, retrieval_covered_turns: turns, reference_covered_turns: referenceIds.length ? turns : [], candidate_covered_turns: candidateIds.length ? turns : [], retrieval_all_turns: true, reference_all_turns: referenceIds.length > 0, candidate_all_turns: candidateIds.length > 0, gained_turns: direction === "gain" ? turns : [], lost_turns: direction === "loss" ? turns : [] },
    });
  }
  passage.queries = [{ query_id: "q1", expected_ids: expected, retrieved_ids: retrieved, candidate_packed_ids: referenceIds, candidate_budget: budget(referenceIds.length), candidate_ranges: referenceRanges }];
  Object.assign(report.queries[0], { selected_message_indices: candidateIds.map((entry_id) => ({ entry_id, message_indices: [0] })), candidate_ranges: candidateRanges, candidate_budget: budget(candidateIds.length), whole_message_conservation: { selected_message_count: candidateIds.length, partial_message_count: 0 } });
  report.whole_message_conservation.selected_message_count = candidateIds.length;
  deps.execute = async () => {
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: expected, retrieved_ids: retrieved, packed_ids: referenceIds, budget: budget(referenceIds.length) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: passage, message_comparison: report }));
    return 0;
  };
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(0);
  for (const pair of [report.versus_legacy, report.versus_passages]) {
    if (direction === "gain") pair.queries[0].gained_ids = retrieved;
    else pair.queries[0].lost_ids = retrieved;
  }
  output = join(dir, "wrong-gold-delta-order.json");
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
});

it("rechecks message-boundary bytes after async artifact retrieval", async () => {
  const boundaries = writeReviewedMessageBoundaries(); const labels = writeReviewedGoldTurns();
  deps.fetchArtifacts = vi.fn(async () => {
    mkdirSync(artifactDir, { recursive: true }); for (const path of ["snapshot.db", "queries.jsonl", "query-vectors.json"]) writeFileSync(join(artifactDir, path), "fixture");
    writeFileSync(boundaries, Buffer.concat([reviewedMessageBoundaries, Buffer.from("\n")]));
    return { release_tag: RELEASE_TAG, source: "downloaded", files: [] };
  });
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
  expect(deps.execute).not.toHaveBeenCalled();
});

it.each(["missing", "wrong strategy", "wrong report digest", "bad count", "partial message", "missing paired comparison"])("fails closed for malformed message comparison: %s", async (failure) => {
  const boundaries = writeReviewedMessageBoundaries(); const labels = writeReviewedGoldTurns();
  const { passage, report } = messageComparison();
  const malformed = structuredClone(report);
  if (failure === "wrong strategy") malformed.versus_passages.reference_strategy = "legacy";
  if (failure === "wrong report digest") malformed.lineage.message_boundaries_sha256 = "0".repeat(64);
  if (failure === "bad count") malformed.versus_legacy.annotated_message_coverage.candidate_packed.all_turn_count = 1;
  if (failure === "partial message") malformed.whole_message_conservation.partial_message_count = 1;
  deps.execute = async () => {
    const withMissing = failure === "missing" || failure === "missing paired comparison" ? undefined : malformed;
    writeFileSync(output, JSON.stringify({ quality_state: "unchanged", rows: [{ query_id: "q1", expected_ids: ["e"], retrieved_ids: ["e"], packed_ids: ["e"], budget: messageBudget(1, 0) }], comparison: { gained_question_ids: [], lost_question_ids: [] }, passage_comparison: failure === "missing paired comparison" ? undefined : passage, message_comparison: withMissing }));
    return 0;
  };
  expect(await main([...args(), "--message-comparison", "query-message-neighbors-v1", "--message-boundaries", boundaries, "--passage-comparison", "query-passages-v1", "--gold-turns", labels], deps)).toBe(2);
});
