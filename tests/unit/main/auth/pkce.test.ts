import { describe, expect, it } from 'vitest';
import { codeChallenge, constantTimeEqual, createCodeVerifier, createState } from '../../../../src/main/auth/pkce';

describe('pkce', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('produces a 43-char unpadded base64url verifier (32 bytes of entropy)', () => {
    const v = createCodeVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it('never repeats a verifier or a state', () => {
    const verifiers = new Set(Array.from({ length: 200 }, () => createCodeVerifier()));
    const states = new Set(Array.from({ length: 200 }, () => createState()));
    expect(verifiers.size).toBe(200);
    expect(states.size).toBe(200);
  });

  it('challenges are unpadded base64url and stable for a given verifier', () => {
    const v = createCodeVerifier();
    const c = codeChallenge(v);
    expect(c).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(codeChallenge(v)).toBe(c);
  });

  describe('constantTimeEqual', () => {
    it('is true only for identical strings', () => {
      expect(constantTimeEqual('abc', 'abc')).toBe(true);
      expect(constantTimeEqual('abc', 'abd')).toBe(false);
    });
    it('handles unequal lengths without throwing (timingSafeEqual would)', () => {
      expect(constantTimeEqual('abc', '')).toBe(false);
      expect(constantTimeEqual('', 'abcdefghijkl')).toBe(false);
      expect(constantTimeEqual('', '')).toBe(true);
    });
    it('compares by bytes, not by prefix', () => {
      const state = createState();
      expect(constantTimeEqual(state, `${state}x`)).toBe(false);
      expect(constantTimeEqual(state, state.slice(0, -1))).toBe(false);
    });
  });
});
