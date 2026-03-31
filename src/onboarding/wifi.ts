/**
 * WiFi operations via nmcli subprocess.
 * All external calls go through the WifiAdapter interface for testability.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Types ---

export interface WifiNetwork {
  ssid: string;
  signal: number; // 0-100
  security: string; // "WPA2", "WPA3", "OPEN", etc.
  frequency: number; // MHz — 2.4 GHz networks are < 3000
  in24GHz: boolean;
}

export interface ConnectionResult {
  success: boolean;
  ip?: string;
  error?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  ssid?: string;
  ip?: string;
}

// --- WifiAdapter interface (for mocking) ---

export interface WifiAdapter {
  scan(): Promise<WifiNetwork[]>;
  connect(ssid: string, password: string): Promise<ConnectionResult>;
  getStatus(): Promise<ConnectionStatus>;
  disconnect(): Promise<void>;
}

// --- Real implementation (nmcli) ---

export class NmcliWifiAdapter implements WifiAdapter {
  async scan(): Promise<WifiNetwork[]> {
    try {
      const { stdout } = await execFileAsync("nmcli", [
        "-t",
        "-f", "SSID,SIGNAL,SECURITY,FREQ",
        "device", "wifi", "list",
        "--rescan", "yes",
      ], { timeout: 15_000 });

      const networks: WifiNetwork[] = [];
      const seen = new Set<string>();

      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        // nmcli terse output uses : as separator, but SSID can contain colons
        // Format: SSID:SIGNAL:SECURITY:FREQ
        // Parse from the right since SSID is the only variable field
        const parts = line.split(":");
        if (parts.length < 4) continue;

        const freq = parseInt(parts[parts.length - 1]!, 10);
        const security = parts[parts.length - 2]!;
        const signal = parseInt(parts[parts.length - 3]!, 10);
        const ssid = parts.slice(0, parts.length - 3).join(":");

        if (!ssid || seen.has(ssid)) continue;
        seen.add(ssid);

        networks.push({
          ssid,
          signal: Number.isFinite(signal) ? signal : 0,
          security: security || "OPEN",
          frequency: Number.isFinite(freq) ? freq : 0,
          in24GHz: freq > 0 && freq < 3000,
        });
      }

      return networks.sort((a, b) => b.signal - a.signal);
    } catch (err) {
      // scan failure is non-fatal — user can enter SSID manually
      return [];
    }
  }

  async connect(ssid: string, password: string): Promise<ConnectionResult> {
    try {
      await execFileAsync("nmcli", [
        "device", "wifi", "connect",
        ssid,
        "password", password,
      ], { timeout: 30_000 });

      // Wait a moment for DHCP
      await new Promise((r) => setTimeout(r, 2_000));

      const status = await this.getStatus();
      if (status.connected && status.ip) {
        return { success: true, ip: status.ip };
      }
      return { success: false, error: "Connected but no IP address assigned" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Secrets were required")) {
        return { success: false, error: "Incorrect password" };
      }
      if (msg.includes("No network with SSID")) {
        return { success: false, error: "Network not found" };
      }
      return { success: false, error: `Connection failed: ${msg}` };
    }
  }

  async getStatus(): Promise<ConnectionStatus> {
    try {
      const { stdout } = await execFileAsync("nmcli", [
        "-t",
        "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS",
        "device", "show", "wlan0",
      ], { timeout: 5_000 });

      let connected = false;
      let ssid: string | undefined;
      let ip: string | undefined;

      for (const line of stdout.split("\n")) {
        if (line.startsWith("GENERAL.STATE:") && line.includes("connected")) {
          connected = true;
        }
        if (line.startsWith("GENERAL.CONNECTION:")) {
          const val = line.split(":").slice(1).join(":").trim();
          if (val && val !== "--") ssid = val;
        }
        if (line.startsWith("IP4.ADDRESS")) {
          const val = line.split(":").slice(1).join(":").trim();
          if (val) ip = val.split("/")[0]; // strip CIDR
        }
      }

      return { connected, ssid, ip };
    } catch {
      return { connected: false };
    }
  }

  async disconnect(): Promise<void> {
    try {
      await execFileAsync("nmcli", ["device", "disconnect", "wlan0"], { timeout: 5_000 });
    } catch {
      // Best effort
    }
  }
}

// --- Mock implementation (for testing) ---

export class MockWifiAdapter implements WifiAdapter {
  networks: WifiNetwork[] = [
    { ssid: "HomeNetwork", signal: 85, security: "WPA2", frequency: 2437, in24GHz: true },
    { ssid: "Neighbor5G", signal: 72, security: "WPA3", frequency: 5180, in24GHz: false },
    { ssid: "OpenCafe", signal: 45, security: "OPEN", frequency: 2412, in24GHz: true },
  ];
  connectedSsid: string | null = null;
  connectedIp: string | null = null;
  shouldFailConnect = false;
  connectError = "Connection failed";

  async scan(): Promise<WifiNetwork[]> {
    return [...this.networks];
  }

  async connect(ssid: string, password: string): Promise<ConnectionResult> {
    if (this.shouldFailConnect) {
      return { success: false, error: this.connectError };
    }
    const net = this.networks.find((n) => n.ssid === ssid);
    if (!net) {
      return { success: false, error: "Network not found" };
    }
    this.connectedSsid = ssid;
    this.connectedIp = "192.168.1.42";
    return { success: true, ip: this.connectedIp };
  }

  async getStatus(): Promise<ConnectionStatus> {
    if (this.connectedSsid) {
      return { connected: true, ssid: this.connectedSsid, ip: this.connectedIp ?? undefined };
    }
    return { connected: false };
  }

  async disconnect(): Promise<void> {
    this.connectedSsid = null;
    this.connectedIp = null;
  }
}
