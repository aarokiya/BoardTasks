/**
 * Google Tasks error taxonomy.
 *
 * The load-bearing subtlety: **403 is not always auth**. Google returns
 * `403 + error.errors[].reason = rateLimitExceeded` for throttling, which is
 * throttling wearing a 403 costume. A client that treats every 403 as "signed
 * out" logs users out under load. The classification lives in http-client.ts;
 * this module only defines what it classifies into.
 */

export interface GoogleErrorDetail {
  domain?: string;
  reason?: string;
  message?: string;
  location?: string;
  locationType?: string;
}

export interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  errors?: GoogleErrorDetail[];
}

export class ApiError extends Error {
  readonly kind = 'api' as const;

  constructor(
    readonly status: number,
    readonly googleError: GoogleErrorBody | null,
    readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? `Google Tasks API returned ${status}`);
    this.name = 'ApiError';
  }

  /** First `reason` Google supplied, e.g. 'rateLimitExceeded' / 'insufficientPermissions'. */
  get reason(): string | null {
    return this.googleError?.errors?.[0]?.reason ?? null;
  }

  get googleMessage(): string | null {
    return this.googleError?.message ?? this.googleError?.errors?.[0]?.message ?? null;
  }
}

export class RateLimitError extends ApiError {
  constructor(
    readonly retryAfterMs: number,
    /** True for `dailyLimitExceeded`: the project's daily quota, not a burst. */
    readonly daily: boolean,
    readonly rateReason: string,
    status = 429,
    googleError: GoogleErrorBody | null = null,
  ) {
    super(status, googleError, true, `Rate limited (${rateReason}); retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
  }
}

export class NetworkError extends Error {
  readonly kind = 'network' as const;
  readonly retryable = true;

  constructor(
    override readonly cause: unknown,
    readonly timedOut: boolean,
  ) {
    super(timedOut ? 'Request to Google timed out' : 'Network request to Google failed');
    this.name = 'NetworkError';
  }
}

/** 412 from an If-Match precondition: the server's copy moved under us. */
export class ConflictError extends ApiError {
  constructor(
    readonly currentEtag: string | null,
    googleError: GoogleErrorBody | null = null,
  ) {
    super(412, googleError, false, 'Precondition failed: the item changed on Google');
    this.name = 'ConflictError';
  }
}

/** Parse Google's `{ "error": { ... } }` envelope; tolerant of HTML error pages. */
export function parseGoogleError(text: string): GoogleErrorBody | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: GoogleErrorBody | string };
    if (typeof parsed.error === 'string') return { message: parsed.error };
    return parsed.error ?? null;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const DAILY_REASONS = new Set(['dailyLimitExceeded', 'quotaExceeded']);

export type ForbiddenKind = 'rate' | 'daily' | 'scope';

/** Which flavour of 403 this is. Never guess: read `error.errors[].reason`. */
export function classifyForbidden(body: GoogleErrorBody | null): { kind: ForbiddenKind; reason: string } {
  for (const detail of body?.errors ?? []) {
    const reason = detail.reason ?? '';
    if (RATE_REASONS.has(reason)) return { kind: 'rate', reason };
    if (DAILY_REASONS.has(reason)) return { kind: 'daily', reason };
  }
  // Some responses only carry `status`; RESOURCE_EXHAUSTED is the gRPC spelling.
  if (body?.status === 'RESOURCE_EXHAUSTED') return { kind: 'rate', reason: 'RESOURCE_EXHAUSTED' };
  return { kind: 'scope', reason: body?.errors?.[0]?.reason ?? body?.status ?? 'forbidden' };
}
