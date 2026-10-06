/**
 * Grades an agent-under-test's response against a probe's expected verdict.
 *
 * Parser-based, not LLM-judge: the output contract (`VERDICT: {...}` as the
 * final line) is strict enough that a hand-rolled parser is both cheaper and
 * more auditable than an LLM judge for the primary metric. See
 * benchmark/decision-provenance/README.md for the rationale.
 */

import type { VerdictAction, GradeOutcome } from "./types.js";
import { isReopenAction } from "./types.js";

const VALID_ACTIONS: ReadonlySet<string> = new Set<VerdictAction>([
  "REOPEN_SWITCH",
  "REOPEN_HOLD",
  "HOLD",
]);

const VERDICT_MARKER = "VERDICT:";

export interface ParsedVerdict {
  action: VerdictAction | "INVALID";
  reason?: string;
  /** Raw JSON text of the matched verdict, when a JSON object was found (even if invalid). */
  raw_verdict_json?: string;
}

/**
 * Scan `text` starting at `text[start]` (which must be the opening `{`) and
 * return the substring up to and including the matching closing `}`,
 * respecting quoted strings (so a `}` inside a `"reason"` string doesn't
 * prematurely close the object). Returns null if the braces never balance.
 */
function extractBalancedJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extract the LAST `VERDICT: {...}` JSON payload from a model response and
 * parse it into a structured verdict.
 *
 * Robust to: surrounding prose, leading/trailing whitespace, markdown code
 * fences (the fence markers simply fall outside the matched JSON span), and
 * multiple VERDICT lines (the last occurrence of the `VERDICT:` marker wins —
 * earlier ones are treated as draft/scratch reasoning, matching how the
 * prompt instructs the model to emit exactly one final line).
 *
 * Returns `{ action: "INVALID" }` when: no `VERDICT:` marker is found, no
 * JSON object follows it, the JSON does not parse, or `action` is not one of
 * the three allowed literals.
 */
export function parseVerdict(response: string): ParsedVerdict {
  const lastMarkerIdx = response.lastIndexOf(VERDICT_MARKER);
  if (lastMarkerIdx === -1) {
    return { action: "INVALID" };
  }

  const afterMarker = response.slice(lastMarkerIdx + VERDICT_MARKER.length);
  const braceOffset = afterMarker.indexOf("{");
  if (braceOffset === -1) {
    return { action: "INVALID" };
  }

  const jsonText = extractBalancedJsonObject(afterMarker, braceOffset);
  if (jsonText === null) {
    return { action: "INVALID" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { action: "INVALID", raw_verdict_json: jsonText };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { action: "INVALID", raw_verdict_json: jsonText };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action !== "string" || !VALID_ACTIONS.has(obj.action)) {
    return { action: "INVALID", raw_verdict_json: jsonText };
  }

  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  return { action: obj.action as VerdictAction, reason, raw_verdict_json: jsonText };
}

/**
 * Grade a raw model response against a probe's expected verdict, producing
 * both the exact (ternary) and reopen-vs-hold (binary) comparisons.
 *
 * An INVALID parse never credits a lucky guess: both match flags are false
 * regardless of `expected`. An empty/whitespace-only response is classified
 * as `blank: true` — distinct from a present-but-unparseable response
 * (malformed) — so a starved run (e.g. a thinking model that blanked out
 * under a tight `max_tokens` budget) is never silently lumped in with a
 * genuine output-contract failure. A blank response is still INVALID and
 * still never credits a match.
 */
export function grade(response: string, expected: VerdictAction): GradeOutcome {
  if (response.trim().length === 0) {
    return {
      parsed_action: "INVALID",
      ternary_match: false,
      binary_match: false,
      blank: true,
    };
  }

  const parsed = parseVerdict(response);
  if (parsed.action === "INVALID") {
    return {
      parsed_action: "INVALID",
      raw_verdict_json: parsed.raw_verdict_json,
      ternary_match: false,
      binary_match: false,
    };
  }

  const ternary_match = parsed.action === expected;
  const binary_match = isReopenAction(parsed.action) === isReopenAction(expected);

  return {
    parsed_action: parsed.action,
    raw_verdict_json: parsed.raw_verdict_json,
    reason: parsed.reason,
    ternary_match,
    binary_match,
  };
}
