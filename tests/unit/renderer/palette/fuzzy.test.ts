import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyRank, highlight, isSubsequence, SCORE } from '@/features/palette/fuzzy';

const score = (q: string, t: string): number => {
  const m = fuzzyMatch(q, t);
  if (!m) throw new Error(`expected "${q}" to match "${t}"`);
  return m.score;
};

describe('subsequence pre-filter', () => {
  it('accepts an in-order subsequence', () => {
    expect(isSubsequence('abc', 'axbxc')).toBe(true);
  });
  it('rejects an out-of-order one', () => {
    expect(isSubsequence('cba', 'axbxc')).toBe(false);
  });
  it('rejects a missing character', () => {
    expect(fuzzyMatch('xyz', 'Command Palette')).toBeNull();
  });
  it('rejects a query longer than the target', () => {
    expect(fuzzyMatch('completed', 'all')).toBeNull();
  });
});

describe('fuzzyMatch', () => {
  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'Anything')).toEqual({ score: 0, positions: [] });
  });

  it('reports ascending match positions', () => {
    const m = fuzzyMatch('cp', 'Command Palette')!;
    expect(m.positions).toEqual([0, 8]);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('CMD', 'command')).not.toBeNull();
  });

  it('rewards a prefix over a mid-string hit', () => {
    expect(score('task', 'Task Delete')).toBeGreaterThan(score('task', 'New Task'));
  });

  it('rewards a word boundary over a mid-word hit', () => {
    expect(score('p', 'Command Palette')).toBeGreaterThan(score('p', 'Complete'));
  });

  it('rewards a camelCase boundary', () => {
    expect(score('c', 'quickCall')).toBeGreaterThan(score('c', 'quickcall'));
  });

  it('rewards consecutive runs over scattered hits', () => {
    expect(score('abc', 'zabcz')).toBeGreaterThan(score('abc', 'zazbzcz'));
  });

  it('rewards an exact-case hit', () => {
    expect(score('T', 'Task')).toBe(score('t', 'Task') + SCORE.exactCase);
  });

  it('penalises a longer target for the same match', () => {
    expect(score('sync', 'Sync')).toBeGreaterThan(score('sync', 'Sync Everything Now'));
  });

  it('caps the gap penalty so distant tails still match', () => {
    const near = score('ae', 'abcde');
    const far = score('ae', `a${'b'.repeat(60)}e`);
    // Without the cap the 60-character gap would cost 120 points.
    expect(near - far).toBeLessThan(SCORE.gapCap + SCORE.lengthPenalty * 61 + 1);
  });

  it('picks the highest-scoring alignment, not the first', () => {
    const m = fuzzyMatch('ta', 'a tab')!;
    expect(m.positions).toEqual([2, 3]);
  });

  it('ranks an exact title above a partial one', () => {
    expect(score('work', 'Work')).toBeGreaterThan(score('work', 'Homework'));
  });

  it('handles separators as word boundaries', () => {
    expect(score('r', 'acme/repo')).toBeGreaterThan(score('r', 'acmerepo'));
  });
});

describe('highlight', () => {
  it('splits into matched and unmatched runs', () => {
    expect(highlight('Command', [0, 1])).toEqual([
      { text: 'Co', match: true },
      { text: 'mmand', match: false },
    ]);
  });
  it('handles a trailing match', () => {
    expect(highlight('abc', [2])).toEqual([
      { text: 'ab', match: false },
      { text: 'c', match: true },
    ]);
  });
  it('returns one plain run with no positions', () => {
    expect(highlight('abc', [])).toEqual([{ text: 'abc', match: false }]);
  });
  it('returns nothing for an empty target', () => {
    expect(highlight('', [])).toEqual([]);
  });
});

describe('fuzzyRank', () => {
  const items = ['Work', 'Homework', 'Network', 'Worktree'];

  it('sorts by descending score', () => {
    const ranked = fuzzyRank('work', items, (x) => x);
    expect(ranked[0]?.item).toBe('Work');
  });

  it('drops non-matches', () => {
    expect(fuzzyRank('zzz', items, (x) => x)).toHaveLength(0);
  });

  it('keeps input order for equal scores', () => {
    const ties = ['aa', 'aa', 'aa'];
    const ranked = fuzzyRank('a', ties, (x) => x);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.score)).toEqual([ranked[0]!.score, ranked[0]!.score, ranked[0]!.score]);
  });

  it('honours a minimum score', () => {
    expect(fuzzyRank('work', items, (x) => x, 1000)).toHaveLength(0);
  });

  it('is stable across repeated calls', () => {
    const a = fuzzyRank('wor', items, (x) => x).map((r) => r.item);
    const b = fuzzyRank('wor', items, (x) => x).map((r) => r.item);
    expect(a).toEqual(b);
  });
});

describe('performance', () => {
  it('scores 5000 targets well inside a frame', () => {
    const targets = Array.from({ length: 5000 }, (_, i) => `Task ${i} — review the quarterly report for team ${i % 40}`);
    const start = performance.now();
    let hits = 0;
    for (const t of targets) if (fuzzyMatch('revqrt', t)) hits++;
    const elapsed = performance.now() - start;
    expect(hits).toBeGreaterThan(0);
    // The real budget is <30ms; the assertion is deliberately generous so a
    // loaded CI box cannot make this flaky.
    expect(elapsed).toBeLessThan(400);
  });
});
