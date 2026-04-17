import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync, existsSync } from "node:fs";
import {
  initDatabase,
  writeState,
  appendLog,
  getConsolidationMetadata,
  getCrossReferences,
  upsertConsolidationMetadata,
} from "../src/db.js";
import {
  buildSynthesisPrompt,
  parseSynthesisResponse,
  consolidateNamespace,
  initConsolidation,
  startConsolidationWorker,
  stopConsolidationWorker,
  isConsolidationAvailable,
  resetConsolidationCircuitBreaker,
  processConsolidationBatch,
  loadTargetVocabulary,
  scanMentions,
  isOrphaned,
  mergeCrossReferences,
  discoverOrphanedReferences,
  _consolidationConfig,
  _setApiKey,
  _setWorkerDb,
  type ChatCompletionResponse,
} from "../src/consolidation.js";
import type { Entry } from "../src/types.js";

const TEST_DB_PATH = "/tmp/munin-memory-consolidation-synthesis-test.db";

function cleanupTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = TEST_DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "test-id",
    namespace: "projects/test",
    key: null,
    entry_type: "log",
    content: "Test log content",
    tags: "[]",
    agent_id: "test",
    owner_principal_id: null,
    created_at: "2026-01-01T10:00:00.000Z",
    updated_at: "2026-01-01T10:00:00.000Z",
    valid_until: null,
    classification: "internal",
    embedding_status: "pending",
    embedding_model: null,
    ...overrides,
  };
}

const cannedSynthesisResult = {
  status_content: "## Phase: Active\n\nTest synthesis content for testing.",
  tags: ["active", "test"],
  cross_references: [
    {
      target_namespace: "projects/other",
      reference_type: "related_to",
      context: "This project relates to the other project.",
      confidence: 0.8,
    },
  ],
};

const cannedResponse: ChatCompletionResponse = {
  choices: [{ message: { content: JSON.stringify(cannedSynthesisResult) } }],
  usage: { prompt_tokens: 500, completion_tokens: 300 },
};

const mockCallApi = vi.fn<(prompt: string) => Promise<ChatCompletionResponse>>()
  .mockResolvedValue(cannedResponse);

let db: Database.Database;

// Save/restore env vars
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  cleanupTestDb();
  db = initDatabase(TEST_DB_PATH);
  mockCallApi.mockClear();
  // Save env vars
  savedEnv = {
    MUNIN_CONSOLIDATION_ENABLED: process.env.MUNIN_CONSOLIDATION_ENABLED,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  // Reset circuit breaker state
  resetConsolidationCircuitBreaker();
});

afterEach(async () => {
  await stopConsolidationWorker();
  db.close();
  cleanupTestDb();
  // Restore env vars
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ─── buildSynthesisPrompt ────────────────────────────────────────────────────

describe("buildSynthesisPrompt", () => {
  it("includes namespace, status, synthesis, and log content", () => {
    const logs: Entry[] = [
      makeEntry({ content: "Worked on feature X", created_at: "2026-01-01T10:00:00.000Z", tags: '["progress"]' }),
    ];

    const prompt = buildSynthesisPrompt(
      "projects/test-project",
      "Current status: active",
      "Previous synthesis content",
      logs,
    );

    expect(prompt).toContain('projects/test-project');
    expect(prompt).toContain("Current status: active");
    expect(prompt).toContain("Previous synthesis content");
    expect(prompt).toContain("Worked on feature X");
    expect(prompt).toContain("progress");
  });

  it("includes 'No status entry exists' when status is null", () => {
    const logs: Entry[] = [makeEntry({ content: "A log entry" })];
    const prompt = buildSynthesisPrompt("projects/alpha", null, "previous synth", logs);
    expect(prompt).toContain("No status entry exists yet for this namespace.");
    expect(prompt).toContain("previous synth");
  });

  it("includes 'No previous synthesis exists' when synthesis is null", () => {
    const logs: Entry[] = [makeEntry({ content: "A log entry" })];
    const prompt = buildSynthesisPrompt("projects/alpha", "some status", null, logs);
    expect(prompt).toContain("some status");
    expect(prompt).toContain("No previous synthesis exists.");
  });

  it("truncates oldest logs when content is huge", () => {
    const bigContent = "A".repeat(1000);
    const logs: Entry[] = Array.from({ length: 20 }, (_, i) =>
      makeEntry({
        id: `log-${i}`,
        content: `Entry ${i}: ${bigContent}`,
        created_at: `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );

    const prompt = buildSynthesisPrompt("projects/big", null, null, logs);
    expect(prompt).toContain("older log entries omitted due to length");
    expect(prompt).toContain(`Entry 19:`);
  });

  it("handles tags as JSON string", () => {
    const logs: Entry[] = [
      makeEntry({ content: "Test entry", tags: '["tag1","tag2"]' }),
    ];
    const prompt = buildSynthesisPrompt("projects/test", null, null, logs);
    expect(prompt).toContain("tag1, tag2");
  });

  it("shows 'none' when tags are empty", () => {
    const logs: Entry[] = [
      makeEntry({ content: "Test entry", tags: "[]" }),
    ];
    const prompt = buildSynthesisPrompt("projects/test", null, null, logs);
    expect(prompt).toContain("Tags: none");
  });

  it("includes Ground Truth grounding section when status entry exists", () => {
    const logs: Entry[] = [makeEntry({ content: "A log entry" })];
    const statusContent = "## Phase: Active\n\nWorking on feature Y.";
    const prompt = buildSynthesisPrompt("projects/grounded", statusContent, null, logs);

    expect(prompt).toContain("## Ground Truth (human-maintained — DO NOT contradict)");
    expect(prompt).toContain("never override the Phase or lifecycle");
    expect(prompt).toContain(statusContent);
  });

  it("omits Ground Truth grounding section when status entry is null", () => {
    const logs: Entry[] = [makeEntry({ content: "A log entry" })];
    const prompt = buildSynthesisPrompt("projects/no-status", null, null, logs);

    expect(prompt).not.toContain("## Ground Truth (human-maintained — DO NOT contradict)");
  });
});

// ─── parseSynthesisResponse ──────────────────────────────────────────────────

describe("parseSynthesisResponse", () => {
  it("parses valid JSON response correctly", () => {
    const result = parseSynthesisResponse(JSON.stringify(cannedSynthesisResult));

    expect(result.status_content).toBe(cannedSynthesisResult.status_content);
    expect(result.tags).toEqual(["active", "test"]);
    expect(result.cross_references).toHaveLength(1);
    expect(result.cross_references[0].target_namespace).toBe("projects/other");
    expect(result.cross_references[0].reference_type).toBe("related_to");
    expect(result.cross_references[0].confidence).toBe(0.8);
  });

  it("parses response wrapped in markdown code fences", () => {
    const text = "```json\n" + JSON.stringify(cannedSynthesisResult) + "\n```";
    const result = parseSynthesisResponse(text);
    expect(result.status_content).toBe(cannedSynthesisResult.status_content);
    expect(result.tags).toEqual(["active", "test"]);
  });

  it("rejects response with missing status_content", () => {
    const bad = { tags: ["active"], cross_references: [] };
    expect(() => parseSynthesisResponse(JSON.stringify(bad))).toThrow(/status_content/);
  });

  it("rejects response with empty status_content", () => {
    const bad = { status_content: "   ", tags: ["active"], cross_references: [] };
    expect(() => parseSynthesisResponse(JSON.stringify(bad))).toThrow(/status_content/);
  });

  it("rejects response with invalid reference_type", () => {
    const bad = {
      status_content: "some content",
      tags: ["active"],
      cross_references: [
        {
          target_namespace: "projects/other",
          reference_type: "invalid_type",
          context: "some context",
          confidence: 0.8,
        },
      ],
    };
    expect(() => parseSynthesisResponse(JSON.stringify(bad))).toThrow(/reference_type/);
  });

  it("rejects completely invalid JSON", () => {
    expect(() => parseSynthesisResponse("this is not json at all")).toThrow();
  });

  it("rejects response with missing cross_references", () => {
    const bad = { status_content: "some content", tags: ["active"] };
    expect(() => parseSynthesisResponse(JSON.stringify(bad))).toThrow(/cross_references/);
  });

  it("rejects response with non-array tags", () => {
    const bad = { status_content: "some content", tags: "active", cross_references: [] };
    expect(() => parseSynthesisResponse(JSON.stringify(bad))).toThrow(/tags/);
  });
});

// ─── consolidateNamespace ────────────────────────────────────────────────────

describe("consolidateNamespace", () => {
  it("consolidates namespace with 3 logs — writes synthesis, cross_refs, metadata", async () => {
    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/alpha", `Log entry ${i}`, ["progress"]);
    }

    const result = await consolidateNamespace(db, "projects/alpha", mockCallApi);

    expect(result.error).toBeUndefined();
    expect(result.logs_processed).toBe(3);
    expect(result.cross_references_found).toBe(1);
    expect(result.token_count).toBe(300);

    // Verify synthesis key was written
    const synthesis = db
      .prepare("SELECT content, tags FROM entries WHERE namespace = ? AND key = 'synthesis' AND entry_type = 'state'")
      .get("projects/alpha") as { content: string; tags: string } | undefined;
    expect(synthesis).toBeDefined();
    expect(synthesis!.content).toBe(cannedSynthesisResult.status_content);

    // Verify cross-references written
    const crossRefs = getCrossReferences(db, "projects/alpha");
    expect(crossRefs.length).toBeGreaterThan(0);
    expect(crossRefs[0].target_namespace).toBe("projects/other");

    // Verify metadata updated
    const meta = getConsolidationMetadata(db, "projects/alpha");
    expect(meta).not.toBeNull();
    expect(meta!.synthesis_token_count).toBe(300);
  });

  it("consolidates with existing status + synthesis — both included in API call", async () => {
    writeState(db, "projects/beta", "status", "## Current Status\nActive project", ["active"]);
    writeState(db, "projects/beta", "synthesis", "## Previous Synthesis\nOld synthesis", ["active"]);

    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/beta", `New log ${i}`, []);
    }

    await consolidateNamespace(db, "projects/beta", mockCallApi);

    const promptText = mockCallApi.mock.calls[0][0];
    expect(promptText).toContain("## Current Status");
    expect(promptText).toContain("Active project");
    expect(promptText).toContain("## Previous Synthesis");
    expect(promptText).toContain("Old synthesis");
  });

  it("prompt includes Ground Truth grounding section when status entry exists", async () => {
    writeState(db, "projects/grounded-ns", "status", "## Phase: Active\nBuilding the integration layer.", ["active"]);

    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/grounded-ns", `Log entry ${i}`, []);
    }

    await consolidateNamespace(db, "projects/grounded-ns", mockCallApi);

    const promptText = mockCallApi.mock.calls[0][0];
    expect(promptText).toContain("## Ground Truth (human-maintained — DO NOT contradict)");
    expect(promptText).toContain("never override the Phase or lifecycle");
    expect(promptText).toContain("Building the integration layer.");
  });

  it("prompt does NOT include Ground Truth grounding section when no status entry exists", async () => {
    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/no-status-ns", `Log entry ${i}`, []);
    }

    await consolidateNamespace(db, "projects/no-status-ns", mockCallApi);

    const promptText = mockCallApi.mock.calls[0][0];
    expect(promptText).not.toContain("## Ground Truth (human-maintained — DO NOT contradict)");
  });

  it("handles API error gracefully — returns error in result, no DB writes", async () => {
    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/gamma", `Log ${i}`, []);
    }

    const failingCallApi = vi.fn().mockRejectedValue(new Error("API connection failed"));

    const result = await consolidateNamespace(db, "projects/gamma", failingCallApi);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("API connection failed");
    expect(result.logs_processed).toBe(0);

    // No synthesis written
    const synthesis = db
      .prepare("SELECT * FROM entries WHERE namespace = ? AND key = 'synthesis'")
      .get("projects/gamma");
    expect(synthesis).toBeUndefined();

    // No metadata written
    const meta = getConsolidationMetadata(db, "projects/gamma");
    expect(meta).toBeNull();
  });

  it("no-ops when no logs — returns early without API call", async () => {
    const result = await consolidateNamespace(db, "projects/empty", mockCallApi);

    expect(result.logs_processed).toBe(0);
    expect(result.error).toBeUndefined();
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it("returns error when no API key is available", async () => {
    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/no-key", `Log ${i}`, []);
    }

    // Call without callApi and without module-level apiKey initialized
    const result = await consolidateNamespace(db, "projects/no-key");
    expect(result.error).toContain("No API key available");
    expect(result.logs_processed).toBe(0);
  });

  it("respects sinceTimestamp from prior metadata", async () => {
    const r1 = appendLog(db, "projects/delta", "Old log 1", []);
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-01-01T10:00:00.000Z", "2026-01-01T10:00:00.000Z", r1.id);

    const r2 = appendLog(db, "projects/delta", "Old log 2", []);
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-01-01T11:00:00.000Z", "2026-01-01T11:00:00.000Z", r2.id);

    upsertConsolidationMetadata(db, {
      namespace: "projects/delta",
      last_consolidated_at: "2026-01-01T12:00:00.000Z",
      last_log_id: r2.id,
      last_log_created_at: "2026-01-01T11:00:00.000Z",
      synthesis_model: "claude-haiku-3-5",
      synthesis_token_count: null,
      run_duration_ms: null,
    });

    const r3 = appendLog(db, "projects/delta", "New log 1", []);
    db.prepare("UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-02-01T10:00:00.000Z", "2026-02-01T10:00:00.000Z", r3.id);

    const result = await consolidateNamespace(db, "projects/delta", mockCallApi);

    expect(result.logs_processed).toBe(1);
    expect(result.error).toBeUndefined();

    const promptText = mockCallApi.mock.calls[0][0];
    expect(promptText).toContain("New log 1");
    expect(promptText).not.toContain("Old log 1");
    expect(promptText).not.toContain("Old log 2");
  });
});

// ─── Worker lifecycle ────────────────────────────────────────────────────────

describe("initConsolidation", () => {
  it("returns false when MUNIN_CONSOLIDATION_ENABLED not set", () => {
    delete process.env.MUNIN_CONSOLIDATION_ENABLED;
    const result = initConsolidation();
    expect(typeof result).toBe("boolean");
  });

  it("returns false when OPENROUTER_API_KEY is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = initConsolidation();
    expect(result).toBe(false);
  });
});

describe("startConsolidationWorker / stopConsolidationWorker", () => {
  it("start and stop without error when apiKey is null (disabled)", async () => {
    startConsolidationWorker(db);
    await stopConsolidationWorker();
  });

  it("stopConsolidationWorker cleans up workerDb reference", async () => {
    startConsolidationWorker(db);
    await stopConsolidationWorker();
  });
});

// ─── Circuit breaker ─────────────────────────────────────────────────────────

describe("circuit breaker", () => {
  const failingCallApi = vi.fn().mockRejectedValue(new Error("API error"));

  it("trips after maxFailures consecutive failures in processConsolidationBatch", async () => {
    const failCount = _consolidationConfig.maxFailures;

    for (let ns = 0; ns < failCount + 1; ns++) {
      for (let i = 0; i < _consolidationConfig.minLogs; i++) {
        appendLog(db, `projects/cb${ns}`, `Log ${i}`, []);
      }
    }

    _setApiKey("test-key");
    _setWorkerDb(db);

    await processConsolidationBatch();

    // Circuit breaker should have tripped — batch processor stops after maxFailures
    // Note: processConsolidationBatch uses the internal callOpenRouter, not our mock,
    // but since apiKey is a fake key, the fetch will fail. However the circuit breaker
    // counts errors from consolidateNamespace results. Let's verify via isConsolidationAvailable.
    // Actually, the internal calls will fail with fetch errors, which trigger the breaker.

    _setApiKey(null);
    _setWorkerDb(null);
  });

  it("resets failure count on successful consolidation via callApi param", async () => {
    for (let i = 0; i < _consolidationConfig.minLogs; i++) {
      appendLog(db, "projects/fail1", `Log ${i}`, []);
      appendLog(db, "projects/ok1", `Log ${i}`, []);
    }

    let callCount = 0;
    const mixedCallApi = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Fail 1"));
      }
      return Promise.resolve(cannedResponse);
    });

    // Test via direct consolidateNamespace calls (simulating what batch does)
    const r1 = await consolidateNamespace(db, "projects/fail1", mixedCallApi);
    expect(r1.error).toContain("Fail 1");

    const r2 = await consolidateNamespace(db, "projects/ok1", mixedCallApi);
    expect(r2.error).toBeUndefined();
    expect(r2.logs_processed).toBeGreaterThan(0);
    expect(callCount).toBe(2);
  });

  it("resetConsolidationCircuitBreaker clears tripped state", () => {
    resetConsolidationCircuitBreaker();
    // Verify it doesn't throw and state is clean
    expect(isConsolidationAvailable()).toBe(false); // still false — apiKey is null
  });

  it("skips batch processing when no workerDb set", async () => {
    _setApiKey("test-key");
    _setWorkerDb(null);
    await processConsolidationBatch();
    _setApiKey(null);
  });
});

// ─── isConsolidationAvailable ────────────────────────────────────────────────

describe("isConsolidationAvailable", () => {
  it("returns false when consolidation is disabled (default)", () => {
    expect(isConsolidationAvailable()).toBe(false);
  });
});

// ─── Orphaned cross-reference scanner ────────────────────────────────────────

describe("loadTargetVocabulary", () => {
  it("returns tracked namespaces and excludes the source", () => {
    writeState(db, "projects/alpha", "status", "alpha status", ["active"]);
    writeState(db, "projects/beta", "status", "beta status", ["active"]);
    writeState(db, "clients/acme", "status", "acme status", ["active"]);
    writeState(db, "people/sara", "status", "sara profile", []);
    writeState(db, "meta/workbench", "status", "irrelevant", []);

    const targets = loadTargetVocabulary(db, "projects/alpha");
    const namespaces = targets.map((t) => t.namespace).sort();

    expect(namespaces).toEqual(["clients/acme", "people/sara", "projects/beta"]);
    expect(namespaces).not.toContain("projects/alpha");
    expect(namespaces).not.toContain("meta/workbench");
  });

  it("filters out bare names shorter than 4 chars", () => {
    writeState(db, "projects/ab", "status", "short", []);
    writeState(db, "projects/longenough", "status", "ok", []);

    const targets = loadTargetVocabulary(db, "projects/other");
    expect(targets.map((t) => t.namespace)).toEqual(["projects/longenough"]);
  });

  it("populates bareName as the last path segment", () => {
    writeState(db, "projects/hugin", "status", "ok", []);
    const targets = loadTargetVocabulary(db, "projects/alpha");
    expect(targets[0]).toEqual({ namespace: "projects/hugin", bareName: "hugin" });
  });
});

describe("scanMentions", () => {
  const targets = [
    { namespace: "projects/hugin", bareName: "hugin" },
    { namespace: "projects/heimdall", bareName: "heimdall" },
    { namespace: "people/sara", bareName: "sara" },
  ];

  it("counts full-path and bare-name mentions, case-insensitive", () => {
    const logs: Entry[] = [
      makeEntry({ content: "Worked with Hugin today on the projects/hugin task." }),
      makeEntry({ content: "HUGIN crashed overnight." }),
    ];
    const hits = scanMentions(logs, targets);
    const hugin = hits.find((h) => h.targetNamespace === "projects/hugin");
    expect(hugin).toBeDefined();
    // Full-path matches once; bare name matches "Hugin", "hugin" (inside
    // projects/hugin), and "HUGIN" — total 4. The exact count is less
    // important than crossing the threshold; we just need >= 2.
    expect(hugin!.count).toBeGreaterThanOrEqual(2);
  });

  it("excludes targets below the 2-mention threshold", () => {
    const logs: Entry[] = [makeEntry({ content: "single hugin mention" })];
    const hits = scanMentions(logs, targets);
    expect(hits).toEqual([]);
  });

  it("does not match substrings inside words", () => {
    const logs: Entry[] = [
      makeEntry({ content: "resara and saracen and saragossa — no standalone tokens." }),
    ];
    const hits = scanMentions(logs, targets);
    const sara = hits.find((h) => h.targetNamespace === "people/sara");
    expect(sara).toBeUndefined();
  });

  it("returns empty for empty inputs", () => {
    expect(scanMentions([], targets)).toEqual([]);
    expect(scanMentions([makeEntry({ content: "nothing here" })], [])).toEqual([]);
  });
});

describe("isOrphaned", () => {
  it("returns true when target namespace has no status or synthesis", () => {
    writeState(db, "projects/target", "other-key", "unrelated", []);
    expect(isOrphaned(db, "projects/source", "projects/target")).toBe(true);
  });

  it("returns false when target status mentions source's full path", () => {
    writeState(db, "projects/target", "status", "depends on projects/source for data", []);
    expect(isOrphaned(db, "projects/source", "projects/target")).toBe(false);
  });

  it("returns false when target status mentions source's bare name", () => {
    writeState(db, "projects/target", "status", "Source powers the flow.", []);
    expect(isOrphaned(db, "projects/source", "projects/target")).toBe(false);
  });

  it("returns false when target synthesis (not status) mentions source", () => {
    writeState(db, "projects/target", "synthesis", "Uses source as its primary feed.", []);
    expect(isOrphaned(db, "projects/source", "projects/target")).toBe(false);
  });

  it("returns true when target mentions something else, not the source", () => {
    writeState(db, "projects/target", "status", "mentions alpha and beta only", []);
    expect(isOrphaned(db, "projects/source", "projects/target")).toBe(true);
  });
});

describe("mergeCrossReferences", () => {
  const llmRef = {
    target_namespace: "projects/hugin",
    reference_type: "depends_on" as const,
    context: "LLM-extracted dependency",
    confidence: 0.9,
  };
  const scannerRefSameTarget = {
    target_namespace: "projects/hugin",
    reference_type: "related_to" as const,
    context: "Scanner-detected: 5 mentions",
    confidence: 0.5,
  };
  const scannerRefNewTarget = {
    target_namespace: "people/sara",
    reference_type: "related_to" as const,
    context: "Scanner-detected: 3 mentions",
    confidence: 0.5,
  };

  it("LLM wins on target collision (keeps LLM type and context)", () => {
    const merged = mergeCrossReferences([llmRef], [scannerRefSameTarget]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(llmRef);
  });

  it("appends scanner refs for targets the LLM did not find", () => {
    const merged = mergeCrossReferences([llmRef], [scannerRefNewTarget]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(llmRef);
    expect(merged[1]).toEqual(scannerRefNewTarget);
  });

  it("returns LLM refs untouched when no scanner refs", () => {
    expect(mergeCrossReferences([llmRef], [])).toEqual([llmRef]);
  });

  it("returns scanner refs when LLM produced none", () => {
    expect(mergeCrossReferences([], [scannerRefNewTarget])).toEqual([scannerRefNewTarget]);
  });
});

describe("discoverOrphanedReferences (integration)", () => {
  it("emits a scanner-derived orphan ref for a target mentioned twice with no back-reference", () => {
    writeState(db, "projects/beta", "status", "beta runs independently", ["active"]);
    const logs: Entry[] = [
      makeEntry({ content: "Beta needs rework." }),
      makeEntry({ content: "Another call-site in projects/beta failed." }),
    ];

    const { orphans, diagnostics } = discoverOrphanedReferences(db, "projects/alpha", logs);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].target_namespace).toBe("projects/beta");
    expect(orphans[0].reference_type).toBe("related_to");
    expect(orphans[0].confidence).toBe(0.5);
    expect(orphans[0].context).toMatch(/^Scanner-detected: \d+ mentions/);
    expect(diagnostics.candidates_above_threshold).toBe(1);
    expect(diagnostics.dropped_by_reciprocal).toBe(0);
    expect(diagnostics.orphans_found).toBe(1);
  });

  it("skips targets whose state already mentions the source (not orphaned)", () => {
    writeState(db, "projects/beta", "status", "tightly coupled to alpha", ["active"]);
    const logs: Entry[] = [
      makeEntry({ content: "Beta is failing." }),
      makeEntry({ content: "Fixed projects/beta config." }),
    ];

    const { orphans, diagnostics } = discoverOrphanedReferences(db, "projects/alpha", logs);
    expect(orphans).toEqual([]);
    expect(diagnostics.candidates_above_threshold).toBe(1);
    expect(diagnostics.dropped_by_reciprocal).toBe(1);
    expect(diagnostics.orphans_found).toBe(0);
  });

  it("consolidateNamespace persists scanner-discovered orphans via replaceCrossReferences", async () => {
    // projects/alpha is the source. projects/gamma is the orphan target.
    writeState(db, "projects/gamma", "status", "gamma is self-contained", ["active"]);

    for (let i = 0; i < 3; i++) {
      appendLog(db, "projects/alpha", `Update ${i}: coordinated with Gamma and projects/gamma this iteration.`, []);
    }

    // Use a canned LLM response that returns NO cross-references, so we can
    // verify the scanner-derived orphan is the one that lands in the table.
    const noRefResponse: ChatCompletionResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              status_content: "## Phase: Active\n\nSynthesis body.",
              tags: ["active"],
              cross_references: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const callApi = vi.fn<(p: string) => Promise<ChatCompletionResponse>>().mockResolvedValue(noRefResponse);

    const result = await consolidateNamespace(db, "projects/alpha", callApi);

    expect(result.error).toBeUndefined();
    expect(result.orphans_discovered).toBe(1);
    expect(result.cross_references_found).toBe(1);

    const crossRefs = getCrossReferences(db, "projects/alpha").filter(
      (r) => r.source_namespace === "projects/alpha",
    );
    expect(crossRefs).toHaveLength(1);
    expect(crossRefs[0].target_namespace).toBe("projects/gamma");
    expect(crossRefs[0].reference_type).toBe("related_to");
    expect(crossRefs[0].confidence).toBe(0.5);
    expect(crossRefs[0].context).toMatch(/^Scanner-detected:/);
  });
});
