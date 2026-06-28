/**
 * M5 User-Test Harness
 *
 * Lets a LOCAL M5 model genuinely user-test Munin Memory by calling its real
 * MCP tools via an agent loop. Captures the full transcript + a UX report.
 *
 * Usage:
 *   M5_API_KEY=$(m5-auth) node benchmark/m5-usertest/run.mjs \
 *     --models qwen3-30b-instruct [--base http://100.76.72.59:8080/v1] [--max-steps 12]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const FIXTURE_DB = join(REPO_ROOT, "benchmark/fixtures/memory-snapshot-2026-04-07.db");
const OUT_DIR = join(__dirname, "out");
const DIST_INDEX = join(REPO_ROOT, "dist/index.js");

// Curated core subset — keeps small-model tool-calling tractable
const ALLOWED_TOOLS = new Set([
  "memory_orient",
  "memory_resume",
  "memory_write",
  "memory_update_status",
  "memory_log",
  "memory_read",
  "memory_query",
  "memory_list",
]);

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCLI() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const modelsArg = get("--models");
  if (!modelsArg) {
    console.error("Usage: node run.mjs --models <model1,model2> [--base <url>] [--max-steps <n>]");
    process.exit(1);
  }

  return {
    models: modelsArg.split(",").map((m) => m.trim()).filter(Boolean),
    baseUrl: get("--base") ?? process.env.M5_BASE_URL ?? "http://100.76.72.59:8080/v1",
    maxSteps: parseInt(get("--max-steps") ?? "12", 10),
    apiKey: process.env.M5_API_KEY ?? "",
  };
}

// ---------------------------------------------------------------------------
// Ensure dist exists
// ---------------------------------------------------------------------------

async function ensureBuild() {
  if (!existsSync(DIST_INDEX)) {
    console.log("[harness] dist/index.js missing — running npm run build ...");
    const { execSync } = await import("node:child_process");
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

// ---------------------------------------------------------------------------
// Munin MCP client
// ---------------------------------------------------------------------------

async function createMuninClient() {
  // Copy fixture DB to a temp path so we never touch the real DB
  const tmpDb = join(tmpdir(), `munin-usertest-${randomUUID()}.db`);
  copyFileSync(FIXTURE_DB, tmpDb);
  // Also copy WAL/SHM if present (may not exist)
  for (const ext of ["-shm", "-wal"]) {
    const src = FIXTURE_DB + ext;
    if (existsSync(src)) copyFileSync(src, tmpDb + ext);
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST_INDEX],
    env: {
      ...process.env,
      MUNIN_MEMORY_DB_PATH: tmpDb,
      MUNIN_EMBEDDINGS_ENABLED: "false",
      MUNIN_TRANSPORT: "stdio",
      // Suppress verbose output from consolidation / OAuth workers
      MUNIN_CONSOLIDATION_ENABLED: "false",
    },
  });

  const client = new Client(
    { name: "m5-usertest-harness", version: "0.1.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  return { client, tmpDb };
}

// ---------------------------------------------------------------------------
// Fetch tools from Munin and map to OpenAI format
// ---------------------------------------------------------------------------

async function getMuninTools(client) {
  const { tools } = await client.listTools();
  return tools
    .filter((t) => ALLOWED_TOOLS.has(t.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
}

// ---------------------------------------------------------------------------
// Execute a single MCP tool call
// ---------------------------------------------------------------------------

async function callMuninTool(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args ?? {} });
    // Extract text content from result
    let text = "";
    if (Array.isArray(result.content)) {
      text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else if (typeof result.content === "string") {
      text = result.content;
    } else {
      text = JSON.stringify(result.content ?? result);
    }
    // Truncate huge results to ~3KB to stay within context budget
    if (text.length > 3000) {
      text = text.slice(0, 3000) + "\n... [truncated]";
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: `ERROR: ${err.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Best-effort JSON tool-call parser for models that emit raw JSON
// ---------------------------------------------------------------------------

function tryParseInlineToolCall(content) {
  // Look for patterns like {"name":"...","arguments":{...}} or {"tool":"...","input":{...}}
  const patterns = [
    /\{"name"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|input|parameters)"\s*:\s*(\{[\s\S]*?\})\s*\}/,
    /\{"tool"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|input|parameters)"\s*:\s*(\{[\s\S]*?\})\s*\}/,
    /```json\s*(\{[\s\S]*?\})\s*```/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      try {
        if (match[1] && match[2]) {
          return [{ id: randomUUID(), function: { name: match[1], arguments: match[2] } }];
        } else if (match[1]) {
          const obj = JSON.parse(match[1]);
          const name = obj.name ?? obj.tool ?? obj.function;
          const args = obj.arguments ?? obj.input ?? obj.parameters ?? {};
          if (name && ALLOWED_TOOLS.has(name)) {
            return [{ id: randomUUID(), function: { name, arguments: JSON.stringify(args) } }];
          }
        }
      } catch {
        // parse failed, try next
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completion call
// ---------------------------------------------------------------------------

async function chatCompletion(baseUrl, apiKey, model, messages, tools) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": BROWSER_UA,
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.2,
    max_tokens: 1500,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM API ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Per-model agent loop
// ---------------------------------------------------------------------------

async function runModel(config, muninClient, tools, modelId) {
  const { baseUrl, apiKey, maxSteps } = config;
  const safeModelId = modelId.replace(/[^a-zA-Z0-9_-]/g, "_");

  const systemPrompt = `You are an AI assistant evaluating a persistent-memory tool called Munin for the FIRST time, by actually using it. Your namespace for any writes is \`testing/${safeModelId}\` — only write there. Goals: (1) call memory_orient to understand the system; (2) record a decision you made — "chose SQLite+FTS5 over Postgres for the memory store because of ARM/edge deployment" — with its rationale, so a future you can recall it; (3) retrieve that decision back. Use the provided tools. When done (max ~10 tool calls), STOP calling tools and reply with a UX report: onboarding clarity (1-10), what was intuitive, what confused you, what you'd want, and the single biggest friction.`;

  const messages = [{ role: "system", content: systemPrompt }];

  const transcript = [];
  const toolsUsed = [];
  let toolCallsCount = 0;
  let toolCallingSupported = null; // unknown initially
  let finalReport = null;
  const startTime = Date.now();
  let stepsWithNoToolCalls = 0;

  for (let step = 0; step < maxSteps; step++) {
    let completion;
    try {
      completion = await chatCompletion(baseUrl, apiKey, modelId, messages, tools);
    } catch (err) {
      transcript.push({ step, type: "error", error: err.message });
      console.error(`  [step ${step}] LLM error: ${err.message.slice(0, 200)}`);
      break;
    }

    const choice = completion.choices?.[0];
    if (!choice) {
      transcript.push({ step, type: "error", error: "No choices in response" });
      break;
    }

    const { message } = choice;
    messages.push(message);

    // Check for tool_calls
    if (message.tool_calls?.length > 0) {
      toolCallingSupported = true;
      stepsWithNoToolCalls = 0;

      for (const tc of message.tool_calls) {
        const name = tc.function?.name ?? "unknown";
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = { _raw: tc.function?.arguments };
        }

        const result = await callMuninTool(muninClient, name, args);
        toolCallsCount++;
        toolsUsed.push(name);

        transcript.push({
          step,
          type: "tool_call",
          tool: name,
          args,
          result_summary: result.text.slice(0, 500),
          ok: result.ok,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.text,
        });
      }
    } else if (message.content) {
      // No tool calls — check if this is a final report or inline tool call
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);

      // Try inline tool-call parse first (small models sometimes emit JSON)
      if (toolCallingSupported !== true && stepsWithNoToolCalls < 2) {
        const inlineCalls = tryParseInlineToolCall(content);
        if (inlineCalls?.length) {
          // Execute inline tool calls
          const toolResults = [];
          for (const tc of inlineCalls) {
            const name = tc.function?.name ?? "unknown";
            let args = {};
            try {
              args = JSON.parse(tc.function?.arguments ?? "{}");
            } catch {
              args = {};
            }
            const result = await callMuninTool(muninClient, name, args);
            toolCallsCount++;
            toolsUsed.push(name);
            transcript.push({
              step,
              type: "tool_call_inline",
              tool: name,
              args,
              result_summary: result.text.slice(0, 500),
              ok: result.ok,
            });
            toolResults.push(`Tool: ${name}\nResult: ${result.text}`);
          }
          // Feed results back to the model
          messages.push({
            role: "user",
            content: `Tool execution results:\n${toolResults.join("\n\n")}\n\nPlease continue with the next step.`,
          });
          continue;
        }
      }

      stepsWithNoToolCalls++;
      transcript.push({ step, type: "content", content: content.slice(0, 1000) });

      // If this looks like a final report (long-ish text with no tool calls), capture it
      if (content.length > 100) {
        finalReport = content;
        // If the model has been going for a while or explicitly looks done, stop
        if (step >= 2 || choice.finish_reason === "stop") {
          break;
        }
      }

      // If no tool calls ever after 3 steps, mark and ask for report
      if (toolCallingSupported === null && stepsWithNoToolCalls >= 3) {
        toolCallingSupported = false;
        // Ask for report anyway
        messages.push({
          role: "user",
          content:
            "You haven't called any tools yet. Please provide your UX report about what you observed: onboarding clarity (1-10), what was intuitive, what confused you, what you'd want, and the single biggest friction based on the system description.",
        });
      }
    } else {
      // Empty message
      transcript.push({ step, type: "empty" });
      stepsWithNoToolCalls++;
      if (stepsWithNoToolCalls >= 3) break;
    }

    if (choice.finish_reason === "stop" && !message.tool_calls?.length) {
      break;
    }
  }

  if (toolCallingSupported === null) {
    toolCallingSupported = toolCallsCount > 0;
  }

  const duration = Date.now() - startTime;

  return {
    model: modelId,
    steps: transcript.length,
    tool_calls: toolCallsCount,
    tools_used: [...new Set(toolsUsed)],
    tool_calling_supported: toolCallingSupported,
    final_report: finalReport,
    transcript,
    duration_ms: duration,
  };
}

// ---------------------------------------------------------------------------
// Write output files
// ---------------------------------------------------------------------------

function writeOutputs(result) {
  const safeId = result.model.replace(/[^a-zA-Z0-9_-]/g, "_");

  // JSON transcript
  const jsonPath = join(OUT_DIR, `${safeId}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");

  // Markdown human-readable
  const lines = [
    `# M5 User-Test: ${result.model}`,
    "",
    `**Duration:** ${(result.duration_ms / 1000).toFixed(1)}s  `,
    `**Steps:** ${result.steps}  `,
    `**Tool calls:** ${result.tool_calls}  `,
    `**Tool calling supported:** ${result.tool_calling_supported ? "Yes" : "No"}  `,
    `**Tools used:** ${result.tools_used.join(", ") || "(none)"}`,
    "",
    "## Transcript",
    "",
  ];

  for (const entry of result.transcript) {
    if (entry.type === "tool_call" || entry.type === "tool_call_inline") {
      lines.push(`### Step ${entry.step}: \`${entry.tool}\``);
      lines.push("```json");
      lines.push(JSON.stringify(entry.args, null, 2).slice(0, 400));
      lines.push("```");
      lines.push("**Result:**");
      lines.push("```");
      lines.push(entry.result_summary);
      lines.push("```");
      lines.push("");
    } else if (entry.type === "content") {
      lines.push(`### Step ${entry.step}: Model content`);
      lines.push(entry.content.slice(0, 600));
      lines.push("");
    } else if (entry.type === "error") {
      lines.push(`### Step ${entry.step}: ERROR`);
      lines.push(entry.error ?? "");
      lines.push("");
    }
  }

  lines.push("## UX Report");
  lines.push("");
  lines.push(result.final_report ?? "(no report generated)");
  lines.push("");

  const mdPath = join(OUT_DIR, `${safeId}.md`);
  writeFileSync(mdPath, lines.join("\n"), "utf8");

  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseCLI();

  if (!config.apiKey) {
    console.error(
      "[harness] M5_API_KEY is not set. Run: M5_API_KEY=$(m5-auth) node benchmark/m5-usertest/run.mjs ..."
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  await ensureBuild();

  console.log(`[harness] Connecting to Munin (stdio)...`);
  const { client, tmpDb } = await createMuninClient();

  let tools;
  try {
    tools = await getMuninTools(client);
    console.log(`[harness] Loaded ${tools.length} Munin tools: ${tools.map((t) => t.function.name).join(", ")}`);
  } catch (err) {
    console.error(`[harness] Failed to list Munin tools: ${err.message}`);
    await client.close();
    process.exit(1);
  }

  const summaries = [];

  for (const modelId of config.models) {
    console.log(`\n[harness] === Running model: ${modelId} ===`);
    let result;
    try {
      result = await runModel(config, client, tools, modelId);
    } catch (err) {
      console.error(`  [model] FATAL: ${err.message}`);
      result = {
        model: modelId,
        steps: 0,
        tool_calls: 0,
        tools_used: [],
        tool_calling_supported: false,
        final_report: `Run failed: ${err.message}`,
        transcript: [{ type: "fatal_error", error: err.message }],
        duration_ms: 0,
      };
    }

    const { jsonPath, mdPath } = writeOutputs(result);

    const summary = `${modelId} | steps=${result.steps} tool_calls=${result.tool_calls} supported=${result.tool_calling_supported ? "Y" : "N"} | ${jsonPath}`;
    summaries.push(summary);
    console.log(`  SUMMARY: ${summary}`);
  }

  // Cleanup
  try {
    await client.close();
  } catch {
    // ignore
  }

  console.log("\n[harness] === All models done ===");
  for (const s of summaries) console.log(`  ${s}`);
}

main().catch((err) => {
  console.error("[harness] Unhandled error:", err);
  process.exit(1);
});
