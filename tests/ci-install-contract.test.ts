import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = [".github/workflows/ci.yml", ".github/workflows/evidence-regression.yml"];

describe("CI dependency install contract (#414)", () => {
  // onnxruntime-node (via @huggingface/transformers) downloads unused CUDA
  // binaries from nuget.org during npm ci on linux/x64 unless told to skip;
  // that download caused every red main run in the 30 days before #396.
  it.each(workflows)("%s skips the onnxruntime-node CUDA download on every npm ci", (path) => {
    const lines = readFileSync(join(repoRoot, path), "utf8").split("\n");
    const installSteps = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*- run: npm ci\s*$/.test(line));
    expect(installSteps.length).toBeGreaterThan(0);
    for (const { index } of installSteps) {
      const stepBody = lines.slice(index + 1, index + 6).join("\n");
      expect(stepBody).toMatch(/^\s+env:\s*$/m);
      expect(stepBody).toMatch(/^\s+ONNXRUNTIME_NODE_INSTALL: skip\s*$/m);
    }
  });
});
