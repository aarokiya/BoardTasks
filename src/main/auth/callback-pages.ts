/**
 * The three pages the loopback server can serve. They render in the user's
 * browser, outside the app, so everything is inline and self-contained: no
 * network, no external CSS, no script. Dark mode follows the OS via
 * prefers-color-scheme because the browser tab has no app theme to inherit.
 */

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => escapes[c] ?? c);
}

function page(opts: { title: string; heading: string; body: string; tone: 'ok' | 'warn' }): string {
  const accent = opts.tone === 'ok' ? '#1f9d55' : '#c2410c';
  const accentDark = opts.tone === 'ok' ? '#4ade80' : '#fb923c';
  const glyph = opts.tone === 'ok' ? '&#10003;' : '&#33;';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(opts.title)}</title>
<style>
  :root { --bg:#f5f5f7; --card:#ffffff; --fg:#1d1d1f; --muted:#6e6e73; --line:rgb(0 0 0 / 8%); --accent:${accent}; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1a1c; --card:#242426; --fg:#f5f5f7; --muted:#98989d; --line:rgb(255 255 255 / 10%); --accent:${accentDark}; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 30rem; width: 100%; padding: 32px; border-radius: 14px; text-align: center;
    background: var(--card); border: 1px solid var(--line); box-shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 8px 24px rgb(0 0 0 / 6%);
  }
  .mark {
    width: 46px; height: 46px; margin: 0 auto 18px; border-radius: 50%;
    display: grid; place-items: center; font-size: 22px; font-weight: 600;
    color: var(--accent); border: 2px solid var(--accent);
  }
  h1 { margin: 0 0 8px; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); }
  p + p { margin-top: 10px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">${glyph}</div>
    <h1>${esc(opts.heading)}</h1>
    ${opts.body}
  </main>
</body>
</html>
`;
}

export function successPage(): string {
  return page({
    title: 'BoardTasks is connected',
    heading: 'BoardTasks is connected — you can close this tab',
    body: '<p>Your Google Tasks are syncing now. Switch back to BoardTasks to pick up where you left off.</p>',
    tone: 'ok',
  });
}

export function declinedPage(): string {
  return page({
    title: 'Sign-in cancelled',
    heading: 'You declined — nothing was connected',
    body:
      '<p>BoardTasks has no access to your Google account, and nothing was changed.</p>' +
      '<p>You can close this tab and try again from BoardTasks whenever you like.</p>',
    tone: 'warn',
  });
}

export function errorPage(heading: string, detail: string): string {
  return page({
    title: 'Sign-in failed',
    heading,
    body: `<p>${esc(detail)}</p><p>Close this tab and try again from BoardTasks.</p>`,
    tone: 'warn',
  });
}
