import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 7636 PKCE. The client secret of an installed app is not confidential
 * (Google documents this), so the code challenge is the actual security control:
 * it is what stops another local process that races us to the loopback port
 * from redeeming the authorization code.
 */

/** 32 random bytes, base64url, no padding → 43 chars (RFC 7636 allows 43–128). */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** S256: BASE64URL(SHA256(ASCII(verifier))). */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** CSRF token echoed by the authorization server on the loopback redirect. */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Length-independent constant-time compare. Hashing first is deliberate:
 * timingSafeEqual throws on unequal lengths, and branching on that would leak
 * the length of the expected state.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
