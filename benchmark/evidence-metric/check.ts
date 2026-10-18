#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeParents, fetchSharedArtifacts, loadSharedContract, type VerificationReceipt } from "./shared-artifacts.js";

const USAGE = "Usage: npm run benchmark:evidence:check -- --artifacts-dir DIR --output PATH";
type Contract = Awaited<ReturnType<typeof loadSharedContract>>;
export interface CheckDependencies {
  loadContract: () => Promise<Contract>;
  fetchArtifacts: (directory: string, manifest: Contract["manifest"]) => Promise<VerificationReceipt>;
  execute: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}
const execute: CheckDependencies["execute"] = (args, env) => new Promise((resolveCode, reject) => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve(import.meta.dirname, "run.ts"), ...args], { env, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => resolveCode(code ?? 2));
});
function parseArgs(args: string[]): { artifactsDir: string; output: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!["--artifacts-dir", "--output"].includes(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new Error(USAGE);
    values[key] = value;
  }
  if (!values["--artifacts-dir"] || !values["--output"]) throw new Error(USAGE);
  return { artifactsDir: resolve(values["--artifacts-dir"]), output: resolve(values["--output"]) };
}
function assertOutput(output: string, artifactsDir: string, metadataPaths: string[]): void {
  assertSafeParents(output);
  if (!lstatSync(dirname(output)).isDirectory()) throw new Error("Report output parent must exist");
  const canonicalOutput = join(realpathSync(dirname(output)), output.slice(dirname(output).length + 1));
  const artifactParent = realpathSync(dirname(artifactsDir)); const canonicalArtifacts = join(artifactParent, artifactsDir.slice(dirname(artifactsDir).length + 1));
  const inside = relative(canonicalArtifacts, canonicalOutput);
  if (inside === "" || (inside !== ".." && !inside.startsWith("../"))) throw new Error("Report output collides with artifact inputs/metadata");
  try { lstatSync(output); throw new Error("Evidence check requires a fresh report and verification receipt path"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const input of metadataPaths) {
    if (canonicalOutput === realpathSync(input)) throw new Error("Report output collides with baseline metadata");
  }
}
/** Downloads only the reviewed shared inputs, then delegates to the unchanged offline evaluator. */
export async function main(args: string[], dependencies: CheckDependencies = { loadContract: loadSharedContract, fetchArtifacts: fetchSharedArtifacts, execute }): Promise<0 | 1 | 2> {
  try {
    const { artifactsDir, output } = parseArgs(args);
    assertSafeParents(artifactsDir);
    const contract = await dependencies.loadContract();
    const receiptPath = output + ".verification.json";
    assertOutput(output, artifactsDir, contract.metadataPaths);
    assertOutput(receiptPath, artifactsDir, contract.metadataPaths);
    const receipt = await dependencies.fetchArtifacts(artifactsDir, contract.manifest);
    assertOutput(output, artifactsDir, contract.metadataPaths);
    assertOutput(receiptPath, artifactsDir, contract.metadataPaths);
    writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, ...receipt }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const env = { ...process.env }; delete env.MUNIN_SEMANTIC_MAX_DISTANCE;
    const status = await dependencies.execute(["--snapshot", join(artifactsDir, "snapshot.db"), "--queries", join(artifactsDir, "queries.jsonl"), "--vectors", join(artifactsDir, "query-vectors.json"), "--as-of", contract.asOf, "--baseline", contract.baseline, "--output", output], env);
    process.stdout.write(`Verified artifact receipt: ${JSON.stringify(receipt)}\n`);
    try {
      const report = JSON.parse(readFileSync(output, "utf8")) as { quality_state?: string; comparison?: { gained_question_ids?: unknown; lost_question_ids?: unknown; reproduced?: boolean } };
      const gained = report.comparison?.gained_question_ids ?? []; const lost = report.comparison?.lost_question_ids ?? [];
      if (((status === 0 || status === 1) && (!Array.isArray(report.comparison?.gained_question_ids) || !Array.isArray(report.comparison?.lost_question_ids)))
        || !Array.isArray(gained) || !Array.isArray(lost) || [...gained, ...lost].some((id: unknown) => typeof id !== "string" || !id)
        || (status === 0 && (!report.comparison || !["unchanged", "improved"].includes(report.quality_state ?? "") || lost.length !== 0 || (report.quality_state === "improved") !== (gained.length > 0)))
        || (status === 1 && (report.quality_state !== "regressed" || report.comparison?.reproduced !== true || lost.length === 0))
        || (status === 2 && report.quality_state !== "invalid")) throw new Error("Evaluator report/status mismatch");
      process.stdout.write(`Evidence ${report.quality_state ?? "invalid"}: gained ${gained.length} [${gained.join(", ")}]; lost ${lost.length} [${lost.join(", ")}]\n`);
    } catch { process.stdout.write("Evidence invalid: evaluator report is missing, malformed or inconsistent\n"); return 2; }
    return status === 0 || status === 1 ? status : 2;
  } catch (error) {
    process.stderr.write(`Evidence check invalid: ${error instanceof Error ? error.message : "Unknown setup error"}\n`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
