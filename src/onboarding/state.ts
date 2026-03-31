/**
 * Device state machine for Munin Memory appliance onboarding.
 *
 * Persists state to a JSON file. All writes are atomic (temp + fsync + rename).
 * Boot reconciliation corrects inconsistent state on startup.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { fdatasyncSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// --- Types ---

export type DeviceStateType =
  | "UNCONFIGURED"
  | "CONNECTING"
  | "SETUP_FALLBACK"
  | "RUNNING_UNCLAIMED"
  | "CLAIMED"
  | "FACTORY_RESET";

export interface DeviceStateData {
  state: DeviceStateType;
  deviceId: string; // last 4 of wlan0 MAC, e.g. "a1b2"
  wifiSsid?: string;
  claimedAt?: string;
  apiKeyHash?: string; // SHA-256 of generated API key
  claimCodeHash: string; // SHA-256 of printed claim code
  wifiPasswordHash: string; // SHA-256 of printed WiFi AP password
  lastError?: string; // last failure reason for user display
}

// --- Valid transitions ---

const VALID_TRANSITIONS: Record<DeviceStateType, DeviceStateType[]> = {
  UNCONFIGURED: ["CONNECTING"],
  CONNECTING: ["RUNNING_UNCLAIMED", "UNCONFIGURED", "SETUP_FALLBACK"],
  SETUP_FALLBACK: ["CONNECTING"],
  RUNNING_UNCLAIMED: ["CLAIMED", "SETUP_FALLBACK"],
  CLAIMED: ["SETUP_FALLBACK", "FACTORY_RESET"],
  FACTORY_RESET: ["UNCONFIGURED"],
};

// --- DeviceState class ---

export class DeviceState {
  constructor(private readonly stateFilePath: string) {}

  /**
   * Load state from disk. Returns null if file doesn't exist.
   */
  load(): DeviceStateData | null {
    if (!existsSync(this.stateFilePath)) return null;
    try {
      const raw = readFileSync(this.stateFilePath, "utf-8");
      return JSON.parse(raw) as DeviceStateData;
    } catch {
      return null;
    }
  }

  /**
   * Load state and reconcile inconsistencies.
   * Always returns valid state — creates UNCONFIGURED if file is missing/corrupt.
   * Requires envFilePath to check .env consistency for CLAIMED state.
   */
  loadAndReconcile(envFilePath: string): DeviceStateData {
    const data = this.load();

    if (!data || !data.state || !data.deviceId || !data.claimCodeHash || !data.wifiPasswordHash) {
      // Corrupt or missing — can't recover without secrets.
      // If file existed but was corrupt, we still have the hashes in it potentially.
      // If truly missing, caller must handle (first-boot init hasn't run).
      if (data && data.claimCodeHash && data.wifiPasswordHash && data.deviceId) {
        // Partial corruption — reset to UNCONFIGURED but preserve identity
        const reset: DeviceStateData = {
          state: "UNCONFIGURED",
          deviceId: data.deviceId,
          claimCodeHash: data.claimCodeHash,
          wifiPasswordHash: data.wifiPasswordHash,
        };
        this.save(reset);
        return reset;
      }
      // Truly missing — return null-like sentinel that caller must handle
      // For safety, return a minimal UNCONFIGURED with empty hashes
      // The caller (first-boot script) is responsible for initializing properly
      const empty: DeviceStateData = {
        state: "UNCONFIGURED",
        deviceId: "0000",
        claimCodeHash: "",
        wifiPasswordHash: "",
      };
      return empty;
    }

    // Reconciliation rules
    switch (data.state) {
      case "CONNECTING":
        // Stale transient state — crashed mid-transition
        data.state = "UNCONFIGURED";
        data.lastError = "Connection interrupted — please try again";
        this.save(data);
        return data;

      case "FACTORY_RESET":
        // Complete the reset
        const reset: DeviceStateData = {
          state: "UNCONFIGURED",
          deviceId: data.deviceId,
          claimCodeHash: data.claimCodeHash,
          wifiPasswordHash: data.wifiPasswordHash,
        };
        this.save(reset);
        return reset;

      case "CLAIMED":
        // Verify .env exists and has API key
        if (!envFilePath || !existsSync(envFilePath)) {
          data.state = "RUNNING_UNCLAIMED";
          data.apiKeyHash = undefined;
          data.claimedAt = undefined;
          data.lastError = "Configuration file missing — please re-claim";
          this.save(data);
          return data;
        }
        try {
          const envContent = readFileSync(envFilePath, "utf-8");
          if (!envContent.includes("MUNIN_API_KEY=")) {
            data.state = "RUNNING_UNCLAIMED";
            data.apiKeyHash = undefined;
            data.claimedAt = undefined;
            data.lastError = "API key missing — please re-claim";
            this.save(data);
            return data;
          }
        } catch {
          data.state = "RUNNING_UNCLAIMED";
          data.apiKeyHash = undefined;
          data.claimedAt = undefined;
          this.save(data);
          return data;
        }
        return data;

      default:
        return data;
    }
  }

  /**
   * Atomically persist state to disk.
   * Writes to temp file, fsyncs, then renames.
   */
  save(data: DeviceStateData): void {
    const dir = dirname(this.stateFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tmpPath = this.stateFilePath + ".tmp." + randomBytes(4).toString("hex");
    const content = JSON.stringify(data, null, 2) + "\n";

    writeFileSync(tmpPath, content, { mode: 0o600 });

    // fsync the temp file
    const fd = openSync(tmpPath, "r");
    try {
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // Atomic rename
    renameSync(tmpPath, this.stateFilePath);
  }

  /**
   * Transition from one state to another with optional updates.
   * Throws if the transition is invalid.
   */
  transition(
    from: DeviceStateType,
    to: DeviceStateType,
    updates?: Partial<Omit<DeviceStateData, "state">>,
  ): DeviceStateData {
    const current = this.load();
    if (!current) {
      throw new Error("Cannot transition: state file does not exist");
    }
    if (current.state !== from) {
      throw new Error(
        `Invalid transition: expected current state "${from}" but found "${current.state}"`,
      );
    }
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new Error(`Invalid transition: ${from} → ${to} is not allowed`);
    }

    const updated: DeviceStateData = {
      ...current,
      ...updates,
      state: to,
    };

    this.save(updated);
    return updated;
  }
}

// --- Utility functions ---

/**
 * Hash a string with SHA-256, returning hex.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Generate a random alphanumeric string (uppercase, no ambiguous chars).
 * Excludes: 0, O, I, 1, L to avoid confusion on printed cards.
 */
export function generateReadableCode(length: number): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length * 2); // extra entropy
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

/**
 * Generate a random WiFi-friendly password (mixed case + digits, no ambiguous chars).
 */
export function generateWifiPassword(length: number): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length * 2);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

/**
 * Derive device ID from a MAC address string.
 * Takes last 4 hex chars of the MAC (without colons).
 */
export function deriveDeviceId(mac: string): string {
  const clean = mac.replace(/:/g, "").toLowerCase();
  return clean.slice(-4);
}
