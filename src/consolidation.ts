import type Database from "better-sqlite3";
import {
  getNamespacesNeedingConsolidation,
  getLogsForConsolidation,
  getConsolidationMetadata,
  upsertConsolidationMetadata,
  replaceCrossReferences,
  writeState,
  nowUTC,
} from "./db.js";
import type { Entry, SynthesisResult, ConsolidationRunResult, CrossReferenceType } from "./types.js";

// --- Configuration from env vars ---

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

const config = {
  enabled: (process.env.MUNIN_CONSOLIDATION_ENABLED ?? "false") === "true",
  model: process.env.MUNIN_CONSOLIDATION_MODEL ?? "anthropic/claude-haiku-4-5-20251001",
  intervalMs: parseInt(process.env.MUNIN_CONSOLIDATION_INTERVAL_MS ?? "60000", 10) || 60000,
  batchSize: parseInt(process.env.MUNIN_CONSOLIDATION_BATCH_SIZE ?? "5", 10) || 5,
  minLogs: parseInt(process.env.MUNIN_CONSOLIDATION_MIN_LOGS ?? "3", 10) || 3,
  maxFailures: parseInt(process.env.MUNIN_CONSOLIDATION_MAX_FAILURES ?? "3", 10) || 3,
};

// --- OpenRouter API types ---

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// --- Module state ---

let apiKey: string | null = null;
let circuitBreakerFailures = 0;
let circuitBreakerTripped = false;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerProcessing = false;
let workerInflightPromise: Promise<void> | null = null;
let workerDb: Database.Database | null = null;

// --- API call ---

async function callOpenRouter(prompt: string): Promise<ChatCompletionResponse> {
  const response = await fetch(OPENROUTER_BASE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://munin-memory.gille.ai",
      "X-Title": "Munin Memory Consolidation",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
      provider: { zdr: true },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter API error ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}

// --- Lifecycle exports ---

export function initConsolidation(): boolean {
  if (!config.enabled) {
    return false;
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.warn("MUNIN_CONSOLIDATION_ENABLED=true but OPENROUTER_API_KEY is not set — consolidation disabled");
    return false;
  }

  apiKey = key;
  return true;
}

export function startConsolidationWorker(db: Database.Database): void {
  if (apiKey === null) return;
  workerDb = db;
  scheduleNextRun();
}

export async function stopConsolidationWorker(): Promise<void> {
  if (workerTimer !== null) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  if (workerInflightPromise) {
    await workerInflightPromise;
    workerInflightPromise = null;
  }
  workerDb = null;
}

export function isConsolidationAvailable(): boolean {
  return config.enabled && apiKey !== null && !circuitBreakerTripped;
}

export function resetConsolidationCircuitBreaker(): void {
  circuitBreakerFailures = 0;
  circuitBreakerTripped = false;
}

// --- Worker loop ---

function scheduleNextRun(): void {
  if (!workerDb) return;
  workerTimer = setTimeout(() => {
    if (!workerDb || workerProcessing) return;
    workerInflightPromise = processConsolidationBatch().finally(() => {
      workerInflightPromise = null;
      if (workerDb) scheduleNextRun();
    });
  }, config.intervalMs);
}

export async function processConsolidationBatch(): Promise<void> {
  if (!workerDb || !apiKey || circuitBreakerTripped) return;
  workerProcessing = true;

  try {
    const db = workerDb;
    const candidates = getNamespacesNeedingConsolidation(db, config.minLogs).slice(0, config.batchSize);

    for (const candidate of candidates) {
      const result = await consolidateNamespace(db, candidate.namespace);

      if (result.error) {
        circuitBreakerFailures++;
        console.error(`Consolidation failed for ${candidate.namespace} (${circuitBreakerFailures}/${config.maxFailures}): ${result.error}`);

        if (circuitBreakerFailures >= config.maxFailures) {
          circuitBreakerTripped = true;
          console.warn("Consolidation circuit breaker tripped — consolidation disabled until reset");
          break;
        }
      } else {
        circuitBreakerFailures = 0;
        if (result.orphans_discovered > 0) {
          console.log(
            `Consolidated ${candidate.namespace}: ${result.logs_processed} logs, ${result.cross_references_found} cross-refs (${result.orphans_discovered} scanner-discovered orphans)`,
          );
        }
      }
    }
  } finally {
    workerProcessing = false;
  }
}

// --- Core consolidation logic ---

export async function consolidateNamespace(
  db: Database.Database,
  namespace: string,
  callApi?: (prompt: string) => Promise<ChatCompletionResponse>,
): Promise<ConsolidationRunResult> {
  // Step 1: Read current state
  const metadata = getConsolidationMetadata(db, namespace);
  const sinceTimestamp = metadata?.last_log_created_at ?? null;
  const logs = getLogsForConsolidation(db, namespace, sinceTimestamp);

  if (logs.length === 0) {
    return {
      namespace,
      logs_processed: 0,
      synthesis_model: config.model,
      token_count: null,
      duration_ms: 0,
      cross_references_found: 0,
      orphans_discovered: 0,
    };
  }

  // Step 2: Read existing entries
  const existingStatus = db
    .prepare("SELECT content, tags FROM entries WHERE namespace = ? AND key = 'status' AND entry_type = 'state'")
    .get(namespace) as { content: string; tags: string } | undefined;

  const existingSynthesis = db
    .prepare("SELECT content, tags FROM entries WHERE namespace = ? AND key = 'synthesis' AND entry_type = 'state'")
    .get(namespace) as { content: string; tags: string } | undefined;

  // Step 3: Build prompt and call API
  const prompt = buildSynthesisPrompt(
    namespace,
    existingStatus?.content ?? null,
    existingSynthesis?.content ?? null,
    logs,
  );

  const doCall = callApi ?? callOpenRouter;
  if (!callApi && !apiKey) {
    return {
      namespace,
      logs_processed: 0,
      synthesis_model: config.model,
      token_count: null,
      duration_ms: 0,
      cross_references_found: 0,
      orphans_discovered: 0,
      error: "No API key available — consolidation not initialized",
    };
  }

  const startTime = Date.now();

  try {
    const response = await doCall(prompt);
    const durationMs = Date.now() - startTime;

    // Step 4: Parse response
    const text = response.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Unexpected response format: no content in first choice");
    }
    const result = parseSynthesisResponse(text);

    // Step 5: Discover orphaned cross-references via scanner, merge with LLM refs
    const scannerOrphans = discoverOrphanedReferences(db, namespace, logs);
    const mergedRefs = mergeCrossReferences(result.cross_references, scannerOrphans);

    // Step 6: Write results
    const lastLog = logs[logs.length - 1];

    writeState(db, namespace, "synthesis", result.status_content, result.tags, "consolidation-worker");

    replaceCrossReferences(
      db,
      namespace,
      mergedRefs.map((ref) => ({
        source_namespace: namespace,
        target_namespace: ref.target_namespace,
        reference_type: ref.reference_type,
        context: ref.context,
        confidence: ref.confidence,
      })),
    );

    upsertConsolidationMetadata(db, {
      namespace,
      last_consolidated_at: nowUTC(),
      last_log_id: lastLog.id,
      last_log_created_at: lastLog.created_at,
      synthesis_model: config.model,
      synthesis_token_count: response.usage?.completion_tokens ?? null,
      run_duration_ms: durationMs,
    });

    return {
      namespace,
      logs_processed: logs.length,
      synthesis_model: config.model,
      token_count: response.usage?.completion_tokens ?? null,
      duration_ms: durationMs,
      cross_references_found: mergedRefs.length,
      orphans_discovered: scannerOrphans.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      namespace,
      logs_processed: 0,
      synthesis_model: config.model,
      token_count: null,
      duration_ms: Date.now() - startTime,
      cross_references_found: 0,
      orphans_discovered: 0,
      error: message,
    };
  }
}

// --- Orphaned cross-reference discovery (scanner) ---
//
// The LLM synthesis prompt asks for cross-references, which catches strong
// architectural couplings. The Phase 2 consolidation spike (2026-04-04) showed
// it misses ~50% of meaningful connections — especially cross-type links
// (projects → people, projects → decisions) and weak/asymmetric mentions.
//
// This scanner closes the orphan gap deterministically: scan the unincorporated
// log window for mentions of other tracked namespaces, then for each mention
// check whether the target's state entries contain a reciprocal reference.
// Orphans are merged with LLM refs before the single replaceCrossReferences
// write — LLM wins on (source, target) collision.

interface TargetNamespace {
  namespace: string;
  bareName: string;
}

interface MentionHit {
  targetNamespace: string;
  count: number;
}

const MIN_BARE_NAME_LENGTH = 4;
const MIN_MENTIONS_FOR_ORPHAN = 2;
const ORPHAN_CONFIDENCE = 0.5;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadTargetVocabulary(
  db: Database.Database,
  sourceNamespace: string,
): TargetNamespace[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT namespace FROM entries
       WHERE (namespace GLOB 'projects/*'
          OR namespace GLOB 'clients/*'
          OR namespace GLOB 'people/*'
          OR namespace GLOB 'decisions/*')
         AND namespace != ?`,
    )
    .all(sourceNamespace) as Array<{ namespace: string }>;

  const targets: TargetNamespace[] = [];
  for (const row of rows) {
    const segments = row.namespace.split("/");
    const bareName = segments[segments.length - 1] ?? "";
    if (bareName.length < MIN_BARE_NAME_LENGTH) continue;
    targets.push({ namespace: row.namespace, bareName });
  }
  return targets;
}

function countMentions(haystack: string, target: TargetNamespace): number {
  let count = 0;
  try {
    const fullPath = new RegExp(escapeRegex(target.namespace), "gi");
    count += (haystack.match(fullPath) ?? []).length;
    const bare = new RegExp(`\\b${escapeRegex(target.bareName)}\\b`, "gi");
    count += (haystack.match(bare) ?? []).length;
  } catch {
    return 0;
  }
  return count;
}

export function scanMentions(
  logs: Entry[],
  targets: TargetNamespace[],
): MentionHit[] {
  if (logs.length === 0 || targets.length === 0) return [];
  const haystack = logs.map((l) => l.content).join("\n");
  const hits: MentionHit[] = [];
  for (const target of targets) {
    const count = countMentions(haystack, target);
    if (count >= MIN_MENTIONS_FOR_ORPHAN) {
      hits.push({ targetNamespace: target.namespace, count });
    }
  }
  return hits;
}

export function isOrphaned(
  db: Database.Database,
  sourceNamespace: string,
  targetNamespace: string,
): boolean {
  const rows = db
    .prepare(
      `SELECT content FROM entries
       WHERE namespace = ? AND entry_type = 'state' AND key IN ('status', 'synthesis')`,
    )
    .all(targetNamespace) as Array<{ content: string }>;

  if (rows.length === 0) return true;

  const corpus = rows.map((r) => r.content).join("\n");
  const sourceSegments = sourceNamespace.split("/");
  const sourceBare = sourceSegments[sourceSegments.length - 1] ?? "";

  const vocab: TargetNamespace = {
    namespace: sourceNamespace,
    bareName: sourceBare.length >= MIN_BARE_NAME_LENGTH ? sourceBare : sourceNamespace,
  };
  return countMentions(corpus, vocab) === 0;
}

export function mergeCrossReferences(
  llmRefs: SynthesisResult["cross_references"],
  scannerRefs: SynthesisResult["cross_references"],
): SynthesisResult["cross_references"] {
  const seen = new Set(llmRefs.map((r) => r.target_namespace));
  const merged = [...llmRefs];
  for (const ref of scannerRefs) {
    if (!seen.has(ref.target_namespace)) {
      merged.push(ref);
      seen.add(ref.target_namespace);
    }
  }
  return merged;
}

export function discoverOrphanedReferences(
  db: Database.Database,
  sourceNamespace: string,
  logs: Entry[],
): SynthesisResult["cross_references"] {
  const targets = loadTargetVocabulary(db, sourceNamespace);
  const hits = scanMentions(logs, targets);
  const orphans: SynthesisResult["cross_references"] = [];
  for (const hit of hits) {
    if (!isOrphaned(db, sourceNamespace, hit.targetNamespace)) continue;
    orphans.push({
      target_namespace: hit.targetNamespace,
      reference_type: "related_to",
      context: `Scanner-detected: ${hit.count} mentions in recent logs, no reciprocal reference in target state.`,
      confidence: ORPHAN_CONFIDENCE,
    });
  }
  return orphans;
}

// --- Prompt building ---

const MAX_PROMPT_CONTENT_CHARS = 12000;

export function buildSynthesisPrompt(
  namespace: string,
  existingStatus: string | null,
  existingSynthesis: string | null,
  logs: Entry[],
): string {
  // Serialize logs oldest-first
  const serializedLogs: string[] = logs.map((log) => {
    const tags = parseTags(log.tags);
    return `### ${log.created_at}\nTags: ${tags.join(", ") || "none"}\n\n${log.content}`;
  });

  let totalChars = serializedLogs.reduce((sum, s) => sum + s.length, 0);
  let omittedCount = 0;

  // Truncate from oldest end if over limit
  while (totalChars > MAX_PROMPT_CONTENT_CHARS && serializedLogs.length > 0) {
    const removed = serializedLogs.shift()!;
    totalChars -= removed.length;
    omittedCount++;
  }

  let logsSection = serializedLogs.join("\n\n---\n\n");
  if (omittedCount > 0) {
    logsSection = `[${omittedCount} older log entries omitted due to length]\n\n${logsSection}`;
  }

  const groundingSection = existingStatus
    ? `## Ground Truth (human-maintained — DO NOT contradict)

The following status entry is maintained by the human user and is authoritative for Phase, lifecycle state, and current work description. Your synthesis must be consistent with this. Supplement with log-derived insights, timeline, and decision context — but never override the Phase or lifecycle.

${existingStatus}

---

`
    : "";

  return `You are a memory consolidation agent for Munin, a persistent memory system for an AI assistant.
Your job is to synthesize recent log entries into an enriched status summary for the namespace "${namespace}".

${groundingSection}## Current Status Entry
${existingStatus ?? "No status entry exists yet for this namespace."}

## Previous Synthesis
${existingSynthesis ?? "No previous synthesis exists."}

## Recent Log Entries (chronological, oldest first)

${logsSection}

---

## Your Task

Synthesize ALL the information above into an updated status summary. Your synthesis should:

1. **Preserve important context** from the current status entry and previous synthesis
2. **Incorporate new information** from the log entries — decisions, milestones, discoveries, corrections
3. **Maintain this structure** (adapt sections as appropriate):
   - Phase: current lifecycle phase and brief description
   - Current Work: what is actively being worked on
   - Key Decisions: important decisions made (with rationale)
   - Blockers: any open blockers
   - Next Steps: what comes next
4. **Extract cross-namespace references** — any mentions of other projects, people, clients, decisions, systems, or namespaces. Only include references you are confident about.

Return ONLY valid JSON (no markdown fences, no commentary):

{
  "status_content": "<markdown string — the full synthesis>",
  "tags": ["<lifecycle tag>", "<other relevant tags>"],
  "cross_references": [
    {
      "target_namespace": "<namespace path, e.g. projects/hugin or people/sara>",
      "reference_type": "<one of: depends_on, blocks, related_to, supersedes, feeds_into>",
      "context": "<one sentence explaining this connection>",
      "confidence": <0.0 to 1.0>
    }
  ]
}

Rules:
- status_content must be well-structured markdown, 200-800 words
- tags must include exactly one lifecycle tag (active, blocked, completed, stopped, maintenance, archived)
- cross_references should only include connections with confidence >= 0.5
- Use "related_to" as the default reference_type when the relationship is unclear
- Target namespaces must follow Munin conventions: projects/<name>, clients/<name>, people/<name>, decisions/<topic>
- Do NOT invent information — only synthesize what is present in the inputs`;
}

function parseTags(tags: string | string[]): string[] {
  if (Array.isArray(tags)) return tags;
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

// --- Response parsing ---

const VALID_REFERENCE_TYPES: CrossReferenceType[] = [
  "depends_on",
  "blocks",
  "related_to",
  "supersedes",
  "feeds_into",
];

export function parseSynthesisResponse(text: string): SynthesisResult {
  // Find first { and last } to handle markdown code fences
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No valid JSON object found in response");
  }

  const jsonStr = text.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse JSON from response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Parsed JSON is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  // Validate status_content
  if (typeof obj.status_content !== "string" || obj.status_content.trim() === "") {
    throw new Error("Invalid or missing status_content: must be a non-empty string");
  }

  // Validate tags
  if (!Array.isArray(obj.tags)) {
    throw new Error("Invalid or missing tags: must be an array");
  }

  // Validate cross_references
  if (!Array.isArray(obj.cross_references)) {
    throw new Error("Invalid or missing cross_references: must be an array");
  }

  for (let i = 0; i < obj.cross_references.length; i++) {
    const ref = obj.cross_references[i] as Record<string, unknown>;

    if (typeof ref.target_namespace !== "string") {
      throw new Error(`cross_references[${i}].target_namespace must be a string`);
    }

    if (!VALID_REFERENCE_TYPES.includes(ref.reference_type as CrossReferenceType)) {
      throw new Error(
        `cross_references[${i}].reference_type "${ref.reference_type}" is not valid. Must be one of: ${VALID_REFERENCE_TYPES.join(", ")}`,
      );
    }

    if (typeof ref.context !== "string") {
      throw new Error(`cross_references[${i}].context must be a string`);
    }

    if (typeof ref.confidence !== "number") {
      throw new Error(`cross_references[${i}].confidence must be a number`);
    }
  }

  return {
    status_content: obj.status_content,
    tags: obj.tags as string[],
    cross_references: obj.cross_references as SynthesisResult["cross_references"],
  };
}

// --- Test helpers (exported for vitest only) ---

export type { ChatCompletionResponse };

export function _setApiKey(key: string | null): void {
  apiKey = key;
}

export function _setWorkerDb(d: Database.Database | null): void {
  workerDb = d;
}

export { config as _consolidationConfig };
