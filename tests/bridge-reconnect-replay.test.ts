import { expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, type TransportLike } from "../src/bridge.js";

it("retains a keyed write's recovery instructions when its response fails after reconnect", async () => {
  const key = "11111111-1111-4111-8111-111111111111";
  const sent: JSONRPCMessage[] = [];
  const writes: JSONRPCMessage[] = [];
  const stdio: TransportLike = {
    start: async () => {}, close: async () => {},
    send: async message => { sent.push(message); },
  };
  const initial: TransportLike = {
    start: async () => {}, close: async () => {},
    send: async message => {
      writes.push(message);
      throw new StreamableHTTPError(400, "No valid session");
    },
  };
  let committed = false;
  const replacement: TransportLike = {
    start: async () => {}, close: async () => {},
    send: async message => {
      if ("method" in message && message.method === "initialize" && "id" in message) {
        replacement.onmessage?.({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if ("method" in message && message.method === "tools/call") {
        writes.push(message);
        committed = true;
        throw new TypeError("response body failed after commit");
      }
    },
  };
  let transports = 0;
  const bridge = createBridge({
    stdio, createHttpTransport: () => transports++ === 0 ? initial : replacement,
    supportsWriteReplay: () => true, uuid: () => key, log: () => {}, onExit: () => {},
  });
  try {
    await bridge.start();
    stdio.onmessage?.({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "memory_log", arguments: { namespace: "testing/reconnect", content: "one decision" } },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(committed).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(writes[0]);
    expect(sent[0]).toMatchObject({ error: {
      code: -32000, message: expect.stringContaining(key),
    } });
    expect(JSON.stringify(sent[0])).toContain("exactly the same arguments");
  } finally {
    await bridge.cleanup();
  }
});
