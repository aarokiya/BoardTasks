import type { ErrorCode, IpcError } from '@shared/result';
import { createLogger } from '../logger';

const log = createLogger('ipc');

/** Typed, serializable application error. Throw this from handlers; the router converts it. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: { retryable?: boolean; retryAfterMs?: number; details?: IpcError['details']; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toIpcError(e: unknown, traceId: string, channel: string): IpcError {
  if (e instanceof AppError) {
    log.warn(`${channel} [${traceId}] ${e.code}: ${e.message}`, e.opts.cause ?? '');
    const out: IpcError = { code: e.code, message: e.message, retryable: e.opts.retryable ?? false, traceId };
    if (e.opts.retryAfterMs !== undefined) out.retryAfterMs = e.opts.retryAfterMs;
    if (e.opts.details) out.details = e.opts.details;
    return out;
  }
  const sqliteCode = (e as { code?: string })?.code;
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_')) {
    log.error(`${channel} [${traceId}] db error`, e);
    return { code: 'DB', message: 'A local database error occurred.', retryable: false, traceId, details: { sqlite: sqliteCode } };
  }
  log.error(`${channel} [${traceId}] unhandled`, e);
  return { code: 'INTERNAL', message: 'Something went wrong. Details were written to the log.', retryable: false, traceId };
}
