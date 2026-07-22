import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatFirstSuccessLines, parseQuickstartArgs, runQuickstartCli, type QuickstartCliIo } from "../src/quickstart-cli.js";

const tempRoots: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeRoot(): { root: string; project: string; data: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "munin-quickstart-cli-test-"));
  tempRoots.push(root);
  const project = join(root, "project");
  mkdirSync(join(project, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(project, "package.json"), '{"name":"munin-memory"}\n');
  writeFileSync(join(project, "dist/index.js"), "// built\n");
  return { root, project, data: join(root, "data"), config: join(root, "config") };
}

function captureIo(): { io: QuickstartCliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: { log: (message) => output.push(message), error: (message) => errors.push(message) },
    output,
    errors,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("quickstart CLI", () => {
  it("parses supported options and environment without exposing credentials", () => {
    const paths = makeRoot();
    const options = parseQuickstartArgs(
      [
        "--project-root", paths.project,
        "--data-dir", paths.data,
        "--config-dir", paths.config,
        "--transport", "http",
        "--server-url", "https://munin.example/mcp",
        "--profile", "full-node",
        "--json",
      ],
      {
        MUNIN_API_KEY: "sensitive-owner-key",
        MUNIN_HTTP_HOST: "0.0.0.0",
        MUNIN_HTTP_PORT: "4040",
        MUNIN_QUICKSTART_INSTALL_MS: "900",
      },
    );

    expect(options.transport).toBe("http");
    expect(options.profile).toBe("full-node");
    expect(options.embeddings).toBe(false);
    expect(options.apiKeyPresent).toBe(true);
    expect(options.port).toBe(4040);
    expect(options.host).toBe("0.0.0.0");
    expect(options.installDurationMs).toBe(900);
    expect(options.sensitiveValues).toEqual(["sensitive-owner-key"]);
  });

  it("uses the default HTTP port when the environment value is empty", () => {
    const options = parseQuickstartArgs([], { MUNIN_HTTP_PORT: "  " });
    expect(options.port).toBe(3030);
    expect(options.host).toBe("127.0.0.1");
  });

  it("formats failed first-success steps for human-readable output", () => {
    const lines = formatFirstSuccessLines({
      ok: false,
      transport: "stdio",
      namespace: "onboarding/quickstart",
      entryId: "",
      coldStartMs: 10,
      durationMs: 20,
      steps: [
        { id: "orient", ok: true, message: "orient worked" },
        { id: "status", ok: false, message: "health failed" },
      ],
    });
    expect(lines.join("\n")).toContain("First-success flow: FAIL");
    expect(lines.join("\n")).toContain("✗ status: health failed");
  });

  it("prints help successfully", async () => {
    const captured = captureIo();
    expect(await runQuickstartCli(["--help"], {}, captured.io)).toBe(0);
    expect(captured.output.join("\n")).toContain("five-minute quick start");
    expect(captured.errors).toEqual([]);
  });

  it("runs JSON preflight and a complete human-readable first success", async () => {
    const paths = makeRoot();
    const preflight = captureIo();
    const common = [
      "--project-root", repoRoot,
      "--data-dir", paths.data,
      "--config-dir", paths.config,
    ];
    expect(await runQuickstartCli([...common, "--preflight-only", "--json"], {}, preflight.io)).toBe(0);
    expect(JSON.parse(preflight.output[0]) as { ok: boolean }).toMatchObject({ ok: true });

    const run = captureIo();
    expect(await runQuickstartCli(common, {}, run.io)).toBe(0);
    expect(run.output.join("\n")).toContain("First-success flow: PASS");
    expect(run.output.join("\n")).toContain("memory_orient");
  });

  it("returns a secret-safe actionable error for invalid input", async () => {
    const secret = "sensitive-owner-key";
    const captured = captureIo();
    expect(await runQuickstartCli([`--${secret}`], { MUNIN_API_KEY: secret }, captured.io)).toBe(1);
    expect(captured.errors[0]).toContain("[REDACTED]");
    expect(captured.errors[0]).not.toContain(secret);

    const transport = captureIo();
    expect(await runQuickstartCli(["--transport", "tcp"], {}, transport.io)).toBe(1);
    expect(transport.errors[0]).toContain("stdio or http");
  });
});
