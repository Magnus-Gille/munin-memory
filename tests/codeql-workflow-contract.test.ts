import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateCodeqlWorkflow } from "../scripts/check-codeql-workflow.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github", "workflows", "codeql.yml");
const dependabotPath = join(root, ".github", "dependabot.yml");

describe("CodeQL workflow contract", () => {
  it("pins init and analyze to the same immutable CodeQL action revision", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const pins = validateCodeqlWorkflow(workflow);
    expect(pins.get("init")).toMatch(/^[0-9a-f]{40}$/);
    expect(pins.get("analyze")).toBe(pins.get("init"));
  });

  it("reports a useful error when init and analyze pins drift apart", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const pins = validateCodeqlWorkflow(workflow);
    const currentSha = pins.get("analyze");
    const differentSha = currentSha === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
    const mismatched = workflow.replace(/(github\/codeql-action\/analyze@)[0-9a-f]{40}/, `$1${differentSha}`);

    expect(() => validateCodeqlWorkflow(mismatched)).toThrow(/init and analyze must use the same commit SHA/i);
  });

  it("rejects a version tag in place of a full commit SHA", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    validateCodeqlWorkflow(workflow);
    const mutableTag = workflow.replace(/(github\/codeql-action\/init@)[0-9a-f]{40}/, "$1v4.38.3");

    expect(() => validateCodeqlWorkflow(mutableTag)).toThrow(/full 40-character lowercase commit SHA/i);
  });

  it("ignores commented references and accepts quoted active uses", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const fixture = [
      `# - uses: github/codeql-action/init@v4`,
      `  # - uses: github/codeql-action/analyze@v4`,
      `      - uses: "github/codeql-action/init@${sha}" # pinned init`,
      `      - uses: 'github/codeql-action/analyze@${sha}'`,
    ].join("\n");

    expect(validateCodeqlWorkflow(fixture).get("init")).toBe(sha);
  });

  it("reports when an active action use is missing", () => {
    const fixture = `      - uses: github/codeql-action/init@${"1".repeat(40)}\n`;
    expect(() => validateCodeqlWorkflow(fixture)).toThrow(/exactly one github\/codeql-action\/analyze use; found 0/i);
  });

  it("validates named steps and rejects an extra named mutable action", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const named = workflow.replace(
      /- uses: (github\/codeql-action\/init@)/,
      '- name: Initialize CodeQL\n        uses: $1',
    );
    expect(() => validateCodeqlWorkflow(named)).not.toThrow();
    expect(() => validateCodeqlWorkflow(`${named}\n      - name: Extra analysis\n        uses: github/codeql-action/analyze@v4\n`))
      .toThrow(/exactly one github\/codeql-action\/analyze use; found 2/i);
  });

  it("groups CodeQL action updates in Dependabot's GitHub Actions ecosystem", () => {
    const dependabot = readFileSync(dependabotPath, "utf8");
    const githubActionsConfig = dependabot.split("  - package-ecosystem: github-actions")[1];
    expect(githubActionsConfig).toBeDefined();
    expect(githubActionsConfig).toContain("codeql-actions:");
    expect(githubActionsConfig).toMatch(/patterns:\s+- "github\/codeql-action\/\*"/);
    expect(dependabot).toContain("dev-dependencies:");
    expect(dependabot).toContain("production-dependencies:");
  });
});
