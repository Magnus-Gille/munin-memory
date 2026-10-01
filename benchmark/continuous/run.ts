import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runContinuousEval } from "./evaluator.js";
import { compareMetrics } from "./policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

interface Baseline {
  schema_version: 1;
  contract_id: string;
  fixture_sha256: string;
  seed: number;
  question_count: number;
  metrics: Record<string, number>;
}

function writeReport(path: string, report: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function lineage(): Record<string, unknown> {
  const files = [
    "benchmark/continuous/generator.ts", "benchmark/continuous/evaluator.ts",
    "benchmark/continuous/clock.ts", "benchmark/continuous/policy.ts",
    "benchmark/continuous/run.ts", "benchmark/runner.ts", "benchmark/scorer.ts",
    "src/db.ts", "src/internal/reranker.ts", "src/internal/retrieval-shared.ts",
  ];
  return {
    source_revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    source_sha256: Object.fromEntries(files.map((file) => [file,
      createHash("sha256").update(readFileSync(resolve(ROOT, file))).digest("hex")])),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export async function runContinuousCli(args: string[]): Promise<number> {
  let output = resolve(ROOT, "benchmark/reports/continuous/latest.json");
  const runAt = new Date().toISOString();
  try {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false,
      options: { output: { type: "string" }, baseline: { type: "string" } } });
    output = resolve(values.output ?? output);
    const baselinePath = resolve(values.baseline ?? resolve(HERE, "baseline.json"));
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
    const evaluated = await runContinuousEval();
    if (!baseline || baseline.schema_version !== 1
      || baseline.contract_id !== evaluated.contract_id
      || baseline.fixture_sha256 !== evaluated.fixture_sha256
      || baseline.seed !== evaluated.seed
      || baseline.question_count !== evaluated.question_count) {
      throw new Error("Baseline and evaluation contracts differ; no comparable quality signal.");
    }
    const verdict = compareMetrics(evaluated.metrics, baseline.metrics);
    let confirmation: { attempts: number; consistent: boolean } | undefined;
    if (verdict.status === "regressed") {
      const repeated = await runContinuousEval();
      const consistency = compareMetrics(repeated.metrics, evaluated.metrics);
      if (repeated.fixture_sha256 !== evaluated.fixture_sha256 || consistency.status !== "unchanged") {
        throw new Error("Regression could not be reproduced on identical generated inputs.");
      }
      confirmation = { attempts: 2, consistent: true };
    }
    const report = { ...evaluated, run_at: runAt, lineage: lineage(),
      quality_state: verdict.status, comparison: verdict, confirmation,
      interpretation: "Known-source lexical retrieval only; unchanged does not mean overall memory quality is good." };
    writeReport(output, report);
    process.stdout.write(`${JSON.stringify({ status: report.status, quality_state: report.quality_state,
      questions: report.question_count, metrics: report.metrics, output })}\n`);
    return verdict.status === "regressed" ? 1 : 0;
  } catch (error) {
    const report = { schema_version: 1, status: "invalid", quality_state: "not_measured",
      run_at: runAt, error: error instanceof Error ? error.message : "Evaluation failed." };
    process.stderr.write(`${JSON.stringify(report)}\n`);
    // An unwritable destination must stay "not measured"; a throw here would exit 1 (regression).
    try {
      writeReport(output, report);
    } catch (writeError) {
      process.stderr.write(`${JSON.stringify({ status: "invalid", quality_state: "not_measured",
        error: `Report could not be written: ${writeError instanceof Error ? writeError.message : "unknown error"}` })}\n`);
    }
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runContinuousCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ status: "invalid", quality_state: "not_measured",
      error: error instanceof Error ? error.message : "Evaluation failed." })}\n`);
    return 2;
  });
}
