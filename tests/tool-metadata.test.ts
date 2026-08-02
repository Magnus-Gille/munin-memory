import { describe, expect, it } from "vitest";
import { MCP_SERVER_INSTRUCTIONS, REGISTERED_TOOL_METADATA } from "../src/tools.js";

const metadataByName = new Map(REGISTERED_TOOL_METADATA.map((tool) => [tool.name, tool]));

describe("MCP tool metadata discovery contract", () => {
  it("publishes fallback-safe first-call guidance at the server level", () => {
    const instructions = MCP_SERVER_INSTRUCTIONS.toLowerCase();
    for (const phrase of [
      "first memory operation",
      "memory_orient",
      "callable",
      "deferred tool discovery",
      "memory_status",
      "memory_resume",
    ]) {
      expect(instructions).toContain(phrase);
    }
  });

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

  it("keeps memory_status self-describing as the fallback discovery tool", () => {
    const status = metadataByName.get("memory_status");
    expect(status).toBeDefined();

    const description = status!.description.toLowerCase();
    for (const phrase of ["memory_orient", "fallback", "deferred tool discovery", "memory_status"]) {
      expect(description).toContain(phrase);
    }
  });

  it("moves the repeated first-call guidance out of individual tool descriptions", () => {
    const staleRequirement = "if this is your first memory operation in this conversation, call memory_orient first.";
    for (const tool of REGISTERED_TOOL_METADATA) {
      expect(tool.description.toLowerCase()).not.toContain(staleRequirement);
      expect(tool.description).not.toContain("First memory operation:");
    }

    const repeatedFallbackClause =
      "If your host/deferred tool discovery did not expose `memory_orient`, call `memory_status` or `memory_resume` as a fallback instead of stalling.";
    for (const tool of REGISTERED_TOOL_METADATA) {
      if (tool.name === "memory_status") continue;
      expect(tool.description).not.toContain(repeatedFallbackClause);
    }
  });
});
