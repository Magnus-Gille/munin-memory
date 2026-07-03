import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  callModel,
  aggregateRuns,
  summarizeByWorldArm,
  renderMarkdownSummary,
  runDecisionProvenanceEval,
  resolveBaseUrl,
  resolveModel,
  type MinimalFetchResponse,
} from "../benchmark/decision-provenance/runner.js";
import type { RunRecord, World } from "../benchmark/decision-provenance/types.js";

function jsonResponse(body: unknown, status = 200): MinimalFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("parseArgs", () => {
  it("parses all flags", () => {
    const args = parseArgs([
      "--corpus",
      "foo.json",
      "--arms",
      "A,B",
      "--k",
      "3",
      "--out",
      "out-dir",
      "--model",
      "some-model",
      "--temperature",
      "0.2",
    ]);
    expect(args.corpusPath).toBe("foo.json");
    expect(args.arms).toEqual(["A", "B"]);
    expect(args.k).toBe(3);
    expect(args.outDir).toBe("out-dir");
    expect(args.model).toBe("some-model");
    expect(args.temperature).toBe(0.2);
  });

  it("defaults arms to A,B,C and k to 5 when omitted", () => {
    const args = parseArgs([]);
    expect(args.arms).toEqual(["A", "B", "C"]);
    expect(args.k).toBe(5);
  });

  it("rejects an invalid arm letter", () => {
    expect(() => parseArgs(["--arms", "A,Z"])).toThrow(/arm/i);
  });

  it("rejects a non-positive k", () => {
    expect(() => parseArgs(["--k", "0"])).toThrow(/k/i);
  });
});

describe("resolveBaseUrl", () => {
  it("defaults to the M5 loopback endpoint when MUNIN_LLM_BASE_URL is unset", () => {
    expect(resolveBaseUrl({})).toBe("http://127.0.0.1:8091/v1");
  });

  it("honors MUNIN_LLM_BASE_URL and trims a trailing slash", () => {
    expect(resolveBaseUrl({ MUNIN_LLM_BASE_URL: "https://openrouter.ai/api/v1/" })).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

describe("resolveModel", () => {
  it("requires DECISION_PROVENANCE_MODEL (or --model) and throws an actionable error otherwise", () => {
    expect(() => resolveModel(undefined, {})).toThrow(/DECISION_PROVENANCE_MODEL/);
  });

  it("prefers an explicit --model over the env var", () => {
    expect(resolveModel("cli-model", { DECISION_PROVENANCE_MODEL: "env-model" })).toBe("cli-model");
  });

  it("falls back to the env var when no --model given", () => {
    expect(resolveModel(undefined, { DECISION_PROVENANCE_MODEL: "env-model" })).toBe("env-model");
  });
});

describe("callModel retry behavior (dependency-injected fetch, no network)", () => {
  it("returns content on a clean 200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "VERDICT: {\"action\":\"HOLD\",\"reason\":\"x\"}" } }] }),
    );
    const result = await callModel({
      baseUrl: "http://example.test/v1",
      model: "m",
      temperature: 0.7,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    });
    expect(result.content).toContain("VERDICT");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 500 and succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "VERDICT: {\"action\":\"HOLD\",\"reason\":\"ok\"}" } }] }),
      );
    const result = await callModel({
      baseUrl: "http://example.test/v1",
      model: "m",
      temperature: 0.7,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      maxRetries: 1,
    });
    expect(result.content).toContain("HOLD");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a 400 — fails immediately", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad request" }, 400));
    await expect(
      callModel({
        baseUrl: "http://example.test/v1",
        model: "m",
        temperature: 0.7,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once on a network error and rethrows if the retry also fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      callModel({
        baseUrl: "http://example.test/v1",
        model: "m",
        temperature: 0.7,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and fails after repeated 500s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "still down" }, 503));
    await expect(
      callModel({
        baseUrl: "http://example.test/v1",
        model: "m",
        temperature: 0.7,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function minimalWorld(id: string): World {
  return {
    id,
    domain: "engineering",
    decision: {
      title: "t",
      chosen: "A",
      rationale: "A is good.",
      rejected: [{ option: "B", reason: "B is bad." }],
      load_bearing_conditions: ["cond"],
    },
    memory: {
      destination: { namespace: "projects/x", key: "status", content: "Chose A.", tags: ["decision"] },
      path_logs: [
        {
          namespace: "projects/x",
          content: "Chose A over B because B is bad.",
          tags: ["decision"],
          ts: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    probes: [
      { id: `${id}-p`, kind: "perturbation", text: "B got better.", expected: "REOPEN_SWITCH", attacks: "rejected-branch" },
      { id: `${id}-s`, kind: "stasis", text: "A had a patch release.", expected: "HOLD", attacks: "none" },
    ],
  };
}

describe("aggregateRuns", () => {
  it("computes should_flip_rate for perturbation and false_flip_rate for stasis", () => {
    const world = minimalWorld("w1");
    const base = {
      world_id: "w1",
      domain: "engineering",
      arm: "B" as const,
      model: "m",
      temperature: 0.7,
      ts: "2026-01-01T00:00:00.000Z",
      latency_ms: 1,
      raw_response: "",
    };
    const records: RunRecord[] = [
      {
        ...base,
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 0,
        grade: { parsed_action: "REOPEN_SWITCH", ternary_match: true, binary_match: true },
      },
      {
        ...base,
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 1,
        grade: { parsed_action: "HOLD", ternary_match: false, binary_match: false },
      },
      {
        ...base,
        probe_id: "w1-s",
        probe_kind: "stasis",
        probe_attacks: "none",
        expected: "HOLD",
        run_index: 0,
        grade: { parsed_action: "REOPEN_SWITCH", ternary_match: false, binary_match: false },
      },
      {
        ...base,
        probe_id: "w1-s",
        probe_kind: "stasis",
        probe_attacks: "none",
        expected: "HOLD",
        run_index: 1,
        grade: { parsed_action: "HOLD", ternary_match: true, binary_match: true },
      },
    ];

    const aggregates = aggregateRuns(records);
    const perturbation = aggregates.find((a) => a.probe_id === "w1-p")!;
    const stasis = aggregates.find((a) => a.probe_id === "w1-s")!;

    expect(perturbation.k).toBe(2);
    expect(perturbation.should_flip_rate).toBeCloseTo(0.5, 6);
    expect(perturbation.false_flip_rate).toBeUndefined();

    expect(stasis.k).toBe(2);
    expect(stasis.false_flip_rate).toBeCloseTo(0.5, 6);
    expect(stasis.should_flip_rate).toBeUndefined();
  });

  it("counts invalid parses without crediting a match", () => {
    const records: RunRecord[] = [
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
        probe_id: "w1-s",
        probe_kind: "stasis",
        probe_attacks: "none",
        expected: "HOLD",
        run_index: 0,
        model: "m",
        temperature: 0.7,
        ts: "2026-01-01T00:00:00.000Z",
        latency_ms: 1,
        raw_response: "no verdict",
        grade: { parsed_action: "INVALID", ternary_match: false, binary_match: false },
      },
    ];
    const aggregates = aggregateRuns(records);
    expect(aggregates[0].invalid_count).toBe(1);
    expect(aggregates[0].invalid_rate).toBe(1);
    expect(aggregates[0].false_flip_rate).toBe(0);
  });
});

describe("summarizeByWorldArm + renderMarkdownSummary", () => {
  it("renders a compact table with should-flip, false-flip, agreement, and invalid columns", () => {
    const world = minimalWorld("w1");
    void world;
    const aggregates = aggregateRuns([
      {
        world_id: "w1",
        domain: "engineering",
        arm: "B",
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 0,
        model: "m",
        temperature: 0.7,
        ts: "2026-01-01T00:00:00.000Z",
        latency_ms: 1,
        raw_response: "",
        grade: { parsed_action: "REOPEN_SWITCH", ternary_match: true, binary_match: true },
      },
    ]);
    const rows = summarizeByWorldArm(aggregates);
    expect(rows).toHaveLength(1);
    expect(rows[0].world_id).toBe("w1");
    expect(rows[0].arm).toBe("B");

    const md = renderMarkdownSummary(rows, {
      model: "test-model",
      k: 1,
      temperature: 0.7,
      corpus_sha256: "abc123",
    });
    expect(md).toContain("test-model");
    expect(md).toContain("| World | Arm |");
    expect(md).toContain("w1");
  });
});

describe("runDecisionProvenanceEval (fully injected chat, no network)", () => {
  it("produces world x arm x probe x k RunRecords and writes JSONL + aggregate + markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-run-"));
    try {
      const corpusPath = join(__dirname, "..", "benchmark", "decision-provenance", "corpus", "toy.json");
      const chat = vi.fn().mockResolvedValue({
        content: 'VERDICT: {"action":"HOLD","reason":"scripted response"}',
      });

      const outcome = await runDecisionProvenanceEval({
        corpusPath,
        arms: ["A", "B"],
        k: 2,
        outDir: dir,
        model: "scripted-model",
        temperature: 0.5,
        chat,
      });

      // 2 worlds x 2 arms x 4 probes x k=2 = 32 records
      expect(outcome.records).toHaveLength(32);
      expect(outcome.records.every((r) => r.grade.parsed_action === "HOLD")).toBe(true);
      expect(outcome.aggregates.length).toBeGreaterThan(0);

      expect(existsSync(outcome.paths.jsonl)).toBe(true);
      expect(existsSync(outcome.paths.aggregateJson)).toBe(true);
      expect(existsSync(outcome.paths.markdown)).toBe(true);

      const jsonlLines = readFileSync(outcome.paths.jsonl, "utf-8").trim().split("\n");
      expect(jsonlLines).toHaveLength(32);
      const parsedFirst = JSON.parse(jsonlLines[0]);
      expect(parsedFirst.world_id).toBeDefined();

      const aggregateJson = JSON.parse(readFileSync(outcome.paths.aggregateJson, "utf-8"));
      expect(aggregateJson.meta.model).toBe("scripted-model");
      expect(aggregateJson.aggregates.length).toBeGreaterThan(0);

      const markdown = readFileSync(outcome.paths.markdown, "utf-8");
      expect(markdown).toContain("scripted-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never calls chat for arm A with content from a path_log (sanity: arm exclusion holds end-to-end)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-run-"));
    try {
      const corpusPath = join(__dirname, "..", "benchmark", "decision-provenance", "corpus", "toy.json");
      const seenPrompts: string[] = [];
      const chat = vi.fn().mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
        seenPrompts.push(req.messages[0].content);
        return { content: 'VERDICT: {"action":"HOLD","reason":"x"}' };
      });

      await runDecisionProvenanceEval({
        corpusPath,
        arms: ["A"],
        k: 1,
        outDir: dir,
        model: "m",
        chat,
      });

      // "40k msgs/sec" is unique to toy-queue-lib's rationale/path_log content —
      // it never appears in the destination content or in any probe text, so its
      // absence from every arm-A prompt confirms path content did not leak in.
      const armAPrompts = seenPrompts;
      expect(armAPrompts.length).toBeGreaterThan(0);
      expect(armAPrompts.some((p) => p.includes("40k msgs/sec"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
