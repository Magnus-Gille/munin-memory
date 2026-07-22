import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROFILE_NAMES } from "./profiles.js";

export type QuickstartTransport = "stdio" | "http";
export type CheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface PreflightOptions {
  projectRoot: string;
  dataDir: string;
  configDir: string;
  transport: QuickstartTransport;
  embeddings: boolean;
  profile?: string;
  embeddingModel?: string;
  apiKeyPresent?: boolean;
  port?: number;
  nodeVersion?: string;
  platform?: NodeJS.Platform | string;
}

export interface PreflightResult {
  ok: boolean;
  mode: "lexical-first" | "semantic";
  checks: PreflightCheck[];
}

export interface ClientConfigurations {
  codexToml: string;
  claudeCodeCommand: string;
  claudeDesktopJson: string;
  streamableHttpJson: string;
}

export interface ClientConfigurationOptions {
  projectRoot: string;
  dataDir: string;
  serverUrl?: string;
}

export interface FirstSuccessStep {
  id: "orient" | "status" | "write" | "log" | "resume" | "inspect";
  ok: boolean;
  message: string;
}

export interface FirstSuccessResult {
  ok: boolean;
  namespace: string;
  entryId: string;
  coldStartMs: number;
  durationMs: number;
  steps: FirstSuccessStep[];
}

export interface QuickstartOptions extends PreflightOptions {
  serverUrl?: string;
  installDurationMs?: number;
  sensitiveValues?: string[];
}

export interface QuickstartMetrics {
  installDurationMs: number;
  coldStartMs: number;
  setupDurationMs: number;
  totalDurationMs: number;
  rssBytes: number;
  databaseBytes: number;
  diskFootprintBytes: number;
}

export interface QuickstartResult {
  ok: boolean;
  preflight: PreflightResult;
  firstSuccess?: FirstSuccessResult;
  artifacts: string[];
  metrics: QuickstartMetrics;
}

const LOCAL_ENV = {
  MUNIN_EMBEDDINGS_ENABLED: "false",
  MUNIN_SEMANTIC_ENABLED: "false",
  MUNIN_HYBRID_ENABLED: "false",
} as const;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function localMcpDefinition(projectRoot: string, dataDir: string) {
  return {
    type: "stdio",
    command: "node",
    args: [join(resolve(projectRoot), "dist/index.js")],
    env: {
      MUNIN_MEMORY_DB_PATH: join(resolve(dataDir), "memory.db"),
      ...LOCAL_ENV,
    },
  };
}

export function generateClientConfigurations(options: ClientConfigurationOptions): ClientConfigurations {
  const definition = localMcpDefinition(options.projectRoot, options.dataDir);
  const envLines = Object.entries(definition.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join("\n");
  const codexToml = [
    "[mcp_servers.munin-memory]",
    `command = ${tomlString(definition.command)}`,
    `args = [${definition.args.map(tomlString).join(", ")}]`,
    "",
    "[mcp_servers.munin-memory.env]",
    envLines,
    "",
  ].join("\n");

  const claudePayload = JSON.stringify(definition);
  const claudeDesktopJson = json({
    mcpServers: {
      "munin-memory": {
        command: definition.command,
        args: definition.args,
        env: definition.env,
      },
    },
  });
  const streamableHttpJson = json({
    transport: "streamable-http",
    url: options.serverUrl ?? "http://127.0.0.1:3030/mcp",
    headers: {
      Authorization: "Bearer <MUNIN_API_KEY>",
    },
  });

  return {
    codexToml,
    claudeCodeCommand: `claude mcp add-json munin-memory ${shellSingleQuote(claudePayload)} -s user\n`,
    claudeDesktopJson,
    streamableHttpJson,
  };
}

export function validateGeneratedClientConfigurations(configs: ClientConfigurations): string[] {
  const errors: string[] = [];
  if (!configs.codexToml.includes("[mcp_servers.munin-memory]")) {
    errors.push("Codex configuration is missing the MCP server table.");
  }
  if (!configs.codexToml.includes("MUNIN_MEMORY_DB_PATH")) {
    errors.push("Codex configuration is missing the database path.");
  }
  if (!configs.claudeCodeCommand.startsWith("claude mcp add-json munin-memory ")) {
    errors.push("Claude Code command is not an add-json command.");
  }
  try {
    const parsed = JSON.parse(configs.claudeDesktopJson) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: unknown }>;
    };
    const server = parsed.mcpServers?.["munin-memory"];
    if (server?.command !== "node" || !Array.isArray(server.args) || typeof server.env !== "object") {
      errors.push("Claude Desktop configuration has an invalid stdio server shape.");
    }
  } catch {
    errors.push("Claude Desktop configuration is not valid JSON.");
  }
  try {
    const parsed = JSON.parse(configs.streamableHttpJson) as {
      transport?: unknown;
      url?: unknown;
      headers?: { Authorization?: unknown };
    };
    if (
      parsed.transport !== "streamable-http" ||
      typeof parsed.url !== "string" ||
      parsed.headers?.Authorization !== "Bearer <MUNIN_API_KEY>"
    ) {
      errors.push("Streamable HTTP configuration has an invalid or unsafe shape.");
    }
  } catch {
    errors.push("Streamable HTTP configuration is not valid JSON.");
  }
  return errors;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

function permissionCheck(id: string, path: string, label: string): PreflightCheck {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { id, status: "fail", message: `${label} must not be a symbolic link: ${path}.` };
    }
    if (!stat.isDirectory()) {
      return { id, status: "fail", message: `${label} must be a directory: ${path}.` };
    }
    accessSync(path, fsConstants.R_OK | fsConstants.W_OK);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        id,
        status: "fail",
        message: `${label} is accessible by group/other (${mode.toString(8)}); run chmod 700 ${path}.`,
      };
    }
    return { id, status: "pass", message: `${label} is writable and owner-only.` };
  } catch {
    return { id, status: "fail", message: `${label} is not readable and writable: ${path}.` };
  }
}

function databasePermissionCheck(dataDir: string): PreflightCheck {
  const path = join(dataDir, "memory.db");
  if (!existsSync(path)) {
    return { id: "database-permissions", status: "pass", message: "New database will be created owner-only (0600)." };
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { id: "database-permissions", status: "fail", message: `Database must not be a symbolic link: ${path}.` };
    }
    if (!stat.isFile()) {
      return { id: "database-permissions", status: "fail", message: `Database path must be a regular file: ${path}.` };
    }
    const mode = stat.mode & 0o777;
    return (mode & 0o077) === 0
      ? { id: "database-permissions", status: "pass", message: "Existing database is owner-only." }
      : { id: "database-permissions", status: "fail", message: `Existing database permissions are ${mode.toString(8)}; run chmod 600 ${path}.` };
  } catch {
    return { id: "database-permissions", status: "fail", message: `Existing database cannot be inspected: ${path}.` };
  }
}

async function checkPort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePort(true));
    });
  });
}

function checkSqlite(): PreflightCheck {
  let db: Database.Database | undefined;
  try {
    db = new Database(":memory:");
    const version = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    db.exec("CREATE VIRTUAL TABLE quickstart_fts USING fts5(content)");
    return {
      id: "sqlite-fts5",
      status: "pass",
      message: `SQLite ${version.version} and FTS5 are available.`,
    };
  } catch {
    return {
      id: "sqlite-fts5",
      status: "fail",
      message: "SQLite or FTS5 is unavailable; reinstall dependencies for this platform.",
    };
  } finally {
    db?.close();
  }
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  ensurePrivateDirectory(options.dataDir);
  ensurePrivateDirectory(options.configDir);
  const checks: PreflightCheck[] = [];
  const platform = options.platform ?? process.platform;
  checks.push(
    platform === "darwin" || platform === "linux"
      ? { id: "platform", status: "pass", message: `${platform} is supported.` }
      : { id: "platform", status: "fail", message: `${platform} is not a supported quick-start platform.` },
  );

  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeMajor = Number(nodeVersion.match(/^v?(\d+)/)?.[1]);
  checks.push(
    Number.isInteger(nodeMajor) && nodeMajor >= 20
      ? { id: "node", status: "pass", message: `Node ${nodeVersion} satisfies Node 20+.` }
      : { id: "node", status: "fail", message: `Node ${nodeVersion} is unsupported; install Node 20 or newer.` },
  );

  const packagePath = join(options.projectRoot, "package.json");
  const serverPath = join(options.projectRoot, "dist/index.js");
  checks.push(
    existsSync(packagePath) && existsSync(serverPath)
      ? { id: "build", status: "pass", message: "Built Munin server entrypoint is present." }
      : { id: "build", status: "fail", message: "Munin is not built; run npm ci and npm run build." },
  );

  const validProfile = options.profile === undefined || (PROFILE_NAMES as readonly string[]).includes(options.profile);
  checks.push(
    validProfile
      ? { id: "profile", status: "pass", message: options.profile ? `Profile ${options.profile} is valid.` : "No hardware profile override is set." }
      : { id: "profile", status: "fail", message: `Unknown profile ${options.profile}; use ${PROFILE_NAMES.join(", ")}.` },
  );
  checks.push(permissionCheck("data-permissions", options.dataDir, "Data directory"));
  checks.push(permissionCheck("config-permissions", options.configDir, "Configuration directory"));
  checks.push(databasePermissionCheck(options.dataDir));
  checks.push(checkSqlite());

  if (options.embeddings) {
    const model = options.embeddingModel?.trim();
    checks.push({
      id: "embedding-mode",
      status: model === "" ? "fail" : "warn",
      message:
        model === ""
          ? "Embeddings were requested but the model identifier is empty."
          : `Semantic mode requested${model ? ` with ${model}` : ""}; first start may download model data.`,
    });
  } else {
    checks.push({
      id: "embedding-mode",
      status: "pass",
      message: "First success deliberately uses lexical mode; enable embeddings after verification.",
    });
  }

  if (options.transport === "http") {
    checks.push(
      options.apiKeyPresent
        ? { id: "http-auth", status: "pass", message: "An HTTP bearer credential is configured (value not displayed)." }
        : { id: "http-auth", status: "fail", message: "HTTP mode requires MUNIN_API_KEY or a scoped bearer credential." },
    );
    const port = options.port ?? 3030;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      checks.push({ id: "port", status: "fail", message: `Invalid HTTP port ${String(port)}; use an integer from 1 to 65535.` });
    } else {
      checks.push(
        (await checkPort(port))
          ? { id: "port", status: "pass", message: `127.0.0.1:${port} is available.` }
          : { id: "port", status: "fail", message: `127.0.0.1:${port} is already in use.` },
      );
    }
  } else {
    checks.push({ id: "http-auth", status: "pass", message: "Local stdio mode does not require a bearer credential." });
    checks.push({ id: "port", status: "pass", message: "Local stdio mode does not open a network port." });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    mode: options.embeddings ? "semantic" : "lexical-first",
    checks,
  };
}

function parseToolResponse(raw: unknown): Record<string, unknown> {
  const response = raw as { content?: Array<{ type?: string; text?: string }> };
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text result.");
  return JSON.parse(text) as Record<string, unknown>;
}

function toolSucceeded(value: Record<string, unknown>): boolean {
  return value.ok === true && value.error === undefined;
}

export async function runFirstSuccess(options: { dbPath: string; serverPath?: string }): Promise<FirstSuccessResult> {
  const startedAt = Date.now();
  const namespace = "onboarding/quickstart";
  const key = `first-success-${randomUUID()}`;
  const serverPath = options.serverPath ?? join(resolve("."), "dist/index.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: dirname(dirname(serverPath)),
    env: {
      ...getDefaultEnvironment(),
      MUNIN_TRANSPORT: "stdio",
      MUNIN_MEMORY_DB_PATH: options.dbPath,
      MUNIN_EMBEDDINGS_ENABLED: "false",
      MUNIN_SEMANTIC_ENABLED: "false",
      MUNIN_HYBRID_ENABLED: "false",
      MUNIN_CONSOLIDATION_ENABLED: "false",
    },
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    if (serverStderr.length < 8_000) serverStderr += chunk.toString();
  });
  const client = new Client({ name: "munin-quickstart", version: "0.5.0" });
  const connectStartedAt = Date.now();
  let coldStartMs = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parseToolResponse(await client.callTool({ name, arguments: args }));
  const steps: FirstSuccessStep[] = [];
  let entryId = "";
  const record = (id: FirstSuccessStep["id"], result: Record<string, unknown>, message: string) => {
    steps.push({ id, ok: toolSucceeded(result), message });
  };

  try {
    await client.connect(transport);
    coldStartMs = Date.now() - connectStartedAt;
    const orient = await call("memory_orient", { detail: "compact", include_namespaces: false });
    record("orient", orient, "Session handshake returned conventions and dashboard context.");
    const status = await call("memory_status");
    record("status", status, "Server capability status is available.");
    const write = await call("memory_write", {
      namespace,
      key,
      content: "Munin quick-start write-to-resume verification succeeded.",
      tags: ["milestone", "topic:quickstart"],
      create_if_absent: true,
    });
    entryId = typeof write.id === "string" ? write.id : "";
    record("write", write, "Created an isolated first-success state entry.");
    const log = await call("memory_log", {
      namespace,
      content: "Completed the canonical Munin quick-start verification flow.",
      tags: ["milestone", "topic:quickstart"],
    });
    record("log", log, "Appended a first-success milestone log.");
    const resume = await call("memory_resume", { namespace, limit: 6, include_history: true });
    record("resume", resume, "Resume returned the new onboarding context.");
    const inspect = await call("memory_read", { namespace, key });
    const inspectedContent = typeof inspect.content === "string" ? inspect.content : "";
    const inspectOk = toolSucceeded(inspect) && inspectedContent.includes("write-to-resume verification succeeded");
    steps.push({ id: "inspect", ok: inspectOk, message: "Read-back matched the created state entry." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = serverStderr.trim().slice(-2_000);
    throw new Error(`MCP stdio verification failed: ${message}${diagnostic ? `\nServer diagnostics:\n${diagnostic}` : ""}`);
  } finally {
    await client.close();
  }

  return {
    ok: steps.length === 6 && steps.every((step) => step.ok) && entryId.length > 0,
    namespace,
    entryId,
    coldStartMs,
    durationMs: Date.now() - startedAt,
    steps,
  };
}

export function redactSensitiveText(text: string, sensitiveValues: string[] = []): string {
  let redacted = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]");
  for (const value of sensitiveValues) {
    if (value.length >= 8) redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

function privateWrite(path: string, content: string, sensitiveValues: string[]): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic-link artifact: ${path}`);
  }
  writeFileSync(path, redactSensitiveText(content, sensitiveValues), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    total += directorySize(join(path, entry.name));
  }
  return total;
}

function emptyMetrics(installDurationMs: number): QuickstartMetrics {
  return {
    installDurationMs,
    coldStartMs: 0,
    setupDurationMs: 0,
    totalDurationMs: installDurationMs,
    rssBytes: process.memoryUsage().rss,
    databaseBytes: 0,
    diskFootprintBytes: 0,
  };
}

export async function runQuickstart(options: QuickstartOptions): Promise<QuickstartResult> {
  const startedAt = Date.now();
  const installDurationMs = Math.max(0, options.installDurationMs ?? 0);
  const sensitiveValues = (options.sensitiveValues ?? []).filter(Boolean);
  const preflight = await runPreflight(options);
  if (!preflight.ok) {
    return { ok: false, preflight, artifacts: [], metrics: emptyMetrics(installDurationMs) };
  }

  const configs = generateClientConfigurations(options);
  const configErrors = validateGeneratedClientConfigurations(configs);
  if (configErrors.length > 0) throw new Error(configErrors.join(" "));
  const artifacts = [
    join(options.configDir, "codex.toml"),
    join(options.configDir, "claude-code.txt"),
    join(options.configDir, "claude-desktop.json"),
    join(options.configDir, "streamable-http.json"),
  ];
  privateWrite(artifacts[0], configs.codexToml, sensitiveValues);
  privateWrite(artifacts[1], configs.claudeCodeCommand, sensitiveValues);
  privateWrite(artifacts[2], configs.claudeDesktopJson, sensitiveValues);
  privateWrite(artifacts[3], configs.streamableHttpJson, sensitiveValues);

  const dbPath = join(options.dataDir, "memory.db");
  const firstSuccess = await runFirstSuccess({ dbPath, serverPath: join(options.projectRoot, "dist/index.js") });
  const setupDurationMs = Date.now() - startedAt;
  const databaseBytes = statSync(dbPath).size;
  const metrics: QuickstartMetrics = {
    installDurationMs,
    coldStartMs: firstSuccess.coldStartMs,
    setupDurationMs,
    totalDurationMs: installDurationMs + setupDurationMs,
    rssBytes: process.memoryUsage().rss,
    databaseBytes,
    diskFootprintBytes:
      directorySize(options.projectRoot) + directorySize(options.dataDir) + directorySize(options.configDir),
  };
  const reportPath = join(options.configDir, "last-run.json");
  artifacts.push(reportPath);
  privateWrite(
    reportPath,
    json({
      schema: "munin-quickstart/v1",
      generatedAt: new Date().toISOString(),
      ok: firstSuccess.ok,
      mode: preflight.mode,
      transport: options.transport,
      profile: options.profile ?? null,
      preflight,
      firstSuccess,
      metrics,
      artifacts,
    }),
    sensitiveValues,
  );
  return { ok: firstSuccess.ok, preflight, firstSuccess, artifacts, metrics };
}
