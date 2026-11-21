import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openSync, closeSync, readSync } from "node:fs";
import {
  parseArgs,
  assertTokenStdoutSafe,
  writeTokenOnly,
  TokenNotDeliveredError,
} from "../src/admin-cli.js";

// MUNIN-440: --token-stdout prints only the secret on stdout (piped), never on stderr.
let dir: string;
let db: string;
function auditCount(): number {
  const d = new Database(db, { readonly: true });
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  } finally {
    d.close();
  }
}

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
    expect(r.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(r.stderr).not.toContain(r.stdout.trim());
    expect(r.stderr).toContain("Created principal: p1");
  });

  it("rotate-token: same contract and the new token differs", () => {
    const first = admin(["principals", "rotate-token", "p1", "--token-stdout"]);
    const second = admin(["principals", "rotate-token", "p1", "--token-stdout"]);
    expect(first.status).toBe(0);
    expect(second.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(second.stdout).not.toBe(first.stdout);
    expect(second.stderr).not.toContain(second.stdout.trim());
  });

  it("bearer rotate: same contract", () => {
    const r = admin(["bearer", "rotate", "--grace-hours", "1", "--token-stdout"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(r.stderr).not.toContain(r.stdout.trim());
  });

  it("refuses --json: nothing on stdout, error on stderr, no mutation", () => {
    const before = auditCount();
    const r = admin(["principals", "rotate-token", "p1", "--json", "--token-stdout"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--token-stdout cannot be combined");
    expect(auditCount()).toBe(before);
  });

  it("add with a non-agent type is rejected before any mutation", () => {
    const before = auditCount();
    const r = admin(["principals", "add", "fam1", "--type", "family", "--rules", RULES, "--token-stdout"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("requires --type agent");
    expect(auditCount()).toBe(before);
    expect(admin(["principals", "show", "fam1"]).status).not.toBe(0);
  });

  it("is rejected on unrelated commands", () => {
    const r = admin(["principals", "list", "--token-stdout"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("only valid with");
  });

  it("not-found rotate emits nothing on stdout", () => {
    const r = admin(["principals", "rotate-token", "nope", "--token-stdout"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("bearer rotate keeps the grace-window info on stderr", () => {
    const r = admin(["bearer", "rotate", "--grace-hours", "1", "--token-stdout"]);
    expect(r.stderr).toMatch(/retiring key/);
  });

  it("assertTokenStdoutSafe rejects a TTY, --json and non-agent types", () => {
    const original = process.stdout.isTTY;
    try {
      process.stdout.isTTY = true;
      expect(() => assertTokenStdoutSafe(false)).toThrow(/terminal/);
      process.stdout.isTTY = false;
      expect(() => assertTokenStdoutSafe(true)).toThrow(/--json/);
      expect(() => assertTokenStdoutSafe(false, "owner")).toThrow(/agent/);
      expect(() => assertTokenStdoutSafe(false, "agent")).not.toThrow();
    } finally {
      process.stdout.isTTY = original;
    }
  });

  it("writeTokenOnly writes token+newline to the fd, and reports failure with exit code 3", () => {
    const file = join(dir, "sink");
    const fd = openSync(file, "w+");
    try {
      writeTokenOnly("tok", "recover", fd);
      const buf = Buffer.alloc(16);
      const n = readSync(fd, buf, 0, 16, 0); // same descriptor: no path re-check
      expect(buf.subarray(0, n).toString("utf8")).toBe("tok\n");
    } finally {
      closeSync(fd);
    }

    const prior = process.exitCode;
    try {
      expect(() => writeTokenOnly("tok", "recover", 9999)).toThrow(TokenNotDeliveredError);
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = prior;
    }
  });
});
