import type { ReactElement } from 'react';
import type { GithubLink, GithubLinkError, GithubState } from '@shared/models';
import s from './github.module.css';

/**
 * Every state is a distinct SHAPE, never colour alone: open is a ringed dot,
 * merged is a merge fork, closed is a crossed circle, draft is a dashed ring.
 */
export type GlyphKind = 'open' | 'merged' | 'closed' | 'draft' | 'unknown' | 'alert' | 'locked';
export type GlyphTone = 'open' | 'merged' | 'closed' | 'draft' | 'unknown' | 'warning';

const TONE: Record<GlyphKind, GlyphTone> = {
  open: 'open', merged: 'merged', closed: 'closed', draft: 'draft',
  unknown: 'unknown', alert: 'warning', locked: 'warning',
};

function shape(kind: GlyphKind): ReactElement {
  switch (kind) {
    case 'open':
      return (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </>
      );
    case 'merged':
      return (
        <>
          <circle cx="4.5" cy="3.6" r="1.5" />
          <circle cx="4.5" cy="12.4" r="1.5" />
          <circle cx="11.5" cy="8" r="1.5" />
          <path d="M4.5 5.1v5.8" />
          <path d="M4.5 6.6c0 2 1.8 3.2 3.9 3.3l2.1.1" />
        </>
      );
    case 'closed':
      return (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <path d="M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9" />
        </>
      );
    case 'draft':
      return (
        <>
          <circle cx="8" cy="8" r="5.25" strokeDasharray="2 2" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </>
      );
    case 'alert':
      return (
        <>
          <path d="M8 2.6 14.4 13.4H1.6z" />
          <path d="M8 6.6v2.9" />
          <circle cx="8" cy="11.6" r="0.55" fill="currentColor" stroke="none" />
        </>
      );
    case 'locked':
      return (
        <>
          <rect x="3.4" y="7" width="9.2" height="6.1" rx="1.6" />
          <path d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7" />
        </>
      );
    default:
      return (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <path d="M5.5 8h5" />
        </>
      );
  }
}

export function GithubStateGlyph({ kind, size = 14 }: { kind: GlyphKind; size?: number }): ReactElement {
  return (
    <svg
      className={s.glyph}
      data-glyph={kind}
      data-tone={TONE[kind]}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape(kind)}
    </svg>
  );
}

export function stateLabel(state: GithubState | null): string {
  switch (state) {
    case 'open': return 'Open';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
    case 'draft': return 'Draft';
    default: return 'Unknown';
  }
}

/** One short sentence per failure, in the user's language — no HTTP codes. */
export function errorCopy(error: GithubLinkError): string {
  switch (error) {
    case 'no_token': return 'Connect GitHub to see status';
    case 'unauthorized': return 'GitHub rejected the saved token — update it in Settings';
    case 'forbidden': return 'This token cannot see that repository';
    case 'not_found': return 'This issue or pull request no longer exists';
    case 'rate_limited': return 'GitHub rate limit reached — status updates resume shortly';
    default: return 'Could not reach GitHub';
  }
}

export interface GlyphDecision {
  kind: GlyphKind;
  /** Draw the label with a line through it (the item is gone). */
  strike: boolean;
  /** Append a bold "!" — something needs the user's attention. */
  mark: boolean;
}

export function glyphFor(link: Pick<GithubLink, 'state' | 'error'>): GlyphDecision {
  switch (link.error) {
    case 'unauthorized': return { kind: 'alert', strike: false, mark: true };
    case 'forbidden': return { kind: 'locked', strike: false, mark: false };
    case 'not_found': return { kind: 'unknown', strike: true, mark: false };
    case 'no_token':
    case 'rate_limited':
    case 'network': return { kind: 'unknown', strike: false, mark: false };
    default: return { kind: link.state ?? 'unknown', strike: false, mark: false };
  }
}

/** 30 minutes: matches the main-process background refresh window. */
export const STALE_MS = 30 * 60 * 1000;

export function isStale(link: Pick<GithubLink, 'fetchedAt' | 'error'>, now: number = Date.now()): boolean {
  if (link.error !== null) return true;
  if (link.fetchedAt === null) return true;
  const t = Date.parse(link.fetchedAt);
  return Number.isNaN(t) || now - t > STALE_MS;
}
