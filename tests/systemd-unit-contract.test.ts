/**
 * Deployment-unit contract for the portable public installation path.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicTemplate = readFileSync(join(repoRoot, "munin-memory.service"), "utf8");
const backupTemplate = readFileSync(join(repoRoot, "munin-backup.service"), "utf8");
const offsiteTemplate = readFileSync(join(repoRoot, "munin-offsite.service"), "utf8");
const opsInstaller = readFileSync(join(repoRoot, "scripts", "install-ops.sh"), "utf8");
const fleetUnitPath = join(repoRoot, "systemd", "munin-memory.service");
const snapshotScriptPath = join(repoRoot, "scripts", "snapshot-benchmark-db.sh");

describe("systemd deployment-unit contract", () => {
  it("keeps the public service file as a renderable template", () => {
    expect(publicTemplate).toContain("User=<user>");
    expect(publicTemplate).toContain("/home/<user>/<install-dir>");
  });

  it("binds to loopback and grants write access only to the memory directory", () => {
    expect(publicTemplate).toContain("Environment=MUNIN_HTTP_HOST=127.0.0.1");
    expect(publicTemplate).toContain("ReadWritePaths=/home/<user>/.munin-memory");
    expect(publicTemplate).toContain("NoNewPrivileges=true");
  });

  it("keeps backup units portable and rendered by the ops installer", () => {
    expect(backupTemplate).toContain("User=<user>");
    expect(backupTemplate).toContain("ExecStart=<ops-dir>/scripts/backup-to-nas.sh");
    expect(offsiteTemplate).toContain("ReadWritePaths=<home-dir>/.munin-memory");
    expect(`${backupTemplate}\n${offsiteTemplate}`).not.toMatch(/\/home\/[a-z0-9._-]+\//i);
    for (const placeholder of ["<user>", "<home-dir>", "<ops-dir>"]) {
      expect(opsInstaller).toContain(`s|${placeholder}|`);
    }
  });

  it("ships an install-ready public-safe unit for the Grimnir fleet deployer", () => {
    expect(existsSync(fleetUnitPath)).toBe(true);
    const fleetUnit = readFileSync(fleetUnitPath, "utf8");
    expect(fleetUnit).not.toMatch(/^[^#;\n]*<[A-Za-z][A-Za-z0-9_-]*>/m);
    expect(fleetUnit).toContain("WorkingDirectory=/srv/grimnir/munin-memory");
    expect(fleetUnit).toContain("ReadWritePaths=/var/lib/grimnir/munin-memory");
    expect(fleetUnit).not.toMatch(/\/home\/[a-z0-9._-]+\//i);
  });

  it("keeps the documented benchmark snapshot helper executable", () => {
    expect(statSync(snapshotScriptPath).mode & 0o111).not.toBe(0);
  });
});
