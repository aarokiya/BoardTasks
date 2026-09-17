/**
 * fzy-style fuzzy matching, ~150 lines, no dependency.
 *
 * Two phases:
 *  1. A cheap subsequence pre-filter rejects the ~99% of candidates that cannot
 *     match at all, so the expensive phase only ever sees plausible targets.
 *  2. An O(query × target) dynamic program scores the best alignment and
 *     records the matched positions for highlighting.
 *
 * The DP keeps a decaying running maximum instead of scanning every earlier
 * column, which is what keeps 5000 targets comfortably inside one frame.
 */

export interface FuzzyResult {
  score: number;
  /** Indices into `target` that matched, ascending. */
  positions: number[];
}

/** Bonuses and penalties. Tuned so prefix hits always beat scattered ones. */
export const SCORE = {
  start: 18,
  separator: 14,
  camel: 10,
  consecutive: 8,
  exactCase: 3,
  gap: 2,
  gapCap: 20,
  lengthPenalty: 0.5,
  /** Characters before the FIRST match are not a gap — they only carry a mild
      positional nudge, or a long label's word-boundary bonus never survives. */
  leadPenalty: 0.25,
  leadCap: 6,
} as const;

const SEPARATORS = new Set([' ', '-', '_', '/', '\\', '.', ':', ',', '(', '[', '{', '#', '@', '>', '|', "'"]);

const NEG = -Infinity;

/** Positional bonus for matching at `j`, before case and run bonuses. */
function charBonus(target: string, lower: string, j: number): number {
  if (j === 0) return SCORE.start;
  const prev = target[j - 1]!;
  if (SEPARATORS.has(prev)) return SCORE.separator;
  // camelCase boundary: lowercase (or digit) followed by an uppercase letter.
  if (prev === lower[j - 1] && target[j] !== lower[j]) return SCORE.camel;
  return 0;
}

/** True when every character of `query` appears in `target`, in order. */
export function isSubsequence(queryLower: string, targetLower: string): boolean {
  let qi = 0;
  for (let j = 0; j < targetLower.length && qi < queryLower.length; j++) {
    if (targetLower[j] === queryLower[qi]) qi++;
  }
  return qi === queryLower.length;
}

/**
 * Score `query` against `target`. Returns null when `query` is not a
 * subsequence of `target`. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.trim();
  if (q.length === 0) return { score: 0, positions: [] };
  if (q.length > target.length) return null;

  const ql = q.toLowerCase();
  const tl = target.toLowerCase();
  if (!isSubsequence(ql, tl)) return null;

  const n = ql.length;
  const m = tl.length;

  let prevScore = new Float64Array(m).fill(NEG);
  let prevRun = new Int32Array(m);
  const back: Int32Array[] = [];

  for (let i = 0; i < n; i++) {
    const curScore = new Float64Array(m).fill(NEG);
    const curRun = new Int32Array(m);
    const choice = new Int32Array(m).fill(-1);

    // Running best-with-gap-penalty over all previous columns k < j.
    let decayVal = NEG;
    let decayIdx = -1;
    let rawVal = NEG;
    let rawIdx = -1;

    for (let j = 0; j < m; j++) {
      if (j > 0 && i > 0) {
        const p = prevScore[j - 1]!;
        const decayed = decayVal === NEG ? NEG : decayVal - SCORE.gap;
        if (p >= decayed) {
          decayVal = p;
          decayIdx = j - 1;
        } else {
          decayVal = decayed;
        }
        if (p > rawVal) {
          rawVal = p;
          rawIdx = j - 1;
        }
      }

      if (tl[j] !== ql[i]) continue;
      const base = charBonus(target, tl, j) + (target[j] === q[i] ? SCORE.exactCase : 0);

      if (i === 0) {
        curScore[j] = base - Math.min(SCORE.leadCap, SCORE.leadPenalty * j);
        curRun[j] = 1;
        continue;
      }

      let best = NEG;
      let bestFrom = -1;
      let bestRun = 1;

      const contiguous = j > 0 ? prevScore[j - 1]! : NEG;
      if (contiguous !== NEG) {
        const run = prevRun[j - 1]! + 1;
        best = contiguous + base + SCORE.consecutive * run;
        bestFrom = j - 1;
        bestRun = run;
      }
      const capped = rawVal === NEG ? NEG : rawVal - SCORE.gapCap;
      const gapVal = decayVal >= capped ? decayVal : capped;
      const gapIdx = decayVal >= capped ? decayIdx : rawIdx;
      if (gapVal !== NEG && gapVal + base > best) {
        best = gapVal + base;
        bestFrom = gapIdx;
        bestRun = 1;
      }
      if (best === NEG) continue;
      curScore[j] = best;
      curRun[j] = bestRun;
      choice[j] = bestFrom;
    }

    back.push(choice);
    prevScore = curScore;
    prevRun = curRun;
  }

  let bestJ = -1;
  let bestScore = NEG;
  for (let j = 0; j < m; j++) {
    if (prevScore[j]! > bestScore) {
      bestScore = prevScore[j]!;
      bestJ = j;
    }
  }
  if (bestJ < 0 || bestScore === NEG) return null;

  const positions: number[] = new Array<number>(n);
  let j = bestJ;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = j;
    j = back[i]![j]!;
  }
  return { score: bestScore - SCORE.lengthPenalty * m, positions };
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** Split `target` into alternating matched / unmatched runs for rendering. */
export function highlight(target: string, positions: number[]): HighlightSegment[] {
  if (positions.length === 0) return target ? [{ text: target, match: false }] : [];
  const hit = new Set(positions);
  const out: HighlightSegment[] = [];
  let buf = '';
  let mode = hit.has(0);
  for (let i = 0; i < target.length; i++) {
    const m = hit.has(i);
    if (m !== mode) {
      if (buf) out.push({ text: buf, match: mode });
      buf = '';
      mode = m;
    }
    buf += target[i]!;
  }
  if (buf) out.push({ text: buf, match: mode });
  return out;
}

export interface RankedItem<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Rank `items` by fuzzy score, descending. Ties keep input order, so the
 * palette never reshuffles equally-good rows between keystrokes.
 */
export function fuzzyRank<T>(query: string, items: readonly T[], text: (item: T) => string, minScore = -Infinity): Array<RankedItem<T>> {
  const out: Array<RankedItem<T> & { i: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const m = fuzzyMatch(query, text(item));
    if (!m || m.score < minScore) continue;
    out.push({ item, score: m.score, positions: m.positions, i });
  }
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.map(({ item, score, positions }) => ({ item, score, positions }));
}
