/**
 * Minimal HTML consent page for OAuth authorization.
 * Self-contained — no external assets or dependencies.
 *
 * Security: Only the server-generated nonce is included in the form.
 * All security-critical params (redirect_uri, code_challenge, scopes, etc.)
 * are stored server-side and looked up by nonce on approval.
 */

export function renderConsentPage(params: {
  clientName: string;
  scopes: string[];
  nonce: string;
}): string {
  const { clientName, scopes, nonce } = params;
  const scopeList = scopes.length > 0
    ? scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n            ")
    : "<li>Full access to memory tools</li>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Munin Memory</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 2rem;
      max-width: 420px;
      width: 100%;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { color: #888; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .client-name { color: #60a5fa; font-weight: 600; }
    .scopes { margin-bottom: 1.5rem; }
    .scopes h2 { font-size: 0.875rem; color: #aaa; margin-bottom: 0.5rem; }
    .scopes ul { list-style: none; padding: 0; }
    .scopes li {
      padding: 0.5rem 0.75rem;
      background: #222;
      border-radius: 6px;
      margin-bottom: 0.25rem;
      font-size: 0.875rem;
      font-family: monospace;
    }
    .actions { display: flex; gap: 0.75rem; }
    button {
      flex: 1;
      padding: 0.75rem 1rem;
      border: none;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    .approve { background: #22c55e; color: #000; }
    .deny { background: #333; color: #ccc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p class="subtitle">
      <span class="client-name">${escapeHtml(clientName)}</span>
      wants to access your Munin Memory.
    </p>
    <div class="scopes">
      <h2>Requested permissions:</h2>
      <ul>
        ${scopeList}
      </ul>
    </div>
    <form method="POST" action="/authorize/approve">
      <input type="hidden" name="nonce" value="${escapeAttr(nonce)}">
      <div class="actions">
        <button type="submit" name="action" value="approve" class="approve">Approve</button>
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
