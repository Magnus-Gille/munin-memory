import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/admin-cli.js";

// MUNIN-440: --token-stdout prints only the secret on stdout (piped), never on stderr.
let dir: string;
let db: string;
const RULES = '[{"pattern":"tasks/*","permissions":"rw"}]';

function admin(args: string[]) {
  return spawnSync(
    "npx",
    ["tsx", "src/admin-cli.ts", "--db", db, ...args],
    { encoding: "utf8", env: { ...process.env, MUNIN_ENCRYPTION_KEY: "" } },
  );
}

describe("munin-admin --token-stdout", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "munin-admin-tok-"));
    db = join(dir, "t.db");
    expect(admin(["--init", "principals", "list"]).status).toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parseArgs recognises the flag", () => {
    expect(parseArgs(["node", "x", "--token-stdout"]).tokenStdout).toBe(true);
    expect(parseArgs(["node", "x"]).tokenStdout).toBe(false);
  });

  it("add: stdout is exactly one token line, stderr never contains it", () => {
    const r = admin(["principals", "add", "p1", "--type", "agent", "--rules", RULES, "--token-stdout"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^[^\s]+\n$/);
    expect(r.stderr).not.toContain(r.stdout.trim());
    expect(r.stderr).toContain("Created principal: p1");
  });

  it("rotate-token: same contract and the new token differs", () => {
    const first = admin(["principals", "rotate-token", "p1", "--token-stdout"]);
    const second = admin(["principals", "rotate-token", "p1", "--token-stdout"]);
    expect(first.status).toBe(0);
    expect(second.stdout).toMatch(/^[^\s]+\n$/);
    expect(second.stdout).not.toBe(first.stdout);
    expect(second.stderr).not.toContain(second.stdout.trim());
  });

  it("bearer rotate: same contract", () => {
    const r = admin(["bearer", "rotate", "--grace-hours", "1", "--token-stdout"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^[^\s]+\n$/);
    expect(r.stderr).not.toContain(r.stdout.trim());
  });

  it("refuses --json and does not mutate", () => {
    const before = admin(["principals", "show", "p1", "--json"]).stdout;
    const r = admin(["principals", "rotate-token", "p1", "--json", "--token-stdout"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("--token-stdout cannot be combined");
    expect(admin(["principals", "show", "p1", "--json"]).stdout).toBe(before);
  });
});
