/**
 * WiFi connectivity watchdog.
 * Monitors connection status and triggers fallback to setup mode
 * if WiFi is lost for longer than the threshold.
 */

import type { WifiAdapter } from "./wifi.js";
import { DeviceState } from "./state.js";
import type { DeviceStateType } from "./state.js";

export const WATCHDOG_CHECK_INTERVAL_MS = 30_000; // check every 30s
export const WATCHDOG_FALLBACK_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

export interface WatchdogDeps {
  deviceState: DeviceState;
  wifi: WifiAdapter;
  onFallback: () => void; // called when fallback triggers (process restart)
}

export class ConnectivityWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private disconnectedSince: number | null = null;
  private stopped = false;

  constructor(
    private deps: WatchdogDeps,
    private checkIntervalMs = WATCHDOG_CHECK_INTERVAL_MS,
    private fallbackThresholdMs = WATCHDOG_FALLBACK_THRESHOLD_MS,
    private nowFn = () => Date.now(),
  ) {}

  start(): void {
    this.stopped = false;
    this.disconnectedSince = null;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<void> {
    if (this.stopped) return;

    const now = this.nowFn();

    try {
      const status = await this.deps.wifi.getStatus();

      if (status.connected) {
        // Reset disconnect timer
        this.disconnectedSince = null;
        return;
      }

      // Not connected
      if (this.disconnectedSince === null) {
        this.disconnectedSince = now;
        return;
      }

      const elapsed = now - this.disconnectedSince;
      if (elapsed >= this.fallbackThresholdMs) {
        // Threshold exceeded — trigger fallback
        this.stop();

        const current = this.deps.deviceState.load();
        if (!current) return;

        const fallbackFrom: DeviceStateType[] = ["RUNNING_UNCLAIMED", "CLAIMED"];
        if (fallbackFrom.includes(current.state)) {
          try {
            this.deps.deviceState.transition(current.state, "SETUP_FALLBACK", {
              lastError: "WiFi connection lost — please reconfigure",
            });
            this.deps.onFallback();
          } catch {
            // State may have already changed
          }
        }
      }
    } catch {
      // WiFi check failed — treat as disconnected
      if (this.disconnectedSince === null) {
        this.disconnectedSince = now;
      }
    }
  }
}
