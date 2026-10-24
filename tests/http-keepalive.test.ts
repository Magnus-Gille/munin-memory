import { describe, it, expect, afterEach } from "vitest";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Server } from "node:http";
import { createHttpServer, HTTP_KEEP_ALIVE_TIMEOUT_MS } from "../src/index.js";

// cloudflared's default originRequest.keepAliveTimeout. The origin must keep
// idle connections open longer than the proxy, or the proxy can write a request
// into a socket the origin is closing and get a connection reset (#404).
const CLOUDFLARED_DEFAULT_KEEP_ALIVE_MS = 90_000;
// Node closes idle sockets after its 5 s default keepAliveTimeout, plus the
// 1 s keepAliveTimeoutBuffer on Node versions that have one; idle past both.
const IDLE_PAST_NODE_DEFAULT_MS = 6_500;

const REQUEST = "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n";

let server: Server | undefined;
let socket: Socket | undefined;

afterEach(async () => {
  socket?.destroy();
  socket = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function readResponse(sock: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\r\n\r\nok")) {
        cleanup();
        resolve(data);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before response"));
    };
    const cleanup = () => {
      sock.off("data", onData);
      sock.off("close", onClose);
    };
    sock.on("data", onData);
    sock.on("close", onClose);
  });
}

describe("HTTP server keep-alive (#404)", () => {
  it("keeps idle connections open longer than cloudflared's origin pool", () => {
    server = createHttpServer((_req, res) => res.end("ok"));
    expect(HTTP_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(CLOUDFLARED_DEFAULT_KEEP_ALIVE_MS);
    expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(10_000);
  });

  it(
    "serves a second request on a connection that idled past Node's default keep-alive",
    async () => {
      server = createHttpServer((_req, res) => res.end("ok"));
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
      const { port } = server.address() as AddressInfo;

      const sock = connect(port, "127.0.0.1");
      socket = sock;
      let closedByServer = false;
      sock.on("close", () => {
        closedByServer = true;
      });
      await new Promise<void>((resolve) => sock.once("connect", () => resolve()));

      sock.write(REQUEST);
      expect(await readResponse(sock)).toMatch(/^HTTP\/1\.1 200/);

      // A reverse proxy reuses this pooled connection after an idle gap.
      await new Promise((resolve) => setTimeout(resolve, IDLE_PAST_NODE_DEFAULT_MS));
      expect(closedByServer).toBe(false);

      sock.write(REQUEST);
      expect(await readResponse(sock)).toMatch(/^HTTP\/1\.1 200/);
    },
    IDLE_PAST_NODE_DEFAULT_MS + 5_000,
  );
});
