/**
 * Tests for src/onboarding/usb-gadget.ts — SysfsUsbGadgetAdapter + MockUsbGadgetAdapter.
 *
 * SysfsUsbGadgetAdapter reads from /sys/class/udc (sysfs) and calls `ip` via execFile.
 * We vi.mock both "node:fs" and "node:child_process" to control all I/O.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

// Hoist mocks before imports
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  // Keep real implementations for everything not overridden per test
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  SysfsUsbGadgetAdapter,
  MockUsbGadgetAdapter,
  USB_GADGET_IP,
} from "../../src/onboarding/usb-gadget.js";

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

beforeEach(() => {
  vi.clearAllMocks();
});

// -------------------------------------------------------------------------------
// SysfsUsbGadgetAdapter.isUsbHostConnected()
// -------------------------------------------------------------------------------

describe("SysfsUsbGadgetAdapter.isUsbHostConnected()", () => {
  it("returns true when UDC state file reads 'configured'", () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockImplementation((p: string) => {
        if (p === "/sys/class/udc") return true;
        if (p === "/sys/class/udc/fe980000.usb/state") return true;
        return false;
      });
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(["fe980000.usb"]);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("configured\n");

    const adapter = new SysfsUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(true);
  });

  it("returns false when UDC state is not 'configured'", () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockImplementation((p: string) => {
        if (p === "/sys/class/udc") return true;
        if (p === "/sys/class/udc/fe980000.usb/state") return true;
        if (p === "/sys/class/net/usb0") return false;
        return false;
      });
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(["fe980000.usb"]);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("not attached\n");

    const adapter = new SysfsUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(false);
  });

  it("returns false when /sys/class/udc does not exist", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const adapter = new SysfsUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(false);
  });

  it("falls back to checking /sys/class/net/usb0 when state file absent", () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockImplementation((p: string) => {
        if (p === "/sys/class/udc") return true;
        // state file for the UDC does not exist
        if (p.endsWith("/state")) return false;
        // but usb0 interface does
        if (p === "/sys/class/net/usb0") return true;
        return false;
      });
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(["fe980000.usb"]);

    const adapter = new SysfsUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(true);
  });

  it("returns false and does not throw when readdirSync throws", () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockImplementation((p: string) => p === "/sys/class/udc");
    (readdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("EPERM");
    });

    const adapter = new SysfsUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(false);
  });

  it("returns false when UDC dir is empty (no controllers)", () => {
    (existsSync as ReturnType<typeof vi.fn>)
      .mockImplementation((p: string) => {
        if (p === "/sys/class/udc") return true;
        if (p === "/sys/class/net/usb0") return false;
        return false;
      });
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const adapter = new SysfsUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(false);
  });
});

// -------------------------------------------------------------------------------
// SysfsUsbGadgetAdapter.ensureNetwork()
// -------------------------------------------------------------------------------

describe("SysfsUsbGadgetAdapter.ensureNetwork()", () => {
  it("does nothing when IP is already assigned", async () => {
    // ip addr show usb0 contains the USB_GADGET_IP
    mockExecSuccess(`inet ${USB_GADGET_IP}/28 scope global usb0`);

    const adapter = new SysfsUsbGadgetAdapter();
    await expect(adapter.ensureNetwork()).resolves.toBeUndefined();
    // Only one exec call (the check) — no assign/up
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("assigns IP and brings interface up when IP is not present", async () => {
    // First call: addr show (no IP yet)
    mockExecSuccess("2: usb0: <BROADCAST,MULTICAST> mtu 1500 state DOWN");
    // Second: addr add
    mockExecSuccess();
    // Third: link set up
    mockExecSuccess();

    const adapter = new SysfsUsbGadgetAdapter();
    await expect(adapter.ensureNetwork()).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(3);

    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Check 'addr add' call args contain the correct IP+prefix
    const addArgs = (calls[1] as unknown[])[1] as string[];
    expect(addArgs).toContain(`${USB_GADGET_IP}/28`);
    expect(addArgs).toContain("usb0");

    // Check 'link set up' call
    const upArgs = (calls[2] as unknown[])[1] as string[];
    expect(upArgs).toContain("usb0");
    expect(upArgs).toContain("up");
  });

  it("silently swallows errors (best effort)", async () => {
    mockExecError("No such device: usb0");

    const adapter = new SysfsUsbGadgetAdapter();
    await expect(adapter.ensureNetwork()).resolves.toBeUndefined();
  });
});

// -------------------------------------------------------------------------------
// USB_GADGET_IP constant
// -------------------------------------------------------------------------------

describe("USB_GADGET_IP", () => {
  it("equals 10.12.194.1", () => {
    expect(USB_GADGET_IP).toBe("10.12.194.1");
  });
});

// -------------------------------------------------------------------------------
// MockUsbGadgetAdapter
// -------------------------------------------------------------------------------

describe("MockUsbGadgetAdapter", () => {
  it("isUsbHostConnected() returns false by default", () => {
    const adapter = new MockUsbGadgetAdapter();
    expect(adapter.isUsbHostConnected()).toBe(false);
  });

  it("isUsbHostConnected() returns true when connected=true", () => {
    const adapter = new MockUsbGadgetAdapter();
    adapter.connected = true;
    expect(adapter.isUsbHostConnected()).toBe(true);
  });

  it("ensureNetwork() sets networkReady=true when connected", async () => {
    const adapter = new MockUsbGadgetAdapter();
    adapter.connected = true;
    await adapter.ensureNetwork();
    expect(adapter.networkReady).toBe(true);
  });

  it("ensureNetwork() does NOT set networkReady when not connected", async () => {
    const adapter = new MockUsbGadgetAdapter();
    adapter.connected = false;
    await adapter.ensureNetwork();
    expect(adapter.networkReady).toBe(false);
  });
});
