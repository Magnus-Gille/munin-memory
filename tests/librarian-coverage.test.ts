import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOOLS_SOURCE = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");

const ENFORCEMENT_EXPECTATIONS: Record<string, string[]> = {
  memory_write: ["buildWriteHint("],
  memory_read: ["maybeRedactDirectEntry(", "buildReadMissHint("],
  memory_read_batch: ["maybeRedactDirectEntry("],
  memory_get: ["maybeRedactDirectEntry("],
  memory_query: ["formatQueryResult("],
  memory_list: ["listVisibleNamespaces(", "maybeRedactEntryMetadata("],
  memory_delete: ["previewDeleteByClassification("],
  memory_history: ["formatHistoryEntry("],
  memory_orient: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources("],
  memory_resume: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources("],
  memory_extract: ["getVisibleTrackedStatusAssessments(", "buildExtractRelatedEntries(", "redacted_sources"],
  memory_narrative: ["filterDerivedSources("],
  memory_commitments: ["getVisibleTrackedStatusAssessments(", "listFreshCommitmentRows("],
  memory_patterns: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources("],
  memory_handoff: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources("],
  memory_attention: ["getVisibleTrackedStatusAssessments(", "listVisibleNamespaces("],
};

function getCaseBlock(toolName: string): string {
  const marker = `case "${toolName}": {`;
  const start = TOOLS_SOURCE.indexOf(marker);
  expect(start, `Expected tools.ts to contain ${marker}`).toBeGreaterThanOrEqual(0);

  const remainder = TOOLS_SOURCE.slice(start + marker.length);
  const nextCaseMatch = remainder.match(/\n\s+case "([^"]+)": \{/);
  const end = nextCaseMatch
    ? start + marker.length + nextCaseMatch.index
    : TOOLS_SOURCE.length;

  return TOOLS_SOURCE.slice(start, end);
}

describe("Librarian coverage guard", () => {
  it("every content-returning tool includes a Librarian enforcement hook", () => {
    for (const [toolName, snippets] of Object.entries(ENFORCEMENT_EXPECTATIONS)) {
      const block = getCaseBlock(toolName);
      for (const snippet of snippets) {
        expect(block, `${toolName} should contain ${snippet}`).toContain(snippet);
      }
    }
  });
});
