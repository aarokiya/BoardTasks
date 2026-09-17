/**
 * The command registry stores shortcuts as macOS display glyphs ('⌘⇧N').
 * Electron menus want accelerator strings ('CmdOrCtrl+Shift+N'). This module is
 * the only translation point, and it is deliberately free of any electron
 * import so it can be unit-tested on its own.
 */

const MODIFIER_GLYPHS: Record<string, string> = {
  '⌘': 'CmdOrCtrl',
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift',
};

/** Emission order; Electron itself is order-insensitive, we just want stable output. */
const MODIFIER_ORDER = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift'] as const;

const KEY_GLYPHS: Record<string, string> = {
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
  '⏎': 'Return',
  '↩': 'Return',
  '⎋': 'Escape',
  '⇥': 'Tab',
  Space: 'Space',
  Tab: 'Tab',
  Esc: 'Escape',
  Escape: 'Escape',
  Enter: 'Return',
  Return: 'Return',
  Delete: 'Delete',
  Backspace: 'Backspace',
};

/** Keys Electron accepts verbatim beyond the single printable characters. */
const NAMED_KEYS = new Set([
  'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Return', 'Escape', 'Tab', 'Space',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Plus',
  ...Array.from({ length: 24 }, (_v, i) => `F${i + 1}`),
]);

const MODIFIER_NAMES = new Set([
  'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl',
  'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta',
]);

/**
 * A menu accelerator needs a "hard" modifier — Cmd, Ctrl or Alt. Bare keys
 * ('T', 'Space', 'Tab', '1') and Shift-only combos ('⇧T') would be swallowed by
 * the menu before any focused text field ever saw them, which breaks typing
 * app-wide. Those commands are handled by the renderer's KeyboardScope instead,
 * so we show the glyph in the label and register no accelerator.
 */
export function toAccelerator(glyphs: string | undefined): string | undefined {
  if (!glyphs) return undefined;
  const mods = new Set<string>();
  let i = 0;
  const chars = [...glyphs];
  while (i < chars.length && MODIFIER_GLYPHS[chars[i]!]) {
    mods.add(MODIFIER_GLYPHS[chars[i]!]!);
    i++;
  }
  const rest = chars.slice(i).join('');
  if (rest.length === 0) return undefined;
  if (!mods.has('CmdOrCtrl') && !mods.has('Ctrl') && !mods.has('Alt')) return undefined;

  const key = KEY_GLYPHS[rest] ?? (rest.length === 1 ? rest.toUpperCase() : undefined);
  if (key === undefined) return undefined;

  const parts = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...parts, key].join('+');
}

/**
 * Validates a user-supplied accelerator (the Quick Add global shortcut) before
 * handing it to globalShortcut.register, which throws on malformed input.
 */
export function isValidAccelerator(accel: string): boolean {
  const parts = accel.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => p.length === 0)) return false;
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (mods.length === 0 || !mods.every((m) => MODIFIER_NAMES.has(m))) return false;
  if (new Set(mods).size !== mods.length) return false;
  return NAMED_KEYS.has(key) || (key.length === 1 && /[\w`~!@#$%^&*()\-=[\]\\;',./{}|:"<>?+]/.test(key));
}

/** Menu label for a command whose shortcut cannot be a real accelerator. */
export function labelWithHint(label: string, glyphs: string | undefined): string {
  if (!glyphs || toAccelerator(glyphs) !== undefined) return label;
  return `${label} (${glyphs})`;
}
