import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LIST_COLORS, type ListColor, type TaskList } from '@shared/models';
import { useStore } from '../../store/store';
import { call } from '../../lib/ipc';
import { announce } from '../../lib/announce';
import { cx } from '../../components/cx';
import { useContextMenu } from '../../components/ContextMenu';
import { Tooltip } from '../../components/Tooltip';
import { IconAlert } from '../../components/icons';
import type { MenuEntry } from '../../components/Menu';
import o from '../../components/overlays.module.css';
import s from './Sidebar.module.css';

export interface ListRowProps {
  list: TaskList;
  count: number;
  current: boolean;
  rail: boolean;
  tabIndex: number;
  onActivate: () => void;
  onFocus: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onRequestDelete: (list: TaskList) => void;
}

const COLOR_LABEL: Record<ListColor, string> = {
  gray: 'Gray', red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green',
  teal: 'Teal', blue: 'Blue', purple: 'Purple', pink: 'Pink',
};

export function ListRow({
  list, count, current, rail, tabIndex, onActivate, onFocus, onKeyDown, onRequestDelete,
}: ListRowProps): ReactElement {
  const renamingListId = useStore((st) => st.renamingListId);
  const setRenamingListId = useStore((st) => st.setRenamingListId);
  const showCompleted = useStore((st) => st.showCompletedByList[list.id] ?? false);
  const toggleShowCompleted = useStore((st) => st.toggleShowCompleted);
  const applyEvent = useStore((st) => st.applyEvent);
  const toast = useStore((st) => st.toast);
  const renaming = renamingListId === list.id;
  const inputRef = useRef<HTMLInputElement>(null);

  const { attributes, listeners, setNodeRef: setSortRef, transform, transition, isDragging } = useSortable({
    id: `listrow:${list.id}`,
    data: { kind: 'listrow', listId: list.id },
  });
  // useSortable supplies role/tabIndex of its own; ours are authoritative here.
  const { role: _dndRole, tabIndex: _dndTabIndex, ...dragAttrs } = attributes;
  // Keyboard reordering lives on a dedicated handle so it can't shadow the
  // tree's own arrow-key navigation.
  const { onKeyDown: rawDragKeyDown, ...pointerListeners } = listeners ?? {};
  const dragKeyDown = rawDragKeyDown as ((e: ReactKeyboardEvent<HTMLButtonElement>) => void) | undefined;
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `listdrop:${list.id}`, data: { kind: 'listdrop', listId: list.id } });

  const installList = useCallback(
    (next: TaskList) => applyEvent({ type: 'data:changed', reason: 'local', tasks: [], lists: [next], deletedTaskIds: [], deletedListIds: [] }),
    [applyEvent],
  );

  const commitRename = useCallback(async () => {
    const title = (inputRef.current?.value ?? '').trim();
    setRenamingListId(null);
    if (!title || title === list.title) return;
    try {
      const next = await call('lists:update', { id: list.id, title });
      installList(next);
      announce(`List renamed to ${title}`);
    } catch {
      toast({ level: 'error', message: `Couldn't rename "${list.title}".` });
    }
  }, [list.id, list.title, setRenamingListId, installList, toast]);

  const setColor = useCallback(
    async (color: ListColor) => {
      try {
        const next = await call('lists:update', { id: list.id, color });
        installList(next);
        announce(`${list.title} colour set to ${COLOR_LABEL[color]}`);
      } catch {
        toast({ level: 'error', message: `Couldn't change the colour of "${list.title}".` });
      }
    },
    [list.id, list.title, installList, toast],
  );

  const menuItems: MenuEntry[] = [
    { id: 'rename', label: 'Rename', onSelect: () => setRenamingListId(list.id) },
    { kind: 'label', id: 'color-label', label: 'Colour' },
    {
      kind: 'custom',
      id: 'colors',
      render: (close) => (
        <div className={o.swatchRow} role="group" aria-label="List colour">
          {LIST_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={COLOR_LABEL[c]}
              aria-pressed={list.color === c}
              className={cx(o.swatch, list.color === c && o.swatchOn)}
              onClick={() => {
                close();
                void setColor(c);
              }}
            >
              <span className={o.swatchDot} style={{ background: `var(--bt-list-${c})` }} />
            </button>
          ))}
        </div>
      ),
    },
    { kind: 'separator', id: 'sep1' },
    {
      id: 'default',
      label: 'Set as default list',
      checked: list.isDefault,
      disabled: list.isDefault,
      onSelect: () => {
        void (async () => {
          try {
            const next = await call('lists:update', { id: list.id, isDefault: true });
            installList(next);
            await call('settings:set', { defaultListId: list.id });
            announce(`${list.title} is now the default list`);
          } catch {
            toast({ level: 'error', message: `Couldn't set "${list.title}" as the default list.` });
          }
        })();
      },
    },
    { id: 'showCompleted', label: 'Show completed', checked: showCompleted, onSelect: () => toggleShowCompleted(list.id) },
    { kind: 'separator', id: 'sep2' },
    { id: 'delete', label: 'Delete list…', danger: true, onSelect: () => onRequestDelete(list) },
  ];
  const ctx = useContextMenu(menuItems, `${list.title} list actions`);

  const rowClass = cx(
    s.row,
    rail && s.railRow,
    current && s.rowCurrent,
    isOver && s.rowDropTarget,
    isDragging && s.rowDragging,
  );

  const label = `${list.title}${count > 0 ? `, ${count} task${count === 1 ? '' : 's'}` : ''}`;

  const body = (
    <div
      ref={(el) => {
        setSortRef(el);
        setDropRef(el);
      }}
      id={`bt-list-${list.id}`}
      role="treeitem"
      aria-current={current ? 'page' : undefined}
      aria-selected={current}
      aria-label={label}
      tabIndex={tabIndex}
      className={rowClass}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={onActivate}
      onDoubleClick={(e) => {
        e.preventDefault();
        setRenamingListId(list.id);
      }}
      onFocus={onFocus}
      onContextMenu={ctx.onContextMenu}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === 'F2') {
          e.preventDefault();
          setRenamingListId(list.id);
          return;
        }
        if (e.key === 'Enter' && current) {
          e.preventDefault();
          setRenamingListId(list.id);
          return;
        }
        onKeyDown(e);
      }}
      {...pointerListeners}
    >
      <button
        type="button"
        className="sr-only"
        tabIndex={tabIndex}
        aria-label={`Reorder ${list.title}`}
        onKeyDown={dragKeyDown}
        {...dragAttrs}
      />
      <span className={s.rowIcon} aria-hidden="true">
        <span className={s.dot} style={{ background: `var(--bt-list-${list.color})` }} />
      </span>
      {renaming ? (
        <input
          ref={inputRef}
          className={s.renameInput}
          defaultValue={list.title}
          autoFocus
          aria-label={`Rename ${list.title}`}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); setRenamingListId(null); }
          }}
        />
      ) : (
        <span className={s.rowLabel}>{list.title}</span>
      )}
      {!renaming ? (
        <span className={s.rowActions}>
          {list.sync === 'pending' ? <span className={s.syncDot} title="Waiting to sync" aria-hidden="true" /> : null}
          {list.sync === 'failed' ? (
            <span className={s.syncFailed} title="This list failed to sync" aria-hidden="true">
              <IconAlert size={12} />
            </span>
          ) : null}
          {count > 0 ? <span className={cx(s.badge, rail && s.railBadge)}>{count}</span> : null}
        </span>
      ) : null}
      {ctx.element}
    </div>
  );

  return rail ? (
    <Tooltip label={label} placement="right">
      <span className={s.railWrap}>{body}</span>
    </Tooltip>
  ) : (
    body
  );
}
