import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { Agent, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { initDatabase, writeState, appendLog } from "../src/db.js";
import {
  startEmbeddingWorker,
  stopEmbeddingWorker,
  resetCircuitBreaker,
  _setExtractorForTesting,
  _embeddingConfig,
} from "../src/embeddings.js";
import {
  startConsolidationWorker,
  stopConsolidationWorker,
  resetConsolidationCircuitBreaker,
  _consolidationConfig,
  _setApiKey,
  _setWorkerDb,
  _resetHealthState,
} from "../src/consolidation.js";
import { createHttpServer, runGracefulShutdown, type ShutdownDeps } from "../src/index.js";
import { createTestStorage } from "./helpers/test-storage.js";

const STORAGE = createTestStorage("graceful-shutdown");

let db: Database.Database;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = initDatabase(STORAGE.path);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  resetCircuitBreaker();
  resetConsolidationCircuitBreaker();
  _resetHealthState();
});

afterEach(async () => {
  vi.useRealTimers();
  await stopEmbeddingWorker().catch(() => {});
  await stopConsolidationWorker().catch(() => {});
  _setExtractorForTesting(null);
  _setApiKey(null);
  _setWorkerDb(null);
  errorSpy.mockRestore();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    // Fresh database per test; the directory is removed in afterAll.
    try {
      unlinkSync(STORAGE.path + suffix);
    } catch {
      // absent sidecar file
    }
  }
});

afterAll(() => {
  STORAGE.cleanup();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    stopEmbeddingWorker: async () => { events.push("stop-embedding"); },
    stopConsolidationWorker: async () => { events.push("stop-consolidation"); },
    closeDatabase: () => { events.push("close-db"); },
    exit: (code) => { events.push(`exit:${code}`); },
    log: () => {},
    ...overrides,
  };
}

describe("runGracefulShutdown ordering and independence (#413)", () => {
  it("stops the consolidation worker even when the embedding stop rejects", async () => {
    const deps = makeDeps({
      stopEmbeddingWorker: async () => {
        throw new Error("embedding stop failed");
      },
    });

    await runGracefulShutdown(deps);

    expect(deps.events).toEqual(["stop-consolidation", "close-db", "exit:1"]);
  });

  it("stops the embedding worker even when the consolidation stop rejects", async () => {
    const deps = makeDeps({
      stopConsolidationWorker: async () => {
        throw new Error("consolidation stop failed");
      },
    });

    await runGracefulShutdown(deps);

    expect(deps.events).toEqual(["stop-embedding", "close-db", "exit:1"]);
  });

  it("closes the database and exits 1 even if closing the database throws", async () => {
    const deps = makeDeps({
      closeDatabase: () => {
        throw new Error("db close failed");
      },
    });

    await runGracefulShutdown(deps);

    expect(deps.events).toEqual(["stop-embedding", "stop-consolidation", "exit:1"]);
  });

  it("exits 0 on a clean shutdown without an HTTP server (stdio)", async () => {
    const deps = makeDeps();

    await runGracefulShutdown(deps);

    expect(deps.events).toEqual(["stop-embedding", "stop-consolidation", "close-db", "exit:0"]);
  });

  it("keeps a non-zero initial exit code (fatal startup path)", async () => {
    const deps = makeDeps({ exitCode: 1 });

    await runGracefulShutdown(deps);

    expect(deps.events).toEqual(["stop-embedding", "stop-consolidation", "close-db", "exit:1"]);
  });
});

describe("runGracefulShutdown with a real HTTP server (#413)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createHttpServer>[0]): Promise<number> {
    server = createHttpServer(handler);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  function get(port: number, agent: Agent | false = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("drains an in-flight request before closing the database, and stops accepting new ones", async () => {
    const release = deferred();
    const arrived = deferred();
    const port = await listen((_req, res) => {
      arrived.resolve();
      void release.promise.then(() => res.end("drained"));
    });

    // Keep-alive client: once its response completes the socket goes idle and
    // must not hold the drain open for the 95 s keep-alive window.
    const agent = new Agent({ keepAlive: true });
    const inFlight = get(port, agent);
    await arrived.promise;

    const deps = makeDeps({ httpServer: server, drainTimeoutMs: 5_000 });
    const shutdown = runGracefulShutdown(deps);

    // The listener is closed promptly while the request is still being served.
    await vi.waitFor(() => expect(server!.listening).toBe(false));
    await expect(get(port)).rejects.toThrow();
    expect(deps.events).toEqual([]);

    release.resolve();
    await expect(inFlight).resolves.toBe("drained");
    await shutdown;
    agent.destroy();

    expect(deps.events).toEqual(["stop-embedding", "stop-consolidation", "close-db", "exit:0"]);
  });

  it("closes idle keep-alive connections instead of waiting for them", async () => {
    const port = await listen((_req, res) => res.end("ok"));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

    const deps = makeDeps({ httpServer: server, drainTimeoutMs: 60_000 });
    // Would hang for the 95 s keep-alive window if idle sockets were not closed.
    await runGracefulShutdown(deps);
    agent.destroy();

    expect(server!.listening).toBe(false);
    expect(deps.events).toEqual(["stop-embedding", "stop-consolidation", "close-db", "exit:0"]);
  });

  it("force-closes a request that outlives the drain timeout, then closes the database", async () => {
    const arrived = deferred();
    const port = await listen((_req, _res) => {
      arrived.resolve(); // never responds
    });

    const inFlight = get(port);
    inFlight.catch(() => {});
    await arrived.promise;

    const deps = makeDeps({ httpServer: server, drainTimeoutMs: 50 });
    await runGracefulShutdown(deps);

    await expect(inFlight).rejects.toThrow();
    expect(deps.events).toEqual(["stop-embedding", "stop-consolidation", "close-db", "exit:0"]);
  });
});

describe("embedding worker stop (#413)", () => {
  function installFailureStatusTrigger() {
    db.exec(`CREATE TRIGGER fail_embedding_failure_status
      BEFORE UPDATE OF embedding_status ON entries
      WHEN NEW.embedding_status = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fixture injected update failure'); END;`);
  }

  async function startBlockedBatch() {
    const entered = deferred();
    const gate = deferred<{ data: Float32Array }>();
    _setExtractorForTesting((async () => {
      entered.resolve();
      return gate.promise;
    }) as never);
    writeState(db, "test/ns", "k1", "content about cats", []);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    startEmbeddingWorker(db);
    await vi.advanceTimersByTimeAsync(_embeddingConfig.batchDelayMs);
    await entered.promise;
    return gate;
  }

  it("leaves no pending timer after stopping while a batch is in flight", async () => {
    const gate = await startBlockedBatch();
    expect(vi.getTimerCount()).toBe(0); // batch running, next one not yet armed

    const stopped = stopEmbeddingWorker();
    gate.resolve({ data: new Float32Array(384) });
    await stopped;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(_embeddingConfig.batchDelayMs * 10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the batch error yet still resets worker state when the in-flight batch fails", async () => {
    installFailureStatusTrigger();
    const gate = await startBlockedBatch();

    const stopped = stopEmbeddingWorker();
    const assertion = expect(stopped).rejects.toThrow("fixture injected update failure");
    gate.reject(new Error("model crashed"));
    await assertion;

    // The failed stop still leaves nothing armed, and a second stop is a no-op.
    expect(vi.getTimerCount()).toBe(0);
    await expect(stopEmbeddingWorker()).resolves.toBeUndefined();
  });

  it("runGracefulShutdown still stops consolidation when the real embedding stop rejects", async () => {
    installFailureStatusTrigger();
    const gate = await startBlockedBatch();
    const consolidationStop = vi.fn(async () => {});

    const deps = makeDeps({
      stopEmbeddingWorker,
      stopConsolidationWorker: consolidationStop,
    });
    const shutdown = runGracefulShutdown(deps);
    gate.reject(new Error("model crashed"));
    await shutdown;

    expect(consolidationStop).toHaveBeenCalledTimes(1);
    expect(deps.events).toEqual(["close-db", "exit:1"]);
  });
});

describe("consolidation worker stop (#413)", () => {
  const okBody = {
    choices: [{
      message: {
        content: JSON.stringify({
          status_content: "## Phase: Active\n\nSynthesis.",
          tags: ["active"],
          cross_references: [],
        }),
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  it("leaves no pending timer after stopping while a batch is in flight", async () => {
    for (let i = 0; i < _consolidationConfig.minLogs; i++) {
      appendLog(db, "projects/shutdown-timer", `Log ${i}`, []);
    }
    const gate = deferred<Response>();
    const entered = deferred();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/key")) {
        return { ok: true, status: 200, text: async () => "" } as unknown as Response;
      }
      entered.resolve();
      return gate.promise;
    }) as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      _setApiKey("fake-key");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      startConsolidationWorker(db);
      await vi.advanceTimersByTimeAsync(_consolidationConfig.intervalMs);
      await entered.promise;
      expect(vi.getTimerCount()).toBe(0); // batch running, next run not yet armed

      const stopped = stopConsolidationWorker();
      gate.resolve({ ok: true, status: 200, json: async () => okBody } as unknown as Response);
      await stopped;

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(_consolidationConfig.intervalMs * 10);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
