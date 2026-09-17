import { describe, expect, it } from 'vitest';
import { COMMANDS } from '@/commands/ids';
import { buildShortcutMap, chordId, eventChord, isBareKey, normalizeKeyName, parseShortcut, shortcutAria, shortcutFor, shortcutGlyphs } from '@/features/shortcuts/keys';

const ev = (over: Partial<Parameters<typeof eventChord>[0]> = {}): Parameters<typeof eventChord>[0] => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('parseShortcut', () => {
  const cases: Array<[string, ReturnType<typeof parseShortcut>]> = [
    ['⌘N', { meta: true, ctrl: false, alt: false, shift: false, key: 'N' }],
    ['⌘⇧N', { meta: true, ctrl: false, alt: false, shift: true, key: 'N' }],
    ['⌃⇧Space', { meta: false, ctrl: true, alt: false, shift: true, key: 'Space' }],
    ['⌘⌫', { meta: true, ctrl: false, alt: false, shift: false, key: 'Backspace' }],
    ['⌥↑', { meta: false, ctrl: false, alt: true, shift: false, key: 'ArrowUp' }],
    ['⌥↓', { meta: false, ctrl: false, alt: true, shift: false, key: 'ArrowDown' }],
    ['⌘\\', { meta: true, ctrl: false, alt: false, shift: false, key: '\\' }],
    ['⌘.', { meta: true, ctrl: false, alt: false, shift: false, key: '.' }],
    ['⌘=', { meta: true, ctrl: false, alt: false, shift: false, key: '=' }],
    ['⌘-', { meta: true, ctrl: false, alt: false, shift: false, key: '-' }],
    ['⌘/', { meta: true, ctrl: false, alt: false, shift: false, key: '/' }],
    ['⌘,', { meta: true, ctrl: false, alt: false, shift: false, key: ',' }],
    ['Space', { meta: false, ctrl: false, alt: false, shift: false, key: 'Space' }],
    ['Tab', { meta: false, ctrl: false, alt: false, shift: false, key: 'Tab' }],
    ['⇧Tab', { meta: false, ctrl: false, alt: false, shift: true, key: 'Tab' }],
    ['E', { meta: false, ctrl: false, alt: false, shift: false, key: 'E' }],
    ['1', { meta: false, ctrl: false, alt: false, shift: false, key: '1' }],
    ['0', { meta: false, ctrl: false, alt: false, shift: false, key: '0' }],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${input}`, () => {
      expect(parseShortcut(input)).toEqual(expected);
    });
  }

  it('returns null for an empty string', () => {
    expect(parseShortcut('')).toBeNull();
  });

  it('returns null for modifiers with no key', () => {
    expect(parseShortcut('⌘⇧')).toBeNull();
  });
});

describe('the command registry', () => {
  const withShortcut = COMMANDS.filter((c): c is typeof c & { shortcut: string } => 'shortcut' in c && !!c.shortcut);

  it('parses every shortcut in COMMANDS without throwing', () => {
    for (const c of withShortcut) {
      expect(parseShortcut(c.shortcut), c.shortcut).not.toBeNull();
    }
  });

  it('has no duplicate chords', () => {
    const ids = withShortcut.map((c) => chordId(parseShortcut(c.shortcut)!));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds one binding per shortcut', () => {
    expect(buildShortcutMap().size).toBe(withShortcut.length);
  });

  it('renders glyphs for every shortcut', () => {
    for (const c of withShortcut) expect(shortcutGlyphs(c.shortcut).length).toBeGreaterThan(0);
  });

  it('produces a spoken form for every shortcut', () => {
    for (const c of withShortcut) expect(shortcutAria(c.shortcut)).not.toBe('');
  });

  it('looks up a shortcut by command id', () => {
    expect(shortcutFor('view.palette')).toBe('⌘K');
    expect(shortcutFor('task.due.weekend')).toBeUndefined();
  });
});

describe('eventChord', () => {
  it('prefers event.code for letters, so ⌥-shortcuts survive', () => {
    expect(eventChord(ev({ key: '†', code: 'KeyT', altKey: true })).key).toBe('T');
  });

  it('prefers event.code for digits', () => {
    expect(eventChord(ev({ key: '1', code: 'Digit1' })).key).toBe('1');
  });

  it('maps punctuation codes', () => {
    expect(eventChord(ev({ key: '=', code: 'Equal' })).key).toBe('=');
    expect(eventChord(ev({ key: '\\', code: 'Backslash' })).key).toBe('\\');
  });

  it('falls back to event.key when there is no code', () => {
    expect(eventChord(ev({ key: 'ArrowUp' })).key).toBe('ArrowUp');
    expect(eventChord(ev({ key: ' ' })).key).toBe('Space');
  });

  it('uppercases a lone letter key', () => {
    expect(eventChord(ev({ key: 'j' })).key).toBe('J');
  });

  it('carries the modifier flags', () => {
    const c = eventChord(ev({ key: 'k', code: 'KeyK', metaKey: true, shiftKey: true }));
    expect(chordId(c)).toBe('MS:K');
  });

  it('matches the registry chord for ⌘K', () => {
    const chord = eventChord(ev({ key: 'k', code: 'KeyK', metaKey: true }));
    expect(buildShortcutMap().get(chordId(chord))?.id).toBe('view.palette');
  });

  it('matches the registry chord for a bare T', () => {
    const chord = eventChord(ev({ key: 't', code: 'KeyT' }));
    expect(buildShortcutMap().get(chordId(chord))?.id).toBe('task.due.today');
  });

  it('matches the registry chord for ⇧T', () => {
    const chord = eventChord(ev({ key: 'T', code: 'KeyT', shiftKey: true }));
    expect(buildShortcutMap().get(chordId(chord))?.id).toBe('task.due.tomorrow');
  });
});

describe('isBareKey', () => {
  it('is true with no command modifiers', () => {
    expect(isBareKey(parseShortcut('E')!)).toBe(true);
    expect(isBareKey(parseShortcut('⇧Tab')!)).toBe(true);
  });
  it('is false for ⌘, ⌃ and ⌥ chords', () => {
    expect(isBareKey(parseShortcut('⌘E')!)).toBe(false);
    expect(isBareKey(parseShortcut('⌃⇧Space')!)).toBe(false);
    expect(isBareKey(parseShortcut('⌥↑')!)).toBe(false);
  });
});

describe('normalizeKeyName', () => {
  it('normalizes names and glyphs alike', () => {
    expect(normalizeKeyName('esc')).toBe('Escape');
    expect(normalizeKeyName('⌫')).toBe('Backspace');
    expect(normalizeKeyName('Escape')).toBe('Escape');
    expect(normalizeKeyName('')).toBe('');
  });
});

describe('shortcutGlyphs', () => {
  it('orders modifiers ⌃⌥⇧⌘', () => {
    expect(shortcutGlyphs('⌘⇧N')).toEqual(['⇧', '⌘', 'N']);
    expect(shortcutGlyphs('⌃⇧Space')).toEqual(['⌃', '⇧', 'Space']);
  });
  it('renders the delete glyph', () => {
    expect(shortcutGlyphs('⌘⌫')).toEqual(['⌘', '⌫']);
  });
  it('spells out the chord for screen readers', () => {
    expect(shortcutAria('⌘⇧N')).toBe('Shift Command N');
    expect(shortcutAria('⌘⌫')).toBe('Command Delete');
  });
});
