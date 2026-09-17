import { describe, expect, it } from 'vitest';
import { modeFromWidth, nextMode, paneLayout } from '../../src/renderer/src/features/shell/useLayoutMode';

describe('responsive layout mode', () => {
  it('maps widths to modes at the documented breakpoints', () => {
    expect(modeFromWidth(1400)).toBe('full');
    expect(modeFromWidth(1120)).toBe('full');
    expect(modeFromWidth(1000)).toBe('clamped');
    expect(modeFromWidth(800)).toBe('rail');
    expect(modeFromWidth(700)).toBe('overlay');
    expect(modeFromWidth(500)).toBe('stack');
  });

  it('needs a 24px overshoot before flipping down', () => {
    // 1119 is inside "clamped" territory, but hysteresis holds "full".
    expect(nextMode('full', 1110)).toBe('full');
    expect(nextMode('full', 1095)).toBe('clamped');
  });

  it('needs a 24px overshoot before flipping up', () => {
    expect(nextMode('rail', 950)).toBe('rail');
    expect(nextMode('rail', 964)).toBe('clamped');
  });

  it('can cross several modes in one jump', () => {
    expect(nextMode('stack', 1400)).toBe('full');
    expect(nextMode('full', 400)).toBe('stack');
  });

  it('describes the panes for each mode', () => {
    expect(paneLayout('full')).toEqual({ sidebar: 'full', detail: 'inline', detailMaxWidth: null });
    expect(paneLayout('clamped').detailMaxWidth).toBe(300);
    expect(paneLayout('rail').sidebar).toBe('rail');
    expect(paneLayout('overlay')).toMatchObject({ sidebar: 'hidden', detail: 'sheet' });
    expect(paneLayout('stack')).toMatchObject({ sidebar: 'hidden', detail: 'fullscreen' });
  });
});
