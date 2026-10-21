#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeParents, fetchSharedArtifacts, loadSharedContract, type VerificationReceipt } from "./shared-artifacts.js";

const USAGE = "Usage: npm run benchmark:evidence:check -- --artifacts-dir DIR --output PATH [--packing-comparison skip-oversized] [--passage-comparison query-passages-v1 --gold-turns PATH] [--message-comparison query-message-neighbors-v1 --message-boundaries PATH] [--core-comparison query-message-cores-v1]";
/** Reviewed against the pinned upstream dataset; updating labels requires a new reviewed digest. */
const SHARED_GOLD_TURNS_SHA256 = "47dc2a2e8bdd1af0fb1b3d5aa39e68a4716548b8ad11d5587f06a7eac61a55db";
/** Reviewed label-free boundary artifact; any edit requires a new reviewed pin. */
const SHARED_MESSAGE_BOUNDARIES_SHA256 = "3868f7c9ab26eb79953caf139b42535e3895de91ef7cb033eabbf5bf17e3aa8f";
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
function parseArgs(args: string[]): { artifactsDir: string; output: string; packingComparison?: "skip-oversized"; passageComparison?: "query-passages-v1"; goldTurns?: string; messageComparison?: "query-message-neighbors-v1"; messageBoundaries?: string; coreComparison?: "query-message-cores-v1" } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!["--artifacts-dir", "--output", "--packing-comparison", "--passage-comparison", "--gold-turns", "--message-comparison", "--message-boundaries", "--core-comparison"].includes(key) || !value || value.startsWith("--") || values[key] !== undefined) throw new Error(USAGE);
    values[key] = value;
  }
  if (!values["--artifacts-dir"] || !values["--output"]) throw new Error(USAGE);
  if (values["--packing-comparison"] !== undefined && values["--packing-comparison"] !== "skip-oversized") throw new Error(USAGE);
  if (values["--passage-comparison"] !== undefined && values["--passage-comparison"] !== "query-passages-v1") throw new Error(USAGE);
  if (Boolean(values["--passage-comparison"]) !== Boolean(values["--gold-turns"])) throw new Error("Passage comparison requires --passage-comparison query-passages-v1 and --gold-turns together");
  if (values["--message-comparison"] !== undefined && values["--message-comparison"] !== "query-message-neighbors-v1") throw new Error(USAGE);
  if (Boolean(values["--message-comparison"]) !== Boolean(values["--message-boundaries"])) throw new Error("Message comparison requires --message-comparison query-message-neighbors-v1 and --message-boundaries together");
  if (values["--message-comparison"] && (!values["--passage-comparison"] || !values["--gold-turns"])) throw new Error("Message comparison requires --passage-comparison query-passages-v1 and --gold-turns");
  if (values["--core-comparison"] !== undefined && values["--core-comparison"] !== "query-message-cores-v1") throw new Error(USAGE);
  if (values["--core-comparison"] && !values["--message-comparison"]) throw new Error("Core comparison requires --message-comparison query-message-neighbors-v1, --message-boundaries, --passage-comparison query-passages-v1 and --gold-turns");
  return { ...(values["--packing-comparison"] ? { packingComparison: "skip-oversized" as const } : {}), ...(values["--passage-comparison"] ? { passageComparison: "query-passages-v1" as const, goldTurns: resolve(values["--gold-turns"]) } : {}), ...(values["--message-comparison"] ? { messageComparison: "query-message-neighbors-v1" as const, messageBoundaries: resolve(values["--message-boundaries"]) } : {}), ...(values["--core-comparison"] ? { coreComparison: "query-message-cores-v1" as const } : {}), artifactsDir: resolve(values["--artifacts-dir"]), output: resolve(values["--output"]) };
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
function assertReviewedGoldTurns(path: string): void {
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== SHARED_GOLD_TURNS_SHA256) {
    throw new Error(`Shared passage comparison requires the reviewed gold-turn artifact SHA-256 ${SHARED_GOLD_TURNS_SHA256}`);
  }
}
function assertReviewedMessageBoundaries(path: string): void {
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== SHARED_MESSAGE_BOUNDARIES_SHA256) {
    throw new Error(`Shared message comparison requires the reviewed message-boundaries artifact SHA-256 ${SHARED_MESSAGE_BOUNDARIES_SHA256}`);
  }
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
  if (!lineage || !source || lineage.gold_turns_sha256 !== SHARED_GOLD_TURNS_SHA256 || !sha(lineage.gold_turns_source_sha256)
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
type MessagePairName = "legacy" | "query-passages-v1" | "query-message-neighbors-v1";
function validStageCounts(value: unknown): boolean {
  const stage = record(value);
  return stage !== undefined && ["all_gold", "partial_gold", "no_gold"].every((key) => Number.isSafeInteger(stage[key]) && (stage[key] as number) >= 0);
}
function validBudget(value: unknown): boolean {
  const budget = record(value);
  return budget !== undefined && budget.estimator === "utf8_bytes_div4_ceil_v1"
    && budget.max_estimated_tokens === 8192 && typeof budget.truncated === "boolean"
    && Number.isSafeInteger(budget.estimated_tokens) && (budget.estimated_tokens as number) >= 0 && (budget.estimated_tokens as number) <= 8192
    && Number.isSafeInteger(budget.candidate_entry_count) && (budget.candidate_entry_count as number) >= 0
    && Number.isSafeInteger(budget.included_entry_count) && (budget.included_entry_count as number) >= 0
    && Number.isSafeInteger(budget.dropped_entry_count) && budget.dropped_entry_count === (budget.candidate_entry_count as number) - (budget.included_entry_count as number);
}
function validRanges(value: unknown): value is Array<{ entry_id: string; start: number; end: number }> {
  return Array.isArray(value) && value.every((range) => {
    const item = record(range);
    return item !== undefined && typeof item.entry_id === "string" && item.entry_id.trim().length > 0
      && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && (item.start as number) >= 0 && (item.end as number) > (item.start as number);
  });
}
function validTurns(value: unknown): value is Array<{ entry_id: string; message_index: number }> {
  return Array.isArray(value) && value.every((turn) => {
    const item = record(turn);
    return item !== undefined && typeof item.entry_id === "string" && item.entry_id.trim().length > 0
      && Number.isSafeInteger(item.message_index) && (item.message_index as number) >= 0;
  });
}
function validMessagePair(value: unknown, reference: MessagePairName, queryIds: string[], eligibility: Map<string, boolean>): boolean {
  const pair = record(value);
  if (!pair || pair.reference_strategy !== reference || pair.query_count !== queryIds.length || !Array.isArray(pair.queries)) return false;
  const queries = pair.queries.map(record);
  if (queries.some((query) => !query)) return false;
  const rows = queries as Record<string, unknown>[];
  const rowIds = rows.map((row) => row.query_id);
  if (!uniqueIds(rowIds) || rowIds.length !== queryIds.length || queryIds.some((id) => !rowIds.includes(id))) return false;
  const stages = record((record(pair.entry_id_proxy) ?? {}).stages);
  if (!stages || !["retrieval", "reference_packed", "candidate_packed"].every((key) => validStageCounts(stages[key]))) return false;
  const proxy = record(pair.entry_id_proxy)!;
  const goldStage = (expected: string[], packed: string[]) => {
    const count = expected.filter((id) => packed.includes(id)).length;
    return count === expected.length ? "all_gold" : count > 0 ? "partial_gold" : "no_gold";
  };
  const proxyGained = rows.filter((row) => row.reference_all_gold === false && row.candidate_all_gold === true).map((row) => row.query_id);
  const proxyLost = rows.filter((row) => row.reference_all_gold === true && row.candidate_all_gold === false).map((row) => row.query_id);
  const anyIdLoss = rows.filter((row) => Array.isArray(row.lost_ids) && (row.lost_ids as unknown[]).length > 0).map((row) => row.query_id);
  if (!uniqueIds(proxy.gained_question_ids) || !uniqueIds(proxy.lost_question_ids) || !uniqueIds(proxy.any_gold_loss_question_ids)
    || JSON.stringify(proxy.gained_question_ids) !== JSON.stringify(proxyGained)
    || JSON.stringify(proxy.lost_question_ids) !== JSON.stringify(proxyLost)
    || JSON.stringify(proxy.any_gold_loss_question_ids) !== JSON.stringify(anyIdLoss)
    || proxy.regression !== (proxyLost.length > 0)
    || proxy.gained_id_count !== rows.reduce((n, row) => n + (Array.isArray(row.gained_ids) ? row.gained_ids.length : Number.NaN), 0)
    || proxy.lost_id_count !== rows.reduce((n, row) => n + (Array.isArray(row.lost_ids) ? row.lost_ids.length : Number.NaN), 0)) return false;
  const coverage = record(pair.annotated_message_coverage);
  if (!coverage || coverage.metric !== "full_original_annotated_message_coverage_v1"
    || !uniqueIds(coverage.eligible_question_ids) || !uniqueIds(coverage.excluded_question_ids)
    || coverage.eligible_question_count !== coverage.eligible_question_ids.length
    || coverage.eligible_question_ids.some((id) => (coverage.excluded_question_ids as string[]).includes(id))
    || coverage.regression !== (Array.isArray(coverage.lost_question_ids) && coverage.lost_question_ids.length > 0)
    || !uniqueIds(coverage.gained_question_ids) || !uniqueIds(coverage.lost_question_ids)) return false;
  const eligibleRows = rows.filter((row) => row.annotated_messages !== null && typeof row.annotated_messages === "object" && !Array.isArray(row.annotated_messages)
    && (row.annotated_messages as Record<string, unknown>).eligible === true);
  const excludedRows = rows.filter((row) => row.annotated_messages !== null && typeof row.annotated_messages === "object" && !Array.isArray(row.annotated_messages)
    && (row.annotated_messages as Record<string, unknown>).eligible === false);
  if (eligibleRows.length !== coverage.eligible_question_count || JSON.stringify(coverage.eligible_question_ids) !== JSON.stringify(eligibleRows.map((row) => row.query_id))
    || JSON.stringify(coverage.excluded_question_ids) !== JSON.stringify(excludedRows.map((row) => row.query_id))) return false;
  const messageGained = eligibleRows.filter((row) => {
    const annotated = record(row.annotated_messages)!; return annotated.reference_all_turns === false && annotated.candidate_all_turns === true;
  }).map((row) => row.query_id);
  const messageLost = eligibleRows.filter((row) => {
    const annotated = record(row.annotated_messages)!; return annotated.reference_all_turns === true && annotated.candidate_all_turns === false;
  }).map((row) => row.query_id);
  if (JSON.stringify(coverage.gained_question_ids) !== JSON.stringify(messageGained)
    || JSON.stringify(coverage.lost_question_ids) !== JSON.stringify(messageLost)) return false;
  const count = coverage.eligible_question_count as number;
  for (const name of ["retrieval", "reference_packed", "candidate_packed"]) {
    const stage = record(coverage[name]);
    if (!stage || !Number.isSafeInteger(stage.all_turn_count) || (stage.all_turn_count as number) < 0 || (stage.all_turn_count as number) > count
      || stage.all_turn_rate !== (count === 0 ? null : (stage.all_turn_count as number) / count)
      || !Number.isSafeInteger(stage.covered_message_count) || (stage.covered_message_count as number) < 0) return false;
  }
  const categories = record(pair.categories);
  if (!categories || Object.keys(categories).length === 0) return false;
  for (const row of rows) {
    if (typeof row.query_id !== "string" || typeof row.category !== "string" || !row.category.trim()
      || !Array.isArray(row.expected_ids) || !Array.isArray(row.retrieved_ids) || !Array.isArray(row.reference_packed_ids) || !Array.isArray(row.candidate_packed_ids)
      || !uniqueIds(row.expected_ids) || !uniqueIds(row.retrieved_ids) || !uniqueIds(row.reference_packed_ids) || !uniqueIds(row.candidate_packed_ids)
      || !(row.reference_packed_ids as string[]).every((id) => (row.retrieved_ids as string[]).includes(id))
      || !(row.candidate_packed_ids as string[]).every((id) => (row.retrieved_ids as string[]).includes(id))
      || !validBudget(row.reference_budget) || !validBudget(row.candidate_budget) || !validRanges(row.reference_ranges) || !validRanges(row.candidate_ranges)
      || typeof row.reference_all_gold !== "boolean" || typeof row.candidate_all_gold !== "boolean"
      || row.reference_all_gold !== ((row.expected_ids as string[]).every((id) => (row.reference_packed_ids as string[]).includes(id)))
      || row.candidate_all_gold !== ((row.expected_ids as string[]).every((id) => (row.candidate_packed_ids as string[]).includes(id)))
      || row.retrieval_stage !== goldStage(row.expected_ids as string[], row.retrieved_ids as string[])
      || row.reference_packed_stage !== goldStage(row.expected_ids as string[], row.reference_packed_ids as string[])
      || row.candidate_packed_stage !== goldStage(row.expected_ids as string[], row.candidate_packed_ids as string[])
      || !Array.isArray(row.gained_ids) || !uniqueIds(row.gained_ids) || !Array.isArray(row.lost_ids) || !uniqueIds(row.lost_ids)
      // Gold deltas preserve expected-ID order, independently of retrieval/display order.
      || JSON.stringify(row.gained_ids) !== JSON.stringify((row.expected_ids as string[]).filter((id) => (row.candidate_packed_ids as string[]).includes(id) && !(row.reference_packed_ids as string[]).includes(id)))
      || JSON.stringify(row.lost_ids) !== JSON.stringify((row.expected_ids as string[]).filter((id) => (row.reference_packed_ids as string[]).includes(id) && !(row.candidate_packed_ids as string[]).includes(id)))) return false;
    const annotated = record(row.annotated_messages);
    if (!annotated || typeof annotated.eligible !== "boolean" || eligibility.get(row.query_id as string) !== annotated.eligible
      || !Number.isSafeInteger(annotated.gold_turn_count) || (annotated.gold_turn_count as number) < 0
      || !Number.isSafeInteger(annotated.no_positive_entry_count) || (annotated.no_positive_entry_count as number) < 0
      || !validTurns(annotated.retrieval_covered_turns) || !validTurns(annotated.reference_covered_turns) || !validTurns(annotated.candidate_covered_turns)
      || !validTurns(annotated.gained_turns) || !validTurns(annotated.lost_turns)
      || (annotated.eligible ? typeof annotated.reference_all_turns !== "boolean" || typeof annotated.candidate_all_turns !== "boolean" : annotated.reference_all_turns !== null || annotated.candidate_all_turns !== null)) return false;
  }
  const expectedStages = {
    retrieval: rows.map((row) => row.retrieval_stage),
    reference_packed: rows.map((row) => row.reference_packed_stage),
    candidate_packed: rows.map((row) => row.candidate_packed_stage),
  };
  for (const [stageName, values] of Object.entries(expectedStages)) {
    if (!values.every((value) => ["all_gold", "partial_gold", "no_gold"].includes(value as string))) return false;
    for (const key of ["all_gold", "partial_gold", "no_gold"]) {
      if ((stages[stageName] as Record<string, unknown>)[key] !== values.filter((value) => value === key).length) return false;
    }
  }
  // Category summaries are independently consumed by the hosted report; make sure
  // each category exists and its query denominator cannot exceed the whole report.
  if (JSON.stringify(Object.keys(categories).sort()) !== JSON.stringify([...new Set(rows.map((row) => row.category as string))].sort())) return false;
  for (const [category, summary] of Object.entries(categories)) {
    const subset = rows.filter((row) => row.category === category);
    const item = record(summary);
    const categoryStages = record(record(item?.entry_id_proxy)?.stages);
    const categoryCoverage = record(item?.annotated_message_coverage);
    const categoryEligible = subset.filter((row) => record(row.annotated_messages)?.eligible === true);
    if (subset.length === 0 || !item || item.query_count !== subset.length || !categoryStages || !categoryCoverage
      || ["retrieval", "reference_packed", "candidate_packed"].some((name) => !validStageCounts(categoryStages[name]))
      || categoryCoverage.eligible_question_count !== categoryEligible.length
      || categoryCoverage.annotated_message_count !== subset.reduce((sum, row) => sum + (record(row.annotated_messages)!.gold_turn_count as number), 0)) return false;
    for (const [name, field] of [["retrieval", "retrieval_stage"], ["reference_packed", "reference_packed_stage"], ["candidate_packed", "candidate_packed_stage"]]) {
      for (const key of ["all_gold", "partial_gold", "no_gold"]) {
        if ((categoryStages[name] as Record<string, unknown>)[key] !== subset.filter((row) => row[field] === key).length) return false;
      }
    }
  }
  if (coverage.annotated_message_count !== rows.reduce((sum, row) => sum + (record(row.annotated_messages)?.gold_turn_count as number), 0)) return false;
  for (const [name, flag, turnKey] of [
    ["retrieval", "retrieval_all_turns", "retrieval_covered_turns"],
    ["reference_packed", "reference_all_turns", "reference_covered_turns"],
    ["candidate_packed", "candidate_all_turns", "candidate_covered_turns"],
  ] as const) {
    const stage = record(coverage[name])!;
    const coveredCount = rows.reduce((sum, row) => sum + ((record(row.annotated_messages)![turnKey] as unknown[]).length), 0);
    const completeCount = eligibleRows.filter((row) => record(row.annotated_messages)![flag] === true).length;
    if (stage.all_turn_count !== completeCount || stage.covered_message_count !== coveredCount) return false;
  }
  if (coverage.gained_message_count !== rows.reduce((sum, row) => sum + (record(row.annotated_messages)!.gained_turns as unknown[]).length, 0)
    || coverage.lost_message_count !== rows.reduce((sum, row) => sum + (record(row.annotated_messages)!.lost_turns as unknown[]).length, 0)) return false;
  const excludedLabels = record(pair.excluded_labels);
  return excludedLabels !== undefined && excludedLabels.question_count === excludedRows.length
    && excludedLabels.annotated_message_count === excludedRows.reduce((sum, row) => sum + (record(row.annotated_messages)!.gold_turn_count as number), 0)
    && excludedLabels.no_positive_entry_count === excludedRows.reduce((sum, row) => sum + (record(row.annotated_messages)!.no_positive_entry_count as number), 0);
}
function validMessageComparison(value: unknown, passageValue: unknown, controlRowsValue: unknown): boolean {
  const comparison = record(value); const lineage = record(comparison?.lineage); const source = record(lineage?.source);
  const passage = record(passageValue); const passageLineage = record(passage?.lineage); const passageSource = record(passageLineage?.source);
  const sha = (item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
  if (!comparison || comparison.strategy !== "query-message-neighbors-v1" || comparison.control_reproduced !== true
    || comparison.coordinate_system !== "utf16_code_units" || typeof comparison.metric_limitation !== "string" || !comparison.metric_limitation.trim()
    || !lineage || lineage.message_boundaries_sha256 !== SHARED_MESSAGE_BOUNDARIES_SHA256
    || !sha(lineage.message_boundaries_source_sha256) || !sha(lineage.message_packing_source_sha256) || !sha(lineage.message_comparison_source_sha256)
    || !source || !passageSource || !["dataset_sha256", "snapshot_sha256"].every((key) => sha(source[key]) && source[key] === passageSource[key])) return false;
  const legacy = record(comparison.versus_legacy); const passages = record(comparison.versus_passages);
  if (!legacy || !passages || !Array.isArray(legacy.queries) || !Array.isArray(passages.queries)) return false;
  const legacyRows = (legacy.queries as Record<string, unknown>[]); const passageRows = (passages.queries as Record<string, unknown>[]);
  if (legacyRows.length !== passageRows.length || legacyRows.some((row, index) => row.query_id !== passageRows[index].query_id || row.category !== passageRows[index].category)) return false;
  const passageQueries = new Map(((passage?.queries as Record<string, unknown>[] | undefined) ?? []).map((row) => [row.query_id, row]));
  if (passageQueries.size !== legacyRows.length) return false;
  const controlRows = Array.isArray(controlRowsValue) ? controlRowsValue.map(record) : [];
  if (controlRows.some((row) => !row) || controlRows.length !== legacyRows.length) return false;
  const controlById = new Map((controlRows as Record<string, unknown>[]).map((row) => [row.query_id, row]));
  if (controlById.size !== legacyRows.length) return false;
  const eligibility = new Map(legacyRows.map((row) => [row.query_id as string, record(row.annotated_messages)?.eligible === true]));
  if (!validMessagePair(legacy, "legacy", legacyRows.map((row) => row.query_id as string), eligibility)
    || !validMessagePair(passages, "query-passages-v1", passageRows.map((row) => row.query_id as string), eligibility)) return false;
  for (const row of passageRows) {
    const prior = record(passageQueries.get(row.query_id));
    if (!prior || JSON.stringify(row.reference_packed_ids) !== JSON.stringify(prior.candidate_packed_ids)
      || JSON.stringify(row.reference_budget) !== JSON.stringify(prior.candidate_budget)
      || JSON.stringify(row.reference_ranges) !== JSON.stringify(prior.candidate_ranges)
      || JSON.stringify(row.expected_ids) !== JSON.stringify(prior.expected_ids)
      || JSON.stringify(row.retrieved_ids) !== JSON.stringify(prior.retrieved_ids)) return false;
  }
  for (const row of legacyRows) {
    const control = record(controlById.get(row.query_id));
    if (!control || JSON.stringify(row.expected_ids) !== JSON.stringify(control.expected_ids)
      || JSON.stringify(row.retrieved_ids) !== JSON.stringify(control.retrieved_ids)
      || JSON.stringify(row.reference_packed_ids) !== JSON.stringify(control.packed_ids)
      || JSON.stringify(row.reference_budget) !== JSON.stringify(control.budget)) return false;
  }
  if (!Array.isArray(comparison.queries) || comparison.queries.length !== legacyRows.length) return false;
  const selectedRows = comparison.queries.map(record);
  if (selectedRows.some((row) => !row)) return false;
  const selected = selectedRows as Record<string, unknown>[];
  const selectedIds = selected.map((row) => row.query_id);
  if (!uniqueIds(selectedIds) || JSON.stringify(selectedIds) !== JSON.stringify(legacyRows.map((row) => row.query_id))) return false;
  let selectedCount = 0;
  for (const row of selected) {
    const indices = row.selected_message_indices;
    if (!Array.isArray(indices) || !validRanges(row.candidate_ranges) || !validBudget(row.candidate_budget)) return false;
    const seenEntries = new Set<string>();
    for (const value of indices) {
      const item = record(value);
      if (!item || typeof item.entry_id !== "string" || !item.entry_id.trim() || seenEntries.has(item.entry_id)
        || !Array.isArray(item.message_indices) || item.message_indices.some((index) => !Number.isSafeInteger(index) || (index as number) < 0)
        || new Set(item.message_indices).size !== item.message_indices.length) return false;
      seenEntries.add(item.entry_id); selectedCount += (item.message_indices as unknown[]).length;
    }
    const conservation = record(row.whole_message_conservation);
    if (!conservation || conservation.partial_message_count !== 0 || conservation.selected_message_count !== indices.reduce((sum, item) => sum + (record(item)?.message_indices as unknown[]).length, 0)) return false;
    for (const pair of [legacyRows, passageRows]) {
      const paired = pair.find((candidate) => candidate.query_id === row.query_id);
      if (!paired || JSON.stringify(paired.candidate_ranges) !== JSON.stringify(row.candidate_ranges)
        || JSON.stringify(paired.candidate_budget) !== JSON.stringify(row.candidate_budget)) return false;
    }
  }
  const total = record(comparison.whole_message_conservation);
  return total !== undefined && total.selected_message_count === selectedCount && total.partial_message_count === 0;
}
/** Validate the new experiment against the established controls and sibling #391 output. */
function validCoreComparison(value: unknown, passageValue: unknown, messageValue: unknown, controlRowsValue: unknown): boolean {
  const comparison = record(value); const lineage = record(comparison?.lineage); const source = record(lineage?.source);
  const message = record(messageValue); const messageLineage = record(message?.lineage); const messageSource = record(messageLineage?.source);
  const passage = record(passageValue); const passageLineage = record(passage?.lineage); const passageSource = record(passageLineage?.source);
  const sha = (item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
  if (!comparison || comparison.strategy !== "query-message-cores-v1" || comparison.control_reproduced !== true
    || comparison.coordinate_system !== "utf16_code_units" || typeof comparison.metric_limitation !== "string" || !comparison.metric_limitation.trim()
    || !lineage || lineage.message_boundaries_sha256 !== SHARED_MESSAGE_BOUNDARIES_SHA256
    || !sha(lineage.message_boundaries_source_sha256) || !sha(lineage.message_packing_source_sha256)
    || !sha(lineage.message_comparison_source_sha256) || !sha(lineage.core_packing_source_sha256) || !sha(lineage.core_comparison_source_sha256)
    || !source || !messageSource || !passageSource
    || !["dataset_sha256", "snapshot_sha256"].every((key) => sha(source[key]) && source[key] === messageSource[key] && source[key] === passageSource[key])
    || lineage.message_boundaries_sha256 !== messageLineage?.message_boundaries_sha256
    || lineage.message_boundaries_source_sha256 !== messageLineage?.message_boundaries_source_sha256
    || lineage.message_packing_source_sha256 !== messageLineage?.message_packing_source_sha256
    || lineage.message_comparison_source_sha256 !== messageLineage?.message_comparison_source_sha256) return false;

  // Reuse the unchanged strict validator for the legacy and passage pairs.
  const oldShape = {
    ...comparison, strategy: "query-message-neighbors-v1",
    lineage: {
      message_boundaries_sha256: lineage.message_boundaries_sha256,
      message_boundaries_source_sha256: lineage.message_boundaries_source_sha256,
      message_packing_source_sha256: lineage.message_packing_source_sha256,
      message_comparison_source_sha256: lineage.message_comparison_source_sha256,
      source,
    },
  };
  if (!validMessageComparison(oldShape, passageValue, controlRowsValue)) return false;

  const legacy = record(comparison.versus_legacy); const passages = record(comparison.versus_passages); const neighbors = record(comparison.versus_neighbors);
  const oldPairs = [record(message?.versus_legacy), record(message?.versus_passages)];
  if (!legacy || !passages || !neighbors || oldPairs.some((pair) => !pair) || !Array.isArray(message?.queries)) return false;
  const legacyRows = legacy.queries as Record<string, unknown>[];
  const neighborRows = neighbors.queries as Record<string, unknown>[] | undefined;
  const oldPassageRows = (oldPairs[1]!.queries as Record<string, unknown>[] | undefined) ?? [];
  const oldSelectedRows = message.queries.map(record);
  if (!neighborRows || !validMessagePair(neighbors, "query-message-neighbors-v1", legacyRows.map((row) => row.query_id as string), new Map(legacyRows.map((row) => [row.query_id as string, record(row.annotated_messages)?.eligible === true])))
    || JSON.stringify(neighborRows.map((row) => row.query_id)) !== JSON.stringify(legacyRows.map((row) => row.query_id))
    || oldSelectedRows.some((row) => !row) || oldPassageRows.length !== legacyRows.length) return false;
  const rowsById = new Map(neighborRows.map((row) => [row.query_id, row]));
  const oldRowsById = new Map(oldPassageRows.map((row) => [row.query_id, row]));
  const selectedById = new Map((oldSelectedRows as Record<string, unknown>[]).map((row) => [row.query_id, row]));
  if (rowsById.size !== legacyRows.length || oldRowsById.size !== legacyRows.length || selectedById.size !== legacyRows.length) return false;
  if (!Array.isArray(comparison.queries) || comparison.queries.length !== legacyRows.length) return false;
  const coreQueryRows = comparison.queries.map(record);
  if (coreQueryRows.some((row) => !row)) return false;
  const coreSelectedById = new Map((coreQueryRows as Record<string, unknown>[]).map((row) => [row.query_id, row]));
  if (coreSelectedById.size !== legacyRows.length) return false;
  const pairs = [legacy, passages, neighbors];
  for (const row of legacyRows) {
    const id = row.query_id as string; const neighbor = rowsById.get(id); const old = oldRowsById.get(id);
    const selected = selectedById.get(id); const coreSelected = coreSelectedById.get(id);
    if (!neighbor || !old || !selected || !coreSelected) return false;
    const category = row.category;
    const neighborAnnotations = record(neighbor.annotated_messages);
    if (pairs.some((pair) => {
      const q = (pair.queries as Record<string, unknown>[]).find((item) => item.query_id === id);
      const annotations = record(q?.annotated_messages);
      return !q || q.category !== category || JSON.stringify(q.expected_ids) !== JSON.stringify(row.expected_ids)
        || JSON.stringify(q.retrieved_ids) !== JSON.stringify(row.retrieved_ids)
        || JSON.stringify(q.candidate_packed_ids) !== JSON.stringify(neighbor.candidate_packed_ids)
        || JSON.stringify(q.candidate_ranges) !== JSON.stringify(coreSelected.candidate_ranges)
        || JSON.stringify(q.candidate_budget) !== JSON.stringify(coreSelected.candidate_budget)
        || !neighborAnnotations || !annotations
        || ["eligible", "gold_turn_count", "no_positive_entry_count", "retrieval_covered_turns", "retrieval_all_turns", "candidate_covered_turns", "candidate_all_turns"]
          .some((key) => JSON.stringify(annotations[key]) !== JSON.stringify(neighborAnnotations[key]));
    })) return false;
    // New-versus-neighbor references are exactly the candidate selected by sibling #391.
    if (neighbor.category !== old.category || JSON.stringify(neighbor.expected_ids) !== JSON.stringify(old.expected_ids)
      || JSON.stringify(neighbor.retrieved_ids) !== JSON.stringify(old.retrieved_ids)
      || JSON.stringify(neighbor.reference_packed_stage) !== JSON.stringify(old.candidate_packed_stage)
      || JSON.stringify(neighbor.reference_all_gold) !== JSON.stringify(old.candidate_all_gold)
      || JSON.stringify(neighbor.reference_packed_ids) !== JSON.stringify(old.candidate_packed_ids)
      || JSON.stringify(neighbor.reference_budget) !== JSON.stringify(old.candidate_budget)
      || JSON.stringify(neighbor.reference_ranges) !== JSON.stringify(old.candidate_ranges)
      || JSON.stringify(record(neighbor.annotated_messages)?.eligible) !== JSON.stringify(record(old.annotated_messages)?.eligible)
      || JSON.stringify(record(neighbor.annotated_messages)?.gold_turn_count) !== JSON.stringify(record(old.annotated_messages)?.gold_turn_count)
      || JSON.stringify(record(neighbor.annotated_messages)?.no_positive_entry_count) !== JSON.stringify(record(old.annotated_messages)?.no_positive_entry_count)
      || JSON.stringify(record(neighbor.annotated_messages)?.retrieval_covered_turns) !== JSON.stringify(record(old.annotated_messages)?.retrieval_covered_turns)
      || JSON.stringify(record(neighbor.annotated_messages)?.reference_covered_turns) !== JSON.stringify(record(old.annotated_messages)?.candidate_covered_turns)
      || record(neighbor.annotated_messages)?.reference_all_turns !== record(old.annotated_messages)?.candidate_all_turns) return false;
    // Core output metadata is validated against the core's three candidate rows, not #391's distinct candidate.
    const selectedIndices = coreSelected.selected_message_indices as Array<Record<string, unknown>>;
    const selectedEntryIds = selectedIndices.map((entry) => entry.entry_id);
    if (!uniqueIds(selectedEntryIds) || JSON.stringify(selectedEntryIds) !== JSON.stringify(neighbor.candidate_packed_ids)) return false;
    const oldSelectedIndices = selected.selected_message_indices as Array<Record<string, unknown>>;
    const oldSelectedEntryIds = oldSelectedIndices.map((entry) => entry.entry_id);
    if (!uniqueIds(oldSelectedEntryIds) || JSON.stringify(oldSelectedEntryIds) !== JSON.stringify(neighbor.reference_packed_ids)) return false;
  }
  return true;
}
/** Downloads only the reviewed shared inputs, then delegates to the offline evaluator. */
export async function main(args: string[], dependencies: CheckDependencies = { loadContract: loadSharedContract, fetchArtifacts: fetchSharedArtifacts, execute }): Promise<0 | 1 | 2> {
  try {
    const { artifactsDir, output, packingComparison, passageComparison, goldTurns, messageComparison, messageBoundaries, coreComparison } = parseArgs(args);
    assertSafeParents(artifactsDir);
    const contract = await dependencies.loadContract();
    const metadataPaths = [...contract.metadataPaths, ...(goldTurns ? [goldTurns] : []), ...(messageBoundaries ? [messageBoundaries] : [])];
    const receiptPath = output + ".verification.json";
    assertOutput(output, artifactsDir, metadataPaths);
    assertOutput(receiptPath, artifactsDir, metadataPaths);
    if (goldTurns) assertReviewedGoldTurns(goldTurns);
    if (messageBoundaries) assertReviewedMessageBoundaries(messageBoundaries);
    const receipt = await dependencies.fetchArtifacts(artifactsDir, contract.manifest);
    if (goldTurns) assertReviewedGoldTurns(goldTurns);
    if (messageBoundaries) assertReviewedMessageBoundaries(messageBoundaries);
    assertOutput(output, artifactsDir, metadataPaths);
    assertOutput(receiptPath, artifactsDir, metadataPaths);
    writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, ...receipt }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const env = { ...process.env }; delete env.MUNIN_SEMANTIC_MAX_DISTANCE;
    const status = await dependencies.execute(["--snapshot", join(artifactsDir, "snapshot.db"), "--queries", join(artifactsDir, "queries.jsonl"), "--vectors", join(artifactsDir, "query-vectors.json"), "--as-of", contract.asOf, "--baseline", contract.baseline, "--output", output, ...(packingComparison ? ["--packing-comparison", packingComparison] : []), ...(passageComparison ? ["--passage-comparison", passageComparison, "--gold-turns", goldTurns!] : []), ...(messageComparison ? ["--message-comparison", messageComparison, "--message-boundaries", messageBoundaries!] : []), ...(coreComparison ? ["--core-comparison", coreComparison] : [])], env);
    process.stdout.write(`Verified artifact receipt: ${JSON.stringify(receipt)}\n`);
    try {
      const report = JSON.parse(readFileSync(output, "utf8")) as { quality_state?: string; rows?: unknown; packing_comparison?: unknown; passage_comparison?: unknown; message_comparison?: unknown; core_comparison?: unknown; comparison?: { gained_question_ids?: unknown; lost_question_ids?: unknown; reproduced?: boolean } };
      const gained = report.comparison?.gained_question_ids ?? []; const lost = report.comparison?.lost_question_ids ?? [];
      if (((status === 0 || status === 1) && (!Array.isArray(report.comparison?.gained_question_ids) || !Array.isArray(report.comparison?.lost_question_ids)))
        || !Array.isArray(gained) || !Array.isArray(lost) || [...gained, ...lost].some((id: unknown) => typeof id !== "string" || !id)
        || (status === 0 && (!report.comparison || !["unchanged", "improved"].includes(report.quality_state ?? "") || lost.length !== 0 || (report.quality_state === "improved") !== (gained.length > 0)))
        || (status === 1 && (report.quality_state !== "regressed" || report.comparison?.reproduced !== true || lost.length === 0))
        || (status === 2 && report.quality_state !== "invalid")
        || ((status === 0 || status === 1) && packingComparison && !validPackingComparison(report.packing_comparison))
        || ((status === 0 || status === 1) && passageComparison && !validPassageComparison(report.passage_comparison))
        || ((status === 0 || status === 1) && messageComparison && !validMessageComparison(report.message_comparison, report.passage_comparison, report.rows))
        || ((status === 0 || status === 1) && coreComparison && !validCoreComparison(report.core_comparison, report.passage_comparison, report.message_comparison, report.rows))) throw new Error("Evaluator report/status mismatch");
      process.stdout.write(`Evidence ${report.quality_state ?? "invalid"}: gained ${gained.length} [${gained.join(", ")}]; lost ${lost.length} [${lost.join(", ")}]\n`);
    } catch { process.stdout.write("Evidence invalid: evaluator report is missing, malformed or inconsistent\n"); return 2; }
    return status === 0 || status === 1 ? status : 2;
  } catch (error) {
    process.stderr.write(`Evidence check invalid: ${error instanceof Error ? error.message : "Unknown setup error"}\n`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
