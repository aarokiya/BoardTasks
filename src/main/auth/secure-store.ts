import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/atomic-write';
import { createLogger, registerSecret } from '../logger';

const log = createLogger('secure-store');

/**
 * Keychain-backed secret storage via Electron safeStorage.
 * Never falls back to plaintext: if encryption is unavailable the value is
 * held in memory for this session only and `isPersistent()` reports false.
 */
const memory = new Map<string, string>();

function fileFor(name: string): string {
  return join(app.getPath('userData'), `${name}.enc`);
}

export function isPersistent(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function saveSecret(name: string, value: string): void {
  registerSecret(value);
  memory.set(name, value);
  if (!isPersistent()) {
    log.warn(`keychain unavailable; "${name}" held in memory only`);
    return;
  }
  atomicWrite(fileFor(name), safeStorage.encryptString(value), 0o600);
}

/** Returns null if missing; throws 'decrypt_failed' if the ciphertext cannot be read (e.g. signing identity changed). */
export function loadSecret(name: string): string | null {
  const m = memory.get(name);
  if (m !== undefined) return m;
  const f = fileFor(name);
  if (!existsSync(f)) return null;
  if (!isPersistent()) return null;
  try {
    const v = safeStorage.decryptString(readFileSync(f));
    registerSecret(v);
    memory.set(name, v);
    return v;
  } catch (e) {
    log.error(`decrypt failed for "${name}"`, e);
    throw new Error('decrypt_failed', { cause: e });
  }
}

export function deleteSecret(name: string): void {
  memory.delete(name);
  const f = fileFor(name);
  try {
    if (existsSync(f)) unlinkSync(f);
  } catch (e) {
    log.warn(`could not delete "${name}"`, e);
  }
}
