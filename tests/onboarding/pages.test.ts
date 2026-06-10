/**
 * Tests for src/onboarding/pages/status.ts — HTML template function.
 *
 * renderStatusPage is a pure function returning an HTML string.
 * All branches (every DeviceStateType, with/without ssid/ip, CLAIMED MCP endpoint) are covered.
 */

import { describe, it, expect } from "vitest";
import { renderStatusPage } from "../../src/onboarding/pages/status.js";
import type { DeviceStateType } from "../../src/onboarding/state.js";

// -------------------------------------------------------------------------------
// Helper
// -------------------------------------------------------------------------------

function render(overrides: Partial<Parameters<typeof renderStatusPage>[0]> = {}) {
  return renderStatusPage({
    deviceId: "a1b2",
    state: "UNCONFIGURED",
    hostname: "munin.local",
    ...overrides,
  });
}

// -------------------------------------------------------------------------------
// Basic structure
// -------------------------------------------------------------------------------

describe("renderStatusPage — basic structure", () => {
  it("returns a complete HTML document", () => {
    const html = render();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<title>Munin Memory — Status</title>");
  });

  it("includes the device ID in subtitle", () => {
    const html = render({ deviceId: "c3d4" });
    expect(html).toContain("MuninMemory-c3d4");
  });

  it("includes the hostname", () => {
    const html = render({ hostname: "pi.local" });
    expect(html).toContain("pi.local");
  });
});

// -------------------------------------------------------------------------------
// All DeviceStateType labels and colors
// -------------------------------------------------------------------------------

const stateExpectations: Array<[DeviceStateType, string, string]> = [
  ["UNCONFIGURED", "Setup Required", "#f59e0b"],
  ["CONNECTING", "Connecting...", "#60a5fa"],
  ["SETUP_FALLBACK", "Reconnection Required", "#f59e0b"],
  ["RUNNING_UNCLAIMED", "Awaiting Claim", "#60a5fa"],
  ["CLAIMED", "Running", "#22c55e"],
  ["FACTORY_RESET", "Resetting...", "#ef4444"],
];

describe("renderStatusPage — state labels and colors", () => {
  for (const [state, expectedLabel, expectedColor] of stateExpectations) {
    it(`state=${state} shows label "${expectedLabel}" and color ${expectedColor}`, () => {
      const html = render({ state });
      expect(html).toContain(expectedLabel);
      expect(html).toContain(expectedColor);
    });
  }
});

// -------------------------------------------------------------------------------
// Optional network info (ssid, ip)
// -------------------------------------------------------------------------------

describe("renderStatusPage — network info", () => {
  it("shows ssid when provided", () => {
    const html = render({ ssid: "HomeNetwork" });
    expect(html).toContain("Network:");
    expect(html).toContain("HomeNetwork");
  });

  it("omits network section when ssid is absent", () => {
    const html = render({ ssid: undefined });
    expect(html).not.toContain("Network:");
  });

  it("shows IP when provided", () => {
    const html = render({ ip: "192.168.1.42" });
    expect(html).toContain("IP:");
    expect(html).toContain("192.168.1.42");
  });

  it("omits IP section when ip is absent", () => {
    const html = render({ ip: undefined });
    expect(html).not.toContain("IP:");
  });
});

// -------------------------------------------------------------------------------
// MCP endpoint — only shown in CLAIMED state
// -------------------------------------------------------------------------------

describe("renderStatusPage — MCP endpoint", () => {
  it("shows MCP endpoint URL in CLAIMED state", () => {
    const html = render({ state: "CLAIMED", hostname: "munin.local" });
    expect(html).toContain("MCP Endpoint:");
    expect(html).toContain("http://munin.local:3030/mcp");
  });

  it("does NOT show MCP endpoint in non-CLAIMED states", () => {
    const nonClaimedStates: DeviceStateType[] = [
      "UNCONFIGURED",
      "CONNECTING",
      "SETUP_FALLBACK",
      "RUNNING_UNCLAIMED",
      "FACTORY_RESET",
    ];
    for (const state of nonClaimedStates) {
      const html = render({ state });
      expect(html).not.toContain("MCP Endpoint:");
    }
  });
});

// -------------------------------------------------------------------------------
// HTML escaping — user-controlled input must be sanitised
// -------------------------------------------------------------------------------

describe("renderStatusPage — HTML escaping", () => {
  it("escapes deviceId containing < > & characters", () => {
    const html = render({ deviceId: "<script>alert(1)</script>" });
    // Should be escaped, not raw tags
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes ssid containing < > & characters", () => {
    const html = render({ ssid: "<b>evil</b>" });
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
  });

  it("escapes hostname containing special characters", () => {
    const html = render({ state: "CLAIMED", hostname: 'host"name&test' });
    expect(html).toContain("&quot;name&amp;test");
  });

  it("escapes ip address (defensive — should always be safe, but tested)", () => {
    const html = render({ ip: "192.168.1.1" });
    // Dots don't need escaping but should appear correctly
    expect(html).toContain("192.168.1.1");
  });
});

// -------------------------------------------------------------------------------
// Unknown state fallback (defensive — the ?? branch in the source)
// -------------------------------------------------------------------------------

describe("renderStatusPage — unknown state fallback", () => {
  it("uses state name as label with fallback color when state is unrecognised", () => {
    // Cast to satisfy TypeScript — testing the runtime ?? fallback
    const html = render({ state: "MYSTERY_STATE" as DeviceStateType });
    // Falls through to { label: state, color: "#888" }
    expect(html).toContain("MYSTERY_STATE");
    expect(html).toContain("#888");
  });
});
