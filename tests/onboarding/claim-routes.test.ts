import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { DeviceState, hashSecret } from "../../src/onboarding/state.js";
import type { DeviceStateData } from "../../src/onboarding/state.js";
import { createClaimRoutes, createAdminRoutes } from "../../src/onboarding/claim-routes.js";

const TEST_DIR = "/tmp/munin-claim-routes-test";
const STATE_FILE = join(TEST_DIR, "device-state.json");
const ENV_FILE = join(TEST_DIR, ".env");

function cleanup() {
  for (const f of [STATE_FILE, STATE_FILE + ".tmp", ENV_FILE, ENV_FILE + ".tmp"]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
  // Clean up any tmp files
  try {
    const { readdirSync } = require("node:fs");
    for (const f of readdirSync(TEST_DIR)) {
      if (f.startsWith(".env.tmp")) {
        unlinkSync(join(TEST_DIR, f));
      }
    }
  } catch {}
}

const CLAIM_CODE = "HT7K2M";
const CLAIM_CODE_HASH = hashSecret(CLAIM_CODE);

function makeState(overrides?: Partial<DeviceStateData>): DeviceStateData {
  return {
    state: "RUNNING_UNCLAIMED",
    deviceId: "a1b2",
    claimCodeHash: CLAIM_CODE_HASH,
    wifiPasswordHash: hashSecret("kR4mPx7n"),
    wifiSsid: "HomeNet",
    ...overrides,
  };
}

let ds: DeviceState;
let transitionCalled: boolean;

function makeClaimApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(createClaimRoutes({
    deviceState: ds,
    envFilePath: ENV_FILE,
    hostname: "munin-a1b2.local",
    ip: "192.168.1.42",
    onTransition: () => { transitionCalled = true; },
  }));
  return app;
}

function makeAdminApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(createAdminRoutes({
    deviceState: ds,
    envFilePath: ENV_FILE,
    hostname: "munin-a1b2.local",
    onTransition: () => { transitionCalled = true; },
  }));
  return app;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  cleanup();
  ds = new DeviceState(STATE_FILE);
  transitionCalled = false;
});

afterEach(cleanup);

// --- Claim routes ---

describe("GET /setup/claim", () => {
  it("shows claim page when RUNNING_UNCLAIMED", async () => {
    ds.save(makeState());
    const app = makeClaimApp();
    const res = await request(app).get("/setup/claim");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Claim");
    expect(res.text).toContain("MuninMemory-a1b2");
  });

  it("shows already-claimed page when CLAIMED", async () => {
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc", claimedAt: "2026-01-01" }));
    const app = makeClaimApp();
    const res = await request(app).get("/setup/claim");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Already Claimed");
  });
});

describe("POST /setup/claim", () => {
  it("succeeds with correct claim code", async () => {
    ds.save(makeState());
    const app = makeClaimApp();
    const res = await request(app)
      .post("/setup/claim")
      .send(`claimCode=${CLAIM_CODE}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Setup Complete");
    expect(res.text).toContain("API Key");

    // State should be CLAIMED
    const state = ds.load();
    expect(state!.state).toBe("CLAIMED");
    expect(state!.claimedAt).toBeDefined();
    expect(state!.apiKeyHash).toBeDefined();

    // .env should exist with API key
    const env = readFileSync(ENV_FILE, "utf-8");
    expect(env).toContain("MUNIN_API_KEY=");
  });

  it("succeeds with lowercase claim code", async () => {
    ds.save(makeState());
    const app = makeClaimApp();
    const res = await request(app)
      .post("/setup/claim")
      .send(`claimCode=${CLAIM_CODE.toLowerCase()}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Setup Complete");
  });

  it("rejects wrong claim code with 403", async () => {
    ds.save(makeState());
    const app = makeClaimApp();
    const res = await request(app)
      .post("/setup/claim")
      .send("claimCode=WRONG1");

    expect(res.status).toBe(403);
    expect(res.text).toContain("Invalid claim code");
    expect(ds.load()!.state).toBe("RUNNING_UNCLAIMED");
  });

  it("rejects short claim code", async () => {
    ds.save(makeState());
    const app = makeClaimApp();
    const res = await request(app)
      .post("/setup/claim")
      .send("claimCode=AB");

    expect(res.status).toBe(200); // Shows form with error
    expect(res.text).toContain("6-character");
  });

  it("returns 409 when already claimed", async () => {
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc" }));
    const app = makeClaimApp();
    const res = await request(app)
      .post("/setup/claim")
      .send(`claimCode=${CLAIM_CODE}`);

    expect(res.status).toBe(409);
    expect(res.text).toContain("Already Claimed");
  });

  it("rate limits after too many attempts", async () => {
    ds.save(makeState());
    const app = makeClaimApp();

    // Make 6 attempts (limit is 5/min)
    for (let i = 0; i < 5; i++) {
      await request(app).post("/setup/claim").send("claimCode=WRONG1");
    }

    const res = await request(app)
      .post("/setup/claim")
      .send("claimCode=WRONG1");

    expect(res.status).toBe(429);
    expect(res.text).toContain("Too many attempts");
  });
});

describe("GET / (RUNNING_UNCLAIMED)", () => {
  it("redirects to /setup/claim", async () => {
    ds.save(makeState());
    const app = makeClaimApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/setup/claim");
  });
});

// --- Admin routes ---

describe("POST /admin/regenerate-key", () => {
  it("regenerates API key with valid claim code", async () => {
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: hashSecret("old-key"), claimedAt: "2026-01-01" }));
    const app = makeAdminApp();
    const res = await request(app)
      .post("/admin/regenerate-key")
      .send({ claimCode: CLAIM_CODE });

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.apiKey).toHaveLength(64); // 32 bytes hex
    expect(res.body.mcpConfig).toBeDefined();

    // .env should be updated
    const env = readFileSync(ENV_FILE, "utf-8");
    expect(env).toContain(`MUNIN_API_KEY=${res.body.apiKey}`);
  });

  it("rejects wrong claim code", async () => {
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc" }));
    const app = makeAdminApp();
    const res = await request(app)
      .post("/admin/regenerate-key")
      .send({ claimCode: "WRONG1" });

    expect(res.status).toBe(403);
  });

  it("returns 404 when not claimed", async () => {
    ds.save(makeState({ state: "RUNNING_UNCLAIMED" }));
    const app = makeAdminApp();
    const res = await request(app)
      .post("/admin/regenerate-key")
      .send({ claimCode: CLAIM_CODE });

    expect(res.status).toBe(404);
  });
});

describe("POST /admin/reset", () => {
  it("initiates factory reset with valid claim code", async () => {
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc" }));
    const app = makeAdminApp();
    const res = await request(app)
      .post("/admin/reset")
      .send({ claimCode: CLAIM_CODE });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("Factory reset");
    expect(ds.load()!.state).toBe("FACTORY_RESET");
  });

  it("rejects wrong claim code", async () => {
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc" }));
    const app = makeAdminApp();
    const res = await request(app)
      .post("/admin/reset")
      .send({ claimCode: "WRONG1" });

    expect(res.status).toBe(403);
    expect(ds.load()!.state).toBe("CLAIMED");
  });
});
