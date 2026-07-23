import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSecrets } from "../../src/security.js";
import type { MuninAgentMemoryScorecardReport } from "./types.js";
import { loadScorecardContract } from "./run.js";

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

export function validatePublicationReport(
  value: unknown,
): MuninAgentMemoryScorecardReport {
  assertObject(value, "Scorecard report");
  if (
    value.report_kind !== "munin_agent_memory_scorecard"
    || value.report_schema_version !== 2
    || value.contract_id !== "munin-longmemeval-s-e2e-v2"
    || value.contract_schema_version !== 2
    || value.profile !== "longmemeval_s_full_on_demand"
    || value.publication_status !== "publication_candidate"
    || value.publication_eligible !== true
  ) {
    throw new Error("Report is not an eligible LongMemEval-S v2 publication candidate.");
  }
  assertObject(value.retrieval, "retrieval");
  assertObject(value.answer_quality, "answer_quality");
  assertObject(value.evidence, "evidence");
  assertObject(value.uncertainty, "uncertainty");
  const retrieval = value.retrieval as unknown as MuninAgentMemoryScorecardReport["retrieval"];
  const answerQuality =
    value.answer_quality as unknown as MuninAgentMemoryScorecardReport["answer_quality"];
  const evidence = value.evidence as unknown as MuninAgentMemoryScorecardReport["evidence"];
  const currentContract = loadScorecardContract();
  if (value.contract_sha256 !== currentContract.sha256) {
    throw new Error("Publication report contract hash does not match the shipped v2 contract.");
  }
  if (
    retrieval.report_schema_version !== 3
    || answerQuality.report_schema_version !== 3
    || retrieval.runner_mode !== "production_ranker"
    || retrieval.runner_mode_requested !== "production_ranker"
    || answerQuality.runner_mode !== "production_ranker"
    || answerQuality.search_mode !== "hybrid"
    || answerQuality.answer_model !== "anthropic/claude-haiku-4.5"
    || answerQuality.judge_model !== "anthropic/claude-sonnet-4.5"
    || answerQuality.execution_identity.requested_answer_model
      !== answerQuality.answer_model
    || answerQuality.execution_identity.requested_judge_model
      !== answerQuality.judge_model
    || answerQuality.context_token_estimator !== "utf8_bytes_div4_ceil_v1"
    || !Array.isArray(retrieval.queries)
    || !Array.isArray(answerQuality.results)
  ) {
    throw new Error("Publication report execution contract or nested schema has drifted.");
  }
  if (
    retrieval.query_count !== 500
    || retrieval.evaluation_count !== 500
    || retrieval.queries.length !== 500
    || answerQuality.query_count !== 500
    || answerQuality.results.length !== 500
  ) {
    throw new Error("Publication report must contain all 500 raw retrieval and answer results.");
  }
  const retrievalIds = retrieval.queries.map((result) => result.query_id);
  const answerIds = answerQuality.results.map((result) => result.query_id);
  if (
    new Set(retrievalIds).size !== 500
    || new Set(answerIds).size !== 500
    || JSON.stringify([...retrievalIds].sort()) !== JSON.stringify([...answerIds].sort())
  ) {
    throw new Error("Publication report must contain the same 500 unique query IDs in both harnesses.");
  }
  if (
    retrieval.queries.some((result) =>
      result.search_mode !== "hybrid"
      || (result.actual_mode !== undefined && result.actual_mode !== "hybrid"))
    || answerQuality.results.some((result) =>
      result.effective_search_mode !== "hybrid")
  ) {
    throw new Error("Publication report contains a degraded or non-hybrid query result.");
  }
  const retrievalSources = retrieval.query_set_sources
    .map((source) => `${source.filename}:${source.sha256}`)
    .sort();
  const answerSources = answerQuality.query_set_sources
    .map((source) => `${source.filename}:${source.sha256}`)
    .sort();
  if (
    retrievalSources.length === 0
    || JSON.stringify(retrievalSources) !== JSON.stringify(answerSources)
  ) {
    throw new Error("Publication report query-set source lineage differs between harnesses.");
  }
  if (
    answerQuality.context_token_budget === null
    || answerQuality.results.some((result) =>
      result.context_budget.estimated_tokens > answerQuality.context_token_budget!)
  ) {
    throw new Error("Publication report contains an absent or exceeded context budget.");
  }
  if (
    answerQuality.execution_identity.missing_identity_calls !== 0
    || answerQuality.execution_identity.response_models.length === 0
    || answerQuality.execution_identity.providers.length === 0
  ) {
    throw new Error("Publication report is missing provider/model execution identity.");
  }
  if (
    answerQuality.usage_accounting.expected_calls !== 1000
    || answerQuality.usage_accounting.usage_reported_calls !== 1000
    || answerQuality.usage_accounting.cost_reported_calls !== 1000
  ) {
    throw new Error("Publication report has incomplete per-call usage/cost accounting.");
  }
  let rawPromptTokens = 0;
  let rawCompletionTokens = 0;
  let rawCost = 0;
  for (const result of answerQuality.results) {
    for (const [role, usage, identity] of [
      ["reader", result.answer_usage, result.answer_call],
      ["judge", result.judge_usage, result.judge_call],
    ] as const) {
      if (usage === undefined) {
        throw new Error(`Publication query ${result.query_id} ${role} is missing usage.`);
      }
      if (
        !Number.isSafeInteger(usage.prompt_tokens)
        || usage.prompt_tokens < 0
        || !Number.isSafeInteger(usage.completion_tokens)
        || usage.completion_tokens < 0
      ) {
        throw new Error(`Publication query ${result.query_id} ${role} has invalid token usage.`);
      }
      if (usage.cost === undefined || !Number.isFinite(usage.cost) || usage.cost < 0) {
        throw new Error(`Publication query ${result.query_id} ${role} is missing a valid cost.`);
      }
      if (
        identity?.requested_model !== (
          role === "reader" ? answerQuality.answer_model : answerQuality.judge_model
        )
        ||
        identity?.response_model === undefined
        || identity.response_model.trim().length === 0
        || identity.provider === undefined
        || identity.provider.trim().length === 0
      ) {
        throw new Error(`Publication query ${result.query_id} ${role} is missing provider/model identity.`);
      }
      rawPromptTokens += usage.prompt_tokens;
      rawCompletionTokens += usage.completion_tokens;
      rawCost += usage.cost;
    }
  }
  if (
    answerQuality.total_usage === undefined
    || answerQuality.total_usage.prompt_tokens !== rawPromptTokens
    || answerQuality.total_usage.completion_tokens !== rawCompletionTokens
    || answerQuality.total_usage.cost === undefined
    || Math.abs(answerQuality.total_usage.cost - rawCost) > 1e-9
  ) {
    throw new Error("Publication report aggregate usage/cost does not reconcile with raw calls.");
  }
  const poison = evidence.trust_lanes.live_poison;
  if (
    poison.status !== "pass"
    || poison.call_identity?.response_model === undefined
    || poison.call_identity.provider === undefined
    || poison.usage === undefined
    || !Number.isSafeInteger(poison.usage.prompt_tokens)
    || poison.usage.prompt_tokens < 0
    || !Number.isSafeInteger(poison.usage.completion_tokens)
    || poison.usage.completion_tokens < 0
    || poison.usage.cost === undefined
    || !Number.isFinite(poison.usage.cost)
    || poison.usage.cost < 0
  ) {
    throw new Error("Publication report live poison lane lacks provider identity or usage/cost.");
  }
  if (
    evidence.cost_usd === null
    || !Number.isFinite(evidence.cost_usd)
    || evidence.cost_usd < 0
    || Math.abs(evidence.cost_usd - (rawCost + poison.usage.cost)) > 1e-9
  ) {
    throw new Error("Publication report has an invalid or unreconciled provider-reported cost.");
  }
  if (
    typeof evidence.artifacts?.reused_existing !== "boolean"
    || evidence.artifacts.validation !== "longmemeval_provenance_sha256_v1"
  ) {
    throw new Error("Publication report has invalid generated-artifact provenance evidence.");
  }
  const retries = evidence.retries;
  const retryCounts = retries === undefined
    ? []
    : [
      retries.http_429,
      retries.http_503,
      retries.transport_fetch_failed,
      retries.transport_terminated,
    ];
  if (
    retries === undefined
    || !Number.isSafeInteger(retries.total)
    || retries.total < 0
    || retryCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || retryCounts.reduce((sum, count) => sum + count, 0) !== retries.total
  ) {
    throw new Error("Publication report has invalid or unreconciled retry evidence.");
  }
  if (
    evidence.environment.git_dirty !== false
    || evidence.environment.git_commit === null
    || !/^[a-f0-9]{40}$/.test(evidence.environment.git_commit)
  ) {
    throw new Error("Publication report lacks clean Git commit lineage.");
  }
  if (
    !evidence.trust_lanes.overall_pass
    || poison.status !== "pass"
  ) {
    throw new Error("Publication report trust lanes did not all pass.");
  }
  const reportPaths = [
    retrieval.snapshot_path,
    answerQuality.snapshot_path,
    ...retrieval.query_set_sources.map((source) => source.path),
    ...answerQuality.query_set_sources.map((source) => source.path),
  ];
  if (reportPaths.some((path) => isAbsolute(path))) {
    throw new Error("Publication report contains a machine-local absolute path.");
  }
  const secretCheck = scanForSecrets(JSON.stringify(value));
  if (!secretCheck.valid) {
    throw new Error(`Publication report failed secret scan: ${secretCheck.error}`);
  }
  return value as unknown as MuninAgentMemoryScorecardReport;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function intervalText(
  interval: MuninAgentMemoryScorecardReport["uncertainty"]["answer_accuracy"],
): string {
  return `${formatPercent(interval.point_estimate)} (95% bootstrap CI ${formatPercent(interval.lower)}–${formatPercent(interval.upper)})`;
}

export function renderPublicationSummary(
  report: MuninAgentMemoryScorecardReport,
): string {
  const aq = report.answer_quality;
  const evidence = report.evidence;
  const usage = aq.total_usage;
  const runDate = report.run_at.slice(0, 10);
  return `# Munin LongMemEval-S end-to-end scorecard

**Run date:** ${runDate}

**Contract:** \`${report.contract_id}\` (SHA-256 \`${report.contract_sha256}\`)

**Git commit:** \`${evidence.environment.git_commit}\`

**Publication status:** Phase A Munin result; not a competitor comparison

## Results

| Measure | Result |
|---|---:|
| Questions | ${aq.query_count} |
| End-to-end answer accuracy | ${intervalText(report.uncertainty.answer_accuracy)} |
| Retrieval R@5 | ${intervalText(report.uncertainty.retrieval_recall_at_5)} |
| Retrieval latency p50 / p95 | ${report.retrieval.overall_duration.p50_ms?.toFixed(1) ?? "n/a"} / ${report.retrieval.overall_duration.p95_ms?.toFixed(1) ?? "n/a"} ms |
| Answer pipeline latency p50 / p95 | ${aq.overall_duration.p50_ms?.toFixed(1) ?? "n/a"} / ${aq.overall_duration.p95_ms?.toFixed(1) ?? "n/a"} ms |
| Retrieved-context budget | ${aq.context_token_budget} estimated tokens |
| Provider prompt / completion tokens | ${usage?.prompt_tokens ?? "n/a"} / ${usage?.completion_tokens ?? "n/a"} |
| Provider-reported cost | ${formatUsd(evidence.cost_usd!)} |
| Generated artifacts reused | ${evidence.artifacts.reused_existing ? "yes" : "no"} |
| Transient retries | ${evidence.retries.total} |
| Peak process RSS | ${(evidence.resources.peak_rss_bytes / 1024 / 1024).toFixed(1)} MiB |
| Generated DB + query artifacts | ${(evidence.disk.total_artifact_bytes / 1024 / 1024).toFixed(1)} MiB |

Reader: \`${aq.answer_model}\`. Judge: \`${aq.judge_model}\`. Actual response
models: ${aq.execution_identity.response_models.map((model) => `\`${model}\``).join(", ")}.
Actual providers: ${aq.execution_identity.providers.map((provider) => `\`${provider}\``).join(", ")}.

## Trust lanes

- Namespace isolation and classification-ceiling probes: **${evidence.trust_lanes.authorization.status}**
- Instruction-shaped data boundary probes: **${evidence.trust_lanes.instruction_shaped_content.status}**
- Live reader poison challenge: **${evidence.trust_lanes.live_poison.status}**

These focused lanes complement the repository security regression suite; they do
not replace it.

## Reproduction

\`\`\`bash
OPENROUTER_API_KEY=... npm run scorecard:longmemeval:s
npm run scorecard:publish -- --report <generated-report.json>
\`\`\`

The raw report beside this summary contains all 500 retrieval and answer results,
query-set checksums, provider identities, native token usage/cost, environment
lineage, stage timings, resource measurements, and trust-lane evidence.

## Limitations

${report.limitations.map((limitation) => `- ${limitation}`).join("\n")}
`;
}

export function publishScorecard(
  reportPath: string,
  outputDir?: string,
): { rawPath: string; summaryPath: string } {
  const report = validatePublicationReport(
    JSON.parse(readFileSync(resolve(reportPath), "utf-8")),
  );
  const runDate = report.run_at.slice(0, 10);
  const targetDir = resolve(
    outputDir ?? join("benchmark", "scorecard", "results", runDate),
  );
  mkdirSync(targetDir, { recursive: true });
  const rawPath = join(targetDir, "longmemeval-s-v2-report.json");
  const summaryPath = join(targetDir, "README.md");
  writeFileSync(rawPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeFileSync(summaryPath, renderPublicationSummary(report), "utf-8");
  return { rawPath, summaryPath };
}

function parseArgs(argv: string[]): { reportPath: string; outputDir?: string } {
  const reportIndex = argv.indexOf("--report");
  const outputIndex = argv.indexOf("--output-dir");
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : undefined;
  if (!reportPath) {
    throw new Error(
      "Usage: tsx benchmark/scorecard/publish.ts --report <scorecard.json> [--output-dir <dir>]",
    );
  }
  const outputDir = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  return { reportPath, ...(outputDir === undefined ? {} : { outputDir }) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const published = publishScorecard(args.reportPath, args.outputDir);
  console.log(`Raw report: ${published.rawPath}`);
  console.log(`Summary: ${published.summaryPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      "Scorecard publication failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
