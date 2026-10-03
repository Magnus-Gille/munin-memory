import { describe, it, expect } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createFetchWithTimeout, prepareBridgeWriteMessage } from "../src/bridge.js";

const key = "ABCDEF01-1234-5678-9ABC-123456789ABC";
const write = (name = "memory_log", args: Record<string, unknown> = {}): JSONRPCMessage => ({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name, arguments: { namespace: "testing/replay", content: "hello", ...args } },
});

describe("bridge negotiated write recovery", () => {
  it("injects once only for negotiated write requests and preserves the caller's message", () => {
    const message = write();
    expect(prepareBridgeWriteMessage(message, false, () => key)).toBe(message);
    const keyed = prepareBridgeWriteMessage(message, true, () => key);
    expect(keyed).toMatchObject({ params: { arguments: { idempotency_key: key } } });
    expect(message).not.toMatchObject({ params: { arguments: { idempotency_key: key } } });
    expect(prepareBridgeWriteMessage(keyed, true, () => "different")).toBe(keyed);
    for (const candidate of [
      write("memory_read"), write("unknown_tool"), write("memory_update_status", { validate_only: true }),
      write("memory_log", { idempotency_key: "invalid-explicit-key" }),
      { jsonrpc: "2.0", method: "tools/call", params: { name: "memory_log", arguments: {} } } as JSONRPCMessage,
    ]) expect(prepareBridgeWriteMessage(candidate, true, () => key)).toBe(candidate);
  });

  it("learns capabilities only from successful responses and resets on an older server", async () => {
    const learned: boolean[] = [];
    const responses = [
      new Response("{}", { headers: { "X-Munin-Write-Replay": "v1" } }),
      new Response("{}", { status: 503, headers: { "X-Munin-Write-Replay": "v1" } }),
      new Response("{}"),
    ];
    const fetcher = createFetchWithTimeout(1000, {
      fetchFn: (async () => responses.shift()!) as typeof fetch,
      onWriteReplaySupport: supported => learned.push(supported),
    });
    for (let i = 0; i < 3; i++) await fetcher("http://localhost/mcp");
    expect(learned).toEqual([true, false]);
  });
});
