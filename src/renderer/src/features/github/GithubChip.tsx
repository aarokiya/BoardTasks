import type { MouseEvent, ReactElement } from 'react';
import type { GithubLink } from '@shared/models';
import { formatAgo } from '@shared/date/format';
import { errorCopy, GithubStateGlyph, glyphFor, isStale, stateLabel } from './glyphs';
import { copyGithubUrl, openOnGithub } from './actions';
import s from './github.module.css';

export interface GithubChipProps {
  link: GithubLink;
  /** Glyph + number only, for dense rows. */
  compact?: boolean;
}

function tooltipFor(link: GithubLink): string {
  const ref = `${link.owner}/${link.repo}#${link.number}`;
  if (link.error !== null) return `${ref} — ${errorCopy(link.error)}`;
  const parts = [link.title ?? ref];
  if (link.author !== null && link.author !== '') parts.push(`@${link.author}`);
  parts.push(`${stateLabel(link.state)} · updated ${formatAgo(link.remoteUpdatedAt ?? link.fetchedAt)}`);
  return parts.join(' · ');
}

/**
 * The 20px status chip shown on task rows. State is carried by SHAPE first and
 * colour second, so it survives both colour-blindness and a greyscale screenshot.
 */
export function GithubChip({ link, compact = false }: GithubChipProps): ReactElement {
  const { kind, strike, mark } = glyphFor(link);
  const stale = isStale(link);
  const tooltip = tooltipFor(link);
  const label = compact ? `#${link.number}` : `${link.repo}#${link.number}`;

  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    void (e.metaKey || e.ctrlKey ? copyGithubUrl(link.url) : openOnGithub(link.url));
  };

  return (
    <button
      type="button"
      className={[s.chip, compact ? s.chipCompact : '', stale ? s.chipStale : ''].filter(Boolean).join(' ')}
      data-testid="gh-chip"
      data-state={link.error === null ? (link.state ?? 'unknown') : 'unknown'}
      data-error={link.error ?? undefined}
      data-stale={stale ? 'true' : undefined}
      title={tooltip}
      aria-label={`${link.owner}/${link.repo}#${link.number} — ${tooltip}`}
      onClick={onClick}
      onMouseDown={(e) => { e.stopPropagation(); }}
    >
      <GithubStateGlyph kind={kind} />
      <span className={[s.chipLabel, strike ? s.chipGone : ''].filter(Boolean).join(' ')}>{label}</span>
      {mark ? <span className={s.chipMark} aria-hidden="true">!</span> : null}
    </button>
  );
}
