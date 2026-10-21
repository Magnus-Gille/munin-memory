import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CheckDependencies } from "../benchmark/evidence-metric/check.js";
import { RELEASE_TAG } from "../benchmark/evidence-metric/shared-artifacts.js";
import type { GoldTurnArtifact } from "../benchmark/evidence-metric/gold-turns.js";
const REVIEWED_GOLD_TURNS_SHA256 = "47dc2a2e8bdd1af0fb1b3d5aa39e68a4716548b8ad11d5587f06a7eac61a55db";
const reviewedGoldTurns = readFileSync(new URL("../benchmark/evidence-metric/comparisons/longmemeval-s-passages-20261020/gold-turns.json", import.meta.url));
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
