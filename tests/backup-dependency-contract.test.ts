import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("backup dependency contract v1", () => {
  it("accepts the public-safe positive fixture and rejects every adversarial fixture", () => {
    const result = spawnSync("node", [join(root, "scripts", "validate-backup-dependency-contract.mjs")], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Backup dependency v1 contract fixtures validated");
  });
});
