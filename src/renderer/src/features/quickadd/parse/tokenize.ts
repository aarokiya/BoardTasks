/**
 * Word scanner for the quick-add grammar.
 *
 * Grammar tokens are only ever recognised at a WORD BOUNDARY, which is what
 * keeps `https://github.com/acme/repo/#L12` from becoming a list token and
 * `wow!` from becoming a priority. The scanner is also where the two literal
 * escapes live: `\#`, `\!`, `\*`, `\"`, `\\` and "straight double quotes".
 */

export interface Word {
  /** Exact source slice, `input.slice(start, end)`. */
  text: string;
  /** What this word contributes to the title: escapes resolved, quotes stripped. */
  display: string;
  start: number;
  end: number;
  /** Quoted or escaped — never matched against the grammar. */
  literal: boolean;
  /** True when the word begins with an unescaped `#` (a list-token candidate). */
  hash: boolean;
}

const ESCAPABLE = '#!*"\\';

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/**
 * Split `input[from..to)` into words. Whitespace separates words, except inside
 * a double-quoted run or a `#"quoted list"` token.
 */
export function scanWords(input: string, from = 0, to: number = input.length): Word[] {
  const words: Word[] = [];
  let i = from;
  while (i < to) {
    if (isSpace(input[i])) {
      i++;
      continue;
    }
    const start = i;

    // `#list` / `#"quoted list"` — quotes here belong to the token, not to a literal.
    if (input[i] === '#') {
      i++;
      if (input[i] === '"') {
        i++;
        while (i < to && input[i] !== '"') i++;
        if (i < to) i++;
      } else {
        while (i < to && !isSpace(input[i])) i++;
      }
      const text = input.slice(start, i);
      words.push({ text, display: text, start, end: i, literal: false, hash: true });
      continue;
    }

    let display = '';
    let literal = false;
    while (i < to && !isSpace(input[i])) {
      const c = input[i]!;
      if (c === '\\' && i + 1 < to && ESCAPABLE.includes(input[i + 1]!)) {
        display += input[i + 1]!;
        literal = true;
        i += 2;
        continue;
      }
      if (c === '"') {
        literal = true;
        i++;
        while (i < to && input[i] !== '"') {
          display += input[i]!;
          i++;
        }
        if (i < to) i++; // closing quote
        continue;
      }
      display += c;
      i++;
    }
    words.push({ text: input.slice(start, i), display, start, end: i, literal, hash: false });
  }
  return words;
}

export interface NotesSplit {
  /** The portion of the input the grammar runs over. */
  bodyEnd: number;
  /** Offset of the `//` marker, or -1. */
  markerStart: number;
  notes: string;
}

/**
 * Find the first `//` that starts a word. Requiring a word boundary is what
 * keeps `https://example.com` out of the notes rule.
 */
export function splitNotes(input: string): NotesSplit {
  for (let i = 0; i + 1 < input.length; i++) {
    if (input[i] !== '/' || input[i + 1] !== '/') continue;
    if (i > 0 && input[i - 1] === '\\') continue;
    if (!isSpace(input[i - 1])) continue;
    return { bodyEnd: i, markerStart: i, notes: input.slice(i + 2).trim() };
  }
  return { bodyEnd: input.length, markerStart: -1, notes: '' };
}

/** Lower-cased word with trailing sentence punctuation removed (`tomorrow,` → `tomorrow`). */
export function norm(w: Word): string {
  return w.text.toLowerCase().replace(/[.,;:!?]+$/, '');
}
