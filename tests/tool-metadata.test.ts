import { describe, expect, it } from "vitest";
import { REGISTERED_TOOL_METADATA } from "../src/tools.js";

const metadataByName = new Map(REGISTERED_TOOL_METADATA.map((tool) => [tool.name, tool]));

describe("MCP tool metadata discovery contract", () => {
  it("makes memory_orient self-describing for deferred discovery", () => {
    const orient = metadataByName.get("memory_orient");
    expect(orient).toBeDefined();

    const description = orient!.description.toLowerCase();
    for (const phrase of [
      "memory_orient",
      "session handshake",
      "first memory operation",
      "deferred tool discovery",
      "memory_status",
      "memory_resume",
    ]) {
      expect(description).toContain(phrase);
    }
  });

  it("keeps first-call guidance fallback-safe when memory_orient is not callable", () => {
    const staleRequirement = "if this is your first memory operation in this conversation, call memory_orient first.";
    for (const tool of REGISTERED_TOOL_METADATA) {
      expect(tool.description.toLowerCase()).not.toContain(staleRequirement);
    }

    const fallbackGuidanceTools = REGISTERED_TOOL_METADATA.filter((tool) =>
      tool.description.includes("First memory operation:"),
    );
    expect(fallbackGuidanceTools.length).toBeGreaterThan(10);

    for (const tool of fallbackGuidanceTools) {
      const description = tool.description.toLowerCase();
      expect(description, `${tool.name} should mention callable/discovery fallback`).toContain("callable");
      expect(description, `${tool.name} should mention deferred discovery fallback`).toContain(
        "deferred tool discovery",
      );
      expect(description, `${tool.name} should name memory_status fallback`).toContain("memory_status");
      expect(description, `${tool.name} should name memory_resume fallback`).toContain("memory_resume");
    }
  });
});
