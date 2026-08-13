import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCorpus, loadCorpus } from "../benchmark/decision-provenance/corpus.js";

function validWorld(id = "w1") {
  return {
    id,
    domain: "engineering",
    decision: {
      title: "Pick a thing",
      chosen: "Thing A",
      rationale: "Thing A is fast.",
      rejected: [{ option: "Thing B", reason: "Thing B is slow." }],
      load_bearing_conditions: ["Thing B stays slow."],
    },
    memory: {
      destination: {
        namespace: "projects/toy",
        key: "status",
        content: "Chose Thing A.",
        tags: ["decision"],
      },
      path_logs: [
        {
          namespace: "projects/toy",
          content: "Chose Thing A over Thing B because Thing B is slow.",
          tags: ["decision", "rationale"],
          ts: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    probes: [
      {
        id: "p1",
        kind: "perturbation",
        text: "Thing B got faster.",
        expected: "REOPEN_SWITCH",
        attacks: "rejected-branch",
      },
      {
        id: "p2",
        kind: "stasis",
        text: "Thing A shipped a patch release.",
        expected: "HOLD",
        attacks: "none",
      },
    ],
  };
}

describe("validateCorpus", () => {
  it("accepts a well-formed corpus", () => {
    const worlds = validateCorpus([validWorld()]);
    expect(worlds).toHaveLength(1);
    expect(worlds[0].id).toBe("w1");
  });

  it("rejects a non-array top level with an actionable message", () => {
    expect(() => validateCorpus({ not: "an array" })).toThrow(/must be an array/i);
  });

  it("rejects a world missing an id", () => {
    const world = validWorld();
    // @ts-expect-error deliberately malformed for the test
    delete world.id;
    expect(() => validateCorpus([world])).toThrow(/id/i);
  });

  it("rejects duplicate world ids", () => {
    const a = validWorld("dup");
    const b = validWorld("dup");
    expect(() => validateCorpus([a, b])).toThrow(/duplicate/i);
  });

  it("rejects a decision with an empty rejected array", () => {
    const world = validWorld();
    world.decision.rejected = [];
    expect(() => validateCorpus([world])).toThrow(/rejected/i);
  });

  it("rejects a rejected option missing a reason", () => {
    const world = validWorld();
    // @ts-expect-error deliberately malformed for the test
    world.decision.rejected = [{ option: "Thing B" }];
    expect(() => validateCorpus([world])).toThrow(/reason/i);
  });

  it("rejects a probe with an invalid kind", () => {
    const world = validWorld();
    // @ts-expect-error deliberately malformed for the test
    world.probes[0].kind = "bogus";
    expect(() => validateCorpus([world])).toThrow(/kind/i);
  });

  it("rejects a probe with an invalid expected value", () => {
    const world = validWorld();
    // @ts-expect-error deliberately malformed for the test
    world.probes[0].expected = "MAYBE";
    expect(() => validateCorpus([world])).toThrow(/expected/i);
  });

  it("rejects a probe with an invalid attacks value", () => {
    const world = validWorld();
    // @ts-expect-error deliberately malformed for the test
    world.probes[0].attacks = "decision-surface";
    expect(() => validateCorpus([world])).toThrow(/attacks/i);
  });

  it("rejects a world with no probes", () => {
    const world = validWorld();
    world.probes = [];
    expect(() => validateCorpus([world])).toThrow(/probe/i);
  });

  it("error messages are prefixed with the world index/id for actionability", () => {
    const world = validWorld("bad-world");
    world.decision.rejected = [];
    expect(() => validateCorpus([world])).toThrow(/bad-world/);
  });
});

describe("loadCorpus", () => {
  it("loads and validates a corpus JSON file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-corpus-"));
    try {
      const path = join(dir, "corpus.json");
      writeFileSync(path, JSON.stringify([validWorld()]));
      const result = loadCorpus(path);
      expect(result.worlds).toHaveLength(1);
      expect(result.path).toBe(path);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-corpus-"));
    try {
      const path = join(dir, "corpus.json");
      writeFileSync(path, "{ not valid json");
      expect(() => loadCorpus(path)).toThrow(/not valid JSON/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads the committed toy corpus without error", () => {
    const result = loadCorpus(join(__dirname, "..", "benchmark", "decision-provenance", "corpus", "toy.json"));
    expect(result.worlds.length).toBeGreaterThanOrEqual(2);
  });
});
