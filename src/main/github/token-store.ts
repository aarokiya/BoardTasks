import { deleteSecret, isPersistent, loadSecret, saveSecret } from '../auth/secure-store';
import { createLogger } from '../logger';

const log = createLogger('github');

/** Keychain entry name. The value is a fine-grained personal access token. */
export const GITHUB_TOKEN_KEY = 'github-token';

export function saveGithubToken(token: string): void {
  saveSecret(GITHUB_TOKEN_KEY, token.trim());
}

/**
 * Returns null when no token is stored *and* when the stored ciphertext cannot
 * be decrypted (signing identity changed, keychain reset). Never throws: a
 * broken keychain must degrade to "not connected", not break task loading.
 */
export function loadGithubToken(): string | null {
  try {
    return loadSecret(GITHUB_TOKEN_KEY);
  } catch (e) {
    log.warn('stored GitHub token could not be decrypted', e);
    return null;
  }
}

export function deleteGithubToken(): void {
  deleteSecret(GITHUB_TOKEN_KEY);
}

/** Last 4 characters — the only part of a token that is ever shown or logged. */
export function tokenHint(token: string | null): string | null {
  if (!token) return null;
  const t = token.trim();
  return t.length <= 4 ? t : t.slice(-4);
}

/** False when safeStorage is unavailable: the token lives in memory for this session only. */
export function tokenIsPersistent(): boolean {
  return isPersistent();
}
