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
  DEFAULT_MAX_429_RETRIES,
  type MinimalFetchResponse,
} from "../benchmark/decision-provenance/runner.js";
import type { RunRecord, World } from "../benchmark/decision-provenance/types.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): MinimalFetchResponse {
  const lower = headers
    ? new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    : undefined;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: lower ? { get: (name: string) => lower.get(name.toLowerCase()) ?? null } : undefined,
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

  it("parses --max-tokens", () => {
    const args = parseArgs(["--max-tokens", "512"]);
    expect(args.maxTokens).toBe(512);
  });

  it("defaults --max-tokens to 2048 when omitted", () => {
    const args = parseArgs([]);
    expect(args.maxTokens).toBe(2048);
  });

  it("rejects a non-positive --max-tokens", () => {
    expect(() => parseArgs(["--max-tokens", "0"])).toThrow(/max-tokens/i);
  });

  it("rejects a non-numeric --max-tokens", () => {
    expect(() => parseArgs(["--max-tokens", "abc"])).toThrow(/max-tokens/i);
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

  it("defaults max_tokens to 2048 in the request body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "VERDICT: {\"action\":\"HOLD\",\"reason\":\"x\"}" } }] }),
    );
    await callModel({
      baseUrl: "http://example.test/v1",
      model: "m",
      temperature: 0.7,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(2048);
  });

  it("honors an explicit maxTokens override in the request body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "VERDICT: {\"action\":\"HOLD\",\"reason\":\"x\"}" } }] }),
    );
    await callModel({
      baseUrl: "http://example.test/v1",
      model: "m",
      temperature: 0.7,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      maxTokens: 4096,
    });
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(4096);
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

  it("retries a 429, honoring the Retry-After header (via injected sleep), and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: 'VERDICT: {"action":"HOLD","reason":"ok"}' } }],
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await callModel({
      baseUrl: "http://example.test/v1",
      model: "m",
      temperature: 0.7,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
      sleep,
    });
    expect(result.content).toContain("HOLD");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Retry-After is in seconds; the sleep seam must be called with milliseconds.
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("exhausts the 429 retry cap and throws when the rate limit never clears", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "rate limited" }, 429, { "Retry-After": "0" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      callModel({
        baseUrl: "http://example.test/v1",
        model: "m",
        temperature: 0.7,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow(/429/);
    // 1 initial attempt + DEFAULT_MAX_429_RETRIES retries.
    expect(fetchImpl).toHaveBeenCalledTimes(1 + DEFAULT_MAX_429_RETRIES);
    expect(sleep).toHaveBeenCalledTimes(DEFAULT_MAX_429_RETRIES);
  });

  it("does not retry a non-429 4xx (e.g. 403) — only 429 gets the rate-limit treatment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      callModel({
        baseUrl: "http://example.test/v1",
        model: "m",
        temperature: 0.7,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
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

  it("counts blank responses separately from malformed-invalid, without crediting should/false-flip", () => {
    const records: RunRecord[] = [
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
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
        grade: { parsed_action: "INVALID", ternary_match: false, binary_match: false, blank: true },
      },
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 1,
        model: "m",
        temperature: 0.7,
        ts: "2026-01-01T00:00:00.000Z",
        latency_ms: 1,
        raw_response: "   ",
        grade: { parsed_action: "INVALID", ternary_match: false, binary_match: false, blank: true },
      },
    ];
    const aggregates = aggregateRuns(records);
    expect(aggregates[0].blank_count).toBe(2);
    expect(aggregates[0].blank_rate).toBe(1);
    expect(aggregates[0].invalid_count).toBe(0);
    expect(aggregates[0].invalid_rate).toBe(0);
    // A fully-starved cell must not report as if the model actually decided.
    expect(aggregates[0].should_flip_rate).toBe(0);
  });

  it("keeps a malformed (present but unparseable) response out of blank_count", () => {
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
    expect(aggregates[0].blank_count).toBe(0);
    expect(aggregates[0].blank_rate).toBe(0);
    expect(aggregates[0].invalid_count).toBe(1);
    expect(aggregates[0].invalid_rate).toBe(1);
  });

  it("classifies errored runs separately from blank and malformed (mutually exclusive counts)", () => {
    const records: RunRecord[] = [
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
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
        error: "Decision-provenance runner: model call failed with HTTP 429: rate limited",
        grade: { parsed_action: "INVALID", ternary_match: false, binary_match: false, errored: true },
      },
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 1,
        model: "m",
        temperature: 0.7,
        ts: "2026-01-01T00:00:00.000Z",
        latency_ms: 1,
        raw_response: "",
        grade: { parsed_action: "INVALID", ternary_match: false, binary_match: false, blank: true },
      },
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 2,
        model: "m",
        temperature: 0.7,
        ts: "2026-01-01T00:00:00.000Z",
        latency_ms: 1,
        raw_response: "no verdict",
        grade: { parsed_action: "INVALID", ternary_match: false, binary_match: false },
      },
      {
        world_id: "w1",
        domain: "engineering",
        arm: "A",
        probe_id: "w1-p",
        probe_kind: "perturbation",
        probe_attacks: "rejected-branch",
        expected: "REOPEN_SWITCH",
        run_index: 3,
        model: "m",
        temperature: 0.7,
        ts: "2026-01-01T00:00:00.000Z",
        latency_ms: 1,
        raw_response: 'VERDICT: {"action":"REOPEN_SWITCH","reason":"ok"}',
        grade: { parsed_action: "REOPEN_SWITCH", ternary_match: true, binary_match: true },
      },
    ];
    const aggregates = aggregateRuns(records);
    const stats = aggregates[0];
    expect(stats.k).toBe(4);
    expect(stats.errored_count).toBe(1);
    expect(stats.errored_rate).toBeCloseTo(0.25, 6);
    expect(stats.blank_count).toBe(1);
    expect(stats.invalid_count).toBe(1);
    // should_flip_rate must be computed over DECIDED runs only (k - errored = 3),
    // never treating the errored run as a decision.
    expect(stats.should_flip_rate).toBeCloseTo(1 / 3, 6);
  });

  it("reports errored_rate=1 and no decisions for an all-429 cell", () => {
    const records: RunRecord[] = Array.from({ length: 3 }, (_, i) => ({
      world_id: "w1",
      domain: "engineering",
      arm: "A",
      probe_id: "w1-s",
      probe_kind: "stasis" as const,
      probe_attacks: "none" as const,
      expected: "HOLD" as const,
      run_index: i,
      model: "m",
      temperature: 0.7,
      ts: "2026-01-01T00:00:00.000Z",
      latency_ms: 1,
      raw_response: "",
      error: "Decision-provenance runner: model call failed with HTTP 429: rate limited",
      grade: { parsed_action: "INVALID" as const, ternary_match: false, binary_match: false, errored: true },
    }));
    const aggregates = aggregateRuns(records);
    const stats = aggregates[0];
    expect(stats.errored_count).toBe(3);
    expect(stats.errored_rate).toBe(1);
    expect(stats.blank_count).toBe(0);
    expect(stats.invalid_count).toBe(0);
    // No decision was ever made in this cell — false_flip_rate must not report 0
    // (which would falsely read as "correctly held").
    expect(stats.false_flip_rate).toBeUndefined();
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
    expect(md).toContain("Blank");
    expect(md).toContain("Errored");
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
      expect(aggregateJson.meta.max_tokens).toBe(2048);
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

  it("classifies a run whose chat call throws as errored — not blank, not malformed — and excludes it from decisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-run-"));
    try {
      const corpusPath = join(__dirname, "..", "benchmark", "decision-provenance", "corpus", "toy.json");
      const chat = vi
        .fn()
        .mockRejectedValue(
          new Error("Decision-provenance runner: model call failed with HTTP 429: rate limited"),
        );

      const outcome = await runDecisionProvenanceEval({
        corpusPath,
        arms: ["A"],
        k: 1,
        outDir: dir,
        model: "m",
        chat,
      });

      expect(outcome.records.length).toBeGreaterThan(0);
      expect(outcome.records.every((r) => r.error !== undefined)).toBe(true);
      expect(outcome.records.every((r) => r.grade.errored === true)).toBe(true);
      expect(outcome.records.every((r) => r.grade.blank !== true)).toBe(true);
      expect(outcome.records.every((r) => r.grade.parsed_action === "INVALID")).toBe(true);

      for (const agg of outcome.aggregates) {
        expect(agg.errored_count).toBe(agg.k);
        expect(agg.blank_count).toBe(0);
        expect(agg.invalid_count).toBe(0);
        // No decision was possible in an all-errored cell — should_flip/false_flip
        // must never read as 0 (which would misreport "correctly held/flipped").
        if (agg.should_flip_rate !== undefined) {
          expect(agg.should_flip_rate).toBeUndefined();
        }
        if (agg.false_flip_rate !== undefined) {
          expect(agg.false_flip_rate).toBeUndefined();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prepends a high-error-rate warning banner to the markdown and logs to stderr when errored_rate exceeds the threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-run-"));
    try {
      const corpusPath = join(__dirname, "..", "benchmark", "decision-provenance", "corpus", "toy.json");
      let call = 0;
      const chat = vi.fn().mockImplementation(async () => {
        call++;
        if (call % 2 === 0) {
          return { content: 'VERDICT: {"action":"HOLD","reason":"ok"}' };
        }
        throw new Error("Decision-provenance runner: model call failed with HTTP 429: rate limited");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const outcome = await runDecisionProvenanceEval({
        corpusPath,
        arms: ["A"],
        k: 2,
        outDir: dir,
        model: "m",
        chat,
      });

      const markdown = readFileSync(outcome.paths.markdown, "utf-8");
      expect(markdown).toMatch(/HIGH ERROR RATE/i);
      expect(markdown).toMatch(/NOT trustworthy/i);
      expect(errorSpy).toHaveBeenCalled();
      const loggedText = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(loggedText).toMatch(/HIGH ERROR RATE/i);

      errorSpy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not add a high-error-rate banner when errored_rate is at/under the threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-run-"));
    try {
      const corpusPath = join(__dirname, "..", "benchmark", "decision-provenance", "corpus", "toy.json");
      const chat = vi.fn().mockResolvedValue({ content: 'VERDICT: {"action":"HOLD","reason":"ok"}' });

      const outcome = await runDecisionProvenanceEval({
        corpusPath,
        arms: ["A"],
        k: 2,
        outDir: dir,
        model: "m",
        chat,
      });

      const markdown = readFileSync(outcome.paths.markdown, "utf-8");
      expect(markdown).not.toMatch(/HIGH ERROR RATE/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
