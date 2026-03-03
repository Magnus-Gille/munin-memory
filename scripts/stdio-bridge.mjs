#!/usr/bin/env node

/**
 * munin-bridge: MCP stdio-to-HTTP bridge
 *
 * Reads JSON-RPC from stdin, POSTs to a remote MCP Streamable HTTP server,
 * writes responses to stdout. Each process manages its own session.
 *
 * Replaces mcp-remote to avoid shared-session multiplexing bugs —
 * every Claude Code / Desktop session spawns its own bridge process.
 *
 * Environment variables:
 *   MUNIN_REMOTE_URL        — Required. Remote MCP endpoint URL.
 *   MUNIN_AUTH_TOKEN         — Bearer token for Authorization header.
 *   MUNIN_CF_CLIENT_ID       — Cloudflare Access client ID.
 *   MUNIN_CF_CLIENT_SECRET   — Cloudflare Access client secret.
 */

import { createInterface } from "node:readline";

// --- Configuration ---

const REMOTE_URL = process.env.MUNIN_REMOTE_URL;
if (!REMOTE_URL) {
  process.stderr.write("Fatal: MUNIN_REMOTE_URL is required\n");
  process.exit(1);
}

const authHeaders = {};
if (process.env.MUNIN_AUTH_TOKEN) {
  authHeaders["Authorization"] = `Bearer ${process.env.MUNIN_AUTH_TOKEN}`;
}
if (process.env.MUNIN_CF_CLIENT_ID) {
  authHeaders["CF-Access-Client-Id"] = process.env.MUNIN_CF_CLIENT_ID;
}
if (process.env.MUNIN_CF_CLIENT_SECRET) {
  authHeaders["CF-Access-Client-Secret"] = process.env.MUNIN_CF_CLIENT_SECRET;
}

// --- State ---

let sessionId = null;
let stdinClosed = false;

// Sequential queue — MCP messages must be processed in order
const queue = [];
let processing = false;

// --- Helpers ---

function isNotification(msg) {
  return msg.jsonrpc === "2.0" && msg.method && !("id" in msg);
}

function writeStdout(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(msg) {
  process.stderr.write(`[munin-bridge] ${msg}\n`);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// --- SSE parser ---

function parseSseEvents(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data && data !== "[DONE]") {
        try {
          messages.push(JSON.parse(data));
        } catch {
          log(`SSE: unparseable data line: ${data}`);
        }
      }
    }
  }
  return messages;
}

// --- Core: forward a single message to the remote server ---

async function forwardToRemote(message) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...authHeaders,
  };

  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const notification = isNotification(message);

  try {
    const response = await fetch(REMOTE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    // Capture session ID from response
    const sid = response.headers.get("mcp-session-id");
    if (sid) {
      sessionId = sid;
    }

    // Non-OK response
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log(`HTTP ${response.status}: ${errorBody}`);
      if (!notification) {
        writeStdout(
          jsonRpcError(
            message.id,
            -32000,
            `HTTP ${response.status}: ${errorBody}`,
          ),
        );
      }
      return;
    }

    // Notifications: server may respond 202/204 with no body
    if (notification) {
      return;
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const messages = parseSseEvents(text);
      for (const msg of messages) {
        writeStdout(msg);
      }
    } else {
      const body = await response.text();
      if (body && body.trim()) {
        // Server may return a single JSON-RPC response or an array (batch)
        writeStdout(JSON.parse(body));
      }
    }
  } catch (err) {
    log(`Fetch error: ${err.message}`);
    if (!notification) {
      writeStdout(
        jsonRpcError(message.id, -32000, `Bridge error: ${err.message}`),
      );
    }
  }
}

// --- Queue processor ---

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const message = queue.shift();
    await forwardToRemote(message);
  }

  processing = false;

  // If stdin has closed and queue is drained, exit cleanly
  if (stdinClosed) {
    cleanup();
  }
}

function enqueue(message) {
  queue.push(message);
  processQueue();
}

// --- Stdin reader ---

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log(`Invalid JSON on stdin: ${line.slice(0, 200)}`);
    return;
  }

  enqueue(message);
});

rl.on("close", () => {
  stdinClosed = true;
  // If nothing is in-flight, exit now. Otherwise processQueue will exit.
  if (!processing && queue.length === 0) {
    cleanup();
  }
});

function cleanup() {
  // Best-effort session cleanup with the remote server
  if (sessionId) {
    fetch(REMOTE_URL, {
      method: "DELETE",
      headers: { ...authHeaders, "mcp-session-id": sessionId },
    })
      .catch(() => {})
      .finally(() => process.exit(0));
    // Fallback if DELETE hangs
    setTimeout(() => process.exit(0), 1000);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

log(`Bridge started → ${REMOTE_URL}`);
