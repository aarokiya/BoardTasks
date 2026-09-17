import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createLogger } from '../logger';
import { constantTimeEqual } from './pkce';
import { declinedPage, errorPage, successPage } from './callback-pages';
import { AuthError } from './types';

const log = createLogger('auth');

export const CALLBACK_PATH = '/callback';
/** Hard ceiling on how long a sign-in may sit unanswered. */
export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoopbackServer {
  readonly port: number;
  /** Exactly what must be registered as the redirect URI and sent to Google. */
  readonly redirectUri: string;
  /** Resolves with the authorization code; rejects with AuthError. Settles once. */
  readonly code: Promise<string>;
  /** Abort the wait (user pressed Cancel, or a second sign-in superseded this one). */
  cancel(): void;
  /** Idempotent: stops listening and destroys any keep-alive sockets. */
  close(): void;
}

/**
 * Binds 127.0.0.1 on an ephemeral port — a fixed port can be squatted by
 * another process on the machine, which would let it harvest the code.
 * Only /callback is answered; everything else is a flat 404 so the server is
 * not a general-purpose local HTTP endpoint for the five minutes it lives.
 */
export function startLoopbackServer(opts: { state: string; timeoutMs?: number }): Promise<LoopbackServer> {
  return new Promise<LoopbackServer>((resolveServer, rejectServer) => {
    const sockets = new Set<Socket>();
    let settled = false;
    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (e: unknown) => void;

    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // Mark the promise handled so an early rejection (timeout, cancel) never
    // surfaces as an unhandledRejection before the caller gets to await it.
    void code.catch(() => undefined);

    const server = createServer();

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      server.close();
      // server.close() leaves keep-alive connections open; those would hold the
      // listener (and in a test, the event loop) alive well past the flow.
      for (const s of sockets) s.destroy();
      sockets.clear();
    };

    const settle = (result: { code: string } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      if ('code' in result) resolveCode(result.code);
      else rejectCode(result.error);
    };

    const respond = (res: ServerResponse, status: number, html: string, then?: () => void): void => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        // Referrer-Policy keeps the code out of any outbound referer header.
        'Referrer-Policy': 'no-referrer',
        Connection: 'close',
      });
      res.end(html, () => then?.());
    };

    const handle = (req: IncomingMessage, res: ServerResponse): void => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        respond(res, 400, errorPage('Bad request', 'That request could not be understood.'));
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        respond(res, 404, errorPage('Not found', 'This local page only handles the Google sign-in redirect.'));
        return;
      }

      const state = url.searchParams.get('state') ?? '';
      const oauthError = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');

      // State is validated before anything else, including the error branch:
      // Google echoes state on errors too, so a request without a matching one
      // did not come from the authorization request we started.
      if (!constantTimeEqual(state, opts.state)) {
        log.warn('loopback: state mismatch; ignoring callback');
        respond(res, 400, errorPage('Security check failed', 'This sign-in response did not match the request BoardTasks started.'));
        settle({ error: new AuthError('state_mismatch', 'The sign-in response failed its security check. Please try signing in again.') });
        close();
        return;
      }

      if (oauthError) {
        if (oauthError === 'access_denied') {
          respond(res, 200, declinedPage(), close);
          settle({ error: new AuthError('cancelled', 'You declined access, so BoardTasks was not connected.') });
          return;
        }
        const desc = url.searchParams.get('error_description');
        respond(res, 400, errorPage('Google refused the sign-in', desc ?? oauthError), close);
        settle({ error: new AuthError('unauthorized', `Google refused the sign-in (${oauthError})${desc ? `: ${desc}` : ''}`) });
        return;
      }

      if (!authCode) {
        respond(res, 400, errorPage('Nothing to do', 'Google did not return an authorization code.'), close);
        settle({ error: new AuthError('unauthorized', 'Google did not return an authorization code.') });
        return;
      }

      respond(res, 200, successPage(), close);
      settle({ code: authCode });
    };

    server.on('connection', (socket: Socket) => {
      // Unref so a browser holding a keep-alive socket can never keep the app alive.
      socket.unref();
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('request', handle);
    server.on('error', (e) => {
      if (settled) return;
      settle({ error: e });
      close();
      rejectServer(e);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        close();
        rejectServer(new Error('Loopback server did not report an address'));
        return;
      }
      timer = setTimeout(() => {
        log.warn('loopback: sign-in timed out');
        settle({ error: new AuthError('timeout', 'Sign-in timed out after 5 minutes. Please try again.') });
        close();
      }, opts.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
      timer.unref();

      log.info(`loopback listening on 127.0.0.1:${addr.port}`);
      resolveServer({
        port: addr.port,
        redirectUri: `http://127.0.0.1:${addr.port}${CALLBACK_PATH}`,
        code,
        cancel: () => {
          settle({ error: new AuthError('cancelled', 'Sign-in was cancelled.') });
          close();
        },
        close,
      });
    });
  });
}
