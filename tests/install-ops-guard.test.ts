/**
 * install-ops.sh must never leave a host with a backup that cannot run.
 *
 * backup-to-nas.sh has existed in three shapes: push to a remote host over
 * ssh/rsync, write to a local mounted volume, and (now) a dual-mode script that
 * does either based on the ops .env. Installing a shape the host is not
 * configured for does not fail at install time — it fails on the next timer
 * fire, silently, and surfaces days later as a missing off-host copy of the
 * memory database.
 *
 * Tests run install-ops.sh out of a SYNTHETIC repo directory so every incoming
 * shape stays reachable, independent of which one the real repo currently ships.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realInstallOps = join(repoRoot, "scripts", "install-ops.sh");

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

const REMOTE = `#!/bin/bash\nNAS_HOST="203.0.113.10"\nrsync -a "$1" "u@\${NAS_HOST}:/srv/b/"\n`;
const LOCAL = `#!/bin/bash\nBACKUP_MOUNT="\${MUNIN_BACKUP_MOUNT:-}"\ninstall -m 600 "$1" "\$BACKUP_MOUNT/x"\n`;
const DUAL = `#!/bin/bash\nMODE="\${MUNIN_BACKUP_MODE:-}"\nBACKUP_MOUNT="\${MUNIN_BACKUP_MOUNT:-}"\n`;

/** A synthetic repo whose backup script has the given shape. */
function makeRepo(backupBody: string): string {
  const repo = join(makeScratch(), "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(realInstallOps, join(repo, "scripts", "install-ops.sh"));
  chmodSync(join(repo, "scripts", "install-ops.sh"), 0o755);
  for (const [name, body] of [
    ["backup-to-nas.sh", backupBody],
    ["offsite-backup.sh", "#!/bin/bash\n"],
    ["offsite-snapshot.sh", "#!/bin/bash\n"],
  ] as const) {
    writeFileSync(join(repo, "scripts", name), body);
    chmodSync(join(repo, "scripts", name), 0o755);
  }
  return repo;
}

/** An ops dir with a deployed backup script, and optionally a configured .env. */
function makeOpsDir(deployedBody: string, envBody?: string): string {
  const opsDir = join(makeScratch(), "munin-ops");
  mkdirSync(join(opsDir, "scripts"), { recursive: true });
  const p = join(opsDir, "scripts", "backup-to-nas.sh");
  writeFileSync(p, deployedBody);
  chmodSync(p, 0o755);
  if (envBody !== undefined) writeFileSync(join(opsDir, ".env"), envBody);
  return opsDir;
}

function run(repo: string, opsDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [join(repo, "scripts", "install-ops.sh")], {
    env: { ...process.env, MUNIN_OPS_DIR: opsDir, ...extraEnv },
    encoding: "utf8",
  });
}

describe("install-ops.sh backup destination guard", () => {
  it("refuses to swap a remote deployment for a local-mount script", () => {
    // The original production hazard: the repo's script was local-mount while
    // the deployed host ran remote and had no mounted volume at all.
    const r = run(makeRepo(LOCAL), makeOpsDir(REMOTE));

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to change this host's backup destination model");
    expect(r.stderr).toMatch(/deployed:\s+remote/);
    expect(r.stderr).toContain("MUNIN_BACKUP_MOUNT");
    expect(r.stderr).toContain("NAS_HOST");
  });

  it("refuses the dual-mode upgrade when the ops .env names no destination", () => {
    // The dual script reads its destination from the .env. A host whose
    // destination was compiled into the old script has nothing configured, so
    // installing dual would leave it refusing to start every night.
    const r = run(makeRepo(DUAL), makeOpsDir(REMOTE, "MUNIN_LLM_BASE_URL=https://example.invalid\n"));

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not configured for the dual-mode backup script");
    expect(r.stderr).toContain("MUNIN_BACKUP_HOST=");
    expect(r.stderr).toContain("MUNIN_BACKUP_MOUNT=");
  });

  it("allows the dual-mode upgrade once the ops .env names a destination", () => {
    const r = run(
      makeRepo(DUAL),
      makeOpsDir(REMOTE, "MUNIN_BACKUP_MODE=remote\nMUNIN_BACKUP_HOST=u@h\nMUNIN_BACKUP_REMOTE_DIR=/srv/b\n"),
    );

    expect(r.stderr).not.toContain("not configured for the dual-mode");
    expect(r.stderr).not.toContain("refusing to change");
    expect(r.stdout).toContain("remote -> dual");
  });

  it("aborts before sudo and leaves the deployed script untouched", () => {
    const opsDir = makeOpsDir(REMOTE);
    const r = run(makeRepo(LOCAL), opsDir);

    // The guard lives in the scripts loop, ahead of the units loop — otherwise
    // it would prompt for sudo before refusing.
    expect(r.stdout).not.toContain("Installing systemd units");
    expect(r.stderr).toContain("the deployed backup is untouched");
    const deployed = spawnSync("cat", [join(opsDir, "scripts", "backup-to-nas.sh")], {
      encoding: "utf8",
    }).stdout;
    expect(deployed).toContain("NAS_HOST=");
  });

  it("does not fire when deployed and incoming already match", () => {
    const r = run(makeRepo(LOCAL), makeOpsDir(LOCAL));
    expect(r.stderr).not.toContain("refusing to change");
    expect(r.stderr).not.toContain("not configured for the dual-mode");
  });

  it("does not fire on a first install where nothing is deployed yet", () => {
    const opsDir = join(makeScratch(), "munin-ops");
    const r = run(makeRepo(DUAL), opsDir);
    expect(r.stderr).not.toContain("refusing to change");
    expect(r.stderr).not.toContain("not configured for the dual-mode");
  });
});
