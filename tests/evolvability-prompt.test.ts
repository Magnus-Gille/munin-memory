import { describe, it, expect } from "vitest";
import { buildAgentPrompt, VERDICT_MARKER } from "../benchmark/evolvability/prompt.js";

describe("buildAgentPrompt", () => {
  const prompt = buildAgentPrompt("<memory payload>", "<probe text>");

  it("includes the memory payload and probe text verbatim", () => {
    expect(prompt).toContain("<memory payload>");
    expect(prompt).toContain("<probe text>");
  });

  it("states the strict output contract with the VERDICT marker", () => {
    expect(prompt).toContain(VERDICT_MARKER);
    expect(prompt).toContain("REOPEN_SWITCH");
    expect(prompt).toContain("REOPEN_HOLD");
    expect(prompt).toContain('"HOLD"');
  });

  it("does not hint that reopening is expected or that this is a test", () => {
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain("test");
    expect(lower).not.toContain("evaluat");
    expect(lower).not.toContain("benchmark");
    expect(lower).not.toContain("grade");
    expect(lower).not.toContain("expected answer");
    // Framing must not lean toward any one of the three actions.
    expect(lower).not.toContain("usually");
    expect(lower).not.toContain("most likely");
  });
});
