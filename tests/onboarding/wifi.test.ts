/**
 * Tests for src/onboarding/wifi.ts — NmcliWifiAdapter + MockWifiAdapter.
 *
 * NmcliWifiAdapter shells out via execFile (promisified).
 * We vi.mock "node:child_process" and inject a promisify-compatible stub
 * so the real adapter code runs without touching the OS.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Hoisted mock — must come before any import that pulls in node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
  NmcliWifiAdapter,
  MockWifiAdapter,
} from "../../src/onboarding/wifi.js";

// Helpers to control the mocked execFile ----------------------------------------

type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  result?: { stdout: string; stderr: string },
) => void;

/** Make execFile call its callback with a success result. */
function mockExecSuccess(stdout: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

/** Make execFile call its callback with an error. */
function mockExecError(message: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(Object.assign(new Error(message), { code: 1 }));
    },
  );
}

// -------------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Silence setTimeout delays in connect() — real tests don't need to wait 2 s
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// -------------------------------------------------------------------------------
// NmcliWifiAdapter.scan()
// -------------------------------------------------------------------------------

describe("NmcliWifiAdapter.scan()", () => {
  it("parses standard nmcli terse output into WifiNetwork objects", async () => {
    const stdout = [
      "HomeNetwork:80:WPA2:2437 MHz",
      "Office5G:65:WPA3:5180 MHz",
      "CafeOpen:30:OPEN:2412 MHz",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();

    expect(networks).toHaveLength(3);
    // Sorted by signal descending
    expect(networks[0]!.ssid).toBe("HomeNetwork");
    expect(networks[0]!.signal).toBe(80);
    expect(networks[0]!.security).toBe("WPA2");
    expect(networks[0]!.frequency).toBe(2437);
    expect(networks[0]!.in24GHz).toBe(true);

    expect(networks[1]!.ssid).toBe("Office5G");
    expect(networks[1]!.in24GHz).toBe(false);

    expect(networks[2]!.ssid).toBe("CafeOpen");
    expect(networks[2]!.security).toBe("OPEN");
  });

  it("handles SSID containing colons (parses from right)", async () => {
    // SSID is "Net:work" — has a colon inside
    const stdout = "Net:work:70:WPA2:2437 MHz\n";
    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();

    expect(networks).toHaveLength(1);
    expect(networks[0]!.ssid).toBe("Net:work");
  });

  it("deduplicates networks with the same SSID", async () => {
    const stdout = [
      "HomeNetwork:80:WPA2:2437 MHz",
      "HomeNetwork:75:WPA2:2412 MHz",
      "Other:50:WPA2:2437 MHz",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();

    expect(networks.filter((n) => n.ssid === "HomeNetwork")).toHaveLength(1);
  });

  it("skips blank lines and lines with fewer than 4 parts", async () => {
    const stdout = "\nHomeNetwork:80:WPA2:2437 MHz\n\ntooShort:parts\n";
    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();
    expect(networks).toHaveLength(1);
    expect(networks[0]!.ssid).toBe("HomeNetwork");
  });

  it("returns empty array when nmcli fails (non-fatal)", async () => {
    mockExecError("nmcli: command not found");

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();
    expect(networks).toEqual([]);
  });

  it("treats missing/invalid frequency as 0 and in24GHz=false", async () => {
    // freq = NaN (not parseable)
    const stdout = "NoFreqNet:60:WPA2:invalid MHz\n";
    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();
    // When freq string ends in " MHz" the actual last ":" part is "invalid MHz"
    // parseInt("invalid MHz") = NaN → frequency=0, in24GHz=false
    expect(networks[0]!.in24GHz).toBe(false);
  });

  it("uses 'OPEN' as fallback when security field is empty", async () => {
    // Craft a line where security part (second-to-last) is empty
    const stdout = "NoSecNet:50::2437 MHz\n";
    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const networks = await adapter.scan();
    expect(networks[0]!.security).toBe("OPEN");
  });
});

// -------------------------------------------------------------------------------
// NmcliWifiAdapter.getStatus()
// -------------------------------------------------------------------------------

describe("NmcliWifiAdapter.getStatus()", () => {
  it("parses connected state with ssid and IP", async () => {
    const stdout = [
      "GENERAL.STATE:100 (connected)",
      "GENERAL.CONNECTION:HomeNetwork",
      "IP4.ADDRESS[1]:192.168.1.42/24",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const status = await adapter.getStatus();

    expect(status.connected).toBe(true);
    expect(status.ssid).toBe("HomeNetwork");
    expect(status.ip).toBe("192.168.1.42");
  });

  it("strips CIDR suffix from IP address", async () => {
    const stdout = [
      "GENERAL.STATE:100 (connected)",
      "GENERAL.CONNECTION:Net",
      "IP4.ADDRESS[1]:10.0.0.5/8",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const status = await adapter.getStatus();
    expect(status.ip).toBe("10.0.0.5");
  });

  it("returns connected=false when state line does not include 'connected'", async () => {
    // Note: "disconnected" contains "connected", so use a state that doesn't
    const stdout = [
      "GENERAL.STATE:30 (unavailable)",
      "GENERAL.CONNECTION:--",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const status = await adapter.getStatus();
    expect(status.connected).toBe(false);
    expect(status.ssid).toBeUndefined();
    expect(status.ip).toBeUndefined();
  });

  it("ignores GENERAL.CONNECTION value of '--'", async () => {
    const stdout = [
      "GENERAL.STATE:100 (connected)",
      "GENERAL.CONNECTION:--",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliWifiAdapter();
    const status = await adapter.getStatus();
    expect(status.ssid).toBeUndefined();
  });

  it("returns connected=false on execFile error", async () => {
    mockExecError("permission denied");

    const adapter = new NmcliWifiAdapter();
    const status = await adapter.getStatus();
    expect(status.connected).toBe(false);
  });
});

// -------------------------------------------------------------------------------
// NmcliWifiAdapter.connect()
// -------------------------------------------------------------------------------

describe("NmcliWifiAdapter.connect()", () => {
  it("returns success with IP when connection succeeds", async () => {
    // 1st call: nmcli device wifi connect
    mockExecSuccess("");

    // 2nd call: nmcli device show wlan0 (getStatus)
    const statusOut = [
      "GENERAL.STATE:100 (connected)",
      "GENERAL.CONNECTION:HomeNetwork",
      "IP4.ADDRESS[1]:192.168.1.99/24",
    ].join("\n") + "\n";
    mockExecSuccess(statusOut);

    const adapter = new NmcliWifiAdapter();

    // connect() has a setTimeout(2000) before calling getStatus — advance timers
    const connectPromise = adapter.connect("HomeNetwork", "password");
    await vi.runAllTimersAsync();
    const result = await connectPromise;

    expect(result.success).toBe(true);
    expect(result.ip).toBe("192.168.1.99");
  });

  it("returns success=false with 'no IP' message when connected but IP missing", async () => {
    mockExecSuccess("");

    // getStatus: connected but no IP
    const statusOut = [
      "GENERAL.STATE:100 (connected)",
      "GENERAL.CONNECTION:HomeNetwork",
    ].join("\n") + "\n";
    mockExecSuccess(statusOut);

    const adapter = new NmcliWifiAdapter();
    const connectPromise = adapter.connect("HomeNetwork", "wrongpass");
    await vi.runAllTimersAsync();
    const result = await connectPromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no IP/i);
  });

  it("maps 'Secrets were required' error to 'Incorrect password'", async () => {
    mockExecError("Secrets were required, but not provided");

    const adapter = new NmcliWifiAdapter();
    const connectPromise = adapter.connect("Net", "badpass");
    await vi.runAllTimersAsync();
    const result = await connectPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Incorrect password");
  });

  it("maps 'No network with SSID' error to 'Network not found'", async () => {
    mockExecError("No network with SSID 'Phantom' found.");

    const adapter = new NmcliWifiAdapter();
    const connectPromise = adapter.connect("Phantom", "pass");
    await vi.runAllTimersAsync();
    const result = await connectPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Network not found");
  });

  it("wraps unexpected errors with 'Connection failed:' prefix", async () => {
    mockExecError("some unexpected nmcli error");

    const adapter = new NmcliWifiAdapter();
    const connectPromise = adapter.connect("Net", "pass");
    await vi.runAllTimersAsync();
    const result = await connectPromise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Connection failed:/);
    expect(result.error).toContain("some unexpected nmcli error");
  });
});

// -------------------------------------------------------------------------------
// NmcliWifiAdapter.disconnect()
// -------------------------------------------------------------------------------

describe("NmcliWifiAdapter.disconnect()", () => {
  it("calls nmcli device disconnect wlan0", async () => {
    mockExecSuccess("");

    const adapter = new NmcliWifiAdapter();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("silently ignores errors (best-effort)", async () => {
    mockExecError("device not found");

    const adapter = new NmcliWifiAdapter();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------
// MockWifiAdapter
// -------------------------------------------------------------------------------

describe("MockWifiAdapter", () => {
  it("scan() returns the pre-populated networks", async () => {
    const adapter = new MockWifiAdapter();
    const networks = await adapter.scan();
    expect(networks.length).toBeGreaterThanOrEqual(3);
    expect(networks.some((n) => n.ssid === "HomeNetwork")).toBe(true);
  });

  it("connect() succeeds for a known network and sets connectedIp", async () => {
    const adapter = new MockWifiAdapter();
    const result = await adapter.connect("HomeNetwork", "anypass");
    expect(result.success).toBe(true);
    expect(result.ip).toBe("192.168.1.42");
    expect(adapter.connectedSsid).toBe("HomeNetwork");
  });

  it("connect() returns error for unknown network", async () => {
    const adapter = new MockWifiAdapter();
    const result = await adapter.connect("UnknownNet", "pass");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Network not found");
  });

  it("connect() returns custom error when shouldFailConnect=true", async () => {
    const adapter = new MockWifiAdapter();
    adapter.shouldFailConnect = true;
    adapter.connectError = "Simulated failure";
    const result = await adapter.connect("HomeNetwork", "pass");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Simulated failure");
  });

  it("getStatus() reflects connected state after connect()", async () => {
    const adapter = new MockWifiAdapter();
    await adapter.connect("HomeNetwork", "pass");
    const status = await adapter.getStatus();
    expect(status.connected).toBe(true);
    expect(status.ssid).toBe("HomeNetwork");
    expect(status.ip).toBe("192.168.1.42");
  });

  it("getStatus() returns disconnected when not connected", async () => {
    const adapter = new MockWifiAdapter();
    const status = await adapter.getStatus();
    expect(status.connected).toBe(false);
    expect(status.ssid).toBeUndefined();
  });

  it("disconnect() clears connectedSsid and connectedIp", async () => {
    const adapter = new MockWifiAdapter();
    await adapter.connect("HomeNetwork", "pass");
    await adapter.disconnect();
    expect(adapter.connectedSsid).toBeNull();
    expect(adapter.connectedIp).toBeNull();
    const status = await adapter.getStatus();
    expect(status.connected).toBe(false);
  });
});
