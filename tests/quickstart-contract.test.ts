import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const quickstart = readFileSync(join(repoRoot, "scripts/quickstart.sh"), "utf8");
const smoke = readFileSync(join(repoRoot, "scripts/quickstart-smoke.sh"), "utf8");
const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const guide = readFileSync(join(repoRoot, "docs/quickstart.md"), "utf8");

describe("canonical quick-start contract", () => {
  it("ships executable fail-fast install and smoke entry points", () => {
    for (const path of ["scripts/quickstart.sh", "scripts/quickstart-smoke.sh"]) {
      expect(statSync(join(repoRoot, path)).mode & 0o111).not.toBe(0);
    }
    expect(quickstart).toContain("set -euo pipefail");
    expect(quickstart).toContain("npm ci");
    expect(quickstart).toContain("npm run build");
    expect(quickstart).toContain("dist/quickstart-cli.js");
  });

  it("runs the actual entry point in an isolated five-minute CI smoke lane", () => {
    expect(smoke).toContain("mktemp -d");
    expect(smoke).toContain('MUNIN_QUICKSTART_SKIP_INSTALL="$SKIP_INSTALL"');
    expect(smoke).toContain("elapsed >= 300");
    expect(smoke).not.toMatch(/\bHOME=/);
    expect(ci).toContain("run: npm run quickstart:smoke");
  });

  it("runs the full canonical install on a native Linux ARM64 runner", () => {
    expect(ci).toContain("runs-on: ubuntu-24.04-arm");
    expect(ci).toContain('MUNIN_QUICKSTART_SMOKE_FULL_INSTALL: "1"');
    expect(smoke).toContain("MUNIN_QUICKSTART_SMOKE_FULL_INSTALL");
    expect(smoke).toContain("arch=${process.arch}");
  });

  it("documents rollback boundaries and deliberate data retention", () => {
    expect(guide).toContain("## Upgrade, rollback, and uninstall");
    expect(guide).toContain("Forward-only migrations");
    expect(guide).toContain("Retain `~/.munin-memory`");
    expect(guide).toContain("<MUNIN_API_KEY>");
  });
});
