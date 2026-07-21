import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backupScript = join(repoRoot, "scripts", "backup-to-nas.sh");
const backupUnit = readFileSync(join(repoRoot, "munin-backup.service"), "utf8");

const scratchDirs: string[] = [];

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "munin-backup-safety-"));
  scratchDirs.push(dir);
  return dir;
}

function writeExecutable(path: string, body: string): string {
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

/**
 * Stub `sqlite3` so the snapshot/integrity steps succeed without a real
 * database. Keeps the destination-safety tests hermetic and independent of
 * whether the sqlite3 CLI is installed on the runner.
 */
function stubSqlite3(binDir: string): void {
  writeExecutable(
    join(binDir, "sqlite3"),
    `#!/bin/bash
if [[ "\$2" == .backup* ]]; then
  : > "\${2#.backup }"
  exit 0
fi
if [[ "\$2" == *integrity_check* ]]; then
  echo ok
  exit 0
fi
exit 0
`,
  );
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("backup destination safety", () => {
  it("fails closed before snapshotting when no destination is explicitly configured", () => {
    const env = { ...process.env, HOME: "/tmp/munin-backup-test-home" };
    delete env.MUNIN_BACKUP_DIR;

    const result = spawnSync("bash", [backupScript], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MUNIN_BACKUP_DIR is required");
  });

  it("fails closed when no mount root is explicitly configured", () => {
    const env = {
      ...process.env,
      HOME: "/tmp/munin-backup-test-home",
      MUNIN_BACKUP_DIR: "/tmp/munin-backup-test-mount/munin-memory",
    };
    delete env.MUNIN_BACKUP_MOUNT;

    const result = spawnSync("bash", [backupScript], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MUNIN_BACKUP_MOUNT is required");
  });

  it("fails before snapshotting when the configured mount is not active", () => {
    const env = {
      ...process.env,
      HOME: "/tmp/munin-backup-test-home",
      MUNIN_BACKUP_DIR: "/tmp/munin-memory",
      MUNIN_BACKUP_MOUNT: "/tmp",
      MUNIN_MOUNTPOINT_BIN: "false",
    };

    const result = spawnSync("bash", [backupScript], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not an active mountpoint");
  });

  it("rejects a destination outside the configured mount root", () => {
    const env = {
      ...process.env,
      HOME: "/tmp/munin-backup-test-home",
      MUNIN_BACKUP_DIR: "/var/tmp/munin-memory",
      MUNIN_BACKUP_MOUNT: "/tmp",
      MUNIN_MOUNTPOINT_BIN: "true",
    };

    const result = spawnSync("bash", [backupScript], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be inside MUNIN_BACKUP_MOUNT");
  });

  it("rejects the system root as a backup mount", () => {
    const env = {
      ...process.env,
      HOME: "/tmp/munin-backup-test-home",
      MUNIN_BACKUP_DIR: "/tmp/munin-memory",
      MUNIN_BACKUP_MOUNT: "/",
      MUNIN_MOUNTPOINT_BIN: "true",
    };

    const result = spawnSync("bash", [backupScript], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MUNIN_BACKUP_MOUNT must not be /");
  });

  it("requires the destination to be a strict child of the mount root", () => {
    const env = {
      ...process.env,
      HOME: "/tmp/munin-backup-test-home",
      MUNIN_BACKUP_DIR: "/tmp",
      MUNIN_BACKUP_MOUNT: "/tmp",
      MUNIN_MOUNTPOINT_BIN: "true",
    };

    const result = spawnSync("bash", [backupScript], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be a child of MUNIN_BACKUP_MOUNT");
  });

  it("loads the ops environment file where the explicit destination is configured", () => {
    expect(backupUnit).toContain("EnvironmentFile=-<ops-dir>/.env");
  });

  it("aborts when the mount disappears between the preflight check and the write", () => {
    // Regression: the mount was validated once, before a potentially slow SQLite
    // snapshot. If a removable/NAS mount dropped during the snapshot, `mkdir -p`
    // silently recreated the destination on the root filesystem and the backup
    // "succeeded" locally — the exact fallback README.md says cannot happen.
    const scratch = makeScratch();
    const mount = join(scratch, "mount");
    const dest = join(mount, "munin-memory");
    const binDir = join(scratch, "bin");
    mkdirSync(mount, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    stubSqlite3(binDir);

    // Succeeds on the first call (preflight), fails on every later call.
    const stateFile = join(scratch, "mount-calls");
    const mountpointBin = writeExecutable(
      join(binDir, "mountpoint-flaky"),
      `#!/bin/bash
n=\$(cat "${stateFile}" 2>/dev/null || echo 0)
n=\$((n + 1))
echo "\$n" > "${stateFile}"
[ "\$n" -le 1 ] && exit 0
exit 1
`,
    );

    const result = spawnSync("bash", [backupScript], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: scratch,
        MUNIN_BACKUP_DB: join(scratch, "memory.db"),
        MUNIN_BACKUP_DIR: dest,
        MUNIN_BACKUP_MOUNT: mount,
        MUNIN_MOUNTPOINT_BIN: mountpointBin,
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer an active mountpoint");
    // The critical assertion: nothing was written to the unmounted path.
    expect(existsSync(dest)).toBe(false);
  });

  it("removes the snapshot when it did not land on the mounted filesystem", () => {
    // The final path-based check cannot be made atomic in shell, so a narrow race
    // survives between the last check and `install`. Post-write verification must
    // turn a wrong-location write into a loud failure rather than a silently
    // successful backup left on the root filesystem.
    const scratch = makeScratch();
    const mount = join(scratch, "mount");
    const dest = join(mount, "munin-memory");
    const binDir = join(scratch, "bin");
    mkdirSync(dest, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    stubSqlite3(binDir);

    // Passes every pre-write check, fails only the post-write revalidation.
    const stateFile = join(scratch, "mount-calls");
    const mountpointBin = writeExecutable(
      join(binDir, "mountpoint-late-fail"),
      `#!/bin/bash
n=\$(cat "${stateFile}" 2>/dev/null || echo 0)
n=\$((n + 1))
echo "\$n" > "${stateFile}"
[ "\$n" -le 3 ] && exit 0
exit 1
`,
    );

    const result = spawnSync("bash", [backupScript], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: scratch,
        MUNIN_BACKUP_DB: join(scratch, "memory.db"),
        MUNIN_BACKUP_DIR: dest,
        MUNIN_BACKUP_MOUNT: mount,
        MUNIN_MOUNTPOINT_BIN: mountpointBin,
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not land on the mounted filesystem");
    // The stray snapshot must not be left behind.
    expect(spawnSync("ls", [dest], { encoding: "utf8" }).stdout.trim()).toBe("");
  });

  it("rejects a destination reached through a symlinked path component", () => {
    // Regression: containment was purely lexical, so a symlink inside the mount
    // resolved outside it and both mkdir and install followed it — writing the
    // plaintext database off the mounted volume while reporting success.
    const scratch = makeScratch();
    const mount = join(scratch, "mount");
    const outside = join(scratch, "outside");
    const binDir = join(scratch, "bin");
    mkdirSync(mount, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    stubSqlite3(binDir);
    symlinkSync(outside, join(mount, "escape"));

    const result = spawnSync("bash", [backupScript], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: scratch,
        MUNIN_BACKUP_DB: join(scratch, "memory.db"),
        MUNIN_BACKUP_DIR: join(mount, "escape"),
        MUNIN_BACKUP_MOUNT: mount,
        MUNIN_MOUNTPOINT_BIN: "true",
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symlink");
    // Nothing may be written through the escaping link.
    expect(existsSync(join(outside, "memory.db"))).toBe(false);
    expect(spawnSync("ls", [outside], { encoding: "utf8" }).stdout.trim()).toBe("");
  });
});
