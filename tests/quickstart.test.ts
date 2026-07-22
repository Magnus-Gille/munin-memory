import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateClientConfigurations,
  redactSensitiveText,
  runFirstSuccess,
  runPreflight,
  runQuickstart,
  validateGeneratedClientConfigurations,
} from "../src/quickstart.js";

const tempRoots: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "munin-quickstart-test-"));
  tempRoots.push(root);
  return root;
}

function makeProjectRoot(root: string): string {
  const projectRoot = join(root, "project");
  const distDir = join(projectRoot, "dist");
  mkdirSync(distDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectRoot, "package.json"), '{"name":"munin-memory"}\n');
  writeFileSync(join(distDir, "index.js"), "// built server\n");
  return projectRoot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("quickstart client configuration", () => {
  it("generates schema-checked local and HTTP examples with placeholders only", () => {
    const root = makeTempRoot();
    const projectRoot = repoRoot;
    const dataDir = join(root, "data");
    const configs = generateClientConfigurations({
      projectRoot,
      dataDir,
      serverUrl: "https://munin.example.test/mcp",
    });

    expect(validateGeneratedClientConfigurations(configs)).toEqual([]);
    expect(configs.codexToml).toContain("[mcp_servers.munin-memory]");
    expect(configs.codexToml).toContain(join(projectRoot, "dist/index.js"));
    expect(configs.claudeCodeCommand).toContain("claude mcp add-json");

    const desktop = JSON.parse(configs.claudeDesktopJson) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(isAbsolute(desktop.mcpServers["munin-memory"].command)).toBe(true);
    expect(desktop.mcpServers["munin-memory"].env.MUNIN_EMBEDDINGS_ENABLED).toBe("false");

    const http = JSON.parse(configs.streamableHttpJson) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(http.url).toBe("https://munin.example.test/mcp");
    expect(http.headers.Authorization).toBe("Bearer <MUNIN_API_KEY>");

    const combined = Object.values(configs).join("\n");
    expect(combined).not.toContain("real-sensitive-token");
    expect(combined).not.toMatch(/Bearer (?!<MUNIN_API_KEY>)[A-Za-z0-9._-]{16,}/);
  });
});

describe("quickstart secret redaction", () => {
  it("redacts bearer material regardless of length while retaining the documented placeholder", () => {
    expect(redactSensitiveText("Authorization: Bearer short")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactSensitiveText("Authorization: Bearer <MUNIN_API_KEY>")).toBe(
      "Authorization: Bearer <MUNIN_API_KEY>",
    );
    expect(redactSensitiveText("failed with tiny", ["tiny"])).toBe("failed with [REDACTED]");
  });
});

describe("quickstart preflight", () => {
  it("passes the supported lexical-first local path and verifies SQLite FTS5", async () => {
    const root = makeTempRoot();
    const projectRoot = repoRoot;
    const result = await runPreflight({
      projectRoot,
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      transport: "stdio",
      embeddings: false,
      nodeVersion: "v20.19.0",
      platform: "linux",
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "sqlite-fts5")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "embedding-mode")?.message).toContain("lexical");
  });

  it("fails before startup for unsupported runtime, profile, insecure paths, and missing HTTP auth", async () => {
    const root = makeTempRoot();
    const projectRoot = makeProjectRoot(root);
    const dataDir = join(root, "data");
    const configDir = join(root, "config");
    mkdirSync(dataDir, { mode: 0o755 });
    mkdirSync(configDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    chmodSync(configDir, 0o755);
    writeFileSync(join(dataDir, "memory.db"), "unsafe");
    chmodSync(join(dataDir, "memory.db"), 0o644);

    const result = await runPreflight({
      projectRoot,
      dataDir,
      configDir,
      transport: "http",
      embeddings: true,
      embeddingModel: "",
      profile: "imaginary-profile",
      nodeVersion: "v18.20.0",
      platform: "win32",
      apiKeyPresent: false,
      port: 70_000,
    });

    expect(result.ok).toBe(false);
    for (const id of ["platform", "node", "profile", "data-permissions", "config-permissions", "database-permissions", "embedding-mode", "http-auth", "port"]) {
      expect(result.checks.find((check) => check.id === id)?.status).toBe("fail");
    }
  });

  it("rejects non-directory roots and symbolic-link data paths before startup", async () => {
    const root = makeTempRoot();
    const projectRoot = makeProjectRoot(root);
    const realData = join(root, "real-data");
    const dataLink = join(root, "data-link");
    const configFile = join(root, "config-file");
    mkdirSync(realData, { mode: 0o700 });
    symlinkSync(realData, dataLink);
    writeFileSync(configFile, "not a directory", { mode: 0o600 });

    const result = await runPreflight({
      projectRoot,
      dataDir: dataLink,
      configDir: configFile,
      transport: "stdio",
      embeddings: false,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "data-permissions")?.message).toContain("symbolic link");
    expect(result.checks.find((check) => check.id === "config-permissions")?.message).toContain("must be a directory");
  });
});

describe("quickstart first success", () => {
  it("performs orient, status, write, log, resume, and inspect against a fresh database", async () => {
    const root = makeTempRoot();
    const result = await runFirstSuccess({ dbPath: join(root, "memory.db") });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual([
      "orient",
      "status",
      "write",
      "log",
      "resume",
      "inspect",
    ]);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(result.steps.find((step) => step.id === "status")?.message).toContain("health");
    expect(result.namespace).toBe("onboarding/quickstart");
    expect(result.entryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("creates an isolated secret-safe setup report and client artifacts", async () => {
    const root = makeTempRoot();
    const projectRoot = repoRoot;
    const dataDir = join(root, "data");
    const configDir = join(root, "config");
    const secret = "real-sensitive-token-that-must-never-print";

    const result = await runQuickstart({
      projectRoot,
      dataDir,
      configDir,
      transport: "stdio",
      embeddings: false,
      installDurationMs: 1234,
      sensitiveValues: [secret],
    });

    expect(result.ok).toBe(true);
    expect(result.metrics.installDurationMs).toBe(1234);
    expect(result.metrics.totalDurationMs).toBeLessThan(300_000);
    expect(result.metrics.rssBytes).toBeGreaterThan(0);
    expect(result.metrics.databaseBytes).toBeGreaterThan(0);

    const expectedFiles = [
      "codex.toml",
      "claude-code.txt",
      "claude-desktop.json",
      "streamable-http.json",
      "last-run.json",
    ];
    for (const file of expectedFiles) {
      const path = join(configDir, file);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(readFileSync(path, "utf8")).not.toContain(secret);
    }
    const report = JSON.parse(readFileSync(join(configDir, "last-run.json"), "utf8")) as { artifacts: string[] };
    expect(report.artifacts).toEqual(result.artifacts);
    expect(statSync(join(dataDir, "memory.db")).mode & 0o077).toBe(0);
  });

  it("refuses to overwrite a generated artifact through a symbolic link", async () => {
    const root = makeTempRoot();
    const projectRoot = makeProjectRoot(root);
    const dataDir = join(root, "data");
    const configDir = join(root, "config");
    mkdirSync(configDir, { mode: 0o700 });
    const target = join(root, "must-not-change");
    writeFileSync(target, "original");
    symlinkSync(target, join(configDir, "codex.toml"));

    await expect(runQuickstart({
      projectRoot,
      dataDir,
      configDir,
      transport: "stdio",
      embeddings: false,
    })).rejects.toThrow("Refusing to overwrite symbolic-link artifact");
    expect(readFileSync(target, "utf8")).toBe("original");
  });
});
