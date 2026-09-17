/**
 * Pure GitHub reference parsing, shared by main (linking + enrichment) and the
 * renderer (paste detection, picker). No I/O, no platform APIs, no `Date`.
 *
 * Only issues and pull requests are linkable: repository, commit, blob, project
 * and discussion URLs are rejected so a paste of the wrong kind of link fails
 * loudly instead of producing a link that can never be enriched.
 */
import type { GithubItemType } from './models';

export interface GithubRef {
  host: string;
  owner: string;
  repo: string;
  type: GithubItemType;
  number: number;
}

export const GITHUB_DEFAULT_HOST = 'github.com';

/** owner/repo segments: GitHub allows letters, digits, dot, dash, underscore. */
const NAME = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?';
const SHORTHAND_RE = new RegExp(`^(${NAME})/(${NAME})#(\\d{1,10})$`);
const NAME_RE = new RegExp(`^${NAME}$`);
const NUM_RE = /^\d{1,10}$/;

/** Candidate tokens inside free text: absolute URLs, or the owner/repo#123 shorthand. */
const SCAN_RE = /https?:\/\/[^\s<>"'`)\]}]+|\b[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#\d{1,10}\b/g;

function normalizeHost(h: string | undefined | null): string | null {
  if (!h) return null;
  const v = h.trim().toLowerCase().replace(/^www\./, '');
  return v === '' ? null : v;
}

function hostAllowed(host: string, enterprise: string | null): boolean {
  if (host === GITHUB_DEFAULT_HOST) return true;
  return enterprise !== null && host === enterprise;
}

function kindToType(kind: string): GithubItemType | null {
  if (kind === 'issues') return 'issue';
  if (kind === 'pull' || kind === 'pulls') return 'pull';
  return null;
}

/**
 * Parse a GitHub issue/PR reference.
 *
 * Accepts full https URLs (with /files, /commits, #fragment or ?query suffixes),
 * the `owner/repo#123` shorthand, and GitHub Enterprise hosts when `ctx.host`
 * names one. Returns null for anything else.
 */
export function parseGithubUrl(input: string, ctx?: { host?: string }): GithubRef | null {
  const raw = input.trim();
  if (raw === '' || raw.length > 2048) return null;
  const enterprise = normalizeHost(ctx?.host);

  const short = SHORTHAND_RE.exec(raw);
  if (short) {
    const [, owner, repo, num] = short;
    const number = Number(num);
    if (!owner || !repo || number <= 0) return null;
    // The shorthand cannot say issue vs. pull; the issues endpoint resolves both
    // and enrichment corrects the type when the item turns out to be a PR.
    return { host: enterprise ?? GITHUB_DEFAULT_HOST, owner, repo, type: 'issue', number };
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostAllowed(host, enterprise)) return null;

  const segs = u.pathname.split('/').filter((s) => s !== '');
  if (segs.length < 4) return null;
  const [owner, repo, kind, num] = segs;
  if (!owner || !repo || !kind || !num) return null;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  const type = kindToType(kind);
  if (type === null) return null;
  if (!NUM_RE.test(num)) return null;
  const number = Number(num);
  if (number <= 0) return null;
  return { host, owner, repo, type, number };
}

/** The canonical web URL for a reference — what we store and open. */
export function canonicalGithubUrl(ref: GithubRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/${ref.type === 'pull' ? 'pull' : 'issues'}/${ref.number}`;
}

/** `owner/repo#123` — the label used on chips and in toasts. */
export function shortGithubLabel(ref: { owner: string; repo: string; number: number }): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** First GitHub issue/PR reference inside arbitrary text (paste handling). */
export function findGithubRefIn(text: string, ctx?: { host?: string }): { raw: string; ref: GithubRef } | null {
  SCAN_RE.lastIndex = 0;
  for (const m of text.matchAll(SCAN_RE)) {
    const token = m[0].replace(/[.,;:!?]+$/, '');
    const ref = parseGithubUrl(token, ctx);
    if (ref) return { raw: token, ref };
  }
  return null;
}
