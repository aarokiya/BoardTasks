import { describe, expect, it } from 'vitest';
import { FIRST_KEY, keyBetween, keyFromPosition, POSITION_PREFIX } from '../../../src/shared/ids';

/**
 * Key length is the only thing that can quietly go wrong with fractional
 * indexing: every insert at the same spot adds precision, and an unbounded
 * growth rate turns a day of reordering into kilobyte sort keys.
 */

/** A Google `position`: an opaque, zero-padded 20-digit string. */
const gpos = (n: number): string => keyFromPosition(String(n * 100_000).padStart(20, '0'));

describe('keyBetween growth', () => {
  it('500 inserts at the FRONT stay ordered and bounded', () => {
    const keys: string[] = [FIRST_KEY];
    for (let i = 0; i < 500; i++) keys.unshift(keyBetween(null, keys[0]!));

    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    // ~1 character per 5 inserts; anything super-linear is a defect.
    expect(keys[0]!.length).toBeLessThan(150);
  });

  it('500 inserts at the END stay ordered and grow at most ~1 char per 5', () => {
    const keys: string[] = [FIRST_KEY];
    for (let i = 0; i < 500; i++) keys.push(keyBetween(keys[keys.length - 1]!, null));

    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
    // Appending bisects towards 'z' (~6 steps per digit) before adding one, so
    // growth is linear at roughly a character per six appends. That is bounded
    // in practice because a successful push replaces the key with the server's
    // 21-character `position`; this pins the rate so a regression is visible.
    expect(keys[keys.length - 1]!.length).toBeLessThan(120);
  });

  it('500 inserts into the SAME gap stay ordered and bounded', () => {
    const lo = 'A';
    let hi = 'B';
    const inserted: string[] = [];
    for (let i = 0; i < 500; i++) {
      hi = keyBetween(lo, hi);
      inserted.push(hi);
      expect(lo < hi).toBe(true);
    }
    for (let i = 1; i < inserted.length; i++) expect(inserted[i]! < inserted[i - 1]!).toBe(true);
    expect(hi.length).toBeLessThan(150);
  });

  it('inserts before, between and after Google positions', () => {
    const a = gpos(1);
    const b = gpos(2);
    expect(a.startsWith(POSITION_PREFIX)).toBe(true);

    const before = keyBetween(null, a);
    const between = keyBetween(a, b);
    const after = keyBetween(b, null);
    expect(before < a).toBe(true);
    expect(a < between && between < b).toBe(true);
    expect(b < after).toBe(true);

    // 500 drags into the same server gap must not collide or invert.
    let lo = a;
    for (let i = 0; i < 500; i++) {
      const k = keyBetween(lo, b);
      expect(lo < k && k < b).toBe(true);
      lo = k;
    }
    expect(lo.length).toBeLessThan(150);
  });

  it('sorts locally-generated keys against server keys stably', () => {
    // 'P' sits mid-alphabet, so a local key can be placed either side of a
    // server-positioned one; the total order must still be a total order.
    const server = [gpos(1), gpos(2), gpos(3)];
    const local = [keyBetween(null, server[0]!), keyBetween(server[0]!, server[1]!), keyBetween(server[2]!, null)];
    const all = [...server, ...local].sort();
    for (let i = 1; i < all.length; i++) expect(all[i - 1]! < all[i]!).toBe(true);
  });

  it('never emits a key ending in the minimum digit, at any depth', () => {
    let k = FIRST_KEY;
    for (let i = 0; i < 300; i++) {
      k = keyBetween(null, k);
      expect(k.endsWith('0')).toBe(false);
      expect(k.length).toBeGreaterThan(0);
    }
  });
});
