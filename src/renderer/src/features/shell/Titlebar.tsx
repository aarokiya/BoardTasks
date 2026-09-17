import { useCallback, useEffect, useRef, type ReactElement } from 'react';
import { useStore } from '../../store/store';
import { selectLists, selectRows } from '../../store/selectors/views';
import { runCommand } from '../../commands/registry';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { Kbd } from '../../components/Kbd';
import { cx } from '../../components/cx';
import { IconInspector, IconPlus, IconSearch, IconSidebar, IconX } from '../../components/icons';
import { SyncIndicator } from '../sync/SyncIndicator';
import { viewTitle } from './viewMeta';
import s from './Titlebar.module.css';

export interface TitlebarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

export function Titlebar({ sidebarVisible, onToggleSidebar }: TitlebarProps): ReactElement {
  const view = useStore((st) => st.view);
  const lists = useStore(selectLists);
  const rows = useStore(selectRows);
  const filterQuery = useStore((st) => st.filterQuery);
  const setFilter = useStore((st) => st.setFilter);
  const inspectorOpen = useStore((st) => st.inspectorOpen);
  const setUi = useStore((st) => st.setUi);
  const inputRef = useRef<HTMLInputElement>(null);
  const isMac = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'darwin';

  const title = viewTitle(view, lists);
  const taskCount = rows.filter((r) => r.kind === 'task').length;

  const focusFilter = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  useEffect(() => {
    const handler = (): void => focusFilter();
    window.addEventListener('bt:focus-filter', handler);
    return () => window.removeEventListener('bt:focus-filter', handler);
  }, [focusFilter]);

  return (
    <header className={cx(s.titlebar, isMac && s.titlebarMac)}>
      <Tooltip label={sidebarVisible ? 'Hide sidebar (⌘\\)' : 'Show sidebar (⌘\\)'}>
        <IconButton
          label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          icon={<IconSidebar />}
          size="lg"
          aria-pressed={sidebarVisible}
          onClick={onToggleSidebar}
        />
      </Tooltip>

      <h1 className={s.title}>{title}</h1>
      {taskCount > 0 ? <span className={s.count}>{taskCount}</span> : null}

      <div className={s.spacer} />

      <div className={cx(s.filter, filterQuery && s.filterActive)}>
        <IconSearch size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          className={s.filterInput}
          type="search"
          value={filterQuery}
          placeholder={`Filter ${title}`}
          aria-label={`Filter tasks in ${title}`}
          onChange={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (filterQuery) setFilter('');
              else e.currentTarget.blur();
            }
          }}
        />
        {filterQuery ? (
          <IconButton size="sm" label="Clear filter" icon={<IconX size={12} />} onClick={() => { setFilter(''); focusFilter(); }} />
        ) : (
          <span className={s.filterHint} aria-hidden="true"><Kbd keys="⌘F" /></span>
        )}
      </div>

      <div className={s.actions}>
        <SyncIndicator />
        <span className={s.sep} aria-hidden="true" />
        <Tooltip label="New task (⌘N)">
          <IconButton label="New task" icon={<IconPlus />} size="lg" onClick={() => void runCommand('create.task')} />
        </Tooltip>
        <Tooltip label={inspectorOpen ? 'Hide inspector (⌘I)' : 'Show inspector (⌘I)'}>
          <IconButton
            label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
            icon={<IconInspector />}
            size="lg"
            aria-pressed={inspectorOpen}
            onClick={() => setUi({ inspectorOpen: !inspectorOpen })}
          />
        </Tooltip>
      </div>
    </header>
  );
}
