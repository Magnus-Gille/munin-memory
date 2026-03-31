/**
 * Claimed page — shows API key and MCP config JSON for copying.
 */

import { escapeHtml, pageShell } from "./shared.js";

export function renderClaimedPage(params: {
  apiKey: string;
  deviceId: string;
  hostname: string;
  ip?: string;
}): string {
  const { apiKey, deviceId, hostname, ip } = params;

  const mcpUrl = `http://${hostname}:3030/mcp`;
  const mcpConfig = JSON.stringify({
    "munin-memory": {
      url: mcpUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  }, null, 2);

  return pageShell("Munin Memory — Setup Complete", `
    .step { margin-bottom: 1.5rem; }
    .step-header { font-size: 0.9rem; font-weight: 600; color: #fff; margin-bottom: 0.5rem; }
    .step-num { color: #22c55e; margin-right: 0.5rem; }
    .key-display {
      position: relative;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.85rem;
      background: #111;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      word-break: break-all;
      margin-bottom: 0.5rem;
    }
    .copy-row { display: flex; justify-content: flex-end; margin-bottom: 1rem; }
  `, `
  <div class="card">
    <h1 style="color:#22c55e">Setup Complete</h1>
    <p class="subtitle">Your <span class="brand">Munin Memory</span> (MuninMemory-${escapeHtml(deviceId)}) is ready.</p>

    <div class="step">
      <p class="step-header"><span class="step-num">1.</span> Your API Key</p>
      <div class="key-display" id="api-key">${escapeHtml(apiKey)}</div>
      <div class="copy-row">
        <button class="copy-btn" onclick="copyText('api-key')">Copy Key</button>
      </div>
      <p class="warning">Save this key now. You can regenerate it later with your claim code, but the current key will be invalidated.</p>
    </div>

    <div class="step">
      <p class="step-header"><span class="step-num">2.</span> MCP Configuration</p>
      <p class="subtitle">Add this to your Claude Code MCP config:</p>
      <div class="mono" id="mcp-config">${escapeHtml(mcpConfig)}</div>
      <div class="copy-row">
        <button class="copy-btn" onclick="copyText('mcp-config')">Copy Config</button>
      </div>
    </div>

    <div class="step">
      <p class="step-header"><span class="step-num">3.</span> Or add via CLI</p>
      <div class="mono" id="cli-cmd">claude mcp add-json munin-memory '${escapeHtml(JSON.stringify({ url: mcpUrl, headers: { Authorization: `Bearer ${apiKey}` } }))}' -s user</div>
      <div class="copy-row">
        <button class="copy-btn" onclick="copyText('cli-cmd')">Copy Command</button>
      </div>
    </div>

    <p class="subtitle" style="text-align:center;margin-top:1rem">
      Device address: <strong>${escapeHtml(hostname)}</strong>${ip ? ` (${escapeHtml(ip)})` : ""}
    </p>
  </div>

  <script>
    function copyText(id) {
      const el = document.getElementById(id);
      const text = el.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = el.parentElement.querySelector('.copy-btn') || el.nextElementSibling.querySelector('.copy-btn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }
      });
    }
  </script>`);
}

/**
 * Already-claimed page — shown when someone visits /setup/claim on a claimed device.
 */
export function renderAlreadyClaimedPage(params: {
  deviceId: string;
  hostname: string;
}): string {
  const { deviceId, hostname } = params;

  return pageShell("Munin Memory — Already Claimed", "", `
  <div class="card" style="text-align:center">
    <h1>Device Already Claimed</h1>
    <p class="subtitle">
      MuninMemory-${escapeHtml(deviceId)} is already set up and running.
    </p>
    <p class="subtitle">
      MCP endpoint: <strong>${escapeHtml(hostname)}:3030/mcp</strong>
    </p>
    <p class="warning" style="margin-top:1rem">
      If you need to regenerate your API key, use the admin endpoint with your claim code.<br>
      If you need to start over, factory reset the device.
    </p>
  </div>`);
}
