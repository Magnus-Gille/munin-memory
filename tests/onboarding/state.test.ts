import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeviceState,
  hashSecret,
  generateReadableCode,
  generateWifiPassword,
  deriveDeviceId,
} from "../../src/onboarding/state.js";
import type { DeviceStateData, DeviceStateType } from "../../src/onboarding/state.js";

const TEST_DIR = "/tmp/munin-onboarding-state-test";
const STATE_FILE = join(TEST_DIR, "device-state.json");
const ENV_FILE = join(TEST_DIR, ".env");

function cleanup() {
  for (const f of [STATE_FILE, STATE_FILE + ".tmp", ENV_FILE]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

function makeState(overrides?: Partial<DeviceStateData>): DeviceStateData {
  return {
    state: "UNCONFIGURED",
    deviceId: "a1b2",
    claimCodeHash: hashSecret("HT7K2M"),
    wifiPasswordHash: hashSecret("kR4mPx7n"),
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  cleanup();
});

afterEach(cleanup);

// --- State persistence ---

describe("DeviceState persistence", () => {
  it("returns null when state file does not exist", () => {
    const ds = new DeviceState(STATE_FILE);
    expect(ds.load()).toBeNull();
  });

  it("saves and loads state", () => {
    const ds = new DeviceState(STATE_FILE);
    const data = makeState();
    ds.save(data);
    const loaded = ds.load();
    expect(loaded).toMatchObject({ state: "UNCONFIGURED", deviceId: "a1b2" });
  });

  it("save creates parent directories if needed", () => {
    const deep = join(TEST_DIR, "sub", "dir", "state.json");
    const ds = new DeviceState(deep);
    ds.save(makeState());
    expect(ds.load()).toMatchObject({ state: "UNCONFIGURED" });
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(STATE_FILE, "not json {{{", "utf-8");
    const ds = new DeviceState(STATE_FILE);
    expect(ds.load()).toBeNull();
  });

  it("atomic write survives concurrent reads", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "UNCONFIGURED" }));
    // Rapid write cycle — should never produce corrupt reads
    for (let i = 0; i < 20; i++) {
      ds.save(makeState({ state: i % 2 === 0 ? "UNCONFIGURED" : "CLAIMED", claimedAt: new Date().toISOString() }));
      const loaded = ds.load();
      expect(loaded).not.toBeNull();
      expect(["UNCONFIGURED", "CLAIMED"]).toContain(loaded!.state);
    }
  });
});

// --- Valid transitions ---

describe("DeviceState transitions", () => {
  it("UNCONFIGURED → CONNECTING", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "UNCONFIGURED" }));
    const result = ds.transition("UNCONFIGURED", "CONNECTING", { wifiSsid: "HomeNet" });
    expect(result.state).toBe("CONNECTING");
    expect(result.wifiSsid).toBe("HomeNet");
  });

  it("CONNECTING → RUNNING_UNCLAIMED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CONNECTING", wifiSsid: "HomeNet" }));
    const result = ds.transition("CONNECTING", "RUNNING_UNCLAIMED");
    expect(result.state).toBe("RUNNING_UNCLAIMED");
    expect(result.wifiSsid).toBe("HomeNet");
  });

  it("CONNECTING → UNCONFIGURED (connection failed)", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CONNECTING" }));
    const result = ds.transition("CONNECTING", "UNCONFIGURED", { lastError: "Wrong password" });
    expect(result.state).toBe("UNCONFIGURED");
    expect(result.lastError).toBe("Wrong password");
  });

  it("CONNECTING → SETUP_FALLBACK", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CONNECTING" }));
    const result = ds.transition("CONNECTING", "SETUP_FALLBACK");
    expect(result.state).toBe("SETUP_FALLBACK");
  });

  it("SETUP_FALLBACK → CONNECTING", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "SETUP_FALLBACK" }));
    const result = ds.transition("SETUP_FALLBACK", "CONNECTING", { wifiSsid: "NewNet" });
    expect(result.state).toBe("CONNECTING");
  });

  it("RUNNING_UNCLAIMED → CLAIMED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "RUNNING_UNCLAIMED", wifiSsid: "HomeNet" }));
    const result = ds.transition("RUNNING_UNCLAIMED", "CLAIMED", {
      claimedAt: "2026-04-01T10:00:00Z",
      apiKeyHash: hashSecret("test-api-key"),
    });
    expect(result.state).toBe("CLAIMED");
    expect(result.claimedAt).toBe("2026-04-01T10:00:00Z");
    expect(result.apiKeyHash).toBeDefined();
  });

  it("RUNNING_UNCLAIMED → SETUP_FALLBACK (WiFi lost)", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "RUNNING_UNCLAIMED" }));
    const result = ds.transition("RUNNING_UNCLAIMED", "SETUP_FALLBACK");
    expect(result.state).toBe("SETUP_FALLBACK");
  });

  it("CLAIMED → SETUP_FALLBACK (WiFi lost)", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc" }));
    const result = ds.transition("CLAIMED", "SETUP_FALLBACK");
    expect(result.state).toBe("SETUP_FALLBACK");
  });

  it("CLAIMED → FACTORY_RESET", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CLAIMED" }));
    const result = ds.transition("CLAIMED", "FACTORY_RESET");
    expect(result.state).toBe("FACTORY_RESET");
  });

  it("FACTORY_RESET → UNCONFIGURED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "FACTORY_RESET" }));
    const result = ds.transition("FACTORY_RESET", "UNCONFIGURED");
    expect(result.state).toBe("UNCONFIGURED");
    // Should clear claimed data
  });
});

// --- Invalid transitions ---

describe("DeviceState invalid transitions", () => {
  const invalidPairs: [DeviceStateType, DeviceStateType][] = [
    ["UNCONFIGURED", "CLAIMED"],
    ["UNCONFIGURED", "RUNNING_UNCLAIMED"],
    ["UNCONFIGURED", "SETUP_FALLBACK"],
    ["UNCONFIGURED", "FACTORY_RESET"],
    ["CONNECTING", "CLAIMED"],
    ["RUNNING_UNCLAIMED", "UNCONFIGURED"],
    ["RUNNING_UNCLAIMED", "CONNECTING"],
    ["CLAIMED", "UNCONFIGURED"],
    ["CLAIMED", "CONNECTING"],
    ["CLAIMED", "RUNNING_UNCLAIMED"],
    ["SETUP_FALLBACK", "CLAIMED"],
    ["SETUP_FALLBACK", "RUNNING_UNCLAIMED"],
    ["FACTORY_RESET", "CLAIMED"],
  ];

  for (const [from, to] of invalidPairs) {
    it(`rejects ${from} → ${to}`, () => {
      const ds = new DeviceState(STATE_FILE);
      ds.save(makeState({ state: from }));
      expect(() => ds.transition(from, to)).toThrow(`Invalid transition: ${from} → ${to}`);
    });
  }

  it("rejects transition when current state doesn't match 'from'", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "UNCONFIGURED" }));
    expect(() => ds.transition("CLAIMED", "FACTORY_RESET")).toThrow(
      'expected current state "CLAIMED" but found "UNCONFIGURED"',
    );
  });

  it("rejects transition when state file doesn't exist", () => {
    const ds = new DeviceState(STATE_FILE);
    expect(() => ds.transition("UNCONFIGURED", "CONNECTING")).toThrow("state file does not exist");
  });
});

// --- Boot reconciliation ---

describe("DeviceState boot reconciliation", () => {
  it("missing file returns empty UNCONFIGURED", () => {
    const ds = new DeviceState(STATE_FILE);
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("UNCONFIGURED");
    expect(result.deviceId).toBe("0000");
  });

  it("corrupt JSON resets to UNCONFIGURED", () => {
    writeFileSync(STATE_FILE, "corrupt!", "utf-8");
    const ds = new DeviceState(STATE_FILE);
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("UNCONFIGURED");
  });

  it("CONNECTING resets to UNCONFIGURED with error", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CONNECTING", wifiSsid: "test" }));
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("UNCONFIGURED");
    expect(result.lastError).toContain("interrupted");
    // Persisted
    expect(ds.load()!.state).toBe("UNCONFIGURED");
  });

  it("FACTORY_RESET completes to UNCONFIGURED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "FACTORY_RESET", apiKeyHash: "old", claimedAt: "old" }));
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("UNCONFIGURED");
    expect(result.apiKeyHash).toBeUndefined();
    expect(result.claimedAt).toBeUndefined();
    // Persisted
    expect(ds.load()!.state).toBe("UNCONFIGURED");
  });

  it("CLAIMED with missing .env reverts to RUNNING_UNCLAIMED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc", claimedAt: "2026-01-01" }));
    // No .env file exists
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("RUNNING_UNCLAIMED");
    expect(result.apiKeyHash).toBeUndefined();
    expect(result.lastError).toContain("missing");
  });

  it("CLAIMED with .env missing API key reverts to RUNNING_UNCLAIMED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc" }));
    writeFileSync(ENV_FILE, "SOME_OTHER_VAR=value\n", "utf-8");
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("RUNNING_UNCLAIMED");
    expect(result.lastError).toContain("API key missing");
  });

  it("CLAIMED with valid .env stays CLAIMED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "CLAIMED", apiKeyHash: "abc", claimedAt: "2026-01-01" }));
    writeFileSync(ENV_FILE, "MUNIN_API_KEY=deadbeef\n", "utf-8");
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("CLAIMED");
  });

  it("UNCONFIGURED stays UNCONFIGURED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "UNCONFIGURED" }));
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("UNCONFIGURED");
  });

  it("RUNNING_UNCLAIMED stays RUNNING_UNCLAIMED", () => {
    const ds = new DeviceState(STATE_FILE);
    ds.save(makeState({ state: "RUNNING_UNCLAIMED", wifiSsid: "test" }));
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("RUNNING_UNCLAIMED");
  });

  it("partial corruption with valid identity preserves deviceId and hashes", () => {
    // Write state with missing 'state' field
    const partial = {
      deviceId: "ff01",
      claimCodeHash: hashSecret("ABC123"),
      wifiPasswordHash: hashSecret("pass1234"),
    };
    writeFileSync(STATE_FILE, JSON.stringify(partial), "utf-8");
    const ds = new DeviceState(STATE_FILE);
    const result = ds.loadAndReconcile(ENV_FILE);
    expect(result.state).toBe("UNCONFIGURED");
    expect(result.deviceId).toBe("ff01");
    expect(result.claimCodeHash).toBe(hashSecret("ABC123"));
  });
});

// --- Utility functions ---

describe("hashSecret", () => {
  it("produces consistent SHA-256 hex", () => {
    expect(hashSecret("test")).toBe(hashSecret("test"));
    expect(hashSecret("test")).not.toBe(hashSecret("other"));
    expect(hashSecret("test")).toHaveLength(64);
  });
});

describe("generateReadableCode", () => {
  it("produces correct length", () => {
    expect(generateReadableCode(6)).toHaveLength(6);
    expect(generateReadableCode(8)).toHaveLength(8);
  });

  it("only contains non-ambiguous uppercase chars and digits", () => {
    const code = generateReadableCode(100);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  });

  it("excludes ambiguous characters", () => {
    // Generate many codes and verify no 0, O, I, 1, L
    for (let i = 0; i < 50; i++) {
      const code = generateReadableCode(10);
      expect(code).not.toMatch(/[0OI1L]/);
    }
  });
});

describe("generateWifiPassword", () => {
  it("produces correct length", () => {
    expect(generateWifiPassword(8)).toHaveLength(8);
  });

  it("contains mixed case and digits", () => {
    // With 100 chars, extremely unlikely to miss a category
    const pass = generateWifiPassword(100);
    expect(pass).toMatch(/[a-z]/);
    expect(pass).toMatch(/[A-Z]/);
    expect(pass).toMatch(/[0-9]/);
  });
});

describe("deriveDeviceId", () => {
  it("takes last 4 hex chars of MAC", () => {
    expect(deriveDeviceId("dc:a6:32:12:ab:cd")).toBe("abcd");
    expect(deriveDeviceId("b8:27:eb:ff:00:1a")).toBe("001a");
  });

  it("handles MAC without colons", () => {
    expect(deriveDeviceId("dca63212abcd")).toBe("abcd");
  });

  it("lowercases the result", () => {
    expect(deriveDeviceId("DC:A6:32:12:AB:CD")).toBe("abcd");
  });
});
