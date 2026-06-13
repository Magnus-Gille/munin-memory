/**
 * Tests for src/onboarding/ap.ts — NmcliApAdapter + MockApAdapter.
 *
 * NmcliApAdapter shells out via execFile (promisified).
 * We vi.mock "node:child_process" so the real adapter runs without OS calls.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
  NmcliApAdapter,
  MockApAdapter,
} from "../../src/onboarding/ap.js";

// ---- helpers ----

type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  result?: { stdout: string; stderr: string },
) => void;

function mockExecSuccess(stdout = "") {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

function mockExecError(message: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(Object.assign(new Error(message), { code: 1 }));
    },
  );
}

// Consume N exec calls with success (useful for multi-step methods)
function mockExecSuccessTimes(n: number, stdout = "") {
  for (let i = 0; i < n; i++) {
    mockExecSuccess(stdout);
  }
}

// ---- tests ----

beforeEach(() => {
  vi.clearAllMocks();
});

// -------------------------------------------------------------------------------
// NmcliApAdapter.stopHotspot()
// -------------------------------------------------------------------------------

describe("NmcliApAdapter.stopHotspot()", () => {
  it("calls 'connection down' and 'connection delete' and resolves", async () => {
    // down + delete — both succeed
    mockExecSuccessTimes(2);

    const adapter = new NmcliApAdapter();
    await expect(adapter.stopHotspot()).resolves.toBeUndefined();

    // Verify 2 execFile calls happened
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("ignores 'connection down' error (profile may not exist)", async () => {
    mockExecError("no connection found");
    mockExecSuccess(); // delete still called

    const adapter = new NmcliApAdapter();
    await expect(adapter.stopHotspot()).resolves.toBeUndefined();
  });

  it("ignores 'connection delete' error (profile may not exist)", async () => {
    mockExecSuccess(); // down ok
    mockExecError("no matching connection");

    const adapter = new NmcliApAdapter();
    await expect(adapter.stopHotspot()).resolves.toBeUndefined();
  });

  it("passes HOTSPOT_PROFILE name ('MuninSetup') to both commands", async () => {
    mockExecSuccessTimes(2);

    const adapter = new NmcliApAdapter();
    await adapter.stopHotspot();

    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // First call: connection down MuninSetup
    expect((calls[0] as unknown[])[1]).toContain("MuninSetup");
    // Second call: connection delete MuninSetup
    expect((calls[1] as unknown[])[1]).toContain("MuninSetup");
  });
});

// -------------------------------------------------------------------------------
// NmcliApAdapter.startHotspot()
// -------------------------------------------------------------------------------

describe("NmcliApAdapter.startHotspot()", () => {
  it("issues stopHotspot (down+delete) then hotspot create, modify, up", async () => {
    // stopHotspot: down + delete
    mockExecSuccessTimes(2);
    // hotspot create
    mockExecSuccess();
    // modify
    mockExecSuccess();
    // up
    mockExecSuccess();

    const adapter = new NmcliApAdapter();
    await expect(adapter.startHotspot("a1b2", "testpass")).resolves.toBeUndefined();

    // 5 total execFile calls
    expect(execFile).toHaveBeenCalledTimes(5);
  });

  it("builds SSID as MuninMemory-<deviceId>", async () => {
    mockExecSuccessTimes(2); // stop
    mockExecSuccessTimes(3); // start steps

    const adapter = new NmcliApAdapter();
    await adapter.startHotspot("c3d4", "securepass");

    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Third call (index 2) is the hotspot create — args should include the SSID
    const hotspotArgs = (calls[2] as unknown[])[1] as string[];
    expect(hotspotArgs).toContain("MuninMemory-c3d4");
    expect(hotspotArgs).toContain("securepass");
  });

  it("sets static IP 192.168.4.1/24 during modify step", async () => {
    mockExecSuccessTimes(2); // stop
    mockExecSuccessTimes(3); // start

    const adapter = new NmcliApAdapter();
    await adapter.startHotspot("a1b2", "pass");

    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // 4th call (index 3) is the modify step
    const modifyArgs = (calls[3] as unknown[])[1] as string[];
    expect(modifyArgs).toContain("192.168.4.1/24");
    expect(modifyArgs).toContain("shared");
  });

  it("throws if hotspot create fails", async () => {
    mockExecSuccessTimes(2); // stop
    mockExecError("device not managed"); // hotspot create fails

    const adapter = new NmcliApAdapter();
    await expect(adapter.startHotspot("a1b2", "pass")).rejects.toThrow();
  });
});

// -------------------------------------------------------------------------------
// NmcliApAdapter.isHotspotActive()
// -------------------------------------------------------------------------------

describe("NmcliApAdapter.isHotspotActive()", () => {
  it("returns true when active connections include MuninSetup wifi", async () => {
    const stdout = [
      "Wired connection 1:ethernet:eth0",
      "MuninSetup:wifi:wlan0",
    ].join("\n") + "\n";

    mockExecSuccess(stdout);

    const adapter = new NmcliApAdapter();
    expect(await adapter.isHotspotActive()).toBe(true);
  });

  it("returns false when MuninSetup is not in active connections", async () => {
    const stdout = "OtherNet:wifi:wlan0\n";
    mockExecSuccess(stdout);

    const adapter = new NmcliApAdapter();
    expect(await adapter.isHotspotActive()).toBe(false);
  });

  it("returns false when MuninSetup is present but not wifi type", async () => {
    const stdout = "MuninSetup:ethernet:eth0\n";
    mockExecSuccess(stdout);

    const adapter = new NmcliApAdapter();
    expect(await adapter.isHotspotActive()).toBe(false);
  });

  it("returns false on nmcli error", async () => {
    mockExecError("D-Bus error");

    const adapter = new NmcliApAdapter();
    expect(await adapter.isHotspotActive()).toBe(false);
  });
});

// -------------------------------------------------------------------------------
// MockApAdapter
// -------------------------------------------------------------------------------

describe("MockApAdapter", () => {
  it("startHotspot sets active=true and records ssid/password", async () => {
    const adapter = new MockApAdapter();
    await adapter.startHotspot("a1b2", "wifipass");
    expect(adapter.active).toBe(true);
    expect(adapter.lastSsid).toBe("MuninMemory-a1b2");
    expect(adapter.lastPassword).toBe("wifipass");
  });

  it("stopHotspot sets active=false", async () => {
    const adapter = new MockApAdapter();
    await adapter.startHotspot("a1b2", "pass");
    await adapter.stopHotspot();
    expect(adapter.active).toBe(false);
  });

  it("isHotspotActive reflects current active state", async () => {
    const adapter = new MockApAdapter();
    expect(await adapter.isHotspotActive()).toBe(false);
    await adapter.startHotspot("a1b2", "pass");
    expect(await adapter.isHotspotActive()).toBe(true);
    await adapter.stopHotspot();
    expect(await adapter.isHotspotActive()).toBe(false);
  });
});
