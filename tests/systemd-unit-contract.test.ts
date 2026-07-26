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
// Verbatim Grimnir services.json component fixture. Keep this aligned with the
// registered deploy and persistence authorities.
const grimnirRegistry = JSON.parse(
  readFileSync(join(repoRoot, "tests", "fixtures", "grimnir-munin-memory-registry.json"), "utf8"),
) as { name: string; deploy_path: string; persistent_paths: string[]; systemd_units: Array<{ name: string; type: string }> };

function activeLines(unit: string): string[] {
  return unit
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Every value assigned to a directive, in file order. */
function directiveValues(unit: string, key: string): string[] {
  return activeLines(unit)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1).trim());
}

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

  it("ships an install-ready unit that resolves under the registered Grimnir paths", () => {
    expect(existsSync(fleetUnitPath)).toBe(true);
    const fleetUnit = readFileSync(fleetUnitPath, "utf8");
    const persistentPath = grimnirRegistry.persistent_paths[0];
    expect(fleetUnit).not.toMatch(/^[^#;\n]*<[A-Za-z][A-Za-z0-9_-]*>/m);
    expect(grimnirRegistry).toMatchObject({
      name: "munin-memory",
      deploy_path: "/home/magnus/munin-memory",
      persistent_paths: ["/home/magnus/.munin-memory"],
      systemd_units: [{ name: "munin-memory", type: "service" }],
    });
    expect(fleetUnit).toContain("User=magnus");
    expect(fleetUnit).toContain(`WorkingDirectory=${grimnirRegistry.deploy_path}`);
    expect(fleetUnit).toContain(`Environment=MUNIN_MEMORY_DB_PATH=${persistentPath}/memory.db`);
    expect(fleetUnit).toContain(`EnvironmentFile=${grimnirRegistry.deploy_path}/.env`);
    expect(fleetUnit).toContain(`ReadWritePaths=${persistentPath}`);
    expect(fleetUnit).not.toContain("/srv/grimnir/");
    expect(fleetUnit).not.toContain("/home/grimnir/");
  });

  it("enforces the shared hardening directives on both the template and the fleet unit", () => {
    // The fleet unit is deployed to a bearer/OAuth service, so losing loopback
    // binding or any sandboxing directive is security-relevant. Assert the shared
    // set on BOTH units rather than trusting either one in isolation.
    const fleetUnit = readFileSync(fleetUnitPath, "utf8");
    const shared = [
      "Type=simple",
      "ExecStart=/usr/bin/node dist/index.js",
      "Restart=always",
      "RestartSec=5",
      "Environment=MUNIN_TRANSPORT=http",
      "Environment=MUNIN_HTTP_PORT=3030",
      "Environment=MUNIN_HTTP_HOST=127.0.0.1",
      "ProtectSystem=strict",
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "After=network.target",
      "WantedBy=multi-user.target",
    ];
    for (const directive of shared) {
      expect(activeLines(publicTemplate)).toContain(directive);
      expect(activeLines(fleetUnit)).toContain(directive);
    }

    // ProtectHome differs intentionally (the fleet unit has no home to read), but
    // it must remain enabled in some hardening form on both.
    expect(activeLines(publicTemplate).some((l) => /^ProtectHome=(true|read-only)$/.test(l))).toBe(true);
    expect(activeLines(fleetUnit).some((l) => /^ProtectHome=(true|read-only)$/.test(l))).toBe(true);

    // Exactly one write grant per unit — count-based, so an added ReadWritePaths
    // widening the sandbox fails instead of passing a substring check.
    expect(activeLines(publicTemplate).filter((l) => l.startsWith("ReadWritePaths="))).toHaveLength(1);
    expect(activeLines(fleetUnit).filter((l) => l.startsWith("ReadWritePaths="))).toHaveLength(1);
  });

  it("pins the effective value of every singleton hardening directive", () => {
    // A presence check is not enough: systemd takes the LAST assignment of a
    // scalar directive, so appending `NoNewPrivileges=false` leaves the required
    // `=true` line intact, adds no fleet/template set difference, and silently
    // disables the sandbox. Assert exactly one assignment with exactly the
    // expected value, which catches both deletion and override.
    const fleetUnit = readFileSync(fleetUnitPath, "utf8");
    const pinned: Record<string, string> = {
      Type: "simple",
      Restart: "always",
      RestartSec: "5",
      ExecStart: "/usr/bin/node dist/index.js",
      ProtectSystem: "strict",
      NoNewPrivileges: "true",
      PrivateTmp: "true",
    };

    for (const unit of [publicTemplate, fleetUnit]) {
      for (const [key, value] of Object.entries(pinned)) {
        expect(directiveValues(unit, key)).toEqual([value]);
      }
      // ProtectHome differs intentionally between the two, but must be enabled
      // exactly once in a hardening form.
      const protectHome = directiveValues(unit, "ProtectHome");
      expect(protectHome).toHaveLength(1);
      expect(["true", "read-only"]).toContain(protectHome[0]);

      // Environment is legitimately repeated, but a duplicated KEY would let a
      // later assignment silently override an earlier one.
      const envKeys = directiveValues(unit, "Environment").map((v) => v.split("=")[0]);
      expect(new Set(envKeys).size).toBe(envKeys.length);
      expect(directiveValues(unit, "Environment")).toContain("MUNIN_HTTP_HOST=127.0.0.1");
    }
  });

  it("allows only the declared fleet/template divergences", () => {
    // The install-ready fleet unit deliberately binds the registered `magnus`
    // service identity to Grimnir's current deploy and persistent paths. Any
    // divergence NOT listed here — including a silently dropped hardening
    // directive or either rejected legacy path — fails the contract.
    const fleetUnit = readFileSync(fleetUnitPath, "utf8");
    const fleetSet = new Set(activeLines(fleetUnit));
    const templateSet = new Set(activeLines(publicTemplate));

    const fleetOnly = [...fleetSet].filter((l) => !templateSet.has(l)).sort();
    const templateOnly = [...templateSet].filter((l) => !fleetSet.has(l)).sort();

    expect(fleetOnly).toEqual(
      [
        "User=magnus",
        "WorkingDirectory=/home/magnus/munin-memory",
        "Environment=MUNIN_MEMORY_DB_PATH=/home/magnus/.munin-memory/memory.db",
        "EnvironmentFile=/home/magnus/munin-memory/.env",
        "ReadWritePaths=/home/magnus/.munin-memory",
      ].sort(),
    );
    expect(templateOnly).toEqual(
      [
        "User=<user>",
        "WorkingDirectory=/home/<user>/<install-dir>",
        "EnvironmentFile=/home/<user>/<install-dir>/.env",
        "ReadWritePaths=/home/<user>/.munin-memory",
      ].sort(),
    );
  });

  it("documents no shell-expanded paths in the EnvironmentFile example", () => {
    // A systemd EnvironmentFile performs no expansion, so a documented
    // `${HOME}/...` or `~/...` assignment is passed through literally and breaks
    // the offsite preflight for anyone who copies it.
    const offsiteDoc = readFileSync(join(repoRoot, "docs", "offsite-backup.md"), "utf8");
    const offending = offsiteDoc
      .split("\n")
      .map((line) => line.replace(/^>\s?/, "").trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .filter((line) => /[$~]/.test(line));

    expect(offending).toEqual([]);
  });

  it("keeps the documented benchmark snapshot helper executable", () => {
    expect(statSync(snapshotScriptPath).mode & 0o111).not.toBe(0);
  });
});
