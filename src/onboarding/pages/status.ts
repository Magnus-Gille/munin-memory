/**
 * Device status page — shows current state, network info, MCP endpoint.
 */

import { escapeHtml, pageShell } from "./shared.js";
import type { DeviceStateType } from "../state.js";

export function renderStatusPage(params: {
  deviceId: string;
  state: DeviceStateType;
  hostname: string;
  ip?: string;
  ssid?: string;
}): string {
  const { deviceId, state, hostname, ip, ssid } = params;

  const stateDisplay: Record<DeviceStateType, { label: string; color: string }> = {
    UNCONFIGURED: { label: "Setup Required", color: "#f59e0b" },
    CONNECTING: { label: "Connecting...", color: "#60a5fa" },
    SETUP_FALLBACK: { label: "Reconnection Required", color: "#f59e0b" },
    RUNNING_UNCLAIMED: { label: "Awaiting Claim", color: "#60a5fa" },
    CLAIMED: { label: "Running", color: "#22c55e" },
    FACTORY_RESET: { label: "Resetting...", color: "#ef4444" },
  };

  const { label, color } = stateDisplay[state] ?? { label: state, color: "#888" };

  const networkInfo = ssid
    ? `<p><strong>Network:</strong> ${escapeHtml(ssid)}</p>`
    : "";

  const ipInfo = ip
    ? `<p><strong>IP:</strong> ${escapeHtml(ip)}</p>`
    : "";

  const mcpInfo = state === "CLAIMED"
    ? `<p><strong>MCP Endpoint:</strong> http://${escapeHtml(hostname)}:3030/mcp</p>`
    : "";

  return pageShell("Munin Memory — Status", `
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    .info p { font-size: 0.875rem; margin-bottom: 0.5rem; }
    .info strong { color: #aaa; }
  `, `
  <div class="card">
    <h1>Munin Memory</h1>
    <p class="subtitle">MuninMemory-${escapeHtml(deviceId)}</p>

    <span class="status-badge" style="background:${color}20;color:${color};border:1px solid ${color}">${escapeHtml(label)}</span>

    <div class="info">
      ${networkInfo}
      ${ipInfo}
      <p><strong>Hostname:</strong> ${escapeHtml(hostname)}</p>
      ${mcpInfo}
    </div>
  </div>`);
}
