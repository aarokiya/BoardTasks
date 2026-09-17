import type { Task } from '@shared/models';
import type { SmartViewId, ViewId } from '@shared/constants';
import { addDays, civilFromInstant, type CivilDate } from '@shared/date/civil';
import { formatUpcomingGroup } from '@shared/date/format';
import type { GithubFilter, State } from '../store';

export interface ViewContext {
  today: CivilDate;
  showCompleted: boolean;
}

export const isOpen = (t: Task): boolean => t.status !== 'completed' && !t.deleted && !t.hidden;

export const predicates: Record<SmartViewId, (t: Task, c: ViewContext) => boolean> = {
  today: (t, c) => isOpen(t) && t.due !== null && t.due <= c.today,
  upcoming: (t, c) => isOpen(t) && t.due !== null && t.due > c.today && t.due <= addDays(c.today, 7),
  overdue: (t, c) => isOpen(t) && t.due !== null && t.due < c.today,
  all: (t) => isOpen(t),
  nodate: (t) => isOpen(t) && t.due === null,
  github: (t) => isOpen(t) && t.github !== null,
  completed: (t) => t.status === 'completed' && !t.deleted,
};

/** GitHub smart-view filter pills. Tasks whose link failed to load stay visible under 'all'. */
export const matchesGithubFilter = (t: Task, f: GithubFilter): boolean => {
  const g = t.github;
  if (!g) return false;
  if (f === 'issues') return g.type === 'issue';
  if (f === 'prs') return g.type === 'pull';
  if (f === 'failing') return g.checks === 'failure';
  return true;
};

export const listPredicate = (listId: string) => (t: Task, c: ViewContext): boolean =>
  t.listId === listId && !t.deleted && !t.hidden && (c.showCompleted || t.status !== 'completed');

export function viewPredicate(view: ViewId): (t: Task, c: ViewContext) => boolean {
  return view.startsWith('list:') ? listPredicate(view.slice(5)) : predicates[view as SmartViewId];
}

export interface Row {
  kind: 'group' | 'task';
  id: string;
  label?: string;
  count?: number;
  task?: Task;
  depth: 0 | 1;
  /** Position within its sibling group (for aria-posinset). */
  index: number;
  setSize: number;
  hasChildren?: boolean;
  collapsed?: boolean;
}

export interface Counts {
  today: number;
  todayHasOverdue: boolean;
  overdue: number;
  all: number;
  github: number;
  nodate: number;
  upcoming: number;
  lists: Record<string, number>;
}

function memo<A extends readonly unknown[], R>(deps: (s: State) => A, compute: (s: State, deps: A) => R): (s: State) => R {
  let lastDeps: A | null = null;
  let lastResult: R;
  return (s) => {
    const d = deps(s);
    if (lastDeps && d.length === lastDeps.length && d.every((v, i) => v === lastDeps![i])) return lastResult;
    lastDeps = d;
    lastResult = compute(s, d);
    return lastResult;
  };
}

export const selectCounts = memo(
  (s) => [s.version, s.today] as const,
  (s) => {
    const c: Counts = { today: 0, todayHasOverdue: false, overdue: 0, all: 0, github: 0, nodate: 0, upcoming: 0, lists: {} };
    const ctx = { today: s.today, showCompleted: false };
    for (const t of Object.values(s.tasks)) {
      if (!isOpen(t)) continue;
      c.all++;
      c.lists[t.listId] = (c.lists[t.listId] ?? 0) + 1;
      if (predicates.today(t, ctx)) c.today++;
      if (predicates.overdue(t, ctx)) { c.overdue++; c.todayHasOverdue = true; }
      if (predicates.upcoming(t, ctx)) c.upcoming++;
      if (t.github) c.github++;
      if (t.due === null) c.nodate++;
    }
    return c;
  },
);

export const selectLists = memo(
  (s) => [s.version] as const,
  (s) => Object.values(s.lists).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title)),
);

const byKey = (a: Task, b: Task): number => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
const byDueThenKey = (a: Task, b: Task): number => (a.due ?? '').localeCompare(b.due ?? '') || byKey(a, b);

function matchesFilter(t: Task, q: string): boolean {
  if (!q) return true;
  const l = q.toLowerCase();
  return t.title.toLowerCase().includes(l) || t.notes.toLowerCase().includes(l);
}

/**
 * Rows for the current view: grouped, sorted, with one level of subtask nesting.
 * A subtask whose parent is not in the view is promoted to depth 0.
 */
export const selectRows = memo(
  (s) => [s.version, s.view, s.today, s.filterQuery, s.collapsedParents, s.showCompletedByList, s.settings?.showCompletedInLists, s.githubFilter] as const,
  (s): Row[] => {
    const view = s.view;
    const listId = view.startsWith('list:') ? view.slice(5) : null;
    const ctx: ViewContext = { today: s.today, showCompleted: listId ? (s.showCompletedByList[listId] ?? s.settings?.showCompletedInLists ?? false) : false };
    const pred = viewPredicate(view);
    const all = Object.values(s.tasks);
    const inView = all.filter((t) => pred(t, ctx) && matchesFilter(t, s.filterQuery));
    const inViewIds = new Set(inView.map((t) => t.id));
    const childrenByParent = new Map<string, Task[]>();
    for (const t of inView) if (t.parentId && inViewIds.has(t.parentId)) childrenByParent.set(t.parentId, [...(childrenByParent.get(t.parentId) ?? []), t]);
    const tops = inView.filter((t) => !t.parentId || !inViewIds.has(t.parentId));

    const rows: Row[] = [];
    const pushTree = (items: Task[], sorter: (a: Task, b: Task) => number): void => {
      const sorted = [...items].sort(sorter);
      sorted.forEach((t, i) => {
        const kids = (childrenByParent.get(t.id) ?? []).sort(byKey);
        const collapsed = !!s.collapsedParents[t.id];
        rows.push({ kind: 'task', id: t.id, task: t, depth: 0, index: i, setSize: sorted.length, hasChildren: kids.length > 0, collapsed });
        if (!collapsed) kids.forEach((k, j) => rows.push({ kind: 'task', id: k.id, task: k, depth: 1, index: j, setSize: kids.length }));
      });
    };
    const group = (id: string, label: string, items: Task[], sorter = byKey): void => {
      if (items.length === 0) return;
      rows.push({ kind: 'group', id: `g:${id}`, label, count: items.length, depth: 0, index: 0, setSize: 1 });
      pushTree(items, sorter);
    };

    switch (view) {
      case 'today': {
        group('overdue', 'Overdue', tops.filter((t) => t.due! < s.today), byDueThenKey);
        group('today', 'Today', tops.filter((t) => t.due! >= s.today));
        break;
      }
      case 'upcoming': {
        const days = new Map<string, Task[]>();
        for (const t of tops) days.set(t.due!, [...(days.get(t.due!) ?? []), t]);
        for (const d of [...days.keys()].sort()) group(d, formatUpcomingGroup(d as CivilDate, s.today), days.get(d)!);
        break;
      }
      case 'overdue': {
        const y = addDays(s.today, -1);
        const w = addDays(s.today, -7);
        group('yesterday', 'Yesterday', tops.filter((t) => t.due === y), byDueThenKey);
        group('lastweek', 'Last week', tops.filter((t) => t.due! < y && t.due! >= w), byDueThenKey);
        group('earlier', 'Earlier', tops.filter((t) => t.due! < w), byDueThenKey);
        break;
      }
      case 'completed': {
        const sorted = [...tops].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
        // `completedAt` is a UTC instant; slicing its first ten characters would
        // compare a UTC calendar day against the user's local one and file
        // anything completed after 16:00 in Los Angeles under "Earlier".
        const today: Task[] = [];
        const rest: Task[] = [];
        for (const t of sorted) {
          (t.completedAt !== null && civilFromInstant(t.completedAt) === s.today ? today : rest).push(t);
        }
        group('today', 'Today', today, () => 0);
        group('earlier', 'Earlier', rest, () => 0);
        break;
      }
      case 'github': {
        const order: Array<[string, string]> = [['open', 'Open'], ['draft', 'Draft'], ['merged', 'Merged'], ['closed', 'Closed'], ['unknown', 'Unknown']];
        const ghTops = tops.filter((t) => matchesGithubFilter(t, s.githubFilter));
        for (const [state, label] of order) group(state, label, ghTops.filter((t) => (t.github?.state ?? 'unknown') === state), (a, b) => `${a.github?.owner}/${a.github?.repo}`.localeCompare(`${b.github?.owner}/${b.github?.repo}`) || (b.github?.number ?? 0) - (a.github?.number ?? 0));
        break;
      }
      case 'all':
      case 'nodate': {
        const lists = selectLists(s);
        for (const l of lists) group(l.id, l.title, tops.filter((t) => t.listId === l.id));
        const orphan = tops.filter((t) => !s.lists[t.listId]);
        group('orphan', 'Other', orphan);
        break;
      }
      default: {
        if (listId) {
          const open = tops.filter((t) => t.status !== 'completed');
          const done = tops.filter((t) => t.status === 'completed');
          pushTree(open, byKey);
          if (done.length) group('completed', 'Completed', done, (a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
        }
      }
    }
    return rows;
  },
);

export const selectTaskRows = (s: State): Row[] => selectRows(s).filter((r) => r.kind === 'task');
export const selectTask = (id: string) => (s: State): Task | undefined => s.tasks[id];
export const selectIsSelected = (id: string) => (s: State): boolean => s.selection.includes(id);
export const selectFocusedTask = (s: State): Task | null => (s.focusId ? (s.tasks[s.focusId] ?? null) : null);
export const selectSelectedTasks = (s: State): Task[] => s.selection.map((id) => s.tasks[id]).filter((t): t is Task => !!t);
export const selectCurrentListId = (s: State): string | null => (s.view.startsWith('list:') ? s.view.slice(5) : null);
export const selectDefaultListId = (s: State): string | null => s.settings?.defaultListId ?? Object.values(s.lists).find((l) => l.isDefault)?.id ?? selectLists(s)[0]?.id ?? null;
