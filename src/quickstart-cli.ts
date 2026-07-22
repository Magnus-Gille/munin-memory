#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  redactSensitiveText,
  runPreflight,
  runQuickstart,
  type PreflightOptions,
  type QuickstartOptions,
  type QuickstartTransport,
} from "./quickstart.js";

interface CliOptions extends QuickstartOptions {
  json: boolean;
  preflightOnly: boolean;
  help: boolean;
}

export interface QuickstartCliIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

function usage(): string {
  return `Munin Memory five-minute quick start

Usage:
  ./scripts/quickstart.sh [options]
  munin-quickstart [options]

Options:
  --data-dir <path>       Database directory (default: ~/.munin-memory)
  --config-dir <path>     Generated examples/report (default: ~/.config/munin-memory)
  --project-root <path>   Built Munin checkout (normally detected)
  --transport <mode>      stdio (default) or http
  --server-url <url>      Generic HTTP client example URL
  --profile <name>        zero-appliance, zero-plus, or full-node
  --preflight-only        Check prerequisites without writing memory/config files
  --json                  Machine-readable, secret-safe result
  --help                  Show this help

The default path is local stdio plus lexical search. It needs no bearer token,
opens no network port, and enables embeddings only after first success.
`;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function defaultProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function parseQuickstartArgs(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let projectRoot = defaultProjectRoot();
  let dataDir = join(homedir(), ".munin-memory");
  let configDir = join(homedir(), ".config", "munin-memory");
  let transport: QuickstartTransport = "stdio";
  let serverUrl: string | undefined;
  let profile = env.MUNIN_PROFILE || undefined;
  let jsonOutput = false;
  let preflightOnly = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data-dir") dataDir = takeValue(args, index++, arg);
    else if (arg === "--config-dir") configDir = takeValue(args, index++, arg);
    else if (arg === "--project-root") projectRoot = takeValue(args, index++, arg);
    else if (arg === "--transport") {
      const value = takeValue(args, index++, arg);
      if (value !== "stdio" && value !== "http") throw new Error("--transport must be stdio or http.");
      transport = value;
    } else if (arg === "--server-url") serverUrl = takeValue(args, index++, arg);
    else if (arg === "--profile") profile = takeValue(args, index++, arg);
    else if (arg === "--json") jsonOutput = true;
    else if (arg === "--preflight-only") preflightOnly = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  const sensitiveValues = [
    env.MUNIN_API_KEY,
    env.MUNIN_API_KEY_DPA,
    env.MUNIN_API_KEY_CONSUMER,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const installDurationMs = Number.parseInt(env.MUNIN_QUICKSTART_INSTALL_MS ?? "0", 10);
  return {
    projectRoot: resolve(projectRoot),
    dataDir: resolve(dataDir),
    configDir: resolve(configDir),
    transport,
    embeddings: false,
    profile,
    embeddingModel: env.MUNIN_EMBEDDINGS_MODEL,
    apiKeyPresent: sensitiveValues.length > 0,
    port: Number.parseInt(env.MUNIN_HTTP_PORT ?? "3030", 10),
    serverUrl,
    installDurationMs: Number.isFinite(installDurationMs) ? installDurationMs : 0,
    sensitiveValues,
    json: jsonOutput,
    preflightOnly,
    help,
  };
}

function printPreflight(
  options: PreflightOptions,
  result: Awaited<ReturnType<typeof runPreflight>>,
  io: QuickstartCliIo,
): void {
  io.log(`Munin preflight: ${result.ok ? "PASS" : "FAIL"} (${result.mode})`);
  for (const check of result.checks) {
    const marker = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    io.log(`  ${marker} ${check.message}`);
  }
  if (!result.ok) io.log(`Fix the failed checks, then rerun from ${options.projectRoot}.`);
}

export async function runQuickstartCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: QuickstartCliIo = { log: console.log, error: console.error },
): Promise<number> {
  const sensitiveFromEnv = [
    env.MUNIN_API_KEY,
    env.MUNIN_API_KEY_DPA,
    env.MUNIN_API_KEY_CONSUMER,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  try {
    const options = parseQuickstartArgs(args, env);
    if (options.help) {
      io.log(usage());
      return 0;
    }
    if (options.preflightOnly) {
      const result = await runPreflight(options);
      if (options.json) io.log(JSON.stringify(result, null, 2));
      else printPreflight(options, result, io);
      return result.ok ? 0 : 1;
    }

    const result = await runQuickstart(options);
    if (options.json) {
      io.log(JSON.stringify(result, null, 2));
    } else {
      printPreflight(options, result.preflight, io);
      if (result.ok && result.firstSuccess) {
        io.log("\nFirst-success flow: PASS");
        for (const step of result.firstSuccess.steps) io.log(`  ✓ ${step.id}: ${step.message}`);
        io.log(`\nGenerated placeholder-only client examples in ${options.configDir}`);
        io.log(`Database: ${join(options.dataDir, "memory.db")}`);
        io.log(`Total measured time: ${(result.metrics.totalDurationMs / 1000).toFixed(1)}s`);
        io.log("Next: copy the matching client example, restart that client, and call memory_orient.");
      }
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.error(redactSensitiveText(`Quick start failed: ${message}`, sensitiveFromEnv));
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runQuickstartCli(process.argv.slice(2));
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) void main();
