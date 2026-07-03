/**
 * Domain types for the decision-provenance outcome-eval benchmark layer
 * (issue #186).
 *
 * Concept: measures whether an agent that holds a decision's PATH (rationale
 * + rejected alternatives) reacts to new information correctly, versus an
 * agent that holds only the DESTINATION (what was chosen). Each `World` is a
 * decision plus the memory that would be retrieved for it, paired with
 * `Probe`s — new information that either SHOULD (`perturbation`) or should
 * NOT (`stasis`) trigger reconsideration.
 *
 * This is a separate schema family from `BenchmarkReport` (IR metrics) and
 * `AnswerQualityReport` (RAG answer correctness): decision-provenance grades a
 * decision-revision *action*, not a retrieval rank or a factual answer.
 */

// --- Corpus domain model ---

/** One rejected alternative and why it was rejected. */
export interface RejectedOption {
  option: string;
  reason: string;
}

/** The decision itself — the ground truth an evaluator grades probes against. */
export interface Decision {
  title: string;
  /** The option that was actually chosen. */
  chosen: string;
  /** Why `chosen` was chosen. Perturbations attacking `rationale` undermine this. */
  rationale: string;
  /** Alternatives that were considered and rejected, with reasons. */
  rejected: RejectedOption[];
  /**
   * Conditions that, if they changed, would legitimately warrant revisiting
   * the decision. Authoring aid for probe design — not read by the agent
   * under test, but used to keep probes honest (a probe should map to one of
   * these, or explicitly be a stasis control that maps to none).
   */
  load_bearing_conditions: string[];
}

/** The destination entry — "what was chosen", the compressed/current-truth form. */
export interface DestinationEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
}

/** One path log entry — a decision-log-shaped record carrying rationale/rejected detail. */
export interface PathLogEntry {
  namespace: string;
  content: string;
  tags: string[];
  /** ISO 8601 timestamp. */
  ts: string;
}

/** The memory a world would have stored, split into destination and path layers. */
export interface WorldMemory {
  destination: DestinationEntry;
  path_logs: PathLogEntry[];
}

/** Verdict actions the agent-under-test's output contract allows. */
export type VerdictAction = "REOPEN_SWITCH" | "REOPEN_HOLD" | "HOLD";

/**
 * A probe: one piece of "new information" injected after the memory payload.
 *
 * - `kind: "perturbation"` — new information that legitimately bears on the
 *   decision (attacks `rationale` or a `rejected` option's reason) and SHOULD
 *   trigger at least reconsideration (`expected` is `REOPEN_SWITCH` or
 *   `REOPEN_HOLD`).
 * - `kind: "stasis"` — new information that is decision-adjacent noise and
 *   should NOT trigger reconsideration (`expected: "HOLD"`). Stasis controls
 *   catch an always-flip agent that reopens on any new input regardless of
 *   relevance.
 *
 * Perturbations must attack the rationale or a rejected branch, never the
 * decision surface itself (never state "the chosen option is now known to be
 * bad" directly) — a decision-surface attack would flip arm A (destination
 * only) too, and the case would measure nothing about path-holding.
 */
export interface Probe {
  id: string;
  kind: "perturbation" | "stasis";
  /** The new-information text shown to the agent under test. */
  text: string;
  expected: VerdictAction;
  /** What part of the decision structure this probe targets. */
  attacks: "rationale" | "rejected-branch" | "none";
}

/** One decision-world: a decision, its stored memory, and its probes. */
export interface World {
  id: string;
  /** Free-text domain tag for grouping (e.g. "engineering", "hardware"). */
  domain: string;
  decision: Decision;
  memory: WorldMemory;
  probes: Probe[];
}

// --- Experiment arms ---

/**
 * Which memory payload an agent under test is given:
 * - `A` — destination only (what was chosen, no rationale).
 * - `B` — destination + full path (rationale + rejected alternatives).
 * - `C` — destination + length-matched neutral filler (active control:
 *   separates "more context mass" from "the specific path information").
 */
export type Arm = "A" | "B" | "C";

export const ALL_ARMS: readonly Arm[] = ["A", "B", "C"];

// --- Run records and aggregates ---

/** Grading result for a single graded response, at both granularities. */
export interface GradeOutcome {
  /** Parsed action, or "INVALID" if no parseable VERDICT line was found. */
  parsed_action: VerdictAction | "INVALID";
  /** Raw JSON text of the matched VERDICT payload, when one was found. */
  raw_verdict_json?: string;
  /** Free-text reason field from the parsed verdict, when present. */
  reason?: string;
  /** Exact match against `Probe.expected`. False whenever parsed_action is INVALID. */
  ternary_match: boolean;
  /**
   * Binary match: REOPEN_SWITCH and REOPEN_HOLD both count as "reopened".
   * True iff (parsed is a reopen action) === (expected is a reopen action).
   * False whenever parsed_action is INVALID.
   */
  binary_match: boolean;
  /**
   * True when the raw model response was empty or whitespace-only (e.g. a
   * thinking model that blanked out because `max_tokens` was too tight for
   * its reasoning + the longest prompts). Distinct from a response that was
   * present but failed to parse as a valid VERDICT line — that case is
   * `blank` falsy/omitted with `parsed_action: "INVALID"`. A blank response
   * always has `parsed_action: "INVALID"` and never credits a match; kept
   * optional (rather than required) so existing `GradeOutcome` literals
   * (e.g. in tests) continue to compile without change.
   */
  blank?: boolean;
}

/** One run: one (world, arm, probe, k-index) call against the model under test. */
export interface RunRecord {
  world_id: string;
  domain: string;
  arm: Arm;
  probe_id: string;
  probe_kind: Probe["kind"];
  probe_attacks: Probe["attacks"];
  expected: VerdictAction;
  /** 0-indexed run number within this (world, arm, probe) triple's k runs. */
  run_index: number;
  model: string;
  temperature: number;
  /** ISO 8601 timestamp the call was made. */
  ts: string;
  /** Wall-clock latency of the call in milliseconds. */
  latency_ms: number;
  /** Raw model response text (empty string on a request-level failure). */
  raw_response: string;
  /** Set when the request itself failed (network/HTTP error) after retry. */
  error?: string;
  grade: GradeOutcome;
}

/** Aggregate stats for one (world, arm, probe) triple across its k runs. */
export interface AggregateStats {
  world_id: string;
  domain: string;
  arm: Arm;
  probe_id: string;
  probe_kind: Probe["kind"];
  probe_attacks: Probe["attacks"];
  expected: VerdictAction;
  k: number;
  /** Count of each parsed action (including "INVALID") across the k runs. */
  verdict_counts: Record<VerdictAction | "INVALID", number>;
  /** Fraction of the k runs whose parsed_action exactly equals `expected`. */
  ternary_agreement_rate: number;
  /** Fraction of the k runs whose binary reopen/hold class matches `expected`'s class. */
  binary_agreement_rate: number;
  /**
   * For perturbation probes only: fraction of runs that correctly reopened
   * (binary match, and expected is a reopen action). Undefined for stasis
   * probes (there is nothing to "should-flip" on).
   */
  should_flip_rate?: number;
  /**
   * For stasis probes only: fraction of runs that incorrectly reopened
   * (parsed action is REOPEN_SWITCH or REOPEN_HOLD when expected is HOLD).
   * Undefined for perturbation probes.
   */
  false_flip_rate?: number;
  /**
   * Count/rate of runs whose response was present but did not parse as a
   * valid VERDICT (malformed only — excludes blank/empty responses, which
   * are counted separately in `blank_count`/`blank_rate`). Keeping the two
   * apart matters: a blank response is starvation (e.g. `max_tokens` too
   * tight for a thinking model on the longest prompts), not "the model tried
   * and failed to follow the output contract" — conflating them silently
   * zeroed whole (world, arm) cells and made a starved run indistinguishable
   * from a genuinely-decided-but-malformed one.
   */
  invalid_count: number;
  invalid_rate: number;
  /** Count/rate of runs whose raw response was empty or whitespace-only. */
  blank_count: number;
  blank_rate: number;
}

/** True when a verdict action counts as "the agent chose to reopen". */
export function isReopenAction(action: VerdictAction): boolean {
  return action === "REOPEN_SWITCH" || action === "REOPEN_HOLD";
}
