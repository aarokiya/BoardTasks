import { describe, expect, it } from 'vitest';
import { isValidAccelerator, labelWithHint, toAccelerator } from '../../../../src/main/platform/accelerator';

describe('toAccelerator', () => {
  it.each([
    ['⌘N', 'CmdOrCtrl+N'],
    ['⌘⇧N', 'CmdOrCtrl+Shift+N'],
    ['⌘⇧L', 'CmdOrCtrl+Shift+L'],
    ['⌥↑', 'Alt+Up'],
    ['⌥↓', 'Alt+Down'],
    ['⌘,', 'CmdOrCtrl+,'],
    ['⌘\\', 'CmdOrCtrl+\\'],
    ['⌘/', 'CmdOrCtrl+/'],
    ['⌘=', 'CmdOrCtrl+='],
    ['⌘-', 'CmdOrCtrl+-'],
    ['⌘0', 'CmdOrCtrl+0'],
    ['⌘.', 'CmdOrCtrl+.'],
    ['⌘1', 'CmdOrCtrl+1'],
    ['⌘⌫', 'CmdOrCtrl+Backspace'],
    ['⌃⇧Space', 'Ctrl+Shift+Space'],
    ['⌘⇧Z', 'CmdOrCtrl+Shift+Z'],
    ['⌘⇧G', 'CmdOrCtrl+Shift+G'],
  ])('%s → %s', (glyphs, expected) => {
    expect(toAccelerator(glyphs)).toBe(expected);
  });

  it.each(['E', 'T', 'J', 'K', 'D', 'R', 'F', 'Space', 'Tab', '0', '1', '2', '3'])(
    'refuses %s — a bare key as an accelerator would swallow typing app-wide',
    (glyphs) => {
      expect(toAccelerator(glyphs)).toBeUndefined();
    },
  );

  it('refuses Shift-only combos for the same reason', () => {
    expect(toAccelerator('⇧T')).toBeUndefined();
    expect(toAccelerator('⇧D')).toBeUndefined();
    expect(toAccelerator('⇧Tab')).toBeUndefined();
  });

  it('returns undefined for an absent or modifier-only shortcut', () => {
    expect(toAccelerator(undefined)).toBeUndefined();
    expect(toAccelerator('')).toBeUndefined();
    expect(toAccelerator('⌘')).toBeUndefined();
    expect(toAccelerator('⌘Frobnicate')).toBeUndefined();
  });
});

describe('labelWithHint', () => {
  it('leaves a real accelerator to the menu', () => {
    expect(labelWithHint('New Task', '⌘N')).toBe('New Task');
  });
  it('shows the glyph inline when it cannot be an accelerator', () => {
    expect(labelWithHint('Complete', 'Space')).toBe('Complete (Space)');
    expect(labelWithHint('Indent', 'Tab')).toBe('Indent (Tab)');
  });
  it('leaves a shortcut-less command alone', () => {
    expect(labelWithHint('Full Resync', undefined)).toBe('Full Resync');
  });
});

describe('isValidAccelerator', () => {
  it.each(['Control+Shift+Space', 'CmdOrCtrl+Shift+N', 'Alt+Up', 'Command+,', 'Super+F5'])('accepts %s', (a) => {
    expect(isValidAccelerator(a)).toBe(true);
  });
  it.each(['', 'Space', 'Nope+K', 'Ctrl+', '+K', 'Ctrl+Ctrl+K', 'Shift'])('rejects %j', (a) => {
    expect(isValidAccelerator(a)).toBe(false);
  });
});
