/**
 * The agent-under-test prompt template.
 *
 * Deliberately neutral: it must not hint that reopening is the "expected"
 * or "correct" behavior, and must not reveal that this is an evaluation.
 * The three-way output contract is stated even-handedly (REOPEN_SWITCH /
 * REOPEN_HOLD / HOLD get one sentence each, in the same tone), so a model
 * cannot infer the graders' bias toward flipping (or not flipping) from the
 * prompt itself — any measured should-flip / false-flip rate reflects the
 * model's own reasoning over the memory payload, not prompt leakage.
 */

/** Literal marker line the grader (`grade.ts`) scans for. Keep in sync with grade.ts's VERDICT_MARKER. */
export const VERDICT_MARKER = "VERDICT:";

/**
 * Build the full prompt text shown to the agent under test.
 *
 * `memoryPayload` is the arm-specific memory bundle from `arms.ts`
 * (destination only, destination + path, or destination + filler).
 * `probeText` is the new-information string from the `Probe` being tested.
 */
export function buildAgentPrompt(memoryPayload: string, probeText: string): string {
  return [
    "You are an agent with a persistent memory. Below is memory retrieved for the current task.",
    "",
    "<retrieved_memory>",
    memoryPayload,
    "</retrieved_memory>",
    "",
    "A new piece of information has just arrived:",
    "",
    "<new_information>",
    probeText,
    "</new_information>",
    "",
    "Process the new information in light of the retrieved memory, and state what, if anything, should happen to the stored decision above.",
    "",
    "End your response with exactly one line in this exact format (no other text on that line, and no markdown formatting on it):",
    `${VERDICT_MARKER} {"action":"REOPEN_SWITCH"|"REOPEN_HOLD"|"HOLD","reason":"<one sentence>"}`,
    "",
    "Where the three actions mean:",
    '- "REOPEN_SWITCH" — the decision should be reopened and changed to a different option.',
    '- "REOPEN_HOLD" — the decision is worth reopening and watching, but the current choice should still stand for now.',
    '- "HOLD" — nothing about the stored decision should change.',
  ].join("\n");
}
