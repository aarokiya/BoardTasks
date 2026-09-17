import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react';
import type { AppInfo, Density, DockBadgeMode, Settings, ThemePreference } from '@shared/models';
import { TIME_RE } from '@shared/date/civil';
import { formatAgo } from '@shared/date/format';
import { call } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { selectLists } from '../../store/selectors/views';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Dialog } from '../../components/Dialog';
import { Input } from '../../components/Input';
import { Segmented } from '../../components/Segmented';
import { Skeleton } from '../../components/Skeleton';
import { Switch } from '../../components/Switch';
import { cx } from '../../components/cx';
import {
  IconCloud,
  IconGithub,
  IconInfo,
  IconKeyboard,
  IconList,
  IconSettings,
  IconSignOut,
} from '../../components/icons';
import { GithubConnectSettings } from '../github';
import s from './SettingsPanel.module.css';

type SectionId = 'general' | 'notifications' | 'sync' | 'account' | 'github' | 'shortcuts' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'general', label: 'General', icon: <IconSettings size={14} /> },
  { id: 'notifications', label: 'Notifications', icon: <IconInfo size={14} /> },
  { id: 'sync', label: 'Sync', icon: <IconCloud size={14} /> },
  { id: 'account', label: 'Google account', icon: <IconList size={14} /> },
  { id: 'github', label: 'GitHub', icon: <IconGithub size={14} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <IconKeyboard size={14} /> },
  { id: 'about', label: 'About', icon: <IconInfo size={14} /> },
];

const LEAD_OPTIONS = [
  { value: '0', label: 'At time' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '60', label: '1 hour' },
] as const;

const INTERVAL_OPTIONS = [
  { value: '30', label: '30s' },
  { value: '60', label: '1 min' },
  { value: '300', label: '5 min' },
  { value: '900', label: '15 min' },
] as const;


/** Electron accelerator: at least one modifier plus one key, e.g. Control+Shift+Space. */
const ACCELERATOR_RE =
  /^((CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)\+)+(Space|Tab|Enter|Return|Escape|Esc|Up|Down|Left|Right|Home|End|PageUp|PageDown|Backspace|Delete|Insert|F([1-9]|1[0-9]|2[0-4])|[A-Za-z0-9]|[`~!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|])$/;

function ShortcutRow({ value, onSave }: { value: string; onSave: (v: string) => void }): ReactElement {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // Re-derive the draft when the saved value changes (e.g. another window saved it).
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = (): void => {
    const v = draft.trim();
    if (v === value) return;
    if (!ACCELERATOR_RE.test(v)) {
      setError('Use at least one modifier and a key, like Control+Shift+Space.');
      return;
    }
    setError(null);
    onSave(v);
  };
  return (
    <Row
      title="Quick Add shortcut"
      hint="Works from any app. If another app already owns the combination, BoardTasks tells you and the old shortcut stays."
      control={
        <Input
          aria-label="Quick Add shortcut"
          mono
          value={draft}
          error={error}
          onChange={(e) => { setDraft(e.currentTarget.value); if (error) setError(null); }}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        />
      }
    />
  );
}

function Row({ title, hint, control, stack }: { title: string; hint?: string; control: ReactNode; stack?: boolean }): ReactElement {
  return (
    <div className={cx(s.row, stack && s.rowStack)}>
      <span className={s.rowLabel}>
        <span className={s.rowTitle}>{title}</span>
        {hint ? <span className={s.rowHint}>{hint}</span> : null}
      </span>
      <span className={s.rowControl}>{control}</span>
    </div>
  );
}

export function SettingsPanel(): ReactElement {
  const settings = useStore((st) => st.settings);
  const auth = useStore((st) => st.auth);
  const sync = useStore((st) => st.sync);
  const closeOverlay = useStore((st) => st.closeOverlay);
  const openOverlay = useStore((st) => st.openOverlay);
  const setUi = useStore((st) => st.setUi);
  const toast = useStore((st) => st.toast);

  const [section, setSection] = useState<SectionId>('general');
  const lists = useStore(selectLists);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [wipeLocalData, setWipeLocalData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reminderTime, setReminderTime] = useState<string>(settings?.dateOnlyReminderTime ?? '');
  const navRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void call('app:getInfo')
      .then((i) => {
        if (mounted.current) setInfo(i);
      })
      .catch(() => {
        /* About falls back to "unavailable" */
      });
  }, []);

  const save = useCallback(
    (patch: Partial<Settings>): void => {
      void call('settings:set', patch).catch((e: unknown) =>
        toast({ level: 'error', message: `Could not save that setting${e instanceof Error ? `: ${e.message}` : ''}` }),
      );
    },
    [toast],
  );

  const onNavKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const idx = SECTIONS.findIndex((x) => x.id === section);
    const next =
      e.key === 'ArrowDown' ? (idx + 1) % SECTIONS.length
      : e.key === 'ArrowUp' ? (idx - 1 + SECTIONS.length) % SECTIONS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? SECTIONS.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = SECTIONS[next];
    if (!target) return;
    setSection(target.id);
    navRef.current?.querySelector<HTMLButtonElement>(`[data-section="${target.id}"]`)?.focus();
  };

  const signOut = (): void => {
    setBusy(true);
    void call('auth:signOut', { wipeLocalData })
      .then(() => {
        setSignOutOpen(false);
        toast({ level: 'success', message: wipeLocalData ? 'Signed out and local tasks removed.' : 'Signed out of Google.' });
      })
      .catch((e: unknown) => toast({ level: 'error', message: `Sign-out failed${e instanceof Error ? `: ${e.message}` : ''}` }))
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const body = (): ReactElement => {
    if (!settings) {
      return (
        <div className={s.skeletonStack}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={22} />
          ))}
        </div>
      );
    }

    switch (section) {
      case 'general':
        return (
          <>
            <span className={s.sectionTitle}>General</span>
            <div className={s.group}>
              <Row
                title="Appearance"
                control={
                  <Segmented<ThemePreference>
                    label="Appearance"
                    value={settings.theme}
                    options={[
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' },
                      { value: 'system', label: 'System' },
                    ]}
                    onChange={(theme) => save({ theme })}
                  />
                }
              />
              <Row
                title="Row density"
                control={
                  <Segmented<Density>
                    label="Row density"
                    value={settings.density}
                    options={[
                      { value: 'compact', label: 'Compact' },
                      { value: 'default', label: 'Default' },
                      { value: 'comfortable', label: 'Comfortable' },
                    ]}
                    onChange={(density) => {
                      setUi({ density });
                      save({ density });
                    }}
                  />
                }
              />
              <Row
                title="Translucent sidebar"
                hint="Off by default: a vibrant surface is an unstable background for text contrast. Forced off when the system reduces transparency. Takes effect the next time BoardTasks starts."
                control={<Switch label="Translucent sidebar" checked={settings.translucentSidebar} onChange={(v) => save({ translucentSidebar: v })} />}
              />
              <Row title="Date order" control={
                <Segmented<'MDY' | 'DMY'>
                  label="Date order"
                  value={settings.dateOrder}
                  options={[{ value: 'MDY', label: 'M/D/Y' }, { value: 'DMY', label: 'D/M/Y' }]}
                  onChange={(dateOrder) => save({ dateOrder })}
                />
              } />
            </div>
            <div className={s.divider} />
            <div className={s.group}>
              <span className={s.groupLabel}>System</span>
              <Row title="Launch at login" control={<Switch label="Launch at login" checked={settings.startAtLogin} onChange={(v) => save({ startAtLogin: v })} />} />
              <Row
                title="Close to tray"
                hint="Closing the window keeps BoardTasks running so reminders still fire and sync continues."
                control={<Switch label="Close to tray" checked={settings.closeToTray} onChange={(v) => save({ closeToTray: v })} />}
              />
              <Row title="Show tray icon" control={<Switch label="Show tray icon" checked={settings.showTrayIcon} onChange={(v) => save({ showTrayIcon: v })} />} />
              <Row
                title="Dock badge"
                control={
                  <Segmented<DockBadgeMode>
                    label="Dock badge"
                    value={settings.dockBadgeMode}
                    options={[
                      { value: 'today', label: 'Today' },
                      { value: 'overdue', label: 'Overdue' },
                      { value: 'both', label: 'Both' },
                      { value: 'off', label: 'Off' },
                    ]}
                    onChange={(dockBadgeMode) => save({ dockBadgeMode })}
                  />
                }
              />
              <ShortcutRow value={settings.quickAddShortcut} onSave={(quickAddShortcut) => save({ quickAddShortcut })} />
            </div>
          </>
        );

      case 'notifications':
        return (
          <>
            <span className={s.sectionTitle}>Notifications</span>
            <div className={s.group}>
              <Row
                title="Enable reminders"
                hint="Reminder times are stored on this Mac only — Google Tasks keeps the calendar date and discards the time."
                control={<Switch label="Enable reminders" checked={settings.notificationsEnabled} onChange={(v) => save({ notificationsEnabled: v })} />}
              />
              <Row
                title="Notify before"
                control={
                  <Segmented
                    label="Notify before"
                    value={String(settings.notificationLeadMinutes)}
                    options={LEAD_OPTIONS}
                    onChange={(v) => save({ notificationLeadMinutes: Number(v) })}
                  />
                }
              />
              <Row
                title="Reminder time for date-only tasks"
                hint="Tasks with a due date but no time are announced at this time. Leave blank to skip them."
                control={
                  <span className={s.timeInput}>
                    <Input
                      aria-label="Reminder time for date-only tasks"
                      placeholder="09:00"
                      value={reminderTime}
                      mono
                      onChange={(e) => setReminderTime(e.currentTarget.value)}
                      onBlur={() => {
                        const v = reminderTime.trim();
                        if (v === '') {
                          save({ dateOnlyReminderTime: null });
                        } else if (TIME_RE.test(v)) {
                          save({ dateOnlyReminderTime: v });
                        } else {
                          setReminderTime(settings.dateOnlyReminderTime ?? '');
                          toast({ level: 'warn', message: 'Reminder time must look like 09:00.' });
                        }
                      }}
                    />
                  </span>
                }
              />
            </div>
            <div className={s.divider} />
            <div className={s.group}>
              <span className={s.groupLabel}>Check it works</span>
              <span className={s.rowHint}>
                macOS never tells an app whether notification permission was granted, so the only reliable check is to send one.
              </span>
              <div className={s.buttons}>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void call('notifications:test')
                      .then((r) =>
                        toast({
                          level: r.sent ? 'success' : 'warn',
                          message: r.sent ? 'Test notification sent.' : 'BoardTasks could not send a notification.',
                        }),
                      )
                      .catch((e: unknown) => toast({ level: 'error', message: `Could not send${e instanceof Error ? `: ${e.message}` : ''}` }))
                  }
                >
                  Send test notification
                </Button>
                <Button variant="ghost" onClick={() => void call('notifications:openSystemSettings').catch(() => toast({ level: 'error', message: 'Could not open System Settings.' }))}>
                  Open System Settings
                </Button>
              </div>
            </div>
          </>
        );

      case 'sync':
        return (
          <>
            <span className={s.sectionTitle}>Sync</span>
            <div className={s.group}>
              <Row
                title="Check for changes every"
                hint="Google Tasks has no push notifications, so BoardTasks polls. It slows down automatically in the background and on battery."
                control={
                  <Segmented
                    label="Sync interval"
                    value={String(settings.syncIntervalSec)}
                    options={INTERVAL_OPTIONS}
                    onChange={(v) => save({ syncIntervalSec: Number(v) })}
                  />
                }
              />
              <Row
                title="Default list"
                hint="Where Quick Add puts a task when you don't name a list."
                control={
                  <select
                    className={s.select}
                    aria-label="Default list"
                    value={settings.defaultListId ?? ''}
                    onChange={(e) => save({ defaultListId: e.currentTarget.value || null })}
                  >
                    {lists.length === 0 ? <option value="">No lists yet</option> : null}
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>{l.title}</option>
                    ))}
                  </select>
                }
              />
              <Row title="Last synced" control={<span className={s.accountMeta}>{formatAgo(sync?.lastSyncSucceededAt ?? null)}</span>} />
              {sync && sync.pendingCount > 0 ? (
                <Row title="Pending changes" control={<span className={s.accountMeta}>{sync.pendingCount}</span>} />
              ) : null}
              <div className={s.buttons}>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void call('sync:now', { full: true })
                      .then(() => toast({ level: 'success', message: 'Full resync started.' }))
                      .catch((e: unknown) => toast({ level: 'error', message: `Resync failed${e instanceof Error ? `: ${e.message}` : ''}` }))
                  }
                >
                  Full resync
                </Button>
                <Button variant="ghost" onClick={() => openOverlay('outbox')}>
                  Review unsynced changes
                </Button>
              </div>
            </div>
            <div className={s.divider} />
            <div className={s.group}>
              <span className={s.groupLabel}>Danger zone</span>
              <Row
                title="Sign out of Google"
                hint="Your local tasks stay on this Mac unless you ask for them to be removed."
                control={
                  <Button variant="danger" icon={<IconSignOut size={13} />} onClick={() => setSignOutOpen(true)} disabled={auth?.state !== 'signed_in'}>
                    Sign out
                  </Button>
                }
              />
            </div>
          </>
        );

      case 'account':
        return (
          <>
            <span className={s.sectionTitle}>Google account</span>
            <div className={s.accountBox}>
              <span className={s.accountEmail}>{auth?.account?.email ?? 'Not signed in'}</span>
              {auth?.account?.name ? <span className={s.accountMeta}>{auth.account.name}</span> : null}
              <span className={s.accountMeta}>
                {auth?.clientIdHint ? `Client ID ending …${auth.clientIdHint}` : 'No OAuth credentials stored'}
              </span>
              <span className={s.accountMeta}>
                Status: {auth?.state === 'signed_in' ? 'Signed in' : auth?.state === 'reauth_required' ? 'Needs re-authentication' : auth?.state === 'no_credentials' ? 'No credentials' : auth?.state === 'keychain_unavailable' ? 'Keychain unavailable' : 'Signed out'}
              </span>
              {auth?.signedInAt ? <span className={s.accountMeta}>Signed in {formatAgo(auth.signedInAt)}</span> : null}
            </div>
            {auth?.state === 'keychain_unavailable' ? (
              <div className={s.warning}>
                The macOS Keychain is unavailable, so credentials are held in memory for this session only. BoardTasks will never write
                them to disk unencrypted.
              </div>
            ) : null}
            <div className={s.buttons}>
              {auth?.state !== 'signed_in' ? (
                <Button
                  variant="primary"
                  onClick={() =>
                    void call('auth:signIn').catch((e: unknown) => toast({ level: 'error', message: `Sign-in failed${e instanceof Error ? `: ${e.message}` : ''}` }))
                  }
                  disabled={auth?.state === 'no_credentials'}
                >
                  Sign in with Google
                </Button>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => {
                  void call('auth:clearCredentials')
                    .then(() => openOverlay('onboarding'))
                    .catch((e: unknown) => toast({ level: 'error', message: `Could not clear credentials${e instanceof Error ? `: ${e.message}` : ''}` }));
                }}
              >
                Change credentials
              </Button>
            </div>
          </>
        );

      case 'github':
        return (
          <>
            <span className={s.sectionTitle}>GitHub</span>
            <span className={s.rowHint}>
              Link a task to an issue or pull request to see its state, checks and review status in the inspector. BoardTasks uses a
              fine-grained personal access token stored encrypted on this Mac.
            </span>
            <GithubConnectSettings />
          </>
        );

      case 'shortcuts':
        return (
          <>
            <span className={s.sectionTitle}>Shortcuts</span>
            <span className={s.rowHint}>
              Every command in BoardTasks lives in one registry, so the palette, the menu bar and the cheat sheet always agree.
            </span>
            <div className={s.buttons}>
              <Button variant="secondary" icon={<IconKeyboard size={13} />} onClick={() => openOverlay('shortcuts')}>
                Show keyboard shortcuts
              </Button>
              <Button variant="ghost" onClick={() => openOverlay('palette')}>
                Open command palette
              </Button>
            </div>
          </>
        );

      default:
        return (
          <>
            <span className={s.sectionTitle}>About</span>
            {info ? (
              <div className={s.group}>
                <Row title="Version" control={<span className={s.accountMeta}>{info.version}</span>} />
                <Row title="Electron" control={<span className={s.accountMeta}>{info.electron}</span>} />
                <Row title="Platform" control={<span className={s.accountMeta}>{info.platform}{info.isPackaged ? '' : ' · development build'}</span>} />
                <div className={s.divider} />
                <span className={s.groupLabel}>Log file</span>
                <span className={s.mono}>{info.logPath}</span>
                <div className={s.buttons}>
                  <Button variant="secondary" onClick={() => void call('app:revealLogs').catch(() => toast({ level: 'error', message: 'Could not reveal the log file.' }))}>
                    Reveal log file
                  </Button>
                </div>
              </div>
            ) : (
              <div className={s.skeletonStack}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} height={18} />
                ))}
              </div>
            )}
          </>
        );
    }
  };

  return (
    <>
      <Dialog open onClose={closeOverlay} title="Settings" description="Preferences for BoardTasks." size="wide" tall flushBody>
        <div className={s.layout}>
          <div ref={navRef} className={s.nav} role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onNavKeyDown}>
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                role="tab"
                data-section={sec.id}
                aria-selected={sec.id === section}
                aria-controls="bt-settings-panel"
                tabIndex={sec.id === section ? 0 : -1}
                className={cx(s.navItem, sec.id === section && s.navItemOn)}
                onClick={() => setSection(sec.id)}
              >
                <span className={s.navIcon} aria-hidden="true">
                  {sec.icon}
                </span>
                {sec.label}
              </button>
            ))}
          </div>
          <div id="bt-settings-panel" className={s.panel} role="tabpanel" aria-label={SECTIONS.find((x) => x.id === section)?.label ?? 'Settings'} tabIndex={0}>
            {body()}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        title="Sign out of Google?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSignOutOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={signOut}>
              Sign out
            </Button>
          </>
        }
      >
        <div className={s.confirmBody}>
          <span>BoardTasks will stop syncing until you sign in again.</span>
          {sync && sync.pendingCount > 0 ? (
            <div className={s.warning}>
              You have {sync.pendingCount} unsynced {sync.pendingCount === 1 ? 'change' : 'changes'}. Signing out will not send them.
            </div>
          ) : null}
          <Checkbox
            checked={wipeLocalData}
            onChange={setWipeLocalData}
            label="Also delete tasks stored on this computer"
            hint="Your tasks stay in Google Tasks either way. This only clears the local copy."
          />
        </div>
      </Dialog>
    </>
  );
}
