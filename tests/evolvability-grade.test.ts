import { describe, it, expect } from "vitest";
import { parseVerdict, grade } from "../benchmark/evolvability/grade.js";

describe("parseVerdict", () => {
  it("parses a clean VERDICT line", () => {
    const response = `The maintainer situation is concerning.\n\nVERDICT: {"action":"REOPEN_SWITCH","reason":"maintainer is gone"}`;
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("REOPEN_SWITCH");
    expect(parsed.reason).toBe("maintainer is gone");
  });

  it("parses a VERDICT wrapped in a markdown code fence", () => {
    const response = [
      "Here is my analysis.",
      "",
      "```",
      'VERDICT: {"action":"HOLD","reason":"not load-bearing"}',
      "```",
    ].join("\n");
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("HOLD");
    expect(parsed.reason).toBe("not load-bearing");
  });

  it("uses the LAST VERDICT line when multiple are present", () => {
    const response = [
      'Draft thought: VERDICT: {"action":"HOLD","reason":"first guess"}',
      "On reflection, the rejected option's blocker is now resolved.",
      'VERDICT: {"action":"REOPEN_SWITCH","reason":"final answer"}',
    ].join("\n");
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("REOPEN_SWITCH");
    expect(parsed.reason).toBe("final answer");
  });

  it("is robust to surrounding prose and whitespace", () => {
    const response = `   Some rambling analysis with lots of text.\n\n\n   VERDICT:    {"action":"REOPEN_HOLD","reason":"worth watching"}   \n\nTrailing notes.`;
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("REOPEN_HOLD");
  });

  it("returns INVALID when no VERDICT line is present", () => {
    const response = "I think we should probably keep the current decision as-is.";
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("INVALID");
  });

  it("returns INVALID when the VERDICT JSON is malformed", () => {
    const response = 'VERDICT: {"action": REOPEN_SWITCH, not valid json}';
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("INVALID");
  });

  it("returns INVALID when the action value is not one of the three allowed literals", () => {
    const response = 'VERDICT: {"action":"MAYBE","reason":"unsure"}';
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("INVALID");
  });

  it("returns INVALID when there is no JSON object after the marker", () => {
    const response = "VERDICT: I choose to hold.";
    const parsed = parseVerdict(response);
    expect(parsed.action).toBe("INVALID");
  });
});

describe("grade", () => {
  it("marks ternary and binary match true on an exact hit", () => {
    const result = grade('VERDICT: {"action":"REOPEN_SWITCH","reason":"x"}', "REOPEN_SWITCH");
    expect(result.ternary_match).toBe(true);
    expect(result.binary_match).toBe(true);
  });

  it("marks ternary false but binary true when both are reopen actions of different flavors", () => {
    const result = grade('VERDICT: {"action":"REOPEN_HOLD","reason":"x"}', "REOPEN_SWITCH");
    expect(result.ternary_match).toBe(false);
    expect(result.binary_match).toBe(true);
  });

  it("marks both false when a reopen is expected but HOLD was returned", () => {
    const result = grade('VERDICT: {"action":"HOLD","reason":"x"}', "REOPEN_SWITCH");
    expect(result.ternary_match).toBe(false);
    expect(result.binary_match).toBe(false);
  });

  it("marks both false when the response is INVALID, never crediting a lucky guess", () => {
    const result = grade("no verdict here", "HOLD");
    expect(result.parsed_action).toBe("INVALID");
    expect(result.ternary_match).toBe(false);
    expect(result.binary_match).toBe(false);
  });
});
