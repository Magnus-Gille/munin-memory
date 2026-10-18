import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extractedPushPanel(scriptName: "offsite-backup.sh" | "offsite-snapshot.sh") {
  const source = readFileSync(path.join(ROOT, "scripts", scriptName), "utf8");
  const lines = source.split(/\r?\n/);
  const functionStart = lines.findIndex((line) => line === "push_panel() {");
  expect(functionStart, `${scriptName} push_panel function`).toBeGreaterThanOrEqual(0);
  const functionEnd = lines.findIndex((line, index) => index > functionStart && line === "}");
  expect(functionEnd, `${scriptName} push_panel closing brace`).toBeGreaterThan(functionStart);
  const assignments = lines.filter((line) => /^SERVICE="\$\{MIMIR_OFFSITE_SERVICE:-/.test(line)
    || /^PANEL="\$\{MIMIR_OFFSITE_PANEL:-/.test(line));
  expect(assignments).toHaveLength(2);
  return `${assignments.join("\n")}\n${lines.slice(functionStart, functionEnd + 1).join("\n")}`;
}

function invokePushPanel(
  scriptName: "offsite-backup.sh" | "offsite-snapshot.sh",
  options: { url?: string; token?: string; curlExit?: number; service?: string; panel?: string; message?: string } = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "munin-panel-transport-"));
  temporaryDirectories.push(directory);
  const stubDir = path.join(directory, "bin");
  const home = path.join(directory, "home");
  const argsPath = path.join(directory, "curl-argv.bin");
  const headerPath = path.join(directory, "curl-stdin.txt");
  mkdirSync(stubDir);
  mkdirSync(home);
  const curlStub = path.join(stubDir, "curl");
  writeFileSync(curlStub, `#!/bin/bash
printf '%s\\0' "$@" > "$CURL_ARGS_FILE"
: > "$CURL_STDIN_FILE"
while IFS= read -r line || [[ -n "$line" ]]; do printf '%s\\n' "$line" >> "$CURL_STDIN_FILE"; done
exit "\${CURL_EXIT:-0}"
`);
  chmodSync(curlStub, 0o700);

  const env: NodeJS.ProcessEnv = {
    PATH: stubDir,
    HOME: home,
    TMPDIR: directory,
    CURL_ARGS_FILE: argsPath,
    CURL_STDIN_FILE: headerPath,
  };
  if (options.url !== undefined) env.HEIMDALL_HUB_URL = options.url;
  if (options.token !== undefined) env.HEIMDALL_FLEET_TOKEN = options.token;
  if (options.curlExit !== undefined) env.CURL_EXIT = String(options.curlExit);
  if (options.service !== undefined) env.MIMIR_OFFSITE_SERVICE = options.service;
  if (options.panel !== undefined) env.MIMIR_OFFSITE_PANEL = options.panel;
  env.PANEL_MESSAGE = options.message ?? "synthetic backup failed";

  const invocation = spawnSync("/bin/bash", ["--noprofile", "--norc"], {
    cwd: ROOT,
    env,
    input: `set -euo pipefail\n${extractedPushPanel(scriptName)}\npush_panel fail "$PANEL_MESSAGE"\n`,
    encoding: "utf8",
  });
  const args = existsSync(argsPath)
    ? readFileSync(argsPath).toString("utf8").split("\0").filter(Boolean)
    : null;
  const stdin = existsSync(headerPath) ? readFileSync(headerPath, "utf8") : null;
  return { invocation, args, stdin };
}

const scripts = ["offsite-backup.sh", "offsite-snapshot.sh"] as const;
const sentinel = "synthetic-sentinel/A+B=2026";

describe.each(scripts)("%s Heimdall panel transport", (scriptName) => {
  it("keeps the bearer out of curl argv and preserves header and default payload", () => {
    const result = invokePushPanel(scriptName, { url: "https://heimdall.invalid/api/panels", token: sentinel });
    expect(result.invocation.status).toBe(0);
    expect(result.args).not.toBeNull();
    expect(result.args?.join(" ")).not.toContain(sentinel);
    expect(result.args).toContain("https://heimdall.invalid/api/panels");
    expect(result.args).toContain("-fsS");
    expect(result.args?.[result.args.indexOf("--max-time") + 1]).toBe("5");
    expect(result.args).toContain("POST");
    const headerArgs = result.args ?? [];
    const headerIndex = headerArgs.indexOf("-H");
    expect(headerArgs.slice(headerIndex, headerIndex + 2)).toEqual(["-H", "@-"]);
    expect(result.stdin).toBe(`Authorization: Bearer ${sentinel}\n`);
    expect(result.args).toContain('{"service":"munin","panel":"offsite","kind":"status","label":"Offsite backup","state":"fail","message":"synthetic backup failed"}');
  });

  it("preserves configured service and panel overrides", () => {
    const result = invokePushPanel(scriptName, {
      url: "https://heimdall.invalid/api/panels", token: sentinel,
      service: "munin-staging", panel: "offsite-check",
    });
    expect(result.invocation.status).toBe(0);
    expect(result.args).toContain('{"service":"munin-staging","panel":"offsite-check","kind":"status","label":"Offsite backup","state":"fail","message":"synthetic backup failed"}');
  });

  it.each(["url", "token"] as const)("is a no-op when the %s input is missing", (missing) => {
    const options: { url?: string; token?: string } = {
      url: "https://heimdall.invalid/api/panels", token: sentinel,
    };
    delete options[missing];
    const result = invokePushPanel(scriptName, options);
    expect(result.invocation.status).toBe(0);
    expect(result.args).toBeNull();
  });

  it.each(["\r", "\n"])("rejects a token containing %j without invoking curl or displaying it", (separator) => {
    const token = `synthetic-secret-prefix${separator}synthetic-secret-suffix`;
    const result = invokePushPanel(scriptName, { url: "https://heimdall.invalid/api/panels", token });
    expect(result.invocation.status).toBe(0);
    expect(result.args).toBeNull();
    expect(`${result.invocation.stdout}${result.invocation.stderr}`).not.toContain("synthetic-secret-prefix");
    expect(`${result.invocation.stdout}${result.invocation.stderr}`).not.toContain("synthetic-secret-suffix");
  });

  it("keeps curl failure best-effort", () => {
    const result = invokePushPanel(scriptName, {
      url: "https://heimdall.invalid/api/panels", token: sentinel, curlExit: 22,
    });
    expect(result.invocation.status).toBe(0);
    expect(result.args).not.toBeNull();
    expect(result.args?.join(" ")).not.toContain(sentinel);
  });
});
