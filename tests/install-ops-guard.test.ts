/**
 * install-ops.sh must never silently swap a host's backup destination model.
 *
 * backup-to-nas.sh exists in two incompatible forms — push to a remote host over
 * ssh/rsync, or write to a local mounted volume — and a host is provisioned for
 * exactly one. Installing the other does not fail at install time; it fails on
 * the next timer fire, silently, and surfaces days later as a missing off-host
 * copy of the memory database.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const installOps = join(repoRoot, "scripts", "install-ops.sh");

const scratch: string[] = [];
function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "munin-ops-guard-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length > 0) {
    const d = scratch.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const REMOTE_SCRIPT = `#!/bin/bash\nNAS_HOST="203.0.113.10"\nNAS_DIR="/srv/backups"\nrsync -a "$1" "magnus@\${NAS_HOST}:\${NAS_DIR}/"\n`;
const LOCAL_SCRIPT = `#!/bin/bash\nBACKUP_MOUNT="\${MUNIN_BACKUP_MOUNT:-}"\ninstall -m 600 "$1" "\$BACKUP_MOUNT/x"\n`;

/** Stage an ops dir with a deployed backup script of the given model. */
function stageOpsDir(body: string): string {
  const opsDir = join(makeScratch(), "munin-ops");
  mkdirSync(join(opsDir, "scripts"), { recursive: true });
  const p = join(opsDir, "scripts", "backup-to-nas.sh");
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return opsDir;
}

function runInstall(opsDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [installOps], {
    env: { ...process.env, MUNIN_OPS_DIR: opsDir, ...extraEnv },
    encoding: "utf8",
  });
}

describe("install-ops.sh backup destination-model guard", () => {
  it("refuses to replace a remote-model deployment with the local-mount model", () => {
    // The exact production situation: huginmunin runs the remote model, while
    // the repo's script had been switched to local-mount. A reinstall would have
    // left the nightly backup exiting 64 every night.
    const opsDir = stageOpsDir(REMOTE_SCRIPT);
    const result = runInstall(opsDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to change this host's backup destination model");
    expect(result.stderr).toMatch(/deployed:\s+remote/);
    expect(result.stderr).toContain("MUNIN_OPS_ALLOW_MODEL_CHANGE=true");
  });

  it("aborts before touching sudo or the deployed script", () => {
    const opsDir = stageOpsDir(REMOTE_SCRIPT);
    const result = runInstall(opsDir);

    // The guard must run in the scripts loop, ahead of the units loop — otherwise
    // it would prompt for sudo before refusing.
    expect(result.stdout).not.toContain("Installing systemd units");
    expect(result.stderr).toContain("the deployed backup is untouched");
    // The deployed script must still be the remote-model one.
    const deployed = spawnSync("cat", [join(opsDir, "scripts", "backup-to-nas.sh")], {
      encoding: "utf8",
    }).stdout;
    expect(deployed).toContain("NAS_HOST=");
  });

  it("names both models and what each requires, so the error is actionable", () => {
    const result = runInstall(stageOpsDir(REMOTE_SCRIPT));

    expect(result.stderr).toContain("MUNIN_BACKUP_MOUNT");
    expect(result.stderr).toContain("NAS_HOST");
  });

  it("does not fire when the deployed script already uses the incoming model", () => {
    // Same model on both sides must not trip the guard. Asserted by the absence
    // of the refusal, not by a successful install — the install proceeds into
    // sudo territory, which this test deliberately does not reach.
    const result = runInstall(stageOpsDir(LOCAL_SCRIPT));

    expect(result.stderr).not.toContain("refusing to change");
  });
});
