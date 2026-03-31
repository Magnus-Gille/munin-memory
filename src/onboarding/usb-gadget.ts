/**
 * USB gadget mode detection and network setup.
 * The Pi Zero 2 W can appear as a USB network device when plugged into a computer.
 * Uses rpi-usb-gadget package — IP defaults to 10.12.194.1/28.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const USB_GADGET_IP = "10.12.194.1";

// --- UsbGadgetAdapter interface (for mocking) ---

export interface UsbGadgetAdapter {
  isUsbHostConnected(): boolean;
  ensureNetwork(): Promise<void>;
}

// --- Real implementation (sysfs) ---

export class SysfsUsbGadgetAdapter implements UsbGadgetAdapter {
  /**
   * Check if a USB host is connected by inspecting the UDC (USB Device Controller) state.
   * When a host is connected, the gadget state is "configured".
   * Also check if usb0 interface exists.
   */
  isUsbHostConnected(): boolean {
    try {
      // Check UDC state
      const udcPath = "/sys/class/udc";
      if (!existsSync(udcPath)) return false;

      const udcs = readdirSync(udcPath);
      for (const udc of udcs) {
        const statePath = `${udcPath}/${udc}/state`;
        if (existsSync(statePath)) {
          const state = readFileSync(statePath, "utf-8").trim();
          if (state === "configured") return true;
        }
      }

      // Fallback: check if usb0 interface exists
      return existsSync("/sys/class/net/usb0");
    } catch {
      return false;
    }
  }

  /**
   * Ensure usb0 has the expected IP address.
   * The rpi-usb-gadget service usually handles this, but we set it explicitly as backup.
   */
  async ensureNetwork(): Promise<void> {
    try {
      // Check if usb0 already has the IP
      const { stdout } = await execFileAsync("ip", ["addr", "show", "usb0"], { timeout: 5_000 });
      if (stdout.includes(USB_GADGET_IP)) return;

      // Assign IP
      await execFileAsync("ip", [
        "addr", "add", `${USB_GADGET_IP}/28`, "dev", "usb0",
      ], { timeout: 5_000 });

      // Bring up
      await execFileAsync("ip", ["link", "set", "usb0", "up"], { timeout: 5_000 });
    } catch {
      // Best effort — rpi-usb-gadget may handle this already
    }
  }
}

// --- Mock implementation ---

export class MockUsbGadgetAdapter implements UsbGadgetAdapter {
  connected = false;
  networkReady = false;

  isUsbHostConnected(): boolean {
    return this.connected;
  }

  async ensureNetwork(): Promise<void> {
    if (this.connected) {
      this.networkReady = true;
    }
  }
}
