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

  it("allows only the declared fleet/template divergences", () => {
    // Replaces the old exact line-equality check, which the intentional
    // /srv/grimnir relocation broke. Any divergence NOT listed here — including a
    // silently dropped hardening directive — fails the contract.
    const fleetUnit = readFileSync(fleetUnitPath, "utf8");
    const fleetSet = new Set(activeLines(fleetUnit));
    const templateSet = new Set(activeLines(publicTemplate));

    const fleetOnly = [...fleetSet].filter((l) => !templateSet.has(l)).sort();
    const templateOnly = [...templateSet].filter((l) => !fleetSet.has(l)).sort();

    expect(fleetOnly).toEqual(
      [
        "User=grimnir",
        "WorkingDirectory=/srv/grimnir/munin-memory",
        "Environment=MUNIN_MEMORY_DB_PATH=/var/lib/grimnir/munin-memory/memory.db",
        "EnvironmentFile=/srv/grimnir/munin-memory/.env",
        "ProtectHome=true",
        "ReadWritePaths=/var/lib/grimnir/munin-memory",
      ].sort(),
    );
    expect(templateOnly).toEqual(
      [
        "User=<user>",
        "WorkingDirectory=/home/<user>/<install-dir>",
        "EnvironmentFile=/home/<user>/<install-dir>/.env",
        "ProtectHome=read-only",
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
