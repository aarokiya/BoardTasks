import { describe, expect, it } from 'vitest';
import type { TaskList } from '@shared/models';
import { asCivil } from '@shared/date/civil';
import { parseQuickAdd, type ParseContext, type ParsedQuickAdd } from '@/features/quickadd/parse';

// 2026-09-17 is a Thursday. Week starts Sunday 2026-09-13.
const TODAY = asCivil('2026-09-17');
const NOW = new Date(2026, 8, 17, 10, 0, 0);

const list = (id: string, title: string, isDefault = false): TaskList => ({
  id,
  remoteId: null,
  title,
  color: 'blue',
  position: 0,
  isDefault,
  sync: 'synced',
  rev: 1,
  updatedAt: null,
});

const LISTS = [list('l-inbox', 'Inbox', true), list('l-work', 'Work'), list('l-home', 'Home & Errands'), list('l-side', 'Side Projects')];

function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return { today: TODAY, now: NOW, lists: LISTS, defaultListId: 'l-inbox', dateOrder: 'MDY', ...over };
}

const parse = (input: string, over?: Partial<ParseContext>): ParsedQuickAdd => parseQuickAdd(input, ctx(over));

/** `due` is compared as a plain string so cases stay readable. */
type Expected = Partial<Omit<ParsedQuickAdd, 'due'>> & { due?: string | null };

interface Case {
  name: string;
  input: string;
  expect: Expected;
  ctx?: Partial<ParseContext>;
}

const CASES: Case[] = [
  // ---- relative days ----
  { name: 'today', input: 'Pay rent today', expect: { title: 'Pay rent', due: '2026-09-17' } },
  { name: 'tod abbreviation', input: 'Pay rent tod', expect: { title: 'Pay rent', due: '2026-09-17' } },
  { name: 'tomorrow', input: 'Ship build tomorrow', expect: { title: 'Ship build', due: '2026-09-18' } },
  { name: 'tmr abbreviation', input: 'Ship build tmr', expect: { title: 'Ship build', due: '2026-09-18' } },
  { name: 'tom abbreviation', input: 'Ship build tom', expect: { title: 'Ship build', due: '2026-09-18' } },
  { name: 'tmrw abbreviation', input: 'Ship build tmrw', expect: { title: 'Ship build', due: '2026-09-18' } },
  { name: 'yesterday', input: 'Log hours yesterday', expect: { title: 'Log hours', due: '2026-09-16' } },
  { name: 'tonight implies 20:00', input: 'Call mum tonight', expect: { title: 'Call mum', due: '2026-09-17', dueTime: '20:00' } },

  // ---- weekdays ----
  { name: 'bare weekday = next occurrence', input: 'Standup friday', expect: { title: 'Standup', due: '2026-09-18' } },
  { name: 'bare weekday on the SAME weekday is 7 days out', input: 'Retro thursday', expect: { title: 'Retro', due: '2026-09-24' } },
  { name: 'bare weekday abbreviation', input: 'Standup mon', expect: { title: 'Standup', due: '2026-09-21' } },
  { name: 'this <weekday> stays in the current week', input: 'Standup this friday', expect: { title: 'Standup', due: '2026-09-18' } },
  { name: 'next <weekday> is the following week', input: 'Standup next friday', expect: { title: 'Standup', due: '2026-09-25' } },
  { name: 'next monday', input: 'Standup next monday', expect: { title: 'Standup', due: '2026-09-21' } },

  // ---- offsets and period ends ----
  { name: 'in N days', input: 'Renew cert in 3 days', expect: { title: 'Renew cert', due: '2026-09-20' } },
  { name: 'in N weeks', input: 'Renew cert in 2 weeks', expect: { title: 'Renew cert', due: '2026-10-01' } },
  { name: 'in a month', input: 'Renew cert in a month', expect: { title: 'Renew cert', due: '2026-10-17' } },
  { name: 'next week = coming Monday', input: 'Plan sprint next week', expect: { title: 'Plan sprint', due: '2026-09-21' } },
  { name: 'next month', input: 'Plan offsite next month', expect: { title: 'Plan offsite', due: '2026-10-17' } },
  { name: 'eow = upcoming Friday', input: 'Invoice eow', expect: { title: 'Invoice', due: '2026-09-18' } },
  { name: 'eom = end of month', input: 'Invoice eom', expect: { title: 'Invoice', due: '2026-09-30' } },
  { name: 'end of month spelled out', input: 'Invoice end of month', expect: { title: 'Invoice', due: '2026-09-30' } },
  { name: 'weekend = upcoming Saturday', input: 'Clean garage weekend', expect: { title: 'Clean garage', due: '2026-09-19' } },

  // ---- explicit dates ----
  { name: 'month name + day', input: 'Conference Sep 25', expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'full month name + day + year', input: 'Conference September 25 2026', expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'day + month', input: 'Conference 25 Sep', expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'ordinal day', input: 'Conference Sep 25th', expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'month/day rolls to next year when already past', input: 'Taxes Jan 5', expect: { title: 'Taxes', due: '2027-01-05' } },
  { name: 'numeric M/D under MDY', input: 'Conference 9/25', expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'numeric M/D/YY pivots the year', input: 'Conference 9/25/26', expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'numeric D/M under DMY', input: 'Conference 25/9', ctx: { dateOrder: 'DMY' }, expect: { title: 'Conference', due: '2026-09-25' } },
  { name: 'ISO date', input: 'Conference 2026-12-01', expect: { title: 'Conference', due: '2026-12-01' } },
  { name: 'impossible date stays in the title', input: 'Build 2026-02-30 pipeline', expect: { title: 'Build 2026-02-30 pipeline', due: null } },

  // ---- times ----
  { name: '5pm resolves to today when still ahead', input: 'Gym 5pm', expect: { title: 'Gym', dueTime: '17:00', due: '2026-09-17' } },
  { name: '9am has passed, so tomorrow', input: 'Gym 9am', expect: { title: 'Gym', dueTime: '09:00', due: '2026-09-18' } },
  { name: 'minutes with meridiem', input: 'Gym 5:30pm', expect: { title: 'Gym', dueTime: '17:30' } },
  { name: '24h form needs a colon', input: 'Gym 17:30', expect: { title: 'Gym', dueTime: '17:30' } },
  { name: 'bare 1730 is not a time', input: 'Gym 1730', expect: { title: 'Gym 1730', dueTime: null } },
  { name: 'noon', input: 'Lunch noon', expect: { title: 'Lunch', dueTime: '12:00' } },
  { name: 'midnight rolls to tomorrow', input: 'Deploy midnight', expect: { title: 'Deploy', dueTime: '00:00', due: '2026-09-18' } },
  { name: '@time form', input: 'Gym @5pm', expect: { title: 'Gym', dueTime: '17:00' } },
  { name: 'at + time', input: 'Gym at 5pm', expect: { title: 'Gym', dueTime: '17:00' } },
  { name: 'date + time together', input: 'Interview tomorrow 4pm', expect: { title: 'Interview', due: '2026-09-18', dueTime: '16:00' } },
  { name: 'explicit time beats tonight’s implied one', input: 'Call tonight 9pm', expect: { due: '2026-09-17', dueTime: '21:00' } },

  // ---- lists ----
  { name: '#list resolves exactly', input: 'Fix build #Work', expect: { title: 'Fix build', listId: 'l-work', listQuery: null } },
  { name: '#list is case-insensitive', input: 'Fix build #work', expect: { title: 'Fix build', listId: 'l-work' } },
  { name: '#list fuzzy-matches', input: 'Fix build #sideproj', expect: { title: 'Fix build', listId: 'l-side' } },
  { name: '#"quoted list" keeps the spaces', input: 'Mow lawn #"Home & Errands"', expect: { title: 'Mow lawn', listId: 'l-home' } },
  { name: 'unknown list falls back to the default and warns', input: 'Buy milk #groceries', expect: { title: 'Buy milk', listId: 'l-inbox', listQuery: 'groceries' } },
  { name: 'no list token uses the context default', input: 'Buy milk', expect: { listId: 'l-inbox', listQuery: null } },

  // ---- priority and flag ----
  { name: '!1 is high priority', input: 'Fix prod !1', expect: { title: 'Fix prod', priority: 1 } },
  { name: '!2 is medium', input: 'Fix prod !2', expect: { title: 'Fix prod', priority: 2 } },
  { name: '!3 is low', input: 'Fix prod !3', expect: { title: 'Fix prod', priority: 3 } },
  { name: '!p1 long form', input: 'Fix prod !p1', expect: { title: 'Fix prod', priority: 1 } },
  { name: 'standalone * flags', input: 'Review PR *', expect: { title: 'Review PR', flagged: true } },
  { name: 'trailing * on a word does not flag', input: 'Review PR*', expect: { title: 'Review PR*', flagged: false } },

  // ---- word boundaries and escapes ----
  { name: '#L12 inside a URL is not a list', input: 'Read https://github.com/acme/repo/blob/main/a.ts#L12', expect: { title: 'Read https://github.com/acme/repo/blob/main/a.ts#L12', listId: 'l-inbox', listQuery: null } },
  { name: 'wow! is not a priority', input: 'That was wow!', expect: { title: 'That was wow!', priority: 0 } },
  { name: 'backslash escapes #', input: 'Ship \\#1 release', expect: { title: 'Ship #1 release', listQuery: null } },
  { name: 'backslash escapes !', input: 'Ship it \\!1', expect: { title: 'Ship it !1', priority: 0 } },
  { name: 'backslash escapes *', input: 'Ship \\* now', expect: { title: 'Ship * now', flagged: false } },
  { name: 'quoted text is literal', input: 'Remind me "tomorrow" means the 18th', expect: { title: 'Remind me tomorrow means the 18th', due: null } },

  // ---- notes ----
  { name: '// starts notes', input: 'Call plumber // ask about the boiler', expect: { title: 'Call plumber', notes: 'ask about the boiler' } },
  { name: 'https:// is not a notes marker', input: 'Open https://example.com/a//b', expect: { title: 'Open https://example.com/a//b', notes: '' } },
  { name: 'notes-only input becomes the title', input: '// buy milk', expect: { title: 'buy milk', notes: '' } },

  // ---- last token wins ----
  { name: 'last date wins but both are stripped', input: 'Plan today tomorrow', expect: { title: 'Plan', due: '2026-09-18' } },
  { name: 'last priority wins', input: 'Plan !1 !3', expect: { title: 'Plan', priority: 3 } },
  { name: 'last list wins', input: 'Plan #work #side', expect: { title: 'Plan', listId: 'l-side' } },

  // ---- empty title protection ----
  { name: 'a lone date keeps the word as the title', input: 'tomorrow', expect: { title: 'tomorrow', due: null } },
  { name: 'a lone priority keeps the word', input: '!1', expect: { title: '!1', priority: 0 } },
  { name: 'drops the earliest token first', input: 'tomorrow !1', expect: { title: 'tomorrow', priority: 1, due: null } },

  // ---- everything at once ----
  {
    name: 'kitchen sink',
    input: 'Review specs tomorrow 4pm #work !1 * // send to Dana',
    expect: { title: 'Review specs', due: '2026-09-18', dueTime: '16:00', listId: 'l-work', priority: 1, flagged: true, notes: 'send to Dana' },
  },
  { name: 'unknown unit after "in N" is not a date', input: 'Call in 3 minutes', expect: { title: 'Call in 3 minutes', due: null } },
  { name: 'end of day is today', input: 'Ship end of day', expect: { title: 'Ship', due: '2026-09-17' } },
  { name: 'next weekend is the Saturday after this one', input: 'Camping next weekend', expect: { title: 'Camping', due: '2026-09-26' } },
  { name: 'this weekend is this Saturday', input: 'Camping this weekend', expect: { title: 'Camping', due: '2026-09-19' } },
  { name: 'this week means end of week', input: 'Invoice this week', expect: { title: 'Invoice', due: '2026-09-18' } },
  { name: 'wks abbreviation', input: 'Renew in 2 wks', expect: { title: 'Renew', due: '2026-10-01' } },
  { name: 'mos abbreviation', input: 'Renew in 2 mos', expect: { title: 'Renew', due: '2026-11-17' } },
  { name: 'time split across two words', input: 'Gym 5 pm', expect: { title: 'Gym', dueTime: '17:00' } },
  { name: 'time split across two words with minutes', input: 'Gym 5:30 pm', expect: { title: 'Gym', dueTime: '17:30' } },
  { name: 'an escaped // is not a notes marker', input: 'Keep \\// inline', expect: { notes: '' } },
  { name: 'empty input', input: '', expect: { title: '', due: null, listId: 'l-inbox' } },
  { name: 'whitespace only', input: '   ', expect: { title: '' } },
];

describe('parseQuickAdd', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const got = parse(c.input, c.ctx);
      for (const [key, value] of Object.entries(c.expect)) {
        expect({ [key]: got[key as keyof ParsedQuickAdd] }).toEqual({ [key]: value });
      }
    });
  }

  it('covers at least 40 named cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });
});

describe('warnings', () => {
  it('flags an unknown list', () => {
    const r = parse('Buy milk #groceries');
    expect(r.warnings.map((w) => w.code)).toContain('unknown-list');
    expect(r.warnings[0]?.value).toBe('groceries');
  });

  it('clamps a past "this <weekday>" to today', () => {
    const r = parse('Standup this monday');
    expect(r.due).toBe('2026-09-17');
    expect(r.warnings.map((w) => w.code)).toContain('past-date');
  });

  it('warns when a numeric date only parses the other way round', () => {
    const r = parse('Conference 25/9');
    expect(r.due).toBe('2026-09-25');
    expect(r.warnings.map((w) => w.code)).toContain('ambiguous-date');
  });

  it('has no warnings for a clean line', () => {
    expect(parse('Ship it tomorrow #work').warnings).toEqual([]);
  });
});

describe('tokens', () => {
  it('reports exact offsets into the original input', () => {
    const input = 'Review specs tomorrow 4pm #work !1 *';
    const r = parse(input);
    for (const t of r.tokens) {
      expect(input.slice(t.start, t.end)).toBe(t.raw);
    }
    const kinds = r.tokens.map((t) => t.kind);
    expect(kinds).toEqual(['date', 'time', 'list', 'priority', 'flag']);
    const date = r.tokens[0]!;
    expect([date.start, date.end]).toEqual([13, 21]);
    expect(date.raw).toBe('tomorrow');
  });

  it('spans a multi-word date phrase', () => {
    const input = 'Renew cert in 3 days';
    const r = parse(input);
    const date = r.tokens.find((t) => t.kind === 'date')!;
    expect(input.slice(date.start, date.end)).toBe('in 3 days');
  });

  it('keeps every occurrence of a repeated category as a token', () => {
    const r = parse('Plan today tomorrow');
    expect(r.tokens.filter((t) => t.kind === 'date')).toHaveLength(2);
  });

  it('labels chips for display', () => {
    const r = parse('Review specs tomorrow 4pm #work !1 *');
    expect(r.tokens.map((t) => t.label)).toEqual(['Tomorrow', '4 PM', 'Work', 'High', 'Flagged']);
  });

  it('tokens are sorted by start offset', () => {
    const r = parse('Call plumber tomorrow // ask about the boiler');
    const starts = r.tokens.map((t) => t.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('the notes token runs to the end of the input', () => {
    const input = 'Call plumber // ask about the boiler';
    const r = parse(input);
    const notes = r.tokens.find((t) => t.kind === 'notes')!;
    expect(notes.end).toBe(input.length);
    expect(notes.raw.startsWith('//')).toBe(true);
  });
});

describe('purity', () => {
  it('is deterministic for the same context', () => {
    const a = parse('Ship it friday 5pm #work !2 *');
    const b = parse('Ship it friday 5pm #work !2 *');
    expect(a).toEqual(b);
  });

  it('moves with the injected today, not the real clock', () => {
    const later = parseQuickAdd('Ship it tomorrow', ctx({ today: asCivil('2030-01-31') }));
    expect(later.due).toBe('2030-02-01');
  });

  it('does not mutate the context lists', () => {
    const lists = [...LISTS];
    parseQuickAdd('Ship it #work', ctx({ lists }));
    expect(lists).toEqual(LISTS);
  });
});

describe('edge cases', () => {
  it('handles a title that is only punctuation', () => {
    expect(parse('???').title).toBe('???');
  });

  it('collapses runs of whitespace in the title', () => {
    expect(parse('Ship    it   tomorrow').title).toBe('Ship it');
  });

  it('ignores a bare # with nothing after it', () => {
    const r = parse('Issue # 12');
    expect(r.title).toBe('Issue # 12');
    expect(r.listQuery).toBeNull();
  });

  it('accepts an unterminated quoted list', () => {
    expect(parse('Mow lawn #"Home').listId).toBe('l-home');
  });

  it('accepts an unterminated quoted literal', () => {
    expect(parse('Say "hello').title).toBe('Say hello');
  });

  it('keeps a trailing comma out of the date token label', () => {
    const r = parse('Ship it tomorrow, please');
    expect(r.due).toBe('2026-09-18');
    expect(r.title).toBe('Ship it please');
  });

  it('never returns a due time without a due date', () => {
    const r = parse('Gym 5pm');
    expect(r.due).not.toBeNull();
    expect(r.dueTime).toBe('17:00');
  });

  it('leaves a month name alone without a day number', () => {
    expect(parse('Call Mon about the March report').title).toBe('Call about the March report');
  });

  it('walks forward to the next leap year for Feb 29', () => {
    const r = parseQuickAdd('Leap day Feb 29', ctx({ today: asCivil('2026-01-01') }));
    expect(r.due).toBe('2028-02-29');
  });

  it('clamps "in 1 month" from the 31st', () => {
    const r = parseQuickAdd('Renew in 1 month', ctx({ today: asCivil('2026-01-31') }));
    expect(r.due).toBe('2026-02-28');
  });
});
