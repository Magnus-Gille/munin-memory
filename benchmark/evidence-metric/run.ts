#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertOutputSafe, evaluate, type EvaluationOptions } from "./evaluate.js";

const USAGE = "Usage: npm run benchmark:evidence -- --snapshot PATH --queries PATH --vectors PATH --as-of ISO_TIMESTAMP --output PATH [--baseline PATH] [--packing-comparison skip-oversized] [--passage-comparison query-passages-v1 --gold-turns PATH] [--message-comparison query-message-neighbors-v1 --message-boundaries PATH] [--core-comparison query-message-cores-v1]";
function parseArgs(args: string[]): EvaluationOptions & { output: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!["--snapshot", "--queries", "--vectors", "--as-of", "--output", "--baseline", "--packing-comparison", "--passage-comparison", "--gold-turns", "--message-comparison", "--message-boundaries", "--core-comparison"].includes(key)
      || !value || value.startsWith("--") || values[key] !== undefined) throw new Error(USAGE);
    values[key] = value;
  }
  for (const key of ["--snapshot", "--queries", "--vectors", "--as-of", "--output"]) {
    if (!values[key]) throw new Error(USAGE);
  }
  if (values["--packing-comparison"] !== undefined && values["--packing-comparison"] !== "skip-oversized") throw new Error(USAGE);
  if (values["--packing-comparison"] && !values["--baseline"]) throw new Error("Packing comparison requires --baseline");
  if (values["--passage-comparison"] !== undefined && values["--passage-comparison"] !== "query-passages-v1") throw new Error(USAGE);
  if (values["--passage-comparison"] && (!values["--baseline"] || !values["--gold-turns"])) throw new Error("Passage comparison requires --baseline and --gold-turns");
  if (values["--gold-turns"] && !values["--passage-comparison"]) throw new Error("--gold-turns requires --passage-comparison query-passages-v1");
  if (values["--message-comparison"] !== undefined && values["--message-comparison"] !== "query-message-neighbors-v1") throw new Error(USAGE);
  if (values["--message-comparison"] && (!values["--message-boundaries"] || !values["--baseline"] || values["--passage-comparison"] !== "query-passages-v1" || !values["--gold-turns"])) throw new Error("Message comparison requires --message-boundaries, --baseline, --passage-comparison query-passages-v1 and --gold-turns");
  if (values["--message-boundaries"] && !values["--message-comparison"]) throw new Error("--message-boundaries requires --message-comparison query-message-neighbors-v1");
  if (values["--core-comparison"] !== undefined && values["--core-comparison"] !== "query-message-cores-v1") throw new Error(USAGE);
  if (values["--core-comparison"] && (!values["--baseline"] || values["--passage-comparison"] !== "query-passages-v1" || !values["--gold-turns"] || values["--message-comparison"] !== "query-message-neighbors-v1" || !values["--message-boundaries"])) throw new Error("Core comparison requires --baseline, --passage-comparison query-passages-v1, --gold-turns, --message-comparison query-message-neighbors-v1 and --message-boundaries");
  return { ...(values["--core-comparison"] ? { coreComparison: "query-message-cores-v1" as const } : {}), ...(values["--packing-comparison"] ? { packingComparison: "skip-oversized" as const } : {}), ...(values["--passage-comparison"] ? { passageComparison: "query-passages-v1" as const, goldTurns: resolve(values["--gold-turns"]) } : {}), ...(values["--message-comparison"] ? { messageComparison: "query-message-neighbors-v1" as const, messageBoundaries: resolve(values["--message-boundaries"]) } : {}), snapshot: resolve(values["--snapshot"]), queries: resolve(values["--queries"]), vectors: resolve(values["--vectors"]), asOf: values["--as-of"], output: resolve(values["--output"]), ...(values["--baseline"] ? { baseline: resolve(values["--baseline"]) } : {}) };
}
function writeAtomic(path: string, report: unknown): void {
  const temporary = join(dirname(path), `.evidence-report-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
/** Returns exit status so tests can exercise the exact CLI policy without subprocess IPC. */
export async function main(args: string[]): Promise<0 | 1 | 2> {
  let options: ReturnType<typeof parseArgs> | undefined;
  let safeOutput = false;
  try {
    options = parseArgs(args);
    const inputs = [options.snapshot, options.queries, options.vectors, ...(options.baseline ? [options.baseline] : []), ...(options.goldTurns ? [options.goldTurns] : []), ...(options.messageBoundaries ? [options.messageBoundaries] : [])];
    assertOutputSafe(options.output, inputs);
    safeOutput = true;
    const result = await evaluate(options);
    // Recheck aliases immediately before the atomic replacement.
    assertOutputSafe(options.output, inputs);
    writeAtomic(options.output, result.report);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown evidence evaluation error";
    process.stderr.write(`Evidence evaluation invalid: ${message}\n`);
    if (safeOutput && options) {
      try {
        assertOutputSafe(options.output, [options.snapshot, options.queries, options.vectors, ...(options.baseline ? [options.baseline] : []), ...(options.goldTurns ? [options.goldTurns] : []), ...(options.messageBoundaries ? [options.messageBoundaries] : [])]);
        writeAtomic(options.output, { schema_version: 1, quality_state: "invalid", error: message });
      } catch {
        // Reporting failures preserve status 2; no fallback output may clobber an input.
      }
    }
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // No environment-based snapshot/model defaults, downloads, or populate operations.
  process.exitCode = await main(process.argv.slice(2));
}
