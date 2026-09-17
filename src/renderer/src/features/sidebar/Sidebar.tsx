import { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { TaskList, ListColor } from '@shared/models';
import type { ViewId } from '@shared/constants';
import { useStore } from '../../store/store';
import { selectCounts, selectLists } from '../../store/selectors/views';
import { call } from '../../lib/ipc';
import { announce } from '../../lib/announce';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Tooltip } from '../../components/Tooltip';
import { cx } from '../../components/cx';
import { IconPlus } from '../../components/icons';
import { SMART_VIEW_META } from '../shell/viewMeta';
import { ListRow } from './ListRow';
import s from './Sidebar.module.css';

export interface SidebarProps {
  rail: boolean;
  onNavigate: () => void;
}

const NEXT_COLOR: ListColor[] = ['blue', 'green', 'orange', 'purple', 'pink', 'teal', 'yellow', 'red', 'gray'];

export function Sidebar({ rail, onNavigate }: SidebarProps): ReactElement {
  const view = useStore((st) => st.view);
  const setView = useStore((st) => st.setView);
  const lists = useStore(selectLists);
  const counts = useStore(selectCounts);
  const authState = useStore((st) => st.auth?.state ?? null);
  const applyEvent = useStore((st) => st.applyEvent);
  const setRenamingListId = useStore((st) => st.setRenamingListId);
  const toast = useStore((st) => st.toast);

  const [focusKey, setFocusKey] = useState<string>(view);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [pendingDelete, setPendingDelete] = useState<TaskList | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const visibleViews = useMemo(
    () => SMART_VIEW_META.filter((m) => m.id !== 'overdue' || counts.overdue > 0),
    [counts.overdue],
  );
  const visibleLists = lists;
  const keys = useMemo(
    () => [...visibleViews.map((v) => v.id as string), ...visibleLists.map((l) => `list:${l.id}`)],
    [visibleViews, visibleLists],
  );

  // Roving tabindex: the remembered key can go stale (Overdue hides itself at
  // zero, a list is deleted), which would leave the whole sidebar with no tab
  // stop. Fall back to the first row instead.
  const activeKey = keys.includes(focusKey) ? focusKey : (keys[0] ?? '');

  const navigate = useCallback(
    (v: ViewId) => {
      setView(v);
      setFocusKey(v);
      onNavigate();
    },
    [setView, onNavigate],
  );

  const moveFocus = useCallback(
    (delta: number) => {
      const i = keys.indexOf(activeKey);
      const next = keys[Math.min(keys.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
      if (!next) return;
      setFocusKey(next);
      const id = next.startsWith('list:') ? `bt-list-${next.slice(5)}` : `bt-view-${next}`;
      document.getElementById(id)?.focus();
    },
    [keys, activeKey],
  );

  const onTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
      else if (e.key === 'Home') { e.preventDefault(); setFocusKey(keys[0] ?? ''); document.getElementById(`bt-view-${keys[0] ?? ''}`)?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); moveFocus(keys.length); }
    },
    [moveFocus, keys],
  );

  const createList = useCallback(async () => {
    const title = newTitle.trim();
    setCreating(false);
    setNewTitle('');
    if (!title) return;
    try {
      const color = NEXT_COLOR[lists.length % NEXT_COLOR.length] ?? 'gray';
      const list = await call('lists:create', { title, color });
      applyEvent({ type: 'data:changed', reason: 'local', tasks: [], lists: [list], deletedTaskIds: [], deletedListIds: [] });
      navigate(`list:${list.id}`);
      announce(`List ${title} created`);
    } catch {
      toast({ level: 'error', message: `Couldn't create the list "${title}".` });
    }
  }, [newTitle, lists.length, applyEvent, navigate, toast]);

  const confirmDelete = useCallback(async () => {
    const list = pendingDelete;
    setPendingDelete(null);
    if (!list) return;
    try {
      await call('lists:delete', { id: list.id });
      applyEvent({ type: 'data:changed', reason: 'local', tasks: [], lists: [], deletedTaskIds: [], deletedListIds: [list.id] });
      if (view === `list:${list.id}`) navigate('today');
      announce(`List ${list.title} deleted`);
      toast({ level: 'success', message: `Deleted "${list.title}".` });
    } catch {
      toast({ level: 'error', message: `Couldn't delete "${list.title}".` });
    }
  }, [pendingDelete, applyEvent, view, navigate, toast]);

  const renderSmartView = (meta: (typeof SMART_VIEW_META)[number]): ReactElement => {
    const current = view === meta.id;
    let count = 0;
    let urgent = false;
    let muted = false;
    let danger = false;
    switch (meta.id) {
      case 'today': count = counts.today; urgent = counts.todayHasOverdue; break;
      case 'upcoming': count = counts.upcoming; break;
      case 'overdue': count = counts.overdue; danger = true; break;
      case 'all': count = counts.all; muted = true; break;
      case 'nodate': count = counts.nodate; break;
      case 'github': count = counts.github; break;
      case 'completed': count = 0; break;
    }
    const label = `${meta.title}${count > 0 ? `, ${count} task${count === 1 ? '' : 's'}${urgent ? ', includes overdue' : ''}` : ''}`;
    const row = (
      <button
        type="button"
        id={`bt-view-${meta.id}`}
        role="treeitem"
        aria-current={current ? 'page' : undefined}
        aria-selected={current}
        aria-label={label}
        tabIndex={activeKey === meta.id ? 0 : -1}
        className={cx(s.row, rail && s.railRow, current && s.rowCurrent)}
        onClick={() => navigate(meta.id)}
        onFocus={() => setFocusKey(meta.id)}
        onKeyDown={onTreeKeyDown}
      >
        <span className={s.rowIcon} aria-hidden="true">{meta.icon}</span>
        <span className={s.rowLabel}>{meta.title}</span>
        {count > 0 ? (
          <span
            aria-hidden="true"
            className={cx(
              rail ? s.railBadge : s.badge,
              rail && urgent && s.railBadgeUrgent,
              rail && danger && s.railBadgeDanger,
              rail && muted && s.railBadgeMuted,
              !rail && urgent && s.badgeUrgent,
              !rail && danger && s.badgeDanger,
              !rail && muted && s.badgeMuted,
            )}
          >
            {count}
          </span>
        ) : null}
      </button>
    );
    return rail ? (
      <Tooltip key={meta.id} label={`${label} (${meta.shortcut})`} placement="right">
        <span className={s.railWrap}>{row}</span>
      </Tooltip>
    ) : (
      <span key={meta.id}>{row}</span>
    );
  };

  return (
    <nav className={cx(s.sidebar, rail && s.rail)} aria-label="Views and lists">
      <div className={s.scroll}>
        <div role="tree" aria-label="Views and lists">
          {rail ? null : <div className={s.sectionLabel} id="bt-sec-views">Smart Views</div>}
          <div role="group" aria-labelledby={rail ? undefined : 'bt-sec-views'} aria-label={rail ? 'Smart views' : undefined}>
            {visibleViews.map(renderSmartView)}
          </div>

          {rail ? <div className={s.sectionDivider} /> : <div className={s.sectionLabel} id="bt-sec-lists">Lists</div>}
          <div role="group" aria-labelledby={rail ? undefined : 'bt-sec-lists'} aria-label={rail ? 'Lists' : undefined}>
            <SortableContext items={visibleLists.map((l) => `listrow:${l.id}`)} strategy={verticalListSortingStrategy}>
              {visibleLists.map((l) => (
                <ListRow
                  key={l.id}
                  list={l}
                  count={counts.lists[l.id] ?? 0}
                  current={view === `list:${l.id}`}
                  rail={rail}
                  tabIndex={activeKey === `list:${l.id}` ? 0 : -1}
                  onActivate={() => navigate(`list:${l.id}`)}
                  onFocus={() => setFocusKey(`list:${l.id}`)}
                  onKeyDown={onTreeKeyDown}
                  onRequestDelete={setPendingDelete}
                />
              ))}
            </SortableContext>
            {visibleLists.length === 0 ? (
              <p className={s.signedOutNote}>No lists yet. Create one to start adding tasks.</p>
            ) : null}
          </div>
        </div>

        {authState === 'signed_out' || authState === 'no_credentials' || authState === 'reauth_required' ? (
          <p className={s.signedOutNote}>
            You&rsquo;re signed out. Everything here is the copy stored on this Mac — you can still browse and edit it, and
            changes sync once you sign in.
          </p>
        ) : null}
      </div>

      <div className={s.footer}>
        {creating && !rail ? (
          <input
            ref={newInputRef}
            className={s.renameInput}
            autoFocus
            value={newTitle}
            placeholder="List name"
            aria-label="New list name"
            onChange={(e) => setNewTitle(e.currentTarget.value)}
            onBlur={() => void createList()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); void createList(); }
              else if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setNewTitle(''); }
            }}
          />
        ) : (
          <button
            type="button"
            className={cx(s.newList, rail && s.railRow)}
            onClick={() => {
              setRenamingListId(null);
              setCreating(true);
            }}
            aria-label="New list"
            title="New list"
          >
            <span className={s.rowIcon} aria-hidden="true"><IconPlus /></span>
            {rail ? null : <span className={s.rowLabel}>New list</span>}
          </button>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Delete “${pendingDelete?.title ?? ''}”?`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void confirmDelete()}>Delete list</Button>
          </>
        }
      >
        <p>
          {(counts.lists[pendingDelete?.id ?? ''] ?? 0) > 0
            ? `This deletes the list and its ${counts.lists[pendingDelete?.id ?? ''] ?? 0} task(s) on Google Tasks too. This can't be undone.`
            : "This deletes the list on Google Tasks too. This can't be undone."}
        </p>
      </Dialog>
    </nav>
  );
}
