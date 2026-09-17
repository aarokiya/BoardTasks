import { describe, expect, it } from 'vitest';
import { keyBetween, keyFromPosition, keySequence, FIRST_KEY } from '@shared/ids';

describe('keyBetween', () => {
  it('returns FIRST_KEY for an empty list', () => {
    expect(keyBetween(null, null)).toBe(FIRST_KEY);
  });
  it('generates keys after', () => {
    let k: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      k = keyBetween(k, null);
      keys.push(k);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
    expect(keys[199]!.length).toBeLessThan(40);
  });
  it('generates keys before, including before a zero-padded server position', () => {
    const first = keyFromPosition('00000000000000000000');
    const before = keyBetween(null, first);
    expect(before < first).toBe(true);
    let k = before;
    for (let i = 0; i < 100; i++) {
      const nk = keyBetween(null, k);
      expect(nk < k).toBe(true);
      k = nk;
    }
  });
  it('generates keys between adjacent server positions', () => {
    const a = keyFromPosition('00000000000000000001');
    const b = keyFromPosition('00000000000000000002');
    const m = keyBetween(a, b);
    expect(m > a && m < b).toBe(true);
    const m2 = keyBetween(a, m);
    expect(m2 > a && m2 < m).toBe(true);
    const m3 = keyBetween(m, b);
    expect(m3 > m && m3 < b).toBe(true);
  });
  it('handles a being a prefix of b', () => {
    const m = keyBetween('V', 'VV');
    expect(m > 'V' && m < 'VV').toBe(true);
  });
  it('never produces a key ending in 0', () => {
    let a: string | null = null;
    let b: string | null = null;
    for (let i = 0; i < 500; i++) {
      const k = keyBetween(a, b);
      expect(k.endsWith('0')).toBe(false);
      if (i % 2) a = k;
      else b = k;
      if (a !== null && b !== null && a >= b) [a, b] = [b, a];
    }
  });
  it('repeated bisection between two keys stays ordered', () => {
    let lo = 'A';
    const hi = 'B';
    for (let i = 0; i < 100; i++) {
      const m = keyBetween(lo, hi);
      expect(m > lo && m < hi).toBe(true);
      lo = m;
    }
  });
  it('throws for a >= b', () => {
    expect(() => keyBetween('b', 'a')).toThrow(RangeError);
    expect(() => keyBetween('a', 'a')).toThrow(RangeError);
  });
  it('keySequence is strictly ascending', () => {
    const s = keySequence(50);
    for (let i = 1; i < s.length; i++) expect(s[i]! > s[i - 1]!).toBe(true);
  });
});
