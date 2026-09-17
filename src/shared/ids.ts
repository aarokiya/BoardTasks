/**
 * Fractional indexing over an alphanumeric alphabet: generate a sort key
 * strictly between any two existing keys without renumbering neighbors.
 *
 * Invariant: generated keys never end in the minimum digit '0', so no key is
 * ever a "zero-extension" of another (which would leave no room between them).
 * Keys derived from Google's opaque `position` strings are prefixed with
 * POSITION_PREFIX so that "before the first server item" is always possible.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
const MID = Math.floor(BASE / 2); // 'V'

export const FIRST_KEY = ALPHABET[MID]!;
export const POSITION_PREFIX = 'P';

const idx = (c: string): number => {
  const i = ALPHABET.indexOf(c);
  if (i < 0) throw new RangeError(`Invalid sort key char: ${c}`);
  return i;
};
const ch = (n: number): string => ALPHABET[n]!;

/** A key strictly greater than s (s may be empty). */
function incrementKey(s: string): string {
  if (s.length === 0) return FIRST_KEY;
  const last = idx(s[s.length - 1]!);
  if (last < BASE - 1) return s.slice(0, -1) + ch(Math.floor((last + BASE) / 2));
  return s + FIRST_KEY;
}

/** A non-empty key strictly less than s. Throws if s is all-minimum digits. */
function decrementKey(s: string): string {
  let j = s.length - 1;
  while (j >= 0 && idx(s[j]!) === 0) j--;
  if (j < 0) throw new RangeError(`No key is smaller than "${s}"`);
  const c = idx(s[j]!);
  if (c === 1) return s.slice(0, j) + '0' + FIRST_KEY;
  return s.slice(0, j) + ch(Math.floor(c / 2));
}

/** Key strictly between a and b. a=null → before b; b=null → after a; both null → FIRST_KEY. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a === null && b === null) return FIRST_KEY;
  if (a === null) return decrementKey(b!);
  if (b === null) return incrementKey(a);
  if (a >= b) throw new RangeError(`keyBetween: "${a}" >= "${b}"`);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const prefix = a.slice(0, i);
  if (i === a.length) return prefix + decrementKey(b.slice(i));
  const da = idx(a[i]!);
  const db = idx(b[i]!);
  if (db - da > 1) return prefix + ch(Math.floor((da + db) / 2));
  return prefix + a[i]! + incrementKey(a.slice(i + 1));
}

/** Sort key for a task whose ordering comes from the server's `position`. */
export function keyFromPosition(position: string): string {
  return POSITION_PREFIX + position;
}

/** n evenly-spaced keys for seeding a fresh list. */
export function keySequence(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, null);
    out.push(prev);
  }
  return out;
}
