/**
 * `parseQuickAdd` — the hand-rolled natural-language grammar behind both the
 * inline ⌘N row and the floating Quick Add HUD.
 *
 * Properties the tests pin down:
 *  - Pure: every clock/locale input arrives through `ctx`.
 *  - Word boundaries only, so `…/#L12` and `wow!` survive untouched.
 *  - Last token wins per category, but *every* occurrence is stripped.
 *  - If stripping would empty the title, the token is dropped and the words
 *    stay ("Tomorrow" is a perfectly good task name).
 *  - `tokens[i].start/end` index the ORIGINAL string, so the highlight overlay
 *    can paint them without re-deriving anything.
 */
import type { Priority } from '@shared/models';
import type { CivilDate } from '@shared/date/civil';
import { formatRelative, formatTime12 } from '@shared/date/format';
import { matchDate, matchFlag, matchListQuery, matchPriority, matchTime } from './grammar';
import { dateForBareTime, resolveDate, resolveList, type ResolvedDate } from './resolve';
import { scanWords, splitNotes, type Word } from './tokenize';
import type { ParseContext, ParsedQuickAdd, ParsedToken, ParseWarning, TokenKind } from './types';

export type { ParseContext, ParsedQuickAdd, ParsedToken, ParseWarning, TokenKind, WarningCode } from './types';
export { scanWords, splitNotes } from './tokenize';
export { matchDate, matchTime, parseTimeWord, pivotYear } from './grammar';
export { addMonths, pickYear, resolveDate, resolveList, startOfWeek } from './resolve';

export const PRIORITY_LABELS: Record<Priority, string> = { 0: 'None', 1: 'High', 2: 'Medium', 3: 'Low' };

interface Match {
  kind: TokenKind;
  wordStart: number;
  wordEnd: number;
  start: number;
  end: number;
  raw: string;
  date?: ResolvedDate;
  time?: string;
  priority?: Priority;
  listQuery?: string;
}

const EMPTY = (ctx: ParseContext): ParsedQuickAdd => ({
  title: '',
  notes: '',
  due: null,
  dueTime: null,
  listId: ctx.defaultListId,
  listQuery: null,
  priority: 0,
  flagged: false,
  tokens: [],
  warnings: [],
});

function collect(input: string, words: Word[], ctx: ParseContext): Match[] {
  const matches: Match[] = [];
  const push = (m: Match): void => {
    matches.push(m);
  };
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;

    if (w.literal) {
      i++;
      continue;
    }

    const listQuery = matchListQuery(w);
    if (listQuery !== null) {
      push({ kind: 'list', wordStart: i, wordEnd: i + 1, start: w.start, end: w.end, raw: w.text, listQuery });
      i++;
      continue;
    }
    if (w.hash) {
      // A bare `#` with nothing after it is just text.
      i++;
      continue;
    }

    if (matchFlag(w)) {
      push({ kind: 'flag', wordStart: i, wordEnd: i + 1, start: w.start, end: w.end, raw: w.text });
      i++;
      continue;
    }

    const priority = matchPriority(w);
    if (priority !== null) {
      push({ kind: 'priority', wordStart: i, wordEnd: i + 1, start: w.start, end: w.end, raw: w.text, priority });
      i++;
      continue;
    }

    const dm = matchDate(words, i);
    if (dm) {
      const resolved = resolveDate(dm.spec, ctx);
      if (resolved) {
        const last = words[i + dm.consumed - 1]!;
        push({ kind: 'date', wordStart: i, wordEnd: i + dm.consumed, start: w.start, end: last.end, raw: input.slice(w.start, last.end), date: resolved });
        i += dm.consumed;
        continue;
      }
    }

    const tm = matchTime(words, i);
    if (tm) {
      const last = words[i + tm.consumed - 1]!;
      push({ kind: 'time', wordStart: i, wordEnd: i + tm.consumed, start: w.start, end: last.end, raw: input.slice(w.start, last.end), time: tm.time });
      i += tm.consumed;
      continue;
    }

    i++;
  }
  return matches;
}

function titleFrom(words: Word[], active: Match[]): string {
  const consumed = new Set<number>();
  for (const m of active) for (let k = m.wordStart; k < m.wordEnd; k++) consumed.add(k);
  const parts: string[] = [];
  for (let k = 0; k < words.length; k++) if (!consumed.has(k)) parts.push(words[k]!.display);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a quick-add line. Never throws; unparseable input just becomes a title.
 */
export function parseQuickAdd(input: string, ctx: ParseContext): ParsedQuickAdd {
  const out = EMPTY(ctx);
  if (!input) return out;

  const { bodyEnd, markerStart, notes } = splitNotes(input);
  const words = scanWords(input, 0, bodyEnd);
  let active = collect(input, words, ctx);

  // Keep the words when stripping them would leave an empty title: drop the
  // earliest token first, so "tomorrow !1" keeps "tomorrow" as the title.
  let title = titleFrom(words, active);
  while (title === '' && active.length > 0) {
    active = active.slice(1);
    title = titleFrom(words, active);
  }

  const warnings: ParseWarning[] = [];
  let due: CivilDate | null = null;
  let impliedTime: string | null = null;
  let dueTime: string | null = null;
  let priority: Priority = 0;
  let flagged = false;
  let listId: string | null = ctx.defaultListId;
  let listQuery: string | null = null;

  for (const m of active) {
    switch (m.kind) {
      case 'date':
        due = m.date!.due;
        impliedTime = m.date!.time ?? null;
        if (m.date!.warning) warnings.push(m.date!.warning);
        break;
      case 'time':
        dueTime = m.time!;
        break;
      case 'priority':
        priority = m.priority!;
        break;
      case 'flag':
        flagged = true;
        break;
      case 'list': {
        const r = resolveList(m.listQuery!, ctx.lists);
        listId = r.listId ?? ctx.defaultListId;
        listQuery = r.listQuery;
        if (r.warning) warnings.push(r.warning);
        break;
      }
      default:
        break;
    }
  }

  if (dueTime === null && impliedTime !== null) dueTime = impliedTime;
  if (dueTime !== null && due === null) due = dateForBareTime(ctx, dueTime);

  const tokens: ParsedToken[] = active.map((m) => ({
    kind: m.kind,
    start: m.start,
    end: m.end,
    raw: m.raw,
    label: labelFor(m, ctx),
  }));

  let finalNotes = notes;
  if (markerStart >= 0) {
    if (title === '' && notes !== '') {
      // "// buy milk" with nothing else: promote the note to the title.
      title = notes;
      finalNotes = '';
    } else {
      tokens.push({ kind: 'notes', start: markerStart, end: input.length, raw: input.slice(markerStart), label: notes });
    }
  }
  tokens.sort((a, b) => a.start - b.start);

  return { title, notes: finalNotes, due, dueTime, listId, listQuery, priority, flagged, tokens, warnings };
}

function labelFor(m: Match, ctx: ParseContext): string {
  switch (m.kind) {
    case 'date':
      return formatRelative(m.date!.due, ctx.today);
    case 'time':
      return formatTime12(m.time!);
    case 'priority':
      return PRIORITY_LABELS[m.priority!];
    case 'flag':
      return 'Flagged';
    case 'list': {
      const r = resolveList(m.listQuery!, ctx.lists);
      const list = r.listId ? ctx.lists.find((l) => l.id === r.listId) : undefined;
      return list ? list.title : m.listQuery!;
    }
    default:
      return m.raw;
  }
}
