/**
 * Parses the macOS glyph shortcut strings in COMMANDS into chords the keydown
 * dispatcher can look up, and back into glyphs for the cheat sheet.
 *
 * Key identity comes from `event.code` where possible: on macOS ⌥T produces
 * `event.key === '†'`, so matching on `key` alone silently breaks every
 * Option shortcut.
 */
import { COMMANDS, type CommandId } from '../../commands/ids';

export interface KeyChord {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Normalized key name: 'A'…'Z', '0'…'9', 'Space', 'Tab', 'Backspace', 'ArrowUp', '/', '\\', … */
  key: string;
}

const MODIFIER_GLYPHS: Record<string, keyof Omit<KeyChord, 'key'>> = {
  '⌘': 'meta',
  '⇧': 'shift',
  '⌥': 'alt',
  '⌃': 'ctrl',
};

const NAMED_GLYPHS: Record<string, string> = {
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '⏎': 'Enter',
  '↩': 'Enter',
  '⎋': 'Escape',
  '⇥': 'Tab',
  space: 'Space',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  delete: 'Backspace',
  backspace: 'Backspace',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

/** Glyphs for the cheat sheet / kbd hints, in canonical macOS order. */
const GLYPH_FOR_KEY: Record<string, string> = {
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '⏎',
  Escape: 'esc',
  Tab: '⇥',
  Space: 'Space',
};

const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: 'Space',
};

export function normalizeKeyName(raw: string): string {
  if (raw.length === 0) return '';
  const named = NAMED_GLYPHS[raw] ?? NAMED_GLYPHS[raw.toLowerCase()];
  if (named) return named;
  if (raw === ' ') return 'Space';
  if (raw.length === 1) return raw.toUpperCase();
  // 'ArrowUp', 'Escape', 'Enter', 'Tab', 'Backspace' arrive already normalized.
  return raw;
}

/** '⌘⇧N' → { meta: true, shift: true, key: 'N' }. Returns null for junk. */
export function parseShortcut(shortcut: string): KeyChord | null {
  const chord: KeyChord = { meta: false, ctrl: false, alt: false, shift: false, key: '' };
  let rest = '';
  for (const ch of shortcut) {
    const mod = MODIFIER_GLYPHS[ch];
    if (mod && rest === '') chord[mod] = true;
    else rest += ch;
  }
  chord.key = normalizeKeyName(rest);
  return chord.key ? chord : null;
}

/** Stable lookup string for a chord. */
export function chordId(c: KeyChord): string {
  return `${c.meta ? 'M' : ''}${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}:${c.key}`;
}

interface KeyboardEventish {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Chord for a real keydown event. */
export function eventChord(e: KeyboardEventish): KeyChord {
  const code = e.code ?? '';
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : (CODE_KEYS[code] ?? normalizeKeyName(e.key));
  return { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key };
}

/** A chord with no ⌘/⌃/⌥ — these only fire when focus is in the task list. */
export const isBareKey = (c: KeyChord): boolean => !c.meta && !c.ctrl && !c.alt;

/** Glyph sequence for rendering, e.g. '⌘⇧N' → ['⌘', '⇧', 'N']. */
export function shortcutGlyphs(shortcut: string): string[] {
  const chord = parseShortcut(shortcut);
  if (!chord) return [];
  const out: string[] = [];
  if (chord.ctrl) out.push('⌃');
  if (chord.alt) out.push('⌥');
  if (chord.shift) out.push('⇧');
  if (chord.meta) out.push('⌘');
  out.push(GLYPH_FOR_KEY[chord.key] ?? chord.key);
  return out;
}

export interface ShortcutBinding {
  id: CommandId;
  chord: KeyChord;
  shortcut: string;
}

/**
 * chordId → command. Built once from COMMANDS; later entries win, which never
 * happens today because every shortcut in the registry is unique.
 */
export function buildShortcutMap(): Map<string, ShortcutBinding> {
  const map = new Map<string, ShortcutBinding>();
  for (const c of COMMANDS) {
    if (!('shortcut' in c) || !c.shortcut) continue;
    const chord = parseShortcut(c.shortcut);
    if (!chord) continue;
    map.set(chordId(chord), { id: c.id, chord, shortcut: c.shortcut });
  }
  return map;
}

/** The shortcut string for a command id, or undefined. */
export function shortcutFor(id: CommandId): string | undefined {
  const c = COMMANDS.find((x) => x.id === id);
  return c && 'shortcut' in c ? c.shortcut : undefined;
}

const ARIA_KEY: Record<string, string> = {
  Backspace: 'Delete',
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  ArrowLeft: 'Left arrow',
  ArrowRight: 'Right arrow',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  '\\': 'Backslash',
  '/': 'Slash',
  '.': 'Period',
  ',': 'Comma',
  '=': 'Equals',
  '-': 'Minus',
};

/** Spoken form of a shortcut, e.g. '⌘⇧N' → 'Command Shift N'. */
export function shortcutAria(shortcut: string): string {
  const chord = parseShortcut(shortcut);
  if (!chord) return '';
  const parts: string[] = [];
  if (chord.ctrl) parts.push('Control');
  if (chord.alt) parts.push('Option');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push('Command');
  parts.push(ARIA_KEY[chord.key] ?? chord.key);
  return parts.join(' ');
}
