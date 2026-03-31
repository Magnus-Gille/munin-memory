/**
 * WiFi setup wizard page — network picker + manual SSID entry.
 */

import { escapeHtml, escapeAttr, pageShell } from "./shared.js";
import type { WifiNetwork } from "../wifi.js";

export function renderWizardPage(params: {
  deviceId: string;
  networks: WifiNetwork[];
  error?: string;
}): string {
  const { deviceId, networks, error } = params;

  const networkItems = networks.map((n) => {
    const bars = [1, 2, 3, 4].map((level) => {
      const threshold = level * 25;
      const active = n.signal >= threshold ? " active" : "";
      const height = 4 + level * 3;
      return `<span class="signal-bar${active}" style="height:${height}px"></span>`;
    }).join("");

    const warning = !n.in24GHz ? ' <span class="network-meta">(5 GHz)</span>' : "";
    const sec = n.security !== "OPEN" ? n.security : '<span style="color:#f59e0b">Open</span>';

    return `<li class="network-item" data-ssid="${escapeAttr(n.ssid)}">
        <div>
          <span class="network-name">${escapeHtml(n.ssid)}</span>${warning}
          <div class="network-meta">${sec}</div>
        </div>
        <div>${bars}</div>
      </li>`;
  }).join("\n      ");

  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";

  return pageShell("Munin Memory — WiFi Setup", `
    .manual-toggle { color: #60a5fa; font-size: 0.8rem; cursor: pointer; margin-bottom: 1rem; display: block; }
    .manual-entry { display: none; }
    .manual-entry.visible { display: block; }
    #password-group { display: none; }
    #password-group.visible { display: block; }
  `, `
  <div class="card">
    <h1>Set Up <span class="brand">Munin Memory</span></h1>
    <p class="subtitle">Device: MuninMemory-${escapeHtml(deviceId)}</p>
    ${errorHtml}

    <form method="POST" action="/setup/connect" id="wifi-form">
      <div id="network-picker">
        <label>Select your WiFi network:</label>
        <ul class="network-list" id="network-list">
          ${networkItems || '<li class="network-meta" style="padding:1rem;text-align:center">No networks found</li>'}
        </ul>
        <span class="manual-toggle" id="manual-toggle">Enter network name manually</span>
      </div>

      <div class="manual-entry" id="manual-entry">
        <label for="ssid-input">Network name (SSID):</label>
        <input type="text" id="ssid-input" name="ssid" placeholder="Enter WiFi network name">
        <span class="manual-toggle" id="list-toggle">Show available networks</span>
      </div>

      <input type="hidden" id="ssid-hidden" name="ssid" value="">

      <div id="password-group">
        <label for="password-input">Password:</label>
        <input type="password" id="password-input" name="password" placeholder="WiFi password">
      </div>

      <button type="submit" class="btn-primary" id="connect-btn" disabled>Connect</button>

      <p class="warning" style="margin-top:1rem">
        Your phone/laptop will disconnect from this device when it joins your WiFi network.
        If something goes wrong, reconnect to MuninMemory-${escapeHtml(deviceId)} to try again.
      </p>
    </form>
  </div>

  <script>
    const form = document.getElementById('wifi-form');
    const networkList = document.getElementById('network-list');
    const ssidHidden = document.getElementById('ssid-hidden');
    const ssidInput = document.getElementById('ssid-input');
    const passwordGroup = document.getElementById('password-group');
    const passwordInput = document.getElementById('password-input');
    const connectBtn = document.getElementById('connect-btn');
    const manualToggle = document.getElementById('manual-toggle');
    const listToggle = document.getElementById('list-toggle');
    const manualEntry = document.getElementById('manual-entry');
    const networkPicker = document.getElementById('network-picker');
    let selectedSsid = '';
    let isManual = false;

    networkList.addEventListener('click', function(e) {
      const item = e.target.closest('.network-item');
      if (!item) return;
      document.querySelectorAll('.network-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedSsid = item.dataset.ssid;
      ssidHidden.value = selectedSsid;
      ssidHidden.name = 'ssid';
      if (ssidInput) ssidInput.removeAttribute('name');
      passwordGroup.classList.add('visible');
      passwordInput.focus();
      updateBtn();
    });

    manualToggle.addEventListener('click', function() {
      isManual = true;
      manualEntry.classList.add('visible');
      networkPicker.style.display = 'none';
      ssidHidden.removeAttribute('name');
      ssidInput.name = 'ssid';
      passwordGroup.classList.add('visible');
      ssidInput.focus();
      updateBtn();
    });

    listToggle.addEventListener('click', function() {
      isManual = false;
      manualEntry.classList.remove('visible');
      networkPicker.style.display = 'block';
      ssidInput.removeAttribute('name');
      ssidHidden.name = 'ssid';
      updateBtn();
    });

    ssidInput.addEventListener('input', updateBtn);
    passwordInput.addEventListener('input', updateBtn);

    function updateBtn() {
      const hasSsid = isManual ? ssidInput.value.trim() : selectedSsid;
      connectBtn.disabled = !hasSsid;
    }

    form.addEventListener('submit', function() {
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting...';
    });
  </script>`);
}
