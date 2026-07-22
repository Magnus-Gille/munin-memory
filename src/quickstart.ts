import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  accessSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  host?: string;
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
  transport: "stdio";
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
  return JSON.stringify(value);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function localMcpDefinition(projectRoot: string, dataDir: string) {
  return {
    type: "stdio",
    command: process.execPath,
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
    if (
      typeof server?.command !== "string" ||
      !isAbsolute(server.command) ||
      !Array.isArray(server.args) ||
      typeof server.env !== "object"
    ) {
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
  const check = permissionCheck("directory", path, "Directory");
  if (check.status === "fail") throw new Error(check.message);
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      let ancestor = dirname(resolve(path));
      try {
        while (!existsSync(ancestor)) {
          const parent = dirname(ancestor);
          if (parent === ancestor) throw new Error("No existing parent directory was found.");
          ancestor = parent;
        }
        const ancestorStat = statSync(ancestor);
        if (!ancestorStat.isDirectory()) {
          return { id, status: "fail", message: `${label} cannot be created because ${ancestor} is not a directory.` };
        }
        accessSync(ancestor, fsConstants.W_OK | fsConstants.X_OK);
        return {
          id,
          status: "pass",
          message: `${label} does not exist and will be created owner-only (0700).`,
        };
      } catch (ancestorError) {
        const code = (ancestorError as NodeJS.ErrnoException).code;
        return {
          id,
          status: "fail",
          message: `${label} cannot be created at ${path}${code ? ` (${code})` : ""}.`,
        };
      }
    }
    return { id, status: "fail", message: `${label} is not readable and writable: ${path}.` };
  }
}

function databasePermissionCheck(dataDir: string): PreflightCheck {
  const paths = ["memory.db", "memory.db-wal", "memory.db-shm"].map((name) => join(dataDir, name));
  let inspected = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    inspected += 1;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        return { id: "database-permissions", status: "fail", message: `Database artifact must not be a symbolic link: ${path}.` };
      }
      if (!stat.isFile()) {
        return { id: "database-permissions", status: "fail", message: `Database artifact must be a regular file: ${path}.` };
      }
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          id: "database-permissions",
          status: "fail",
          message: `Database artifact permissions are ${mode.toString(8)}; run chmod 600 ${path}.`,
        };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        id: "database-permissions",
        status: "fail",
        message: `Database artifact cannot be inspected: ${path}${code ? ` (${code})` : ""}.`,
      };
    }
  }
  return inspected === 0
    ? { id: "database-permissions", status: "pass", message: "New database will be created owner-only (0600)." }
    : { id: "database-permissions", status: "pass", message: "Existing database and SQLite sidecars are owner-only." };
}

interface PortProbeResult {
  available: boolean;
  errorCode?: string;
}

async function checkPort(host: string, port: number): Promise<PortProbeResult> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolvePort({ available: false, errorCode: error.code });
    });
    server.listen(port, host, () => {
      server.close(() => resolvePort({ available: true }));
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
    const host = options.host ?? "127.0.0.1";
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      checks.push({ id: "port", status: "fail", message: `Invalid HTTP port ${String(port)}; use an integer from 1 to 65535.` });
    } else {
      const probe = await checkPort(host, port);
      if (probe.available) {
        checks.push({ id: "port", status: "pass", message: `${host}:${port} is available.` });
      } else if (probe.errorCode === "EADDRINUSE") {
        checks.push({ id: "port", status: "fail", message: `${host}:${port} is already in use.` });
      } else if (probe.errorCode === "EACCES") {
        checks.push({ id: "port", status: "fail", message: `Permission denied while binding ${host}:${port}.` });
      } else {
        checks.push({
          id: "port",
          status: "fail",
          message: `${host}:${port} cannot be bound (${probe.errorCode ?? "unknown error"}).`,
        });
      }
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

export function parseQuickstartToolResponse(raw: unknown): Record<string, unknown> {
  const response = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text result.");
  if (response.isError) throw new Error(`MCP tool failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function toolSucceeded(value: Record<string, unknown>): boolean {
  return value.ok === true && value.error === undefined;
}

export async function runFirstSuccess(options: { dbPath: string; serverPath?: string }): Promise<FirstSuccessResult> {
  const startedAt = Date.now();
  const namespace = "onboarding/quickstart";
  const key = `first-success-${randomUUID()}`;
  const serverPath = options.serverPath ?? join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist/index.js");
  if (!existsSync(serverPath)) throw new Error(`Built Munin server not found at ${serverPath}; run npm run build first.`);
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
    parseQuickstartToolResponse(await client.callTool({ name, arguments: args }));
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
    const health = await call("memory_health");
    steps.push({
      id: "status",
      ok: toolSucceeded(status) && toolSucceeded(health),
      message: "Server capability status and owner health snapshot are available.",
    });
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
    transport: "stdio",
    namespace,
    entryId,
    coldStartMs,
    durationMs: Date.now() - startedAt,
    steps,
  };
}

export function redactSensitiveText(text: string, sensitiveValues: string[] = []): string {
  let redacted = text.replace(
    /Bearer\s+(<MUNIN_API_KEY>|[^\s"',}\]]+)/gi,
    (match, credential: string) => credential === "<MUNIN_API_KEY>" ? match : "Bearer [REDACTED]",
  );
  for (const value of sensitiveValues) {
    if (value.length > 0) redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

function privateWrite(path: string, content: string, sensitiveValues: string[]): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing to overwrite symbolic-link artifact: ${path}`);
    }
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to overwrite non-regular or multiply linked artifact: ${path}`);
    }
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, redactSensitiveText(content, sensitiveValues), "utf8");
  } finally {
    closeSync(descriptor);
  }
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
  for (const value of sensitiveValues) {
    if (value.length > 0 && Object.values(configs).some((content) => content.includes(value))) {
      configErrors.push("Generated client configuration contains configured credential material.");
      break;
    }
  }
  if (configErrors.length > 0) throw new Error(configErrors.join(" "));
  ensurePrivateDirectory(options.dataDir);
  ensurePrivateDirectory(options.configDir);

  const dbPath = join(options.dataDir, "memory.db");
  const firstSuccess = await runFirstSuccess({ dbPath, serverPath: join(options.projectRoot, "dist/index.js") });
  const artifacts = [
    join(options.configDir, "codex.toml"),
    join(options.configDir, "claude-code.txt"),
    join(options.configDir, "claude-desktop.json"),
    join(options.configDir, "streamable-http.json"),
  ];
  if (firstSuccess.ok) {
    privateWrite(artifacts[0], configs.codexToml, []);
    privateWrite(artifacts[1], configs.claudeCodeCommand, []);
    privateWrite(artifacts[2], configs.claudeDesktopJson, []);
    privateWrite(artifacts[3], configs.streamableHttpJson, []);
  } else {
    artifacts.splice(0);
  }
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
      verifiedTransport: firstSuccess.transport,
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
