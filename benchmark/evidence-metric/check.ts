#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeParents, fetchSharedArtifacts, loadSharedContract, type VerificationReceipt } from "./shared-artifacts.js";

const USAGE = "Usage: npm run benchmark:evidence:check -- --artifacts-dir DIR --output PATH [--packing-comparison skip-oversized] [--passage-comparison query-passages-v1 --gold-turns PATH]";
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
function parseArgs(args: string[]): { artifactsDir: string; output: string; packingComparison?: "skip-oversized"; passageComparison?: "query-passages-v1"; goldTurns?: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!["--artifacts-dir", "--output", "--packing-comparison", "--passage-comparison", "--gold-turns"].includes(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new Error(USAGE);
    values[key] = value;
  }
  if (!values["--artifacts-dir"] || !values["--output"]) throw new Error(USAGE);
  if (values["--packing-comparison"] !== undefined && values["--packing-comparison"] !== "skip-oversized") throw new Error(USAGE);
  if (values["--passage-comparison"] !== undefined && values["--passage-comparison"] !== "query-passages-v1") throw new Error(USAGE);
  if (Boolean(values["--passage-comparison"]) !== Boolean(values["--gold-turns"])) throw new Error("Passage comparison requires --passage-comparison query-passages-v1 and --gold-turns together");
  return { ...(values["--packing-comparison"] ? { packingComparison: "skip-oversized" as const } : {}), ...(values["--passage-comparison"] ? { passageComparison: "query-passages-v1" as const, goldTurns: resolve(values["--gold-turns"]) } : {}), artifactsDir: resolve(values["--artifacts-dir"]), output: resolve(values["--output"]) };
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
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Check only the experiment fields consumed by the hosted summary. */
function validPackingComparison(value: unknown): boolean {
  const comparison = record(value);
  if (!comparison || comparison.strategy !== "skip-oversized" || comparison.control_reproduced !== true) return false;
  for (const field of ["gained_question_ids", "lost_question_ids"]) {
    const ids = comparison[field];
    if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string" || !id.trim())) return false;
  }
  if (comparison.regression !== ((comparison.lost_question_ids as string[]).length > 0)) return false;
  const stages = record(comparison.stages);
  if (!stages) return false;
  return ["retrieval", "legacy_packed", "candidate_packed"].every((name) => {
    const counts = record(stages[name]);
    return counts !== undefined && ["all_gold", "partial_gold", "no_gold"].every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0);
  });
}
function uniqueIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim()) && new Set(value).size === value.length;
}
function validPassageComparison(value: unknown): boolean {
  const comparison = record(value);
  if (!comparison || comparison.strategy !== "query-passages-v1" || comparison.control_reproduced !== true
    || comparison.coordinate_system !== "utf16_code_units" || comparison.chunk_max_utf8_bytes !== 2048) return false;
  const lineage = record(comparison.lineage); const source = record(lineage?.source);
  const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!lineage || !source || !sha(lineage.gold_turns_sha256) || !sha(lineage.gold_turns_source_sha256)
    || !["dataset_sha256", "snapshot_sha256", "queries_sha256"].every((key) => sha(source[key]))) return false;
  const proxy = record(comparison.entry_id_proxy);
  if (!proxy || !validPackingComparison({ ...proxy, strategy: "skip-oversized", control_reproduced: true })) return false;
  const coverage = record(comparison.annotated_message_coverage);
  if (!coverage || coverage.metric !== "full_original_annotated_message_coverage_v1"
    || !uniqueIds(coverage.eligible_question_ids) || !uniqueIds(coverage.excluded_question_ids)
    || coverage.eligible_question_ids.some((id) => (coverage.excluded_question_ids as string[]).includes(id))
    || coverage.eligible_question_count !== coverage.eligible_question_ids.length
    || !Number.isSafeInteger(coverage.annotated_message_count) || (coverage.annotated_message_count as number) < 0
    || !uniqueIds(coverage.gained_question_ids) || !uniqueIds(coverage.lost_question_ids)
    || [...coverage.gained_question_ids, ...coverage.lost_question_ids].some((id) => !(coverage.eligible_question_ids as string[]).includes(id))
    || coverage.regression !== (coverage.lost_question_ids.length > 0)) return false;
  const eligibleCount = coverage.eligible_question_count as number;
  return ["retrieval", "legacy_packed", "candidate_packed"].every((name) => {
    const stage = record(coverage[name]);
    return stage !== undefined && Number.isSafeInteger(stage.all_turn_count) && (stage.all_turn_count as number) >= 0
      && (stage.all_turn_count as number) <= eligibleCount
      && stage.all_turn_rate === (eligibleCount === 0 ? null : (stage.all_turn_count as number) / eligibleCount)
      && Number.isSafeInteger(stage.covered_message_count) && (stage.covered_message_count as number) >= 0
      && (stage.covered_message_count as number) <= (coverage.annotated_message_count as number);
  });
}
/** Downloads only the reviewed shared inputs, then delegates to the offline evaluator. */
export async function main(args: string[], dependencies: CheckDependencies = { loadContract: loadSharedContract, fetchArtifacts: fetchSharedArtifacts, execute }): Promise<0 | 1 | 2> {
  try {
    const { artifactsDir, output, packingComparison, passageComparison, goldTurns } = parseArgs(args);
    assertSafeParents(artifactsDir);
    const contract = await dependencies.loadContract();
    const metadataPaths = [...contract.metadataPaths, ...(goldTurns ? [goldTurns] : [])];
    const receiptPath = output + ".verification.json";
    assertOutput(output, artifactsDir, metadataPaths);
    assertOutput(receiptPath, artifactsDir, metadataPaths);
    const receipt = await dependencies.fetchArtifacts(artifactsDir, contract.manifest);
    assertOutput(output, artifactsDir, metadataPaths);
    assertOutput(receiptPath, artifactsDir, metadataPaths);
    writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, ...receipt }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const env = { ...process.env }; delete env.MUNIN_SEMANTIC_MAX_DISTANCE;
    const status = await dependencies.execute(["--snapshot", join(artifactsDir, "snapshot.db"), "--queries", join(artifactsDir, "queries.jsonl"), "--vectors", join(artifactsDir, "query-vectors.json"), "--as-of", contract.asOf, "--baseline", contract.baseline, "--output", output, ...(packingComparison ? ["--packing-comparison", packingComparison] : []), ...(passageComparison ? ["--passage-comparison", passageComparison, "--gold-turns", goldTurns!] : [])], env);
    process.stdout.write(`Verified artifact receipt: ${JSON.stringify(receipt)}\n`);
    try {
      const report = JSON.parse(readFileSync(output, "utf8")) as { quality_state?: string; packing_comparison?: unknown; passage_comparison?: unknown; comparison?: { gained_question_ids?: unknown; lost_question_ids?: unknown; reproduced?: boolean } };
      const gained = report.comparison?.gained_question_ids ?? []; const lost = report.comparison?.lost_question_ids ?? [];
      if (((status === 0 || status === 1) && (!Array.isArray(report.comparison?.gained_question_ids) || !Array.isArray(report.comparison?.lost_question_ids)))
        || !Array.isArray(gained) || !Array.isArray(lost) || [...gained, ...lost].some((id: unknown) => typeof id !== "string" || !id)
        || (status === 0 && (!report.comparison || !["unchanged", "improved"].includes(report.quality_state ?? "") || lost.length !== 0 || (report.quality_state === "improved") !== (gained.length > 0)))
        || (status === 1 && (report.quality_state !== "regressed" || report.comparison?.reproduced !== true || lost.length === 0))
        || (status === 2 && report.quality_state !== "invalid")
        || ((status === 0 || status === 1) && packingComparison && !validPackingComparison(report.packing_comparison))
        || ((status === 0 || status === 1) && passageComparison && !validPassageComparison(report.passage_comparison))) throw new Error("Evaluator report/status mismatch");
      process.stdout.write(`Evidence ${report.quality_state ?? "invalid"}: gained ${gained.length} [${gained.join(", ")}]; lost ${lost.length} [${lost.join(", ")}]\n`);
    } catch { process.stdout.write("Evidence invalid: evaluator report is missing, malformed or inconsistent\n"); return 2; }
    return status === 0 || status === 1 ? status : 2;
  } catch (error) {
    process.stderr.write(`Evidence check invalid: ${error instanceof Error ? error.message : "Unknown setup error"}\n`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
