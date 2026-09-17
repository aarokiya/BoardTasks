export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'DB'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'INTERNAL';

/** Structured-clone safe. Never put an Error, Date, Map, or class instance in here. */
export interface IpcError {
  code: ErrorCode;
  /** Safe to display to the user. */
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, string | number | boolean | null>;
  /** Correlates with a line in main.log. */
  traceId: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(error: IpcError): Result<T> => ({ ok: false, error });
