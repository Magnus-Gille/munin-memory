import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DeviceState, hashSecret } from "../../src/onboarding/state.js";
import type { DeviceStateData } from "../../src/onboarding/state.js";
import { MockWifiAdapter } from "../../src/onboarding/wifi.js";
import { ConnectivityWatchdog, WATCHDOG_FALLBACK_THRESHOLD_MS } from "../../src/onboarding/watchdog.js";

const TEST_DIR = "/tmp/munin-watchdog-test";
const STATE_FILE = join(TEST_DIR, "device-state.json");

function cleanup() {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

function makeState(overrides?: Partial<DeviceStateData>): DeviceStateData {
  return {
    state: "CLAIMED",
    deviceId: "a1b2",
    claimCodeHash: hashSecret("HT7K2M"),
    wifiPasswordHash: hashSecret("pass1234"),
    wifiSsid: "HomeNet",
    apiKeyHash: hashSecret("test-key"),
    claimedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let ds: DeviceState;
let wifi: MockWifiAdapter;
let fallbackCalled: boolean;
let currentTime: number;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  cleanup();
  ds = new DeviceState(STATE_FILE);
  wifi = new MockWifiAdapter();
  wifi.connectedSsid = "HomeNet";
  wifi.connectedIp = "192.168.1.42";
  fallbackCalled = false;
  currentTime = 1000000;
});

afterEach(() => {
  cleanup();
});

function makeWatchdog(thresholdMs = WATCHDOG_FALLBACK_THRESHOLD_MS): ConnectivityWatchdog {
  return new ConnectivityWatchdog(
    {
      deviceState: ds,
      wifi,
      onFallback: () => { fallbackCalled = true; },
    },
    1000, // check interval (not used in manual checks)
    thresholdMs,
    () => currentTime,
  );
}

describe("ConnectivityWatchdog", () => {
  it("does nothing when WiFi is connected", async () => {
    ds.save(makeState());
    const wd = makeWatchdog();

    await wd.check();
    await wd.check();
    await wd.check();

    expect(fallbackCalled).toBe(false);
    expect(ds.load()!.state).toBe("CLAIMED");
  });

  it("does not trigger fallback before threshold", async () => {
    ds.save(makeState());
    const wd = makeWatchdog(180_000); // 3 minutes

    // Disconnect
    wifi.connectedSsid = null;
    wifi.connectedIp = null;

    // First check — starts disconnect timer
    await wd.check();
    expect(fallbackCalled).toBe(false);

    // Advance 2 minutes
    currentTime += 120_000;
    await wd.check();
    expect(fallbackCalled).toBe(false);
    expect(ds.load()!.state).toBe("CLAIMED");
  });

  it("triggers fallback after threshold exceeded", async () => {
    ds.save(makeState());
    const wd = makeWatchdog(180_000);

    // Disconnect
    wifi.connectedSsid = null;
    wifi.connectedIp = null;

    // First check
    await wd.check();

    // Advance past threshold
    currentTime += 200_000; // 3m20s
    await wd.check();

    expect(fallbackCalled).toBe(true);
    expect(ds.load()!.state).toBe("SETUP_FALLBACK");
    expect(ds.load()!.lastError).toContain("WiFi connection lost");
  });

  it("resets disconnect timer when WiFi reconnects", async () => {
    ds.save(makeState());
    const wd = makeWatchdog(180_000);

    // Disconnect
    wifi.connectedSsid = null;
    await wd.check();

    // Advance 2 minutes
    currentTime += 120_000;
    await wd.check();

    // Reconnect
    wifi.connectedSsid = "HomeNet";
    wifi.connectedIp = "192.168.1.42";
    await wd.check();

    // Disconnect again
    wifi.connectedSsid = null;
    currentTime += 120_000;
    await wd.check();

    // Should NOT trigger — timer was reset
    expect(fallbackCalled).toBe(false);
    expect(ds.load()!.state).toBe("CLAIMED");
  });

  it("triggers fallback from RUNNING_UNCLAIMED", async () => {
    ds.save(makeState({ state: "RUNNING_UNCLAIMED" }));
    const wd = makeWatchdog(180_000);

    wifi.connectedSsid = null;
    await wd.check();

    currentTime += 200_000;
    await wd.check();

    expect(fallbackCalled).toBe(true);
    expect(ds.load()!.state).toBe("SETUP_FALLBACK");
  });

  it("does not trigger from UNCONFIGURED state", async () => {
    ds.save(makeState({ state: "UNCONFIGURED" }));
    const wd = makeWatchdog(180_000);

    wifi.connectedSsid = null;
    await wd.check();

    currentTime += 200_000;
    await wd.check();

    // Should not trigger — UNCONFIGURED has no fallback transition
    expect(fallbackCalled).toBe(false);
  });

  it("stops checking after fallback", async () => {
    ds.save(makeState());
    const wd = makeWatchdog(1000); // very short threshold

    wifi.connectedSsid = null;
    await wd.check();

    currentTime += 2000;
    await wd.check(); // triggers fallback

    expect(fallbackCalled).toBe(true);

    // Reset for next check
    fallbackCalled = false;
    ds.save(makeState({ state: "SETUP_FALLBACK" }));

    currentTime += 2000;
    await wd.check(); // should be stopped

    expect(fallbackCalled).toBe(false);
  });
});
