import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOOLS_SOURCE = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");

const ENFORCEMENT_EXPECTATIONS: Record<string, string[]> = {
  memory_write: ["buildWriteHint("],
  // Direct-read tools route through the unified read gate (#154), which folds
  // classification redaction (maybeRedactDirectEntry) + the untrusted envelope.
  memory_read: ["serializeEntry(", "buildReadMissHint("],
  memory_read_batch: ["serializeEntry("],
  memory_get: ["serializeEntry("],
  memory_query: ["formatQueryResult("],
  memory_list: ["listVisibleNamespaces(", "maybeRedactEntryMetadata("],
  memory_delete: ["previewDeleteByClassification("],
  memory_history: ["formatHistoryEntry("],
  // memory_orient trust-envelope call sites are all inline in the case block
  // (#152): dashboard summary, owner curated fields (notes/references/
  // legacy_workbench), and cross-reference context.
  memory_orient: [
    "getVisibleTrackedStatusAssessments(",
    "filterDerivedSources(",
    "dashboardUntrustedOverride",
    "refIndexUntrustedOverride",
    "safeContext",
    // Synthesis summary trust is decided from FULL synthesis content, not the
    // truncated preview (#152 round 2 / Codex finding 1).
    "synthesisUntrustedOverride",
  ],
  // memory_resume's open_loops trust envelope lives inside the
  // extractResumeOpenLoops helper (checked below, reached via
  // buildResumeStatusCandidate) — the case block only needs to keep calling
  // the candidate builder.
  memory_resume: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources(", "buildResumeStatusCandidate("],
  memory_extract: ["getVisibleTrackedStatusAssessments(", "buildExtractRelatedEntries(", "redacted_sources"],
  memory_narrative: ["filterDerivedSources("],
  memory_commitments: ["getVisibleTrackedStatusAssessments(", "listFreshCommitmentRows(", "classifyCommitments("],
  // patternsOnlyJson (round 2 / Codex finding 4): the untracked-namespace
  // crystallize heuristic must emit only the minimal tracked_patterns patch,
  // never echo other stored meta/config fields into the rationale string.
  memory_patterns: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources(", "patternsOnlyJson"],
  // memory_handoff wraps both the status-derived open loops (via
  // extractResumeOpenLoops) and the commitment-derived open loops (via
  // commitmentTrustOverride) inline in the case block (#152).
  memory_handoff: ["getVisibleTrackedStatusAssessments(", "filterDerivedSources(", "extractResumeOpenLoops(", "commitmentTrustOverride("],
  memory_attention: ["getVisibleTrackedStatusAssessments(", "listVisibleNamespaces(", "attentionUntrustedOverride"],
  memory_insights: ["computeEntryInsight"],
};

// Helper functions defined outside the switch statement (e.g. shared between
// tools, or too large to inline) can't be checked via getCaseBlock, since that
// only captures the literal text of one `case "tool": { ... }` arm. These
// entries extract a named function's body by brace-counting and assert the
// trust-envelope call (safenText(/safenPreview() is still present inside it —
// a regression tripwire for fixes whose call site is one level removed from
// the case block (#152).
const HELPER_ENFORCEMENT_EXPECTATIONS: Record<string, string[]> = {
  // memory_resume (open_loops) + memory_handoff (status-derived open loops)
  extractResumeOpenLoops: ["safenPreview(", "loopUntrustedOverride"],
  // memory_commitments (text/source_excerpt) + memory_handoff (commitment-derived open loops)
  buildCommitmentItem: ["commitmentTrustOverride(", "safenText(", "safenPreview("],
  // memory_insights (content_preview)
  computeEntryInsight: ["safenPreview(", "insightTags"],
  // memory_orient (conventions.content, full-detail branch)
  projectConventions: ["safenText("],
  // memory_narrative (audit-source previews via the sources array) — resolves
  // trust from the SOURCE entry's full content when entry_id still resolves
  // (#152 round 2 / Codex finding 2), not a scan of the truncated detail.
  buildNarrativeSourceFromAudit: ["safenAuditDetail("],
  // memory_history detail field — same source-entry resolution.
  formatHistoryEntry: ["safenAuditDetail("],
  // memory_resume history candidates — same source-entry resolution.
  buildResumeHistoryCandidate: ["safenAuditDetail("],
  // memory_narrative timeline audit items — same source-entry resolution.
  buildNarrativeTimeline: ["safenAuditDetail("],
  // memory_narrative time_in_phase signal — trust decided from FULL status
  // content, not just the interpolated Phase snippet (#152 round 2 / Codex
  // finding 3).
  pushNarrativePhaseSignals: ["safenPreview(", "statusUntrustedOverride"],
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

function getFunctionBody(functionName: string): string {
  const marker = `function ${functionName}(`;
  const start = TOOLS_SOURCE.indexOf(marker);
  expect(start, `Expected tools.ts to contain ${marker}`).toBeGreaterThanOrEqual(0);

  // Skip past the parameter list first (paren-count, not brace-count) — a
  // parameter's inline object type (e.g. `row: { ... }`) would otherwise be
  // mistaken for the function body's opening brace.
  const parenStart = start + marker.length - 1; // index of the opening "("
  let parenDepth = 0;
  let paramsEnd = parenStart;
  for (; paramsEnd < TOOLS_SOURCE.length; paramsEnd++) {
    if (TOOLS_SOURCE[paramsEnd] === "(") parenDepth++;
    else if (TOOLS_SOURCE[paramsEnd] === ")") {
      parenDepth--;
      if (parenDepth === 0) { paramsEnd++; break; }
    }
  }

  const braceStart = TOOLS_SOURCE.indexOf("{", paramsEnd);
  let depth = 0;
  let end = braceStart;
  for (; end < TOOLS_SOURCE.length; end++) {
    if (TOOLS_SOURCE[end] === "{") depth++;
    else if (TOOLS_SOURCE[end] === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
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

  it("every helper function that synthesizes entry-derived output applies the trust envelope", () => {
    for (const [functionName, snippets] of Object.entries(HELPER_ENFORCEMENT_EXPECTATIONS)) {
      const body = getFunctionBody(functionName);
      for (const snippet of snippets) {
        expect(body, `${functionName} should contain ${snippet}`).toContain(snippet);
      }
    }
  });
});
