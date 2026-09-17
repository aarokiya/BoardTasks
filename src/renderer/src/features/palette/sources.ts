/**
 * Everything the command palette can show, ranked. Kept out of the component
 * so ranking is unit-testable without a DOM.
 */
import type { Task, TaskList } from '@shared/models';
import { SMART_VIEWS, type ViewId } from '@shared/constants';
import { formatRelative } from '@shared/date/format';
import type { CommandId } from '../../commands/ids';
import { listCommands } from '../../commands/registry';
import { selectCurrentListId, selectLists } from '../../store/selectors/views';
import type { State } from '../../store/store';
import { fuzzyMatch } from './fuzzy';
import { commandUsage, recentTaskIds } from './usage';

export type PaletteMode = 'all' | 'actions' | 'lists' | 'tasks' | 'github';

export interface ModeParse {
  mode: PaletteMode;
  /** Query with the prefix removed. */
  query: string;
  /** The prefix itself, for the mode pill. */
  prefix: string;
}

/** `>`, `#`, `@` and `gh ` switch the palette into a single-source mode. */
export function parseMode(raw: string): ModeParse {
  if (raw.startsWith('>')) return { mode: 'actions', query: raw.slice(1).trimStart(), prefix: '>' };
  if (raw.startsWith('#')) return { mode: 'lists', query: raw.slice(1).trimStart(), prefix: '#' };
  if (raw.startsWith('@')) return { mode: 'tasks', query: raw.slice(1).trimStart(), prefix: '@' };
  if (/^gh\s/i.test(raw)) return { mode: 'github', query: raw.slice(3).trimStart(), prefix: 'gh' };
  if (/^gh$/i.test(raw)) return { mode: 'github', query: '', prefix: 'gh' };
  return { mode: 'all', query: raw, prefix: '' };
}

interface Base {
  key: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  /** Matched character offsets in `label`. */
  positions: number[];
  score: number;
}

export type PaletteItem =
  | (Base & { kind: 'command'; id: CommandId; enabled: boolean; reason?: string; destructive?: boolean })
  | (Base & { kind: 'task'; task: Task })
  | (Base & { kind: 'list'; list: TaskList })
  | (Base & { kind: 'view'; view: ViewId })
  | (Base & { kind: 'github'; task: Task; url: string });

export interface PaletteSection {
  title: string;
  items: PaletteItem[];
}

const VIEW_LABELS: Record<string, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  all: 'All Tasks',
  nodate: 'No Date',
  github: 'GitHub',
  completed: 'Completed',
};

const LIMIT = { command: 8, task: 8, list: 6, view: 5, github: 6 } as const;

function taskSubtitle(t: Task, state: State, listName: string | undefined): string {
  const bits: string[] = [];
  if (listName) bits.push(listName);
  if (t.due) bits.push(formatRelative(t.due, state.today));
  const note = t.notes.trim().replace(/\s+/g, ' ');
  if (note) bits.push(note.slice(0, 80));
  return bits.join(' · ');
}

function rankCommands(query: string, includeDisabled: boolean): PaletteItem[] {
  const usage = commandUsage();
  const out: PaletteItem[] = [];
  for (const c of listCommands()) {
    if (!c.enabled && !includeDisabled) continue;
    const hay = [c.label, ...(c.keywords ?? [])];
    let best: { score: number; positions: number[] } | null = null;
    for (let i = 0; i < hay.length; i++) {
      const m = fuzzyMatch(query, hay[i]!);
      if (!m) continue;
      // Keyword hits rank below a direct label hit.
      const score = i === 0 ? m.score : m.score - 12;
      if (!best || score > best.score) best = { score, positions: i === 0 ? m.positions : [] };
    }
    if (!best) continue;
    // Disabled commands only surface on a real name match, never on an empty query.
    if (!c.enabled && (query.trim() === '' || best.positions.length === 0)) continue;
    out.push({
      kind: 'command',
      key: `cmd:${c.id}`,
      id: c.id as CommandId,
      label: c.label,
      shortcut: c.shortcut,
      destructive: c.destructive,
      enabled: c.enabled,
      reason: c.enabled ? undefined : 'Not available right now',
      positions: best.positions,
      score: best.score + Math.min(usage[c.id] ?? 0, 10) * 2 + (c.enabled ? 0 : -40),
    });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, LIMIT.command);
}

function rankTasks(query: string, state: State): PaletteItem[] {
  const currentList = selectCurrentListId(state);
  const recent = recentTaskIds();
  const out: PaletteItem[] = [];
  for (const t of Object.values(state.tasks)) {
    if (t.deleted) continue;
    const onTitle = fuzzyMatch(query, t.title);
    const m = onTitle ?? (query ? fuzzyMatch(query, t.notes) : null);
    if (!m) continue;
    const recentIdx = recent.indexOf(t.id);
    const boost =
      (t.listId === currentList ? 8 : 0) +
      (recentIdx >= 0 ? 10 - recentIdx * 2 : 0) +
      (t.status === 'completed' ? -20 : 0) +
      (onTitle ? 0 : -25);
    out.push({
      kind: 'task',
      key: `task:${t.id}`,
      task: t,
      label: t.title || 'Untitled',
      subtitle: taskSubtitle(t, state, state.lists[t.listId]?.title),
      positions: onTitle ? m.positions : [],
      score: m.score + boost,
    });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, LIMIT.task);
}

function rankLists(query: string, state: State): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const l of selectLists(state)) {
    const m = fuzzyMatch(query, l.title);
    if (!m) continue;
    out.push({ kind: 'list', key: `list:${l.id}`, list: l, label: l.title, positions: m.positions, score: m.score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, LIMIT.list);
}

function rankViews(query: string): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const v of SMART_VIEWS) {
    const label = VIEW_LABELS[v] ?? v;
    const m = fuzzyMatch(query, label);
    if (!m) continue;
    out.push({ kind: 'view', key: `view:${v}`, view: v, label, positions: m.positions, score: m.score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, LIMIT.view);
}

function rankGithub(query: string, state: State): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const t of Object.values(state.tasks)) {
    const g = t.github;
    if (!g || t.deleted) continue;
    const label = `${g.owner}/${g.repo}#${g.number}`;
    const title = g.title ?? t.title;
    const onLabel = fuzzyMatch(query, label);
    const m = onLabel ?? fuzzyMatch(query, title);
    if (!m) continue;
    out.push({
      kind: 'github',
      key: `gh:${t.id}`,
      task: t,
      url: g.url,
      label,
      subtitle: title,
      positions: onLabel ? m.positions : [],
      score: m.score + (onLabel ? 6 : 0),
    });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, LIMIT.github);
}

/** Empty-query landing page: what you touched last, then what you use most. */
function defaultSections(state: State): PaletteSection[] {
  const recent = recentTaskIds()
    .map((id) => state.tasks[id])
    .filter((t): t is Task => !!t && !t.deleted)
    .map<PaletteItem>((t) => ({
      kind: 'task',
      key: `task:${t.id}`,
      task: t,
      label: t.title || 'Untitled',
      subtitle: taskSubtitle(t, state, state.lists[t.listId]?.title),
      positions: [],
      score: 0,
    }));
  const sections: PaletteSection[] = [];
  if (recent.length) sections.push({ title: 'Recent', items: recent });
  sections.push({ title: 'Actions', items: rankCommands('', false) });
  sections.push({ title: 'Views', items: rankViews('') });
  return sections.filter((s) => s.items.length > 0);
}

/** Task-scoped sub-mode: the Task commands that apply to one task. */
export function taskScopedCommands(query: string): PaletteItem[] {
  return rankCommands(query, true).filter((i) => i.kind === 'command' && i.id.startsWith('task.'));
}

/** All sections for the current query, in display order. */
export function buildSections(raw: string, state: State): PaletteSection[] {
  const { mode, query } = parseMode(raw);
  if (mode === 'all' && query.trim() === '') return defaultSections(state);

  const sections: PaletteSection[] = [];
  const want = (m: PaletteMode): boolean => mode === 'all' || mode === m;
  if (want('actions')) sections.push({ title: 'Actions', items: rankCommands(query, true) });
  if (want('tasks')) sections.push({ title: 'Tasks', items: rankTasks(query, state) });
  if (want('lists')) sections.push({ title: 'Lists', items: rankLists(query, state) });
  if (mode === 'all' || mode === 'lists') sections.push({ title: 'Views', items: rankViews(query) });
  if (want('github')) sections.push({ title: 'GitHub', items: rankGithub(query, state) });
  return sections.filter((s) => s.items.length > 0);
}

/** Flattened option list in display order — what ↑/↓ walks. */
export function flatten(sections: PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}
