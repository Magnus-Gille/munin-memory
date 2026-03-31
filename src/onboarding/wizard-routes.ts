/**
 * Express routes for the WiFi setup wizard.
 * Mounted in UNCONFIGURED and SETUP_FALLBACK states.
 */

import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import { DeviceState } from "./state.js";
import type { DeviceStateData } from "./state.js";
import type { WifiAdapter } from "./wifi.js";
import type { ApAdapter } from "./ap.js";
import { renderWizardPage } from "./pages/wizard.js";
import { renderConnectingPage } from "./pages/connecting.js";

export interface WizardDeps {
  deviceState: DeviceState;
  wifi: WifiAdapter;
  ap: ApAdapter;
  onTransition: () => void; // called after state transition to trigger process restart
}

export function createWizardRoutes(deps: WizardDeps): Router {
  const router = createRouter();

  router.get("/setup", async (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current) {
      res.status(500).send("Device not initialized");
      return;
    }

    const networks = await deps.wifi.scan();
    res.type("html").send(renderWizardPage({
      deviceId: current.deviceId,
      networks,
      error: current.lastError,
    }));
  });

  router.post("/setup/connect", async (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current) {
      res.status(500).send("Device not initialized");
      return;
    }

    const ssid = (req.body?.ssid as string)?.trim();
    const password = (req.body?.password as string) ?? "";

    if (!ssid) {
      const networks = await deps.wifi.scan();
      res.type("html").send(renderWizardPage({
        deviceId: current.deviceId,
        networks,
        error: "Please select or enter a network name",
      }));
      return;
    }

    // Transition to CONNECTING
    try {
      deps.deviceState.transition(current.state, "CONNECTING", {
        wifiSsid: ssid,
        lastError: undefined,
      });
    } catch {
      const networks = await deps.wifi.scan();
      res.type("html").send(renderWizardPage({
        deviceId: current.deviceId,
        networks,
        error: "Unable to start connection. Please try again.",
      }));
      return;
    }

    // Show connecting page immediately
    res.type("html").send(renderConnectingPage({
      ssid,
      deviceId: current.deviceId,
    }));

    // Attempt connection in background
    setTimeout(async () => {
      try {
        // Stop the AP before connecting (single radio)
        await deps.ap.stopHotspot();

        const result = await deps.wifi.connect(ssid, password);
        if (result.success) {
          deps.deviceState.transition("CONNECTING", "RUNNING_UNCLAIMED");
          deps.onTransition();
        } else {
          deps.deviceState.transition("CONNECTING", "UNCONFIGURED", {
            lastError: result.error || "Connection failed",
          });
          // Restart AP for retry
          await deps.ap.startHotspot(
            current.deviceId,
            "" /* password loaded from state by caller */,
          );
        }
      } catch (err) {
        try {
          deps.deviceState.transition("CONNECTING", "UNCONFIGURED", {
            lastError: "Unexpected error during connection",
          });
        } catch {
          // State may have already been changed
        }
      }
    }, 100);
  });

  router.get("/setup/status", (req: Request, res: Response) => {
    const current = deps.deviceState.load();
    if (!current) {
      res.json({ state: "UNCONFIGURED", error: "Not initialized" });
      return;
    }
    res.json({
      state: current.state,
      ssid: current.wifiSsid,
      error: current.lastError,
    });
  });

  // Redirect root to setup
  router.get("/", (req: Request, res: Response) => {
    res.redirect("/setup");
  });

  return router;
}
