/**
 * Deployment-unit contract for the two supported installation paths.
 *
 * The root unit is the public template rendered by scripts/deploy-rpi.sh.
 * Grimnir's fleet controller deliberately prefers systemd/ and installs the
 * selected file verbatim, so that copy must already be fully rendered while
 * remaining semantically identical to the public template.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicTemplate = readFileSync(join(repoRoot, "munin-memory.service"), "utf8");
const fleetUnit = readFileSync(join(repoRoot, "systemd", "munin-memory.service"), "utf8");
const placeholderPattern = /<[a-z][a-z0-9-]*>/gi;

function activeLines(unit: string): string[] {
  return unit
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("systemd deployment-unit contract", () => {
  it("keeps the public service file as a renderable template", () => {
    expect(publicTemplate).toContain("User=<user>");
    expect(publicTemplate).toContain("/home/<user>/<install-dir>");
  });

  it("ships a fully rendered fleet unit with no unresolved placeholders", () => {
    expect(fleetUnit.match(placeholderPattern)).toBeNull();
    expect(fleetUnit).toContain("User=magnus");
    expect(fleetUnit).toContain("WorkingDirectory=/home/magnus/munin-memory");
  });

  it("keeps fleet behavior aligned with the rendered public template", () => {
    const renderedTemplate = publicTemplate
      .replaceAll("<user>", "magnus")
      .replaceAll("<install-dir>", "munin-memory");

    expect(activeLines(fleetUnit)).toEqual(activeLines(renderedTemplate));
  });
});
