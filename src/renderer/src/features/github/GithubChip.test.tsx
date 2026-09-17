import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installMockApi } from '../../../../../tests/setup/mockApi';
import { GithubChip } from './GithubChip';
import { STALE_MS } from './glyphs';
import { makeLink } from './testUtils';

describe('GithubChip', () => {
  it('draws a distinct shape for every state — never colour alone', () => {
    const states = ['open', 'merged', 'closed', 'draft'] as const;
    const shapes = new Map<string, string>();
    for (const state of states) {
      const { unmount } = render(<GithubChip link={makeLink({ state })} />);
      const glyph = screen.getByTestId('gh-chip').querySelector('svg')!;
      expect(glyph.getAttribute('data-glyph')).toBe(state);
      shapes.set(state, glyph.innerHTML);
      unmount();
    }
    expect(new Set(shapes.values()).size).toBe(states.length);
  });

  it('shows repo#number with tabular figures, and just the number when compact', () => {
    const { rerender } = render(<GithubChip link={makeLink({ number: 1234 })} />);
    expect(screen.getByTestId('gh-chip')).toHaveTextContent('r#1234');
    rerender(<GithubChip link={makeLink({ number: 1234 })} compact />);
    expect(screen.getByTestId('gh-chip')).toHaveTextContent('#1234');
    expect(screen.getByTestId('gh-chip')).not.toHaveTextContent('r#1234');
  });

  it('describes the item in its tooltip', () => {
    render(<GithubChip link={makeLink({ title: 'Fix the flicker', author: 'octocat' })} />);
    const title = screen.getByTestId('gh-chip').getAttribute('title')!;
    expect(title).toContain('Fix the flicker');
    expect(title).toContain('@octocat');
    expect(title).toContain('Open');
  });

  it('no_token reads as neutral and explains how to fix it', () => {
    render(<GithubChip link={makeLink({ error: 'no_token', state: null, title: null })} />);
    const chip = screen.getByTestId('gh-chip');
    expect(chip.querySelector('svg')!.getAttribute('data-glyph')).toBe('unknown');
    expect(chip.getAttribute('title')).toContain('Connect GitHub to see status');
    expect(chip).toHaveAttribute('data-stale', 'true');
  });

  it('unauthorized marks the chip and forbidden locks it', () => {
    const { unmount } = render(<GithubChip link={makeLink({ error: 'unauthorized' })} />);
    expect(screen.getByTestId('gh-chip')).toHaveTextContent('!');
    expect(screen.getByTestId('gh-chip').querySelector('svg')!.getAttribute('data-glyph')).toBe('alert');
    unmount();
    render(<GithubChip link={makeLink({ error: 'forbidden' })} />);
    expect(screen.getByTestId('gh-chip').querySelector('svg')!.getAttribute('data-glyph')).toBe('locked');
  });

  it('not_found strikes the label through', () => {
    render(<GithubChip link={makeLink({ error: 'not_found' })} />);
    const label = screen.getByTestId('gh-chip').querySelector('span')!;
    expect(label.className).toContain('chipGone');
  });

  it('marks a link nobody has refreshed in half an hour as stale', () => {
    const fresh = render(<GithubChip link={makeLink()} />);
    expect(screen.getByTestId('gh-chip')).not.toHaveAttribute('data-stale');
    fresh.unmount();
    render(<GithubChip link={makeLink({ fetchedAt: new Date(Date.now() - STALE_MS - 1000).toISOString() })} />);
    expect(screen.getByTestId('gh-chip')).toHaveAttribute('data-stale', 'true');
  });

  it('opens the item in the browser through main, and copies on ⌘-click', async () => {
    const api = installMockApi();
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub, so override it afterwards.
    const writeText = vi.fn((): Promise<void> => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<GithubChip link={makeLink({ url: 'https://github.com/o/r/issues/12' })} />);

    await user.click(screen.getByTestId('gh-chip'));
    expect(api.calls.at(-1)).toEqual({ channel: 'app:openExternal', payload: { url: 'https://github.com/o/r/issues/12' } });

    fireEvent.click(screen.getByTestId('gh-chip'), { metaKey: true });
    expect(writeText).toHaveBeenCalledWith('https://github.com/o/r/issues/12');
  });
});
