/**
 * Connecting page — shows spinner, polls /setup/status for result.
 */

import { escapeHtml, pageShell } from "./shared.js";

export function renderConnectingPage(params: {
  ssid: string;
  deviceId: string;
}): string {
  const { ssid, deviceId } = params;

  return pageShell("Munin Memory — Connecting", "", `
  <div class="card" style="text-align:center">
    <h1>Connecting to WiFi</h1>
    <p class="subtitle">Joining <span class="brand">${escapeHtml(ssid)}</span></p>
    <div class="spinner" id="spinner"></div>
    <p id="status-text" class="subtitle">Connecting...</p>
    <p id="error-text" class="error" style="display:none"></p>

    <p class="warning" style="margin-top:1.5rem">
      If you are connected via the setup WiFi, you will lose this page when the device
      switches networks. Reconnect to MuninMemory-${escapeHtml(deviceId)} if something goes wrong.
    </p>
  </div>

  <script>
    let attempts = 0;
    const maxAttempts = 30; // 30s

    function poll() {
      attempts++;
      fetch('/setup/status')
        .then(r => r.json())
        .then(data => {
          if (data.state === 'RUNNING_UNCLAIMED' || data.state === 'CLAIMED') {
            document.getElementById('status-text').textContent = 'Connected! Redirecting...';
            document.getElementById('spinner').style.borderTopColor = '#22c55e';
            setTimeout(() => { window.location.href = '/setup/claim'; }, 1000);
          } else if (data.state === 'UNCONFIGURED' || data.state === 'SETUP_FALLBACK') {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status-text').style.display = 'none';
            const err = document.getElementById('error-text');
            err.style.display = 'block';
            err.textContent = data.error || 'Connection failed. Redirecting back to setup...';
            setTimeout(() => { window.location.href = '/setup'; }, 3000);
          } else if (attempts < maxAttempts) {
            setTimeout(poll, 1000);
          } else {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status-text').textContent = 'Taking longer than expected...';
          }
        })
        .catch(() => {
          if (attempts < 5) {
            setTimeout(poll, 1000);
          } else {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status-text').textContent =
              'The device is switching networks. Check your device LED — solid means connected.';
          }
        });
    }

    setTimeout(poll, 2000);
  </script>`);
}
