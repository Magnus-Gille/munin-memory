import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { DeviceState, hashSecret } from "../../src/onboarding/state.js";
import type { DeviceStateData } from "../../src/onboarding/state.js";
import { MockWifiAdapter } from "../../src/onboarding/wifi.js";
import { MockApAdapter } from "../../src/onboarding/ap.js";
import { createWizardRoutes } from "../../src/onboarding/wizard-routes.js";

const TEST_DIR = "/tmp/munin-wizard-routes-test";

// POST /setup/connect kicks off an untracked background setTimeout that
// transitions the state file (e.g. to RUNNING_UNCLAIMED) ~100ms after the
// response is sent. With a shared state-file path, that leaked timer from one
// test could clobber a later test's state mid-run. Give every test its own
// directory so a stray background write can never reach another test's state.
let testCounter = 0;
let testDir: string;
let STATE_FILE: string;

function makeState(overrides?: Partial<DeviceStateData>): DeviceStateData {
  return {
    state: "UNCONFIGURED",
    deviceId: "a1b2",
    claimCodeHash: hashSecret("HT7K2M"),
    wifiPasswordHash: hashSecret("kR4mPx7n"),
    ...overrides,
  };
}

let ds: DeviceState;
let wifi: MockWifiAdapter;
let ap: MockApAdapter;
let transitionCalled: boolean;
let app: ReturnType<typeof express>;

beforeEach(() => {
  testDir = join(TEST_DIR, String(testCounter++));
  STATE_FILE = join(testDir, "device-state.json");
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  ds = new DeviceState(STATE_FILE);
  wifi = new MockWifiAdapter();
  ap = new MockApAdapter();
  transitionCalled = false;

  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(createWizardRoutes({
    deviceState: ds,
    wifi,
    ap,
    onTransition: () => { transitionCalled = true; },
  }));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("GET /setup", () => {
  it("returns the WiFi wizard page", async () => {
    ds.save(makeState());
    const res = await request(app).get("/setup");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain("MuninMemory-a1b2");
    expect(res.text).toContain("HomeNetwork");
  });

  it("shows error from state", async () => {
    ds.save(makeState({ lastError: "Wrong password" }));
    const res = await request(app).get("/setup");
    expect(res.text).toContain("Wrong password");
  });

  it("returns 500 if state not initialized", async () => {
    const res = await request(app).get("/setup");
    expect(res.status).toBe(500);
  });
});

describe("POST /setup/connect", () => {
  it("transitions to CONNECTING and returns connecting page", async () => {
    ds.save(makeState());
    const res = await request(app)
      .post("/setup/connect")
      .send("ssid=HomeNetwork&password=secret123");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Connecting");
    expect(res.text).toContain("HomeNetwork");

    // State should be CONNECTING
    const state = ds.load();
    expect(state!.state).toBe("CONNECTING");
    expect(state!.wifiSsid).toBe("HomeNetwork");
  });

  it("rejects empty SSID", async () => {
    ds.save(makeState());
    const res = await request(app)
      .post("/setup/connect")
      .send("ssid=&password=test");

    expect(res.status).toBe(200);
    expect(res.text).toContain("select or enter");
  });

  it("handles connection from SETUP_FALLBACK state", async () => {
    ds.save(makeState({ state: "SETUP_FALLBACK" }));
    const res = await request(app)
      .post("/setup/connect")
      .send("ssid=NewNet&password=pass");

    expect(res.status).toBe(200);
    expect(ds.load()!.state).toBe("CONNECTING");
  });
});

describe("GET /setup/status", () => {
  it("returns current state as JSON", async () => {
    ds.save(makeState({ state: "CONNECTING", wifiSsid: "HomeNet" }));
    const res = await request(app).get("/setup/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "CONNECTING",
      ssid: "HomeNet",
    });
  });

  it("returns UNCONFIGURED for uninitialized device", async () => {
    const res = await request(app).get("/setup/status");
    expect(res.body.state).toBe("UNCONFIGURED");
  });
});

describe("GET /", () => {
  it("redirects to /setup", async () => {
    ds.save(makeState());
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/setup");
  });
});
