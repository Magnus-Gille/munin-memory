/**
 * Shared HTML helpers for onboarding pages.
 * Follows the consent.ts pattern — self-contained, no external assets, dark theme.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export const BASE_STYLES = `
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
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { color: #888; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .brand { color: #60a5fa; font-weight: 600; }
    label { display: block; font-size: 0.875rem; color: #aaa; margin-bottom: 0.25rem; }
    input[type="text"], input[type="password"], select {
      width: 100%;
      padding: 0.625rem 0.75rem;
      background: #222;
      border: 1px solid #444;
      border-radius: 6px;
      color: #e0e0e0;
      font-size: 0.9rem;
      margin-bottom: 1rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: #60a5fa;
    }
    button, .btn {
      display: inline-block;
      padding: 0.75rem 1rem;
      border: none;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      text-align: center;
      text-decoration: none;
    }
    button:hover, .btn:hover { opacity: 0.85; }
    .btn-primary { background: #22c55e; color: #000; width: 100%; }
    .btn-secondary { background: #333; color: #ccc; }
    .error { color: #ef4444; font-size: 0.875rem; margin-bottom: 1rem; }
    .success { color: #22c55e; font-size: 0.875rem; margin-bottom: 1rem; }
    .mono {
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
      font-size: 0.8rem;
      background: #111;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
      white-space: pre;
      margin-bottom: 1rem;
    }
    .network-list { list-style: none; margin-bottom: 1rem; }
    .network-item {
      padding: 0.625rem 0.75rem;
      background: #222;
      border: 1px solid #333;
      border-radius: 6px;
      margin-bottom: 0.375rem;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: border-color 0.15s;
    }
    .network-item:hover { border-color: #60a5fa; }
    .network-item.selected { border-color: #22c55e; background: #1a2a1a; }
    .network-name { font-weight: 500; }
    .network-meta { font-size: 0.75rem; color: #888; }
    .signal-bar { display: inline-block; width: 4px; margin-left: 1px; background: #555; border-radius: 1px; }
    .signal-bar.active { background: #22c55e; }
    .copy-btn {
      padding: 0.375rem 0.75rem;
      font-size: 0.75rem;
      background: #333;
      color: #ccc;
      border: 1px solid #444;
      border-radius: 4px;
      cursor: pointer;
    }
    .copy-btn:hover { background: #444; }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid #333;
      border-top: 3px solid #60a5fa;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 1rem auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .warning { color: #f59e0b; font-size: 0.8rem; margin-top: 0.5rem; }
`;

export function pageShell(title: string, extraStyles: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${BASE_STYLES}${extraStyles}</style>
</head>
<body>
${body}
</body>
</html>`;
}
