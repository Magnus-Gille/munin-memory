import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runContinuousEval } from "../benchmark/continuous/evaluator.js";
import { runContinuousCli } from "../benchmark/continuous/run.js";

describe("continuous evaluation CLI signals", () => {
  let directory: string;
  let baseline: Awaited<ReturnType<typeof runContinuousEval>>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "munin-eval-cli-test-"));
    baseline = await runContinuousEval();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  async function execute(name: string, reference?: unknown) {
    const output = join(directory, name + ".report.json");
    const path = join(directory, name + ".baseline.json");
    if (reference !== undefined) await writeFile(path, JSON.stringify(reference));
    const exit = await runContinuousCli(["--output", output, "--baseline", path]);
    return { exit, report: JSON.parse(await readFile(output, "utf8")) };
  }
  it("reports missing baseline as not measured", async () => {
    const { exit, report } = await execute("missing");
    expect(exit).toBe(2);
    expect(report).toMatchObject({ status: "invalid", quality_state: "not_measured" });
  });
  it("rejects an incomparable fixture rather than approving it", async () => {
    const { exit, report } = await execute("mismatch", { ...baseline, fixture_sha256: "changed" });
    expect(exit).toBe(2);
    expect(report.error).toContain("contracts differ");
  });
  it("reports comparable unchanged scores and source hashes", async () => {
    const { exit, report } = await execute("unchanged", baseline);
    expect(exit).toBe(0);
    expect(report).toMatchObject({ status: "measured", quality_state: "unchanged", question_count: 24 });
    expect(report.lineage.source_sha256["src/internal/reranker.ts"]).toMatch(/^[a-f0-9]{64}$/);
    expect(report.metrics).toEqual(baseline.metrics);
  });
  it("fails a reproduced regression without masking it with improvements", async () => {
    const metric = Object.keys(baseline.metrics).find(key => baseline.metrics[key] < 1)!;
    const { exit, report } = await execute("regressed", {
      ...baseline, metrics: { ...baseline.metrics, [metric]: 1 },
    });
    expect(exit).toBe(1);
    expect(report.quality_state).toBe("regressed");
    expect(report.confirmation).toEqual({ attempts: 2, consistent: true });
    expect(report.comparison.regressions.some((delta: { metric: string }) => delta.metric === metric)).toBe(true);
  });
  it("reports an unwritable report destination as not measured, never as a regression", async () => {
    const blocker = join(directory, "blocker");
    const path = join(directory, "unwritable.baseline.json");
    await writeFile(blocker, "");
    await writeFile(path, JSON.stringify(baseline));
    const exit = await runContinuousCli(["--output", join(blocker, "report.json"), "--baseline", path]);
    expect(exit).toBe(2);
  });
  it("exits 2 from the command line when no report can be written", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "benchmark/continuous/run.ts",
      "--output", join(directory, "blocker", "report.json")], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("not_measured");
  });
});
