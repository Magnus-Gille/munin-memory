/**
 * WiFi AP (hotspot) management via nmcli.
 * Uses NetworkManager's built-in hotspot capability — no standalone hostapd.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOTSPOT_PROFILE = "MuninSetup";
const AP_IP = "192.168.4.1";
const AP_SUBNET = "192.168.4.0/24";

// --- ApAdapter interface (for mocking) ---

export interface ApAdapter {
  startHotspot(deviceId: string, password: string): Promise<void>;
  stopHotspot(): Promise<void>;
  isHotspotActive(): Promise<boolean>;
}

// --- Real implementation (nmcli) ---

export class NmcliApAdapter implements ApAdapter {
  async startHotspot(deviceId: string, password: string): Promise<void> {
    const ssid = `MuninMemory-${deviceId}`;

    // Remove any stale hotspot profile first
    await this.stopHotspot();

    // Create hotspot
    await execFileAsync("nmcli", [
      "device", "wifi", "hotspot",
      "ifname", "wlan0",
      "con-name", HOTSPOT_PROFILE,
      "ssid", ssid,
      "password", password,
    ], { timeout: 15_000 });

    // Set static IP for the AP interface
    await execFileAsync("nmcli", [
      "connection", "modify", HOTSPOT_PROFILE,
      "ipv4.addresses", `${AP_IP}/24`,
      "ipv4.method", "shared",
    ], { timeout: 5_000 });

    // Reactivate with new settings
    await execFileAsync("nmcli", [
      "connection", "up", HOTSPOT_PROFILE,
    ], { timeout: 10_000 });
  }

  async stopHotspot(): Promise<void> {
    try {
      await execFileAsync("nmcli", [
        "connection", "down", HOTSPOT_PROFILE,
      ], { timeout: 5_000 });
    } catch {
      // May not exist yet — that's fine
    }

    try {
      await execFileAsync("nmcli", [
        "connection", "delete", HOTSPOT_PROFILE,
      ], { timeout: 5_000 });
    } catch {
      // May not exist
    }
  }

  async isHotspotActive(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("nmcli", [
        "-t", "-f", "NAME,TYPE,DEVICE",
        "connection", "show", "--active",
      ], { timeout: 5_000 });

      return stdout.split("\n").some(
        (line) => line.includes(HOTSPOT_PROFILE) && line.includes("wifi"),
      );
    } catch {
      return false;
    }
  }
}

// --- Mock implementation ---

export class MockApAdapter implements ApAdapter {
  active = false;
  lastSsid?: string;
  lastPassword?: string;

  async startHotspot(deviceId: string, password: string): Promise<void> {
    this.active = true;
    this.lastSsid = `MuninMemory-${deviceId}`;
    this.lastPassword = password;
  }

  async stopHotspot(): Promise<void> {
    this.active = false;
  }

  async isHotspotActive(): Promise<boolean> {
    return this.active;
  }
}
