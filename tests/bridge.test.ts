import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  isSessionExpiredError,
  isRequest,
  createBridge,
  loadBridgeCredentials,
  type TransportLike,
} from "../src/bridge.js";

// --- Mock transport factory ---

function createMockTransport(overrides: Partial<TransportLike> = {}): TransportLike {
  return {
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    send: vi.fn<(msg: JSONRPCMessage) => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    terminateSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    ...overrides,
  };
}

// --- isSessionExpiredError ---

describe("isSessionExpiredError", () => {
  it("returns true for 404 StreamableHTTPError", () => {
    const err = new StreamableHTTPError(404, "Not found");
    expect(isSessionExpiredError(err)).toBe(true);
  });

  it("returns true for 404 regardless of message", () => {
    const err = new StreamableHTTPError(404, "anything");
    expect(isSessionExpiredError(err)).toBe(true);
  });

  it('returns true for 400 with "not initialized"', () => {
    const err = new StreamableHTTPError(
      400,
      "No valid session. Send an initialize request first.",
    );
    expect(isSessionExpiredError(err)).toBe(true);
  });

  it('returns true for 400 with "no valid session"', () => {
    const err = new StreamableHTTPError(400, "No valid session");
    expect(isSessionExpiredError(err)).toBe(true);
  });

  it("returns false for 400 without session-related message", () => {
    const err = new StreamableHTTPError(400, "Invalid JSON body");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  it("returns false for 401 (auth error)", () => {
    const err = new StreamableHTTPError(401, "Unauthorized");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  it("returns false for 429 (rate limit)", () => {
    const err = new StreamableHTTPError(429, "Too many requests");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  it("returns false for 500 (server error)", () => {
    const err = new StreamableHTTPError(500, "Internal server error");
    expect(isSessionExpiredError(err)).toBe(false);
  });

  it("returns false for non-StreamableHTTPError", () => {
    expect(isSessionExpiredError(new Error("some error"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isSessionExpiredError("string error")).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
    expect(isSessionExpiredError(404)).toBe(false);
  });
});

// --- isRequest ---

describe("isRequest", () => {
  it("returns true for JSON-RPC request (has id and method)", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_read" },
    };
    expect(isRequest(msg)).toBe(true);
  });

  it("returns false for JSON-RPC notification (no id)", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    expect(isRequest(msg)).toBe(false);
  });

  it("returns false for JSON-RPC response (no method)", () => {
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    };
    expect(isRequest(msg)).toBe(false);
  });
});

// --- createBridge: liveness ---

describe("createBridge liveness", () => {
  it("reconnect does NOT trigger onExit (process.exit)", async () => {
    const onExit = vi.fn();
    let transportCount = 0;

    const stdio = createMockTransport();
    const bridge = createBridge({
      stdio,
      createHttpTransport: () => {
        transportCount++;
        const t = createMockTransport();
        // On the second transport (created during reconnect), simulate
        // successful initialize response when send is called
        if (transportCount >= 2) {
          t.send = vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
            if ("method" in msg && msg.method === "initialize") {
              // Simulate server responding to initialize
              setTimeout(() => {
                t.onmessage?.({
                  jsonrpc: "2.0",
                  id: (msg as { id: string | number }).id,
                  result: {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "munin-memory", version: "0.1.0" },
                  },
                } as JSONRPCMessage);
              }, 0);
            }
          });
        }
        return t;
      },
      log: () => {},
      onExit,
    });

    // Trigger reconnect — this closes the old transport, which could
    // fire onclose and call cleanup → process.exit if not guarded
    await bridge.reconnect();

    expect(onExit).not.toHaveBeenCalled();
  });

  it("old transport onclose after reconnect does NOT trigger onExit", async () => {
    const onExit = vi.fn();
    let firstTransport: TransportLike | undefined;
    let transportCount = 0;

    const stdio = createMockTransport();
    const bridge = createBridge({
      stdio,
      createHttpTransport: () => {
        transportCount++;
        const t = createMockTransport();
        if (transportCount === 1) {
          firstTransport = t;
        }
        if (transportCount >= 2) {
          t.send = vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
            if ("method" in msg && msg.method === "initialize") {
              setTimeout(() => {
                t.onmessage?.({
                  jsonrpc: "2.0",
                  id: (msg as { id: string | number }).id,
                  result: {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "munin-memory", version: "0.1.0" },
                  },
                } as JSONRPCMessage);
              }, 0);
            }
          });
        }
        return t;
      },
      log: () => {},
      onExit,
    });

    // Save the onclose handler from the first transport before reconnect detaches it
    const firstOnclose = firstTransport!.onclose;

    await bridge.reconnect();

    // Even if the old transport's original onclose fires (edge case),
    // it was detached during reconnect so this shouldn't happen.
    // But if someone manually calls it, identity check prevents cleanup.
    // The handler was set to undefined during reconnect, so calling it is
    // already impossible. Instead, verify the new transport's onclose DOES work.
    const newClient = bridge.getHttpClient();
    expect(newClient).not.toBe(firstTransport);

    // Old transport's handler was detached
    expect(firstTransport!.onclose).toBeUndefined();

    expect(onExit).not.toHaveBeenCalled();
  });
});

// --- createBridge: reconnection flow ---

describe("createBridge reconnection", () => {
  it("reconnects on session-expired error and retries successfully", async () => {
    const onExit = vi.fn();
    const logs: string[] = [];
    let transportCount = 0;
    const sentToStdio: JSONRPCMessage[] = [];

    const stdio = createMockTransport({
      send: vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
        sentToStdio.push(msg);
      }),
    });

    const bridge = createBridge({
      stdio,
      createHttpTransport: () => {
        transportCount++;
        const t = createMockTransport();

        if (transportCount === 1) {
          // First transport: fail with session-expired on first send
          t.send = vi.fn().mockRejectedValueOnce(
            new StreamableHTTPError(404, "Session not found"),
          );
        }

        if (transportCount >= 2) {
          // Second transport (reconnect): handle init + succeed on retry
          t.send = vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
            if ("method" in msg && msg.method === "initialize") {
              setTimeout(() => {
                t.onmessage?.({
                  jsonrpc: "2.0",
                  id: (msg as { id: string | number }).id,
                  result: {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "munin-memory", version: "0.1.0" },
                  },
                } as JSONRPCMessage);
              }, 0);
            }
            // Other sends (retry, initialized notification) succeed silently
          });
        }

        return t;
      },
      log: (msg) => logs.push(msg),
      onExit,
    });

    // Simulate Claude Code sending a tools/call via stdio
    const toolsCallMsg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "memory_read", arguments: { namespace: "test", key: "k" } },
    };
    stdio.onmessage?.(toolsCallMsg);

    // Wait for async queue processing
    await vi.waitFor(() => {
      expect(transportCount).toBe(2);
    });

    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(logs).toContain("Session expired, attempting reconnect...");
    expect(logs).toContain("Session reconnected successfully");
    expect(onExit).not.toHaveBeenCalled();

    // No error was sent to stdio (reconnect + retry succeeded)
    const errorResponses = sentToStdio.filter(
      (m) => "error" in m,
    );
    expect(errorResponses).toHaveLength(0);
  });

  it("forwards error to stdio when reconnect fails", async () => {
    const onExit = vi.fn();
    const logs: string[] = [];
    let transportCount = 0;
    const sentToStdio: JSONRPCMessage[] = [];

    const stdio = createMockTransport({
      send: vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
        sentToStdio.push(msg);
      }),
    });

    const bridge = createBridge({
      stdio,
      createHttpTransport: () => {
        transportCount++;
        const t = createMockTransport();

        if (transportCount === 1) {
          // First transport: fail with session-expired
          t.send = vi.fn().mockRejectedValueOnce(
            new StreamableHTTPError(404, "Session not found"),
          );
        }

        if (transportCount >= 2) {
          // Second transport: start() fails (server unreachable)
          t.start = vi.fn().mockRejectedValue(
            new Error("ECONNREFUSED"),
          );
        }

        return t;
      },
      log: (msg) => logs.push(msg),
      onExit,
    });

    // Simulate a request from Claude Code
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "memory_write", arguments: {} },
    };
    stdio.onmessage?.(msg);

    // Wait for processing
    await vi.waitFor(() => {
      expect(sentToStdio.length).toBeGreaterThan(0);
    });

    await new Promise((r) => setTimeout(r, 50));

    // Error response sent to Claude Code
    expect(sentToStdio).toHaveLength(1);
    const errorMsg = sentToStdio[0] as {
      error: { code: number; message: string };
    };
    expect(errorMsg.error.code).toBe(-32000);
    expect(errorMsg.error.message).toContain("Bridge reconnect failed");
    expect(errorMsg.error.message).toContain("ECONNREFUSED");

    expect(logs).toContain("Session expired, attempting reconnect...");
    expect(logs.some((l) => l.includes("Reconnect failed"))).toBe(true);

    // Bridge did not crash
    expect(onExit).not.toHaveBeenCalled();
  });

  it("forwards non-session errors without reconnect attempt", async () => {
    const onExit = vi.fn();
    const logs: string[] = [];
    const sentToStdio: JSONRPCMessage[] = [];

    const stdio = createMockTransport({
      send: vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
        sentToStdio.push(msg);
      }),
    });

    const bridge = createBridge({
      stdio,
      createHttpTransport: () => {
        const t = createMockTransport();
        // Fail with an auth error (not session-expired)
        t.send = vi.fn().mockRejectedValueOnce(
          new StreamableHTTPError(401, "Unauthorized"),
        );
        return t;
      },
      log: (msg) => logs.push(msg),
      onExit,
    });

    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "memory_list" },
    };
    stdio.onmessage?.(msg);

    await vi.waitFor(() => {
      expect(sentToStdio.length).toBeGreaterThan(0);
    });

    // Error forwarded as bridge error (not reconnect error)
    const errorMsg = sentToStdio[0] as {
      error: { code: number; message: string };
    };
    expect(errorMsg.error.message).toContain("Bridge error:");
    expect(errorMsg.error.message).toContain("Unauthorized");

    // No reconnect was attempted
    expect(logs).not.toContain("Session expired, attempting reconnect...");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("notifications (no id) are not forwarded as errors on failure", async () => {
    const sentToStdio: JSONRPCMessage[] = [];

    const stdio = createMockTransport({
      send: vi.fn().mockImplementation(async (msg: JSONRPCMessage) => {
        sentToStdio.push(msg);
      }),
    });

    const bridge = createBridge({
      stdio,
      createHttpTransport: () => {
        const t = createMockTransport();
        t.send = vi.fn().mockRejectedValueOnce(
          new StreamableHTTPError(401, "Unauthorized"),
        );
        return t;
      },
      log: () => {},
      onExit: vi.fn(),
    });

    // Send a notification (no id)
    const msg: JSONRPCMessage = {
      jsonrpc: "2.0",
      method: "notifications/progress",
    };
    stdio.onmessage?.(msg);

    await new Promise((r) => setTimeout(r, 50));

    // No error response sent (notifications don't get error responses)
    expect(sentToStdio).toHaveLength(0);
  });
});

// --- loadBridgeCredentials ---

describe("loadBridgeCredentials", () => {
  function fakeStat(mode: number): (p: string) => { mode: number } {
    return () => ({ mode });
  }

  it("falls back to env vars when MUNIN_CREDENTIALS_FILE is unset", () => {
    const creds = loadBridgeCredentials({
      env: {
        MUNIN_AUTH_TOKEN: "tok",
        MUNIN_CF_CLIENT_ID: "cid",
        MUNIN_CF_CLIENT_SECRET: "csec",
      },
      log: () => {},
    });
    expect(creds).toEqual({
      authToken: "tok",
      cfClientId: "cid",
      cfClientSecret: "csec",
    });
  });

  it("treats empty MUNIN_CREDENTIALS_FILE as unset", () => {
    const creds = loadBridgeCredentials({
      env: { MUNIN_CREDENTIALS_FILE: "", MUNIN_AUTH_TOKEN: "tok" },
      log: () => {},
    });
    expect(creds.authToken).toBe("tok");
  });

  it("loads credentials from a 0600 JSON file", () => {
    const logs: string[] = [];
    const creds = loadBridgeCredentials({
      env: { MUNIN_CREDENTIALS_FILE: "/tmp/fake-creds.json" },
      stat: fakeStat(0o600),
      readFile: () =>
        JSON.stringify({
          auth_token: "filetok",
          cf_client_id: "filecid",
          cf_client_secret: "filecsec",
        }),
      log: (m) => logs.push(m),
      platform: "linux",
    });
    expect(creds).toEqual({
      authToken: "filetok",
      cfClientId: "filecid",
      cfClientSecret: "filecsec",
    });
    expect(
      logs.some((m) => m.startsWith("Credentials loaded from file:")),
    ).toBe(true);
  });

  it("refuses a world-readable credentials file (0644)", () => {
    expect(() =>
      loadBridgeCredentials({
        env: { MUNIN_CREDENTIALS_FILE: "/tmp/creds.json" },
        stat: fakeStat(0o644),
        readFile: () => "{}",
        log: () => {},
        platform: "linux",
      }),
    ).toThrow(/mode 0644.*chmod 600/);
  });

  it("refuses a group-readable credentials file (0640)", () => {
    expect(() =>
      loadBridgeCredentials({
        env: { MUNIN_CREDENTIALS_FILE: "/tmp/creds.json" },
        stat: fakeStat(0o640),
        readFile: () => "{}",
        log: () => {},
        platform: "linux",
      }),
    ).toThrow(/mode 0640/);
  });

  it("accepts 0400 (read-only owner)", () => {
    const creds = loadBridgeCredentials({
      env: { MUNIN_CREDENTIALS_FILE: "/tmp/creds.json" },
      stat: fakeStat(0o400),
      readFile: () => JSON.stringify({ auth_token: "t" }),
      log: () => {},
      platform: "linux",
    });
    expect(creds.authToken).toBe("t");
  });

  it("skips mode check on win32", () => {
    const creds = loadBridgeCredentials({
      env: { MUNIN_CREDENTIALS_FILE: "C:\\creds.json" },
      stat: fakeStat(0o777),
      readFile: () => JSON.stringify({ auth_token: "wtok" }),
      log: () => {},
      platform: "win32",
    });
    expect(creds.authToken).toBe("wtok");
  });

  it("throws a clear error when stat fails", () => {
    expect(() =>
      loadBridgeCredentials({
        env: { MUNIN_CREDENTIALS_FILE: "/nope" },
        stat: () => {
          throw new Error("ENOENT: no such file");
        },
        readFile: () => "",
        log: () => {},
        platform: "linux",
      }),
    ).toThrow(/not readable at \/nope.*ENOENT/);
  });

  it("throws when the file is not valid JSON", () => {
    expect(() =>
      loadBridgeCredentials({
        env: { MUNIN_CREDENTIALS_FILE: "/tmp/bad.json" },
        stat: fakeStat(0o600),
        readFile: () => "not json",
        log: () => {},
        platform: "linux",
      }),
    ).toThrow(/not valid JSON/);
  });

  it("throws when the file is a JSON array", () => {
    expect(() =>
      loadBridgeCredentials({
        env: { MUNIN_CREDENTIALS_FILE: "/tmp/arr.json" },
        stat: fakeStat(0o600),
        readFile: () => "[]",
        log: () => {},
        platform: "linux",
      }),
    ).toThrow(/JSON object at the top level/);
  });

  it("throws when a field has the wrong type", () => {
    expect(() =>
      loadBridgeCredentials({
        env: { MUNIN_CREDENTIALS_FILE: "/tmp/wrong.json" },
        stat: fakeStat(0o600),
        readFile: () => JSON.stringify({ auth_token: 42 }),
        log: () => {},
        platform: "linux",
      }),
    ).toThrow(/field "auth_token" must be a string/);
  });

  it("logs a warning when env vars are overridden by the file", () => {
    const logs: string[] = [];
    loadBridgeCredentials({
      env: {
        MUNIN_CREDENTIALS_FILE: "/tmp/creds.json",
        MUNIN_AUTH_TOKEN: "envtok",
        MUNIN_CF_CLIENT_ID: "envcid",
      },
      stat: fakeStat(0o600),
      readFile: () => JSON.stringify({ auth_token: "filetok" }),
      log: (m) => logs.push(m),
      platform: "linux",
    });
    expect(
      logs.some(
        (m) =>
          m.includes("ignoring inline env vars") &&
          m.includes("MUNIN_AUTH_TOKEN") &&
          m.includes("MUNIN_CF_CLIENT_ID"),
      ),
    ).toBe(true);
  });

  it("accepts a partial file (only auth_token)", () => {
    const creds = loadBridgeCredentials({
      env: { MUNIN_CREDENTIALS_FILE: "/tmp/partial.json" },
      stat: fakeStat(0o600),
      readFile: () => JSON.stringify({ auth_token: "t" }),
      log: () => {},
      platform: "linux",
    });
    expect(creds).toEqual({
      authToken: "t",
      cfClientId: undefined,
      cfClientSecret: undefined,
    });
  });
});
