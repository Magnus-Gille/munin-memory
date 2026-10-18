import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CheckDependencies } from "../benchmark/evidence-metric/check.js";
import { RELEASE_TAG } from "../benchmark/evidence-metric/shared-artifacts.js";
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
