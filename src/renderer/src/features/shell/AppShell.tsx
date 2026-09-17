import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useStore } from '../../store/store';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { IconButton } from '../../components/IconButton';
import { IconChevronLeft } from '../../components/icons';
import { cx } from '../../components/cx';
import { TaskDndProvider } from '../dnd/TaskDndProvider';
import { Sidebar } from '../sidebar/Sidebar';
import { TaskListPane } from '../tasklist/TaskListPane';
import { DetailPane } from '../detail/DetailPane';
import { ReauthBanner } from '../onboarding/ReauthBanner';
import { Titlebar } from './Titlebar';
import { Divider } from './Divider';
import { paneLayout, useLayoutMode } from './useLayoutMode';
import s from './AppShell.module.css';

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 360;
const DETAIL_MIN = 300;
const DETAIL_MAX = 520;

export function AppShell(): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const mode = useLayoutMode(ref);
  const layout = paneLayout(mode);

  const sidebarWidth = useStore((st) => st.sidebarWidth);
  const detailWidth = useStore((st) => st.detailWidth);
  const sidebarUserCollapsed = useStore((st) => st.sidebarUserCollapsed);
  const inspectorOpen = useStore((st) => st.inspectorOpen);
  const density = useStore((st) => st.density);
  const translucent = useStore((st) => st.settings?.translucentSidebar ?? false);
  const setUi = useStore((st) => st.setUi);
  const [overlaySidebar, setOverlaySidebar] = useState(false);

  // Auto-collapse is tracked separately from the user's own choice, so widening
  // the window restores exactly what the user had.
  useEffect(() => {
    const t = setTimeout(() => setUi({ sidebarAutoCollapsed: layout.sidebar !== 'full' }), 0);
    return () => clearTimeout(t);
  }, [layout.sidebar, setUi]);

  const sidebarHiddenByViewport = layout.sidebar === 'hidden';
  const sidebarKind: 'full' | 'rail' | 'hidden' = sidebarHiddenByViewport ? 'hidden' : sidebarUserCollapsed ? 'hidden' : layout.sidebar;

  const toggleSidebar = useCallback(() => {
    if (sidebarHiddenByViewport) setOverlaySidebar((v) => !v);
    else {
      setOverlaySidebar(false);
      setUi({ sidebarUserCollapsed: !sidebarUserCollapsed });
    }
  }, [sidebarHiddenByViewport, setUi, sidebarUserCollapsed]);

  // ⌘\ routes through the command registry, which toggles sidebarUserCollapsed.
  // In viewport-hidden modes that would be a no-op, so mirror it into the overlay.
  useEffect(() => {
    if (!sidebarHiddenByViewport) return;
    const unsub = useStore.subscribe(
      (st) => st.sidebarUserCollapsed,
      () => setOverlaySidebar((v) => !v),
    );
    return unsub;
  }, [sidebarHiddenByViewport]);

  const detailW = Math.min(layout.detailMaxWidth ?? DETAIL_MAX, Math.max(DETAIL_MIN, detailWidth));
  const sidebarW = sidebarKind === 'rail' ? 48 : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarWidth));

  const columns: string[] = [];
  if (sidebarKind !== 'hidden') columns.push(`${sidebarW}px`);
  columns.push('minmax(0, 1fr)');
  const detailInline = inspectorOpen && layout.detail === 'inline';
  if (detailInline) columns.push(`${detailW}px`);

  const sidebarNode = (
    <ErrorBoundary level="pane" name="Sidebar">
      <Sidebar rail={sidebarKind === 'rail'} onNavigate={() => setOverlaySidebar(false)} />
    </ErrorBoundary>
  );

  const detailNode = (
    <ErrorBoundary level="pane" name="Inspector">
      <DetailPane />
    </ErrorBoundary>
  );

  return (
    <div ref={ref} className={s.shell} data-bt-shell data-mode={mode} data-density={density}>
      <div className={s.dragRegion} aria-hidden="true" />
      <Titlebar sidebarVisible={sidebarKind !== 'hidden' || overlaySidebar} onToggleSidebar={toggleSidebar} />

      <div className={s.banner}>
        <ReauthBanner />
      </div>

      <TaskDndProvider>
      <div className={s.body} style={{ gridTemplateColumns: columns.join(' ') }}>
        {sidebarKind !== 'hidden' ? (
          <aside className={cx(s.pane, s.sidebarPane, translucent && s.sidebarTranslucent)} aria-label="Views and lists">
            {sidebarNode}
          </aside>
        ) : null}

        {sidebarKind === 'full' ? (
          <Divider
            offset={sidebarW + 6}
            value={sidebarW}
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            label="Resize sidebar"
            onChange={(v) => setUi({ sidebarWidth: v })}
          />
        ) : null}

        <main className={s.pane} aria-label="Task list">
          <ErrorBoundary level="pane" name="Task list">
            <TaskListPane />
          </ErrorBoundary>
        </main>

        {detailInline ? (
          <>
            <Divider
              offset={detailW + 6}
              side="right"
              value={detailW}
              min={DETAIL_MIN}
              max={layout.detailMaxWidth ?? DETAIL_MAX}
              label="Resize inspector"
              invert
              onChange={(v) => setUi({ detailWidth: v })}
            />
            <aside className={s.pane} aria-label="Task details">
              {detailNode}
            </aside>
          </>
        ) : null}

        {inspectorOpen && layout.detail === 'sheet' ? (
          <aside
            className={cx(s.pane, s.detailSheet)}
            style={{ width: layout.detailMaxWidth ?? DETAIL_MIN }}
            aria-label="Task details"
          >
            <div className={s.detailBackBar}>
              <IconButton label="Close details" icon={<IconChevronLeft />} onClick={() => setUi({ inspectorOpen: false })} />
              <span className={s.detailBackLabel}>Details</span>
            </div>
            {detailNode}
          </aside>
        ) : null}

        {inspectorOpen && layout.detail === 'fullscreen' ? (
          <section className={cx(s.pane, s.detailFullscreen)} aria-label="Task details">
            <div className={s.detailBackBar}>
              <IconButton label="Back to task list" icon={<IconChevronLeft />} onClick={() => setUi({ inspectorOpen: false })} />
              <span className={s.detailBackLabel}>Back</span>
            </div>
            {detailNode}
          </section>
        ) : null}

        {overlaySidebar && sidebarHiddenByViewport ? (
          <>
            <div className={s.sidebarScrim} onClick={() => setOverlaySidebar(false)} aria-hidden="true" />
            <aside className={cx(s.pane, s.sidebarPane, s.sidebarOverlay, translucent && s.sidebarTranslucent)} aria-label="Views and lists">
              {sidebarNode}
            </aside>
          </>
        ) : null}
      </div>
      </TaskDndProvider>
    </div>
  );
}
