import { describe, it, expect } from "vitest";
import {
  buildArmPayload,
  armBPathPayload,
  extractDistinctiveTokens,
} from "../benchmark/decision-provenance/arms.js";
import type { World } from "../benchmark/decision-provenance/types.js";

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    id: "w-queue",
    domain: "engineering",
    decision: {
      title: "Message queue client library selection",
      chosen: "queue-lib-A",
      rationale:
        "queue-lib-A was chosen because it ships prebuilt ARM64 binaries and has an active maintainer team.",
      rejected: [
        {
          option: "queue-lib-B (RabbitMQ wrapper)",
          reason:
            "objectively faster in benchmarks, but rejected solely because it ships no prebuilt ARM64 wheel.",
        },
      ],
      load_bearing_conditions: ["No prebuilt ARM64 wheel exists for queue-lib-B."],
    },
    memory: {
      destination: {
        namespace: "projects/toy-queue",
        key: "status",
        content: "Decision: adopted queue-lib-A as the message queue client.",
        tags: ["decision", "active"],
      },
      path_logs: [
        {
          namespace: "projects/toy-queue",
          content:
            "Evaluated queue-lib-A vs queue-lib-B for the v1 message queue client. queue-lib-B benchmarked faster but ships no prebuilt ARM64 wheel, an unacceptable ops burden for v1. Chose queue-lib-A: ships prebuilt ARM64 binaries, active maintainer team.",
          tags: ["decision", "rationale"],
          ts: "2026-03-01T00:00:00.000Z",
        },
      ],
    },
    probes: [],
    ...overrides,
  };
}

function makeOtherWorld(): World {
  return {
    id: "w-sensor",
    domain: "hardware",
    decision: {
      title: "Environmental sensor vendor selection",
      chosen: "vendor-A",
      rationale:
        "vendor-A was chosen because it met accuracy spec at the target price and had a 2-week lead time versus 20 weeks industry-wide.",
      rejected: [
        {
          option: "vendor-B TempSense Pro",
          reason: "superior accuracy, but rejected solely because of a 20-week lead time.",
        },
      ],
      load_bearing_conditions: ["Pilot deployment window required parts within 4 weeks."],
    },
    memory: {
      destination: {
        namespace: "projects/toy-sensors",
        key: "status",
        content: "Decision: adopted vendor-A for field-unit environmental sensors.",
        tags: ["decision", "active"],
      },
      path_logs: [
        {
          namespace: "projects/toy-sensors",
          content:
            "Compared vendor-A and vendor-B TempSense Pro for field-unit sensors. vendor-B has superior accuracy but a 20-week lead time that would miss the pilot window, so it was rejected on lead time alone. Chose vendor-A: meets accuracy spec with a 2-week lead time.",
          tags: ["decision", "rationale"],
          ts: "2026-02-10T00:00:00.000Z",
        },
      ],
    },
    probes: [],
  };
}

describe("buildArmPayload", () => {
  it("arm A includes the destination but excludes all path-log content", () => {
    const world = makeWorld();
    const payload = buildArmPayload(world, "A", [world]);
    expect(payload).toContain("Decision: adopted queue-lib-A");
    for (const log of world.memory.path_logs) {
      expect(payload).not.toContain(log.content);
    }
    // Rationale/rejected detail must not leak into arm A via any channel.
    expect(payload).not.toContain(world.decision.rationale);
  });

  it("arm B includes the destination and every path-log's content", () => {
    const world = makeWorld();
    const payload = buildArmPayload(world, "B", [world]);
    expect(payload).toContain("Decision: adopted queue-lib-A");
    for (const log of world.memory.path_logs) {
      expect(payload).toContain(log.content);
    }
  });

  it("arm C includes the destination and length-matches arm B's path payload within 10%", () => {
    const world = makeWorld();
    const other = makeOtherWorld();
    const corpus = [world, other];
    const payload = buildArmPayload(world, "C", corpus);
    expect(payload).toContain("Decision: adopted queue-lib-A");

    const pathPayloadLen = armBPathPayload(world).length;
    // arm C's non-destination portion is everything after the destination block.
    const destinationBlock = buildArmPayload(world, "A", corpus);
    expect(payload.startsWith(destinationBlock)).toBe(true);
    const fillerLen = payload.length - destinationBlock.length;

    const tolerance = pathPayloadLen * 0.1;
    expect(Math.abs(fillerLen - pathPayloadLen)).toBeLessThanOrEqual(tolerance + 1);
  });

  it("arm C filler never contains this world's distinctive rationale/rejected tokens", () => {
    const world = makeWorld();
    const other = makeOtherWorld();
    const corpus = [world, other];
    const payload = buildArmPayload(world, "C", corpus);

    // Distinctive literal tokens drawn straight from this world's rationale/rejected text.
    expect(payload.toLowerCase()).not.toContain("arm64");
    expect(payload.toLowerCase()).not.toContain("rabbitmq");
    expect(payload.toLowerCase()).not.toContain("queue-lib-b");
  });

  it("arm C still length-matches and leaks nothing even in a single-world corpus (no other worlds to draw from)", () => {
    const world = makeWorld();
    const payload = buildArmPayload(world, "C", [world]);
    const pathPayloadLen = armBPathPayload(world).length;
    const destinationBlock = buildArmPayload(world, "A", [world]);
    const fillerLen = payload.length - destinationBlock.length;
    const tolerance = pathPayloadLen * 0.1;
    expect(Math.abs(fillerLen - pathPayloadLen)).toBeLessThanOrEqual(tolerance + 1);
    expect(payload.toLowerCase()).not.toContain("arm64");
    expect(payload.toLowerCase()).not.toContain("rabbitmq");
  });
});

describe("extractDistinctiveTokens", () => {
  it("pulls literal words and full option phrases from rationale + rejected text", () => {
    const world = makeWorld();
    const tokens = extractDistinctiveTokens(world);
    expect(tokens).toContain("queue-lib-b (rabbitmq wrapper)");
    expect(tokens.some((t) => t.includes("arm64"))).toBe(true);
  });
});
