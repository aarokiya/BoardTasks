import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structural secret scrubbing. Assume someone will eventually
 * console.log(credentials) — make it harmless.
 */
const SCRUB_PATTERNS: RegExp[] = [
  /ya29\.[\w.-]+/g,                  // Google access token
  /1\/\/[\w-]{20,}/g,                // Google refresh token
  /GOCSPX-[\w-]+/g,                  // Google client secret
  /gh[pousr]_[A-Za-z0-9]{20,}/g,     // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /github_pat_[A-Za-z0-9_]{20,}/g,   // GitHub fine-grained PAT
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // any JWT (id_token)
  /(Bearer\s+)[\w.-]+/gi,
  /(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/g,
  // Secrets carried in a URL query string. net.fetch and undici errors echo the
  // request URL, and the OAuth authorization code and refresh token both travel
  // that way; the value stops at `&` so the rest of the URL stays readable.
  /([?&](?:access_token|refresh_token|id_token|token|code|code_verifier|client_secret|assertion|password|api_key|apikey|key)=)[^&\s"'<>]+/gi,
  // JSON bodies, object dumps and header maps. `code` is deliberately absent
  // here: `code: 'ENOTFOUND'` is not a secret and redacting it blinds the log.
  /("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|authorization|token|password|api_key|private_key)"?\s*[:=]\s*"?)[^\s",}&]+/gi,
];

const knownSecrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function scrub(input: string): string {
  let out = input;
  for (const s of knownSecrets) out = out.split(s).join('[REDACTED]');
  for (const re of SCRUB_PATTERNS) out = out.replace(re, (m, prefix: string | undefined) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  return out;
}

let logDir: string | null = null;
let logFile: string | null = null;
let minLevel: Level = 'info';
const MAX_BYTES = 5 * 1024 * 1024;

export function initLogger(dir: string, level: Level = 'info'): void {
  logDir = dir;
  logFile = join(dir, 'main.log');
  minLevel = level;
  // 0700: the log is scrubbed, but it is still this user's data.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function getLogPath(): string | null {
  return logFile;
}

function serialize(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function rotateIfNeeded(): void {
  if (!logFile || !logDir) return;
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      renameSync(logFile, join(logDir, 'main.1.log'));
    }
  } catch {
    /* rotation is best-effort */
  }
}

function write(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = scrub(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${args.map(serialize).join(' ')}`);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line);
  if (logFile) {
    try {
      rotateIfNeeded();
      appendFileSync(logFile, line + '\n', { mode: 0o600 });
    } catch {
      /* never crash on logging */
    }
  }
}

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}
