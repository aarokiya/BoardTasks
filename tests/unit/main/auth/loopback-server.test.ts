import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { startLoopbackServer, type LoopbackServer } from '../../../../src/main/auth/loopback-server';
import { AuthError } from '../../../../src/main/auth/types';

const STATE = 'state-abc-123';
const open: LoopbackServer[] = [];

async function start(timeoutMs?: number): Promise<LoopbackServer> {
  const s = await startLoopbackServer(timeoutMs === undefined ? { state: STATE } : { state: STATE, timeoutMs });
  open.push(s);
  return s;
}

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  vi.useRealTimers();
});

/** Rejection reason as an AuthError, or a failure if the promise resolved. */
async function rejection(p: Promise<unknown>): Promise<AuthError> {
  try {
    await p;
  } catch (e) {
    return e as AuthError;
  }
  throw new Error('expected the code promise to reject');
}

describe('loopback server', () => {
  it('binds an ephemeral port on 127.0.0.1 and exposes the matching redirect URI', async () => {
    const s = await start();
    expect(s.port).toBeGreaterThan(0);
    expect(s.redirectUri).toBe(`http://127.0.0.1:${s.port}/callback`);
  });

  it('answers a good callback with the success page and resolves the code', async () => {
    const s = await start();
    const res = await fetch(`${s.redirectUri}?code=auth-code-1&state=${encodeURIComponent(STATE)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('you can close this tab');
    expect(html).toContain('prefers-color-scheme: dark');
    await expect(s.code).resolves.toBe('auth-code-1');
  });

  it('rejects a state mismatch with 400 and never yields a code', async () => {
    const s = await start();
    const res = await fetch(`${s.redirectUri}?code=stolen&state=wrong-state`);
    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toContain('Security check failed');
    const e = await rejection(s.code);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.reason).toBe('state_mismatch');
  });

  it('serves a friendly page and reports cancellation when the user declines', async () => {
    const s = await start();
    const res = await fetch(`${s.redirectUri}?error=access_denied&state=${encodeURIComponent(STATE)}`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('You declined');
    expect((await rejection(s.code)).reason).toBe('cancelled');
  });

  it('surfaces any other Google error with its description', async () => {
    const s = await start();
    const res = await fetch(`${s.redirectUri}?error=invalid_scope&error_description=Bad+scope&state=${encodeURIComponent(STATE)}`);
    expect(res.status).toBe(400);
    const e = await rejection(s.code);
    expect(e.reason).toBe('unauthorized');
    expect(e.message).toContain('Bad scope');
  });

  it('404s every path but /callback and leaves the flow pending', async () => {
    const s = await start();
    for (const path of ['/', '/favicon.ico', '/callback/nested', '/..%2Fetc']) {
      const res = await fetch(`http://127.0.0.1:${s.port}${path}`);
      expect(res.status).toBe(404);
      await res.text();
    }
    const settled = await Promise.race([s.code.then(() => 'settled').catch(() => 'settled'), Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('rejects a callback with no code at all', async () => {
    const s = await start();
    const res = await fetch(`${s.redirectUri}?state=${encodeURIComponent(STATE)}`);
    expect(res.status).toBe(400);
    expect((await rejection(s.code)).reason).toBe('unauthorized');
  });

  it('cancel() rejects the pending code promise', async () => {
    const s = await start();
    s.cancel();
    expect((await rejection(s.code)).reason).toBe('cancelled');
  });

  it('times out after the hard deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await start();
    const pending = rejection(s.code);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect((await pending).reason).toBe('timeout');
  });

  it('stops listening once closed, so nothing lingers on the port', async () => {
    const s = await start();
    const port = s.port;
    s.close();
    s.close(); // idempotent
    await expect(
      new Promise((resolve, reject) => {
        const sock = connect({ port, host: '127.0.0.1' });
        sock.on('connect', () => {
          sock.destroy();
          resolve('connected');
        });
        sock.on('error', reject);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
