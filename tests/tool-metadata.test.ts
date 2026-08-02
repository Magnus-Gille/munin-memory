import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REGISTERED_TOOL_METADATA } from "../src/tools.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();
const readme = normalizeWhitespace(readFileSync(join(repoRoot, "README.md"), "utf8"));
const usageModel = normalizeWhitespace(readFileSync(join(repoRoot, "docs/usage-model.md"), "utf8"));
const changelog = normalizeWhitespace(readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"));
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
      "compact",
      "beginner",
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

  it("keeps published memory_commitments wording aligned with tracked-status and explicit log derivation", () => {
    const commitments = metadataByName.get("memory_commitments");
    expect(commitments).toBeDefined();

    for (const phrase of [
      "dated future clauses in visible tracked-status prose",
      "explicit `memory_log` commitment phrases",
      "`We agreed to: ...`",
      "`I commit to: ...`",
      "future-dated `memory_log` phrases",
      "Legacy plain markdown status blobs with ad-hoc `Next Steps:` headings",
    ]) {
      expect(commitments!.description).toContain(phrase);
      expect(readme, `README should mention ${phrase}`).toContain(phrase);
      expect(usageModel, `docs/usage-model.md should mention ${phrase}`).toContain(phrase);
      expect(changelog, `CHANGELOG.md should mention ${phrase}`).toContain(phrase);
    }
  });
});
