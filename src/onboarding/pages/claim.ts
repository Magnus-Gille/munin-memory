/**
 * Claim page — enter the printed claim code to take ownership of the device.
 */

import { escapeHtml, escapeAttr, pageShell } from "./shared.js";

export function renderClaimPage(params: {
  deviceId: string;
  hostname: string;
  ip?: string;
  error?: string;
}): string {
  const { deviceId, hostname, ip, error } = params;

  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const ipNote = ip ? ` (${escapeHtml(ip)})` : "";

  return pageShell("Munin Memory — Claim Device", `
    .claim-input {
      font-size: 1.5rem;
      text-align: center;
      letter-spacing: 0.3em;
      text-transform: uppercase;
      font-family: "SF Mono", "Fira Code", monospace;
    }
    .device-info {
      background: #222;
      border-radius: 6px;
      padding: 0.75rem;
      margin-bottom: 1.5rem;
      font-size: 0.8rem;
      color: #888;
    }
    .device-info strong { color: #e0e0e0; }
  `, `
  <div class="card">
    <h1>Claim Your <span class="brand">Munin Memory</span></h1>
    <p class="subtitle">Enter the claim code from your quick-start card to take ownership.</p>

    <div class="device-info">
      <strong>Device:</strong> MuninMemory-${escapeHtml(deviceId)}<br>
      <strong>Address:</strong> ${escapeHtml(hostname)}${ipNote}
    </div>

    ${errorHtml}

    <form method="POST" action="/setup/claim" id="claim-form">
      <label for="claim-code">Claim code:</label>
      <input type="text" id="claim-code" name="claimCode"
             class="claim-input" maxlength="6" autocomplete="off"
             placeholder="------" autofocus>

      <button type="submit" class="btn-primary" id="claim-btn">Claim Device</button>
    </form>
  </div>

  <script>
    const input = document.getElementById('claim-code');
    const btn = document.getElementById('claim-btn');
    const form = document.getElementById('claim-form');

    input.addEventListener('input', function() {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      btn.disabled = this.value.length < 6;
    });

    form.addEventListener('submit', function() {
      btn.disabled = true;
      btn.textContent = 'Claiming...';
    });
  </script>`);
}
