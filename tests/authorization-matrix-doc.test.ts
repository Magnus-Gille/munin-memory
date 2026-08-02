import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTHORIZATION_MATRIX_MD = join(__dirname, "..", "docs", "authorization-matrix.md");

function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`Could not find section heading "${heading}" in authorization-matrix.md`);
  }

  const sectionLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^###\s/.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

describe("authorization-matrix memory_history contract", () => {
  const markdown = readFileSync(AUTHORIZATION_MATRIX_MD, "utf8");
  const historySection = extractSection(markdown, "### memory_history");

  it("documents literal, case-sensitive subtree and trailing-slash prefix semantics", () => {
    expect(historySection).toContain("Literal and case-sensitive.");
    expect(historySection).toContain("Bare `projects/foo` means that namespace plus descendants;");
    expect(historySection).toContain("trailing-slash `projects/foo/` means descendants under that literal prefix only.");
  });
});
