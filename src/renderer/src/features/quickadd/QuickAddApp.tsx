import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Settings, TaskList } from '@shared/models';
import { todayCivil, type CivilDate } from '@shared/date/civil';
import { call, onMainEvent } from '../../lib/ipc';
import { QuickAddField } from './QuickAddField';
import { useQuickAddParse } from './useQuickAddParse';
import s from './QuickAddApp.module.css';

/** How long a draft survives after the HUD is dismissed. */
const DRAFT_TTL_MS = 5000;
const FLASH_MS = 1200;

/** Root of the floating Quick Add window (boot.window === 'quickadd'). */
export function QuickAddApp(): ReactElement {
  const [value, setValue] = useState('');
  const [lists, setLists] = useState<TaskList[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [today, setToday] = useState<CivilDate>(() => todayCivil());
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenAt = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void Promise.all([call('lists:getAll').catch(() => [] as TaskList[]), call('settings:getAll').catch(() => null)]).then(([l, st]) => {
        if (!alive) return;
        setLists(l);
        if (st) setSettings(st);
      });
    };
    reloadRef.current = load;
    load();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const refresh = (): void => reloadRef.current();
    const off = onMainEvent((e) => {
      if (e.type === 'data:changed') {
        if (e.lists.length > 0 || e.deletedListIds.length > 0) refresh();
        return;
      }
      if (e.type === 'settings:changed') {
        setSettings(e.settings);
        return;
      }
      if (e.type === 'theme:changed') {
        document.documentElement.dataset['theme'] = e.resolved;
        return;
      }
      if (e.type === 'quickadd:shown') {
        setToday(todayCivil());
        setError(null);
        // A draft only survives a short dismissal; after that it is stale.
        if (Date.now() - hiddenAt.current > DRAFT_TTL_MS) setValue('');
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    });
    return off;
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const parsed = useQuickAddParse(value, {
    lists,
    defaultListId: settings?.defaultListId ?? lists.find((l) => l.isDefault)?.id ?? lists[0]?.id ?? null,
    today,
    dateOrder: settings?.dateOrder ?? 'MDY',
  });

  const hide = useCallback(() => {
    hiddenAt.current = Date.now();
    void call('window:hideQuickAdd').catch(() => undefined);
  }, []);

  const submit = useCallback(
    async (keepOpen: boolean): Promise<void> => {
      if (parsed.title.trim() === '') {
        if (value.trim() === '') hide();
        return;
      }
      let listId = parsed.listId;
      if (parsed.listQuery) {
        const created = await call('lists:create', { title: parsed.listQuery }).catch(() => null);
        if (created) {
          listId = created.id;
          setLists((prev) => [...prev, created]);
        }
      }
      const title = parsed.title;
      try {
        await call('window:quickAddSubmit', {
          title,
          notes: parsed.notes,
          due: parsed.due,
          dueTime: parsed.dueTime,
          priority: parsed.priority,
          flagged: parsed.flagged,
          keepOpen,
          ...(listId ? { listId } : {}),
        });
      } catch {
        setError('Could not save that task.');
        return;
      }
      setValue('');
      setError(null);
      if (keepOpen) {
        setFlash(title);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
        inputRef.current?.focus();
      } else {
        hide();
      }
    },
    [hide, parsed, value],
  );

  const onHeightChange = useCallback((height: number) => {
    void call('window:resizeQuickAdd', { height: height + 36 }).catch(() => undefined);
  }, []);

  return (
    <div className={s.hud} data-testid="quick-add-hud">
      <QuickAddField
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        parsed={parsed}
        lists={lists}
        today={today}
        variant="hud"
        placeholder="Add a task… “pay rent friday 9am #home !1”"
        autoFocus
        inputRef={inputRef}
        onHeightChange={onHeightChange}
        onSubmit={(shiftKey) => void submit(shiftKey)}
        onCancel={() => {
          if (value !== '') setValue('');
          else hide();
        }}
      />
      {flash ? (
        <p className={s.flash} role="status">
          Added “{flash}”
        </p>
      ) : null}
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
