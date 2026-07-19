import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const backupScript = join(repoRoot, "scripts", "backup-to-nas.sh");
const backupUnit = readFileSync(join(repoRoot, "munin-backup.service"), "utf8");

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
});
