import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnHeadersReceivedListenerDetails } from 'electron';
import { DEV_CSP, installCsp, isOwnDocumentUrl, PROD_CSP } from '../../../../src/main/security/csp';

type Listener = (
  details: OnHeadersReceivedListenerDetails,
  cb: (r: { responseHeaders?: Record<string, string[]> }) => void,
) => void;

const h = vi.hoisted(() => ({ listener: null as Listener | null }));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: (fn: Listener): void => {
          h.listener = fn;
        },
      },
    },
  },
}));

function directives(policy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of policy.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out.set(name, rest.join(' '));
  }
  return out;
}

function headersFor(url: string, resourceType = 'mainFrame'): Record<string, string[]> | undefined {
  let result: { responseHeaders?: Record<string, string[]> } = {};
  h.listener?.({ url, resourceType, responseHeaders: { 'content-type': ['text/html'] } } as unknown as OnHeadersReceivedListenerDetails, (r) => {
    result = r;
  });
  return result.responseHeaders;
}

beforeEach(() => {
  h.listener = null;
});

describe('production CSP', () => {
  const d = directives(PROD_CSP);

  it('has no eval and no inline script', () => {
    expect(PROD_CSP).not.toContain('unsafe-eval');
    expect(d.get('script-src')).toBe("'self'");
  });

  it('cuts the renderer off from the network in every form connect-src covers', () => {
    // fetch, XHR, WebSocket, EventSource and navigator.sendBeacon all land here.
    expect(d.get('connect-src')).toBe("'self'");
  });

  it('allows no remote images, so a crafted title cannot beacon out through <img>', () => {
    const img = d.get('img-src') ?? '';
    expect(img).not.toMatch(/https?:/);
    expect(img).toContain('bt-asset:');
  });

  it('closes the iframe, plugin, form and base-tag escape routes', () => {
    expect(d.get('default-src')).toBe("'none'");
    expect(d.get('frame-src')).toBe("'none'");
    expect(d.get('child-src')).toBe("'none'");
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('form-action')).toBe("'none'");
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('frame-ancestors')).toBe("'none'");
  });
});

describe('dev CSP', () => {
  it('is the only policy that relaxes script-src', () => {
    expect(DEV_CSP).toContain('unsafe-eval');
  });
});

describe('isOwnDocumentUrl', () => {
  it('matches our own origin only', () => {
    expect(isOwnDocumentUrl('app://boardtasks/index.html', true)).toBe(true);
    expect(isOwnDocumentUrl('app://evil/index.html', true)).toBe(false);
    expect(isOwnDocumentUrl('https://evil.example/', true)).toBe(false);
  });

  it('matches the dev server only in a development build', () => {
    expect(isOwnDocumentUrl('http://127.0.0.1:5173/index.html', false)).toBe(true);
    expect(isOwnDocumentUrl('http://127.0.0.1:5173/index.html', true)).toBe(false);
  });
});

describe('installCsp', () => {
  it('stamps the production policy on our own documents when packaged', () => {
    installCsp(true);
    const headers = headersFor('app://boardtasks/index.html');
    expect(headers?.['Content-Security-Policy']).toEqual([PROD_CSP]);
    expect(headers?.['X-Content-Type-Options']).toEqual(['nosniff']);
    expect(headers?.['Cross-Origin-Opener-Policy']).toEqual(['same-origin']);
    // Existing headers are preserved, not replaced.
    expect(headers?.['content-type']).toEqual(['text/html']);
  });

  it('also stamps workers and subframes, which carry their own policy', () => {
    installCsp(true);
    expect(headersFor('app://boardtasks/worker.js', 'script')?.['Content-Security-Policy']).toEqual([PROD_CSP]);
    expect(headersFor('app://boardtasks/frame.html', 'subFrame')?.['Content-Security-Policy']).toEqual([PROD_CSP]);
  });

  it('never rewrites the headers of a third-party response', () => {
    installCsp(true);
    expect(headersFor('https://api.github.com/user', 'xhr')).toBeUndefined();
    expect(headersFor('https://oauth2.googleapis.com/token', 'xhr')).toBeUndefined();
  });

  it('does not treat the dev server as ours once packaged', () => {
    installCsp(true);
    expect(headersFor('http://127.0.0.1:5173/index.html')).toBeUndefined();
  });

  it('serves the dev policy in a development build', () => {
    installCsp(false);
    expect(headersFor('http://127.0.0.1:5173/index.html')?.['Content-Security-Policy']).toEqual([DEV_CSP]);
  });
});
