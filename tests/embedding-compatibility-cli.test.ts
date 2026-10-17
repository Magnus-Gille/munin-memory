import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const VALID_REVISION = "0123456789abcdef0123456789abcdef01234567";
const MODEL = "synthetic/fixture-model";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "munin-embedding-preview-"));
  directories.push(directory);
  return directory;
}

function makeLegacyDatabase(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding_status TEXT NOT NULL,
      embedding_model TEXT,
      is_current INTEGER NOT NULL
    );
    INSERT INTO entries VALUES
      ('legacy-generated', 'synthetic legacy content', 'generated', '${MODEL}', 1),
      ('legacy-pending', 'synthetic pending content', 'pending', NULL, 1);`);
  } finally {
    db.close();
  }
}

function invokePreview(databasePath: string, revision: string | undefined) {
  const script = `
    import { previewDatabase } from ${JSON.stringify(new URL("../scripts/embedding-compatibility.ts", import.meta.url).href)};
    try { console.log(JSON.stringify({ result: previewDatabase(process.argv[1]) })); }
    catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
  `;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    MUNIN_EMBEDDINGS_ENABLED: "true",
    MUNIN_EMBEDDINGS_MODEL: MODEL,
  };
  if (revision !== undefined) env.MUNIN_EMBEDDINGS_REVISION = revision;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, databasePath], {
    cwd: resolve("."),
    encoding: "utf8",
    env,
  });
  const output = result.stdout.trim().split("\n").at(-1) ?? "";
  return { ...result, parsed: output ? JSON.parse(output) as Record<string, unknown> : null };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("embedding compatibility preview CLI", () => {
  it("reports legacy generated vectors as incompatible without changing the database", () => {
    const path = join(fixtureDirectory(), "legacy.sqlite");
    makeLegacyDatabase(path);
    const before = sha256(path);

    const child = invokePreview(path, VALID_REVISION);

    expect(child.status).toBe(0);
    expect(child.parsed).toMatchObject({
      result: {
        mode: "read_only_preview",
        identity: { model: MODEL, revision: VALID_REVISION },
        counts: {
          generated: 1,
          generated_current: 0,
          generated_null: 1,
          reembedding_backlog: 2,
          total: 2,
        },
      },
    });
    expect(sha256(path)).toBe(before);
    expect(existsSync(join(dirname(path), "hf-cache"))).toBe(false);
  });

  it("fails closed when the active embedding identity is missing", () => {
    const path = join(fixtureDirectory(), "legacy.sqlite");
    makeLegacyDatabase(path);
    const before = sha256(path);

    const child = invokePreview(path, undefined);

    expect(child.status).toBe(1);
    expect(child.parsed).toMatchObject({ error: expect.stringContaining("Embedding identity is unavailable") });
    expect(sha256(path)).toBe(before);
  });

  it("does not create a database when the requested path does not exist", () => {
    const path = join(fixtureDirectory(), "must-not-be-created.sqlite");

    const child = invokePreview(path, VALID_REVISION);

    expect(child.status).toBe(1);
    expect(child.parsed).toMatchObject({ error: expect.any(String) });
    expect(() => readFileSync(path)).toThrow();
  });
});
