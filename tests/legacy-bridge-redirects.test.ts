import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bridgePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "stdio-bridge.mjs",
);
const synthetic = {
  token: "synthetic-bearer-redirect-test",
  clientId: "synthetic-cf-client-id",
  clientSecret: "synthetic-cf-client-secret",
  body: "synthetic-request-body-must-not-leak",
  sessionId: "synthetic-session-id",
};
const servers: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(servers.splice(0).map(closeServer));
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function origin(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

interface BridgeResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function runBridge(remoteUrl: string, input: string, mockedRedirectTarget?: string): Promise<BridgeResult> {
  const args = mockedRedirectTarget === undefined
    ? [bridgePath]
    : [
        "--input-type=module",
        "-e",
        `let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls > 1) console.error("MOCK_SECOND_FETCH_REACHED");
  if (calls === 1) return new Response("", { status: 307, headers: { location: process.env.BRIDGE_TEST_LOCATION } });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { followed: true } }), { status: 200, headers: { "content-type": "application/json" } });
};
await import(process.argv[1]);`,
        bridgePath,
      ];
  const child = spawn(process.execPath, args, {
    // The bridge does not need the test runner's environment. Keep this list
    // explicit so tests cannot accidentally pass a real credential or proxy.
    env: {
      MUNIN_REMOTE_URL: remoteUrl,
      MUNIN_AUTH_TOKEN: synthetic.token,
      MUNIN_CF_CLIENT_ID: synthetic.clientId,
      MUNIN_CF_CLIENT_SECRET: synthetic.clientSecret,
      ...(mockedRedirectTarget === undefined ? {} : { BRIDGE_TEST_LOCATION: mockedRedirectTarget }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("stdio bridge subprocess timed out"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

function rpcResult(stdout: string): unknown {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines[0]!) as unknown : undefined;
}

function assertStaticRedirectFailure(
  result: BridgeResult,
  expectRpcError = true,
  ...untrusted: string[]
) {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output.toLowerCase()).toContain("redirect");
  for (const value of untrusted) if (value) expect(output).not.toContain(value);
  const rpc = rpcResult(result.stdout) as { error?: { code?: number; message?: string } } | undefined;
  if (expectRpcError) {
    expect(rpc?.error).toBeDefined();
  }
  if (rpc?.error) {
    expect(rpc.error.code).toBe(-32000);
    expect(rpc.error.message?.toLowerCase()).toContain("redirect");
  }
}

function assertStaticInitialUrlFailure(result: BridgeResult, ...untrusted: string[]) {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output.toLowerCase()).toMatch(/url|http/);
  for (const value of untrusted) expect(output).not.toContain(value);
}

async function postMessage(): Promise<string> {
  return `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/call", params: synthetic.body })}\n`;
}

describe("legacy stdio bridge redirect policy", () => {
  it.each([301, 302, 303, 307, 308])(
    "refuses cross-port POST redirect status %i without contacting the target",
    async (status) => {
      let targetHits = 0;
      const target = await listen((_req, res) => {
        targetHits++;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      const source = await listen((_req, res) => {
        res.writeHead(status, { location: `${origin(target)}/capture` }).end(synthetic.body);
      });

      const result = await runBridge(`${origin(source)}/mcp`, await postMessage());

      expect(targetHits).toBe(0);
      assertStaticRedirectFailure(result, true, origin(target), synthetic.body, synthetic.token, synthetic.clientId, synthetic.clientSecret);
    },
  );

  it.each([301, 302, 303])(
    "refuses same-origin POST redirect status %i without contacting the target",
    async (status) => {
      let targetHits = 0;
      const server = await listen((req, res) => {
        if (req.url === "/capture") {
          targetHits++;
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }
        res.writeHead(status, { location: "/capture" }).end(synthetic.body);
      });

      const result = await runBridge(`${origin(server)}/mcp`, await postMessage());

      expect(targetHits).toBe(0);
      assertStaticRedirectFailure(result, true, "/capture", synthetic.body, synthetic.token, synthetic.clientId, synthetic.clientSecret);
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "refuses cross-port EOF DELETE redirect status %i without contacting the target",
    async (status) => {
      let targetHits = 0;
      const target = await listen((_req, res) => {
        targetHits++;
        res.writeHead(204).end();
      });
      const source = await listen((req, res) => {
        if (req.method === "POST") {
          res.writeHead(200, { "mcp-session-id": synthetic.sessionId }).end(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          );
        } else if (req.method === "DELETE") {
          res.writeHead(status, { location: `${origin(target)}/capture` }).end(synthetic.body);
        } else {
          res.writeHead(405).end();
        }
      });

      const result = await runBridge(`${origin(source)}/mcp`, await postMessage());

      expect(targetHits).toBe(0);
      expect(result.stdout).toContain('"ok":true');
      assertStaticRedirectFailure(result, false, origin(target), synthetic.body, synthetic.token, synthetic.clientId, synthetic.clientSecret);
    },
  );

  it.each([301, 302, 303])(
    "refuses same-origin EOF DELETE redirect status %i without contacting the target",
    async (status) => {
      let targetHits = 0;
      const server = await listen(async (req, res) => {
        await readBody(req);
        if (req.method === "POST") {
          res.writeHead(200, { "mcp-session-id": synthetic.sessionId }).end(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          );
        } else if (req.url === "/mcp") {
          res.writeHead(status, { location: "/delete-target" }).end(synthetic.body);
        } else {
          targetHits++;
          res.writeHead(204).end();
        }
      });

      const result = await runBridge(`${origin(server)}/mcp`, await postMessage());

      expect(targetHits).toBe(0);
      expect(result.stdout).toContain('"ok":true');
      assertStaticRedirectFailure(result, false, "/delete-target", synthetic.body, synthetic.token, synthetic.clientId, synthetic.clientSecret);
    },
  );

  it.each([
    { status: 307, location: "/redirected-relative" },
    { status: 308, location: "absolute" },
  ])("follows same-origin POST $status redirect and preserves request", async ({ status, location }) => {
    const seen: Array<{ method: string; url: string; body: string; headers: IncomingMessage["headers"] }> = [];
    let base = "";
    const server = await listen(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method ?? "", url: req.url ?? "", body, headers: req.headers });
      if (req.url === "/mcp") {
        const target = "/redirected-absolute";
        res.writeHead(status, { location: location === "absolute" ? `${base}${target}` : location }).end();
      } else {
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { redirected: true } }));
      }
    });
    base = origin(server);

    const result = await runBridge(`${base}/mcp`, await postMessage());

    expect(result.code).toBe(0);
    expect(rpcResult(result.stdout)).toMatchObject({ id: 1, result: { redirected: true } });
    expect(seen.map(({ method }) => method)).toEqual(["POST", "POST"]);
    expect(seen[1]!.body).toBe(seen[0]!.body);
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${synthetic.token}`);
    expect(seen[1]!.headers["cf-access-client-id"]).toBe(synthetic.clientId);
    expect(seen[1]!.headers["cf-access-client-secret"]).toBe(synthetic.clientSecret);
    expect(seen[1]!.headers["content-type"]).toBe("application/json");
    expect(seen[1]!.headers.accept).toBe("application/json, text/event-stream");
  });

  it.each([
    { name: "scheme change", target: "https://bridge.mock.test/private-target" },
    { name: "hostname change", target: "http://other.mock.test/private-target" },
    { name: "URL userinfo", target: "http://user:pass@bridge.mock.test/private-target" },
  ])("refuses mocked $name redirect before a second fetch", async ({ target }) => {
    const result = await runBridge(
      "http://bridge.mock.test/mcp",
      await postMessage(),
      target,
    );

    expect(result.stderr).not.toContain("MOCK_SECOND_FETCH_REACHED");
    assertStaticRedirectFailure(
      result,
      true,
      target,
      synthetic.body,
      synthetic.token,
      synthetic.clientId,
      synthetic.clientSecret,
    );
  });

  it.each([307, 308])("follows same-origin EOF DELETE %i and preserves session header", async (status) => {
    const seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"] }> = [];
    const server = await listen(async (req, res) => {
      await readBody(req);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      if (req.method === "POST") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": synthetic.sessionId,
        }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      } else if (req.url === "/mcp") {
        res.writeHead(status, { location: "/delete-target" }).end();
      } else {
        res.writeHead(204).end();
      }
    });

    const result = await runBridge(`${origin(server)}/mcp`, await postMessage());

    expect(result.code).toBe(0);
    expect(seen.map(({ method }) => method)).toEqual(["POST", "DELETE", "DELETE"]);
    expect(seen[1]!.headers["mcp-session-id"]).toBe(synthetic.sessionId);
    expect(seen[2]!.headers["mcp-session-id"]).toBe(synthetic.sessionId);
  });

  it("preserves JSON, SSE, notification, and session behavior across ordinary requests", async () => {
    const seen: Array<{ body: string; session: string | undefined }> = [];
    let cleanupSession: string | undefined;
    const server = await listen(async (req, res) => {
      if (req.method === "DELETE") {
        cleanupSession = req.headers["mcp-session-id"] as string | undefined;
        res.writeHead(204).end();
        return;
      }
      const body = await readBody(req);
      seen.push({ body, session: req.headers["mcp-session-id"] as string | undefined });
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === "test/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": synthetic.sessionId })
          .end('data: {"jsonrpc":"2.0","id":2,"result":{"sse":true}}\n\n');
      } else if (message.method === "test/notify") {
        res.writeHead(202, { "mcp-session-id": synthetic.sessionId }).end();
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": synthetic.sessionId })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { json: true } }));
      }
    });
    const input = [
      { jsonrpc: "2.0", id: 1, method: "test/json" },
      { jsonrpc: "2.0", id: 2, method: "test/sse" },
      { jsonrpc: "2.0", method: "test/notify" },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";

    const result = await runBridge(`${origin(server)}/mcp`, input);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"json":true');
    expect(result.stdout).toContain('"sse":true');
    expect(result.stdout.match(/"jsonrpc"/g)).toHaveLength(2);
    expect(seen).toHaveLength(3);
    expect(seen[1]!.session).toBe(synthetic.sessionId);
    expect(seen[2]!.session).toBe(synthetic.sessionId);
    expect(cleanupSession).toBe(synthetic.sessionId);
  });

  it("refuses a redirect chain beyond five followed hops with a static error", async () => {
    let hits = 0;
    const server = await listen((_req, res) => {
      hits++;
      res.writeHead(307, { location: "/loop" }).end(synthetic.body);
    });

    const result = await runBridge(`${origin(server)}/start`, await postMessage());

    expect(hits).toBe(6); // initial request plus at most five followed redirects
    assertStaticRedirectFailure(result, true, "/loop", synthetic.body, synthetic.token, synthetic.clientId, synthetic.clientSecret);
  });

  it.each([
    { name: "missing Location", location: undefined, leaked: "" },
    { name: "malformed Location", location: "http://[::invalid", leaked: "http://[::invalid" },
    { name: "URL userinfo", location: "http://user:pass@127.0.0.1/private", leaked: "user:pass" },
    { name: "unsupported scheme", location: "file:///private/redirect-target", leaked: "file:///private/redirect-target" },
  ])("refuses $name without reflecting target or body", async ({ location, leaked }) => {
    const server = await listen((_req, res) => {
      const headers: Record<string, string> = {};
      if (location !== undefined) headers.location = location;
      res.writeHead(307, headers).end(synthetic.body);
    });

    const result = await runBridge(`${origin(server)}/mcp`, await postMessage());

    assertStaticRedirectFailure(result, true, leaked, synthetic.body, synthetic.token, synthetic.clientId, synthetic.clientSecret);
  });

  it.each(["http://user:pass@127.0.0.1:1/mcp", "file:///private/bridge-target", "not a URL"]) (
    "rejects unsafe initial remote URL %s before making a request",
    async (remoteUrl) => {
      let hits = 0;
      const server = await listen((_req, res) => {
        hits++;
        res.writeHead(200).end("{}");
      });

      const result = await runBridge(remoteUrl.replace(":1/", `:${(server.address() as AddressInfo).port}/`), await postMessage());

      expect(hits).toBe(0);
      expect(result.code).toBe(1);
      assertStaticInitialUrlFailure(
        result,
        "user:pass",
        synthetic.body,
        synthetic.token,
        synthetic.clientId,
        synthetic.clientSecret,
      );
    },
  );
});
