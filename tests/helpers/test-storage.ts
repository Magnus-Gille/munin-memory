import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Allocate a private temporary directory for one test module or fixture.
 *
 * A module-level directory is unique across processes, so independent Vitest
 * workers cannot open or remove one another's SQLite files. Call cleanup after
 * all handles in the fixture have been closed.
 */
export function createTestDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `munin-${prefix}-`));
}

export function createTestStorage(prefix: string, filename = "memory.db"): {
  dir: string;
  path: string;
  cleanup: () => void;
} {
  const dir = createTestDir(prefix);
  return { dir, path: join(dir, filename), cleanup: () => removeTestDir(dir) };
}

export function removeTestDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
