import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { GOOGLE_CLIENT_ID_RE } from '@shared/constants';
import { CLIENT_SECRET_EXPLAINER, SETUP_STEPS } from '@shared/setup-steps';
import { call, IpcCallError } from '../../lib/ipc';
import { useStore } from '../../store/store';
import { selectLists } from '../../store/selectors/views';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Dialog } from '../../components/Dialog';
import { Input } from '../../components/Input';
import { Spinner } from '../../components/Spinner';
import { cx } from '../../components/cx';
import { IconAlert, IconCheck, IconCheckCircle, IconCopy, IconExternal, IconInfo } from '../../components/icons';
import s from './Onboarding.module.css';

const TOTAL_STEPS = 6;

const CLIENT_ID_ERROR = "That doesn't look like a Desktop OAuth client ID — it should end in .apps.googleusercontent.com";
const CLIENT_SECRET_ERROR = 'Paste the client secret from the same OAuth client';

type SignInPhase =
  | { kind: 'idle' }
  | { kind: 'waiting' }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

function signInErrorMessage(e: unknown): string {
  if (e instanceof IpcCallError) {
    if (e.code === 'CANCELLED') return 'Sign-in was cancelled.';
    if (e.code === 'TIMEOUT') return 'Sign-in timed out after 5 minutes.';
    if (e.code === 'NETWORK') return "Couldn't reach Google. Check your connection.";
    return e.message;
  }
  return e instanceof Error ? e.message : 'Sign-in failed.';
}

export function Onboarding(): ReactElement {
  const auth = useStore((st) => st.auth);
  const lists = useStore(selectLists);
  const settings = useStore((st) => st.settings);
  const closeOverlay = useStore((st) => st.closeOverlay);
  const toast = useStore((st) => st.toast);

  const [step, setStep] = useState(() => (useStore.getState().auth?.state === 'signed_in' ? 5 : 1));
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [touchedId, setTouchedId] = useState(false);
  const [touchedSecret, setTouchedSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SignInPhase>({ kind: 'idle' });
  const [pickedListId, setPickedListId] = useState<string | null>(() => useStore.getState().settings?.defaultListId ?? null);
  // Derived, not synced in an effect: falls back to the marked default, then the first list.
  const defaultListId = pickedListId ?? lists.find((l) => l.isDefault)?.id ?? lists[0]?.id ?? null;
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const idValid = GOOGLE_CLIENT_ID_RE.test(clientId.trim());
  const secretValid = clientSecret.trim().length >= 8;

  const openUrl = useCallback(
    (url: string) => {
      void call('app:openExternal', { url }).catch((e: unknown) =>
        toast({ level: 'error', message: `Could not open the link${e instanceof Error ? `: ${e.message}` : ''}` }),
      );
    },
    [toast],
  );

  const copyUrl = useCallback(
    (url: string) => {
      void (async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(url);
          if (mounted.current) setCopiedUrl(url);
          setTimeout(() => {
            if (mounted.current) setCopiedUrl(null);
          }, 1600);
        } catch {
          toast({ level: 'error', message: 'Could not copy — the clipboard is unavailable' });
        }
      })();
    },
    [toast],
  );

  const finish = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      await call('settings:set', { onboardingComplete: true });
      closeOverlay();
      toast({ level: 'success', message: "You're all set — BoardTasks is ready." });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save your settings.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [closeOverlay, toast]);

  const skipToOffline = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      await call('settings:set', { onboardingComplete: true });
      closeOverlay();
      toast({
        level: 'info',
        message: 'Using BoardTasks offline. Connect Google any time from Settings.',
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save your settings.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [closeOverlay, toast]);

  const saveCredentials = useCallback(async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      await call('auth:setCredentials', { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      if (mounted.current) setStep(4);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Google rejected those credentials.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [clientId, clientSecret]);

  const signIn = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'waiting' });
    try {
      const status = await call('auth:signIn');
      if (!mounted.current) return;
      if (status.state === 'signed_in') {
        setPhase({ kind: 'done' });
        setStep(5);
      } else {
        setPhase({ kind: 'error', message: 'Sign-in did not complete. Try again.' });
      }
    } catch (e) {
      if (mounted.current) setPhase({ kind: 'error', message: signInErrorMessage(e) });
    }
  }, []);

  const cancelSignIn = useCallback(async (): Promise<void> => {
    try {
      await call('auth:cancelSignIn');
    } catch {
      /* cancelling a finished flow is not an error worth surfacing */
    }
    if (mounted.current) setPhase({ kind: 'idle' });
  }, []);

  const saveDefaultList = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      if (defaultListId) await call('settings:set', { defaultListId });
      if (mounted.current) setStep(6);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the default list.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [defaultListId]);

  const title =
    step === 1 ? 'Welcome to BoardTasks'
    : step === 2 ? 'Set up Google Cloud'
    : step === 3 ? 'Paste your OAuth credentials'
    : step === 4 ? 'Sign in with Google'
    : step === 5 ? 'Pick a default list'
    : 'You’re ready';

  const body = (): ReactElement => {
    switch (step) {
      case 1:
        return (
          <div className={s.wizard}>
            <span className={s.heading}>A fast, offline-first home for your Google Tasks</span>
            <p className={s.lede}>
              BoardTasks keeps a local copy of every task, so the app never waits on the network. Changes you make offline queue up
              and sync the moment you reconnect.
            </p>
            <div className={s.bullets}>
              {[
                'Smart views — Today, Upcoming, Overdue — plus your own lists and subtasks.',
                'Quick Add from anywhere with ⌃⇧Space, including natural-language dates.',
                'Reminder times stay on this Mac; Google Tasks only stores the calendar date.',
                'Optional GitHub linking connects a task to an issue or pull request.',
              ].map((text) => (
                <div key={text} className={s.bullet}>
                  <span className={s.bulletIcon} aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                  <span>{text}</span>
                </div>
              ))}
            </div>
            <div className={cx(s.callout, s.calloutInfo)}>
              <span className={s.calloutIcon} aria-hidden="true">
                <IconInfo size={15} />
              </span>
              <span>
                <span className={s.calloutTitle}>BoardTasks ships with no Google credentials</span>
                Connecting Google takes about five minutes and creates a Cloud project that belongs to you. You can also skip it and
                use BoardTasks entirely offline.
              </span>
            </div>
          </div>
        );

      case 2:
        return (
          <div className={s.wizard}>
            <p className={s.lede}>
              Work through these in the Google Cloud console. Each “Open” button uses your normal browser.
            </p>
            <div className={s.callout}>
              <span className={s.calloutIcon} aria-hidden="true">
                <IconAlert size={15} />
              </span>
              <span>
                <span className={s.calloutTitle}>Set the consent screen to “In production”</span>
                While an External consent screen sits in “Testing”, Google expires every refresh token after 7 days — BoardTasks would
                ask you to sign in again every week, forever, and it would look like a bug in BoardTasks. Publishing does not require
                verification when you are the only user of your own project.
              </span>
            </div>
            <div className={s.steps}>
              {SETUP_STEPS.map((setupStep, i) => (
                <div key={setupStep.title} className={s.step}>
                  <div className={s.stepHead}>
                    <span className={s.stepIndex} aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className={s.stepTitle}>{setupStep.title}</span>
                  </div>
                  <p className={s.stepBody}>{setupStep.body}</p>
                  {setupStep.url ? (
                    <div className={s.stepActions}>
                      <Button size="sm" variant="secondary" icon={<IconExternal size={13} />} onClick={() => openUrl(setupStep.url!)}>
                        Open
                      </Button>
                      <span className={s.stepUrl}>{setupStep.url}</span>
                      <IconButton
                        size="sm"
                        label={copiedUrl === setupStep.url ? 'Link copied' : `Copy link for ${setupStep.title}`}
                        icon={copiedUrl === setupStep.url ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        onClick={() => copyUrl(setupStep.url!)}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );

      case 3:
        return (
          <div className={s.wizard}>
            <p className={s.lede}>
              Both values come from the Desktop OAuth client you just created. They are encrypted with the macOS Keychain and only ever
              sent to Google.
            </p>
            <div className={s.form}>
              <Input
                label="Client ID"
                mono
                inputSize="lg"
                autoComplete="off"
                spellCheck={false}
                placeholder="123456789012-abcdefg.apps.googleusercontent.com"
                value={clientId}
                onChange={(e) => setClientId(e.currentTarget.value)}
                onBlur={() => setTouchedId(true)}
                error={touchedId && clientId.length > 0 && !idValid ? CLIENT_ID_ERROR : null}
              />
              <Input
                label="Client secret"
                mono
                inputSize="lg"
                autoComplete="off"
                spellCheck={false}
                placeholder="GOCSPX-…"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.currentTarget.value)}
                onBlur={() => setTouchedSecret(true)}
                error={touchedSecret && clientSecret.length > 0 && !secretValid ? CLIENT_SECRET_ERROR : null}
              />
              <div className={s.explainer}>
                <span className={s.explainerTitle}>{CLIENT_SECRET_EXPLAINER.title}</span>
                {CLIENT_SECRET_EXPLAINER.body}
              </div>
              {saveError ? (
                <div className={s.signinError} role="alert">
                  <span>{saveError}</span>
                </div>
              ) : null}
            </div>
          </div>
        );

      case 4:
        return (
          <div className={s.wizard}>
            <p className={s.lede}>
              BoardTasks opens your normal browser — never an embedded window. You will see an “unverified app” warning for your own
              project: click Advanced, then continue, then grant the Google Tasks permission.
            </p>
            {phase.kind === 'waiting' ? (
              <div className={s.waiting} role="status">
                <Spinner size={16} />
                <span>Complete sign-in in your browser…</span>
                <Button variant="ghost" onClick={() => void cancelSignIn()}>
                  Cancel
                </Button>
              </div>
            ) : phase.kind === 'error' ? (
              <div className={s.signinError} role="alert">
                <span>{phase.message}</span>
                <div className={s.signinErrorActions}>
                  <Button variant="secondary" onClick={() => void signIn()}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : phase.kind === 'done' ? (
              <div className={s.waiting} role="status">
                <IconCheckCircle size={16} />
                <span>Signed in{auth?.account?.email ? ` as ${auth.account.email}` : ''}.</span>
              </div>
            ) : (
              <Button variant="primary" size="lg" onClick={() => void signIn()}>
                Sign in with Google
              </Button>
            )}
          </div>
        );

      case 5:
        return (
          <div className={s.wizard}>
            <p className={s.lede}>New tasks go here unless you pick another list. You can change this any time in Settings.</p>
            {lists.length === 0 ? (
              <p className={s.noLists}>
                No lists yet. BoardTasks will create one for you on the first sync, and you can choose a default later in Settings.
              </p>
            ) : (
              <div className={s.listChoices} role="radiogroup" aria-label="Default list">
                {lists.map((l) => {
                  const on = l.id === defaultListId;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={cx(s.listChoice, on && s.listChoiceOn)}
                      onClick={() => setPickedListId(l.id)}
                    >
                      <span className={cx(s.radio, on && s.radioOn)} aria-hidden="true">
                        {on ? <span className={s.radioDot} /> : null}
                      </span>
                      <span className={s.listDot} style={{ background: `var(--bt-list-${l.color})` }} aria-hidden="true" />
                      <span className={s.listChoiceName}>{l.title}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {saveError ? (
              <div className={s.signinError} role="alert">
                <span>{saveError}</span>
              </div>
            ) : null}
          </div>
        );

      default:
        return (
          <div className={s.wizard}>
            <span className={s.heading}>You’re ready</span>
            <div className={s.bullets}>
              <div className={s.bullet}>
                <span className={s.bulletIcon} aria-hidden="true">
                  <IconCheck size={14} />
                </span>
                <span>
                  {auth?.state === 'signed_in'
                    ? `Signed in${auth.account?.email ? ` as ${auth.account.email}` : ''} — your tasks are syncing with Google.`
                    : 'Running offline. Connect Google any time from Settings → Google account.'}
                </span>
              </div>
              <div className={s.bullet}>
                <span className={s.bulletIcon} aria-hidden="true">
                  <IconCheck size={14} />
                </span>
                <span>
                  {defaultListId && settings
                    ? `New tasks go to ${lists.find((l) => l.id === defaultListId)?.title ?? 'your default list'}.`
                    : 'Pick a default list any time in Settings.'}
                </span>
              </div>
              <div className={s.bullet}>
                <span className={s.bulletIcon} aria-hidden="true">
                  <IconCheck size={14} />
                </span>
                <span>Press ⌘K for the command palette, ⌘/ for every keyboard shortcut.</span>
              </div>
            </div>
            {saveError ? (
              <div className={s.signinError} role="alert">
                <span>{saveError}</span>
              </div>
            ) : null}
          </div>
        );
    }
  };

  const canContinue =
    step === 3 ? idValid && secretValid && !saving
    : step === 4 ? phase.kind === 'done' || auth?.state === 'signed_in'
    : !saving;

  const onContinue = (): void => {
    if (step === 3) void saveCredentials();
    else if (step === 5) void saveDefaultList();
    else if (step === 6) void finish();
    else setStep((v) => Math.min(TOTAL_STEPS, v + 1));
  };

  return (
    <Dialog
      open
      onClose={closeOverlay}
      dismissible={false}
      showClose={false}
      size="wide"
      alignTop
      title={title}
      description="First-run setup for BoardTasks."
      headerExtra={
        <span className={s.stepCount}>
          Step {step} of {TOTAL_STEPS}
        </span>
      }
      footerSpread
      footer={
        <>
          <div className={s.footerLeft}>
            {step === 1 ? (
              <Button variant="ghost" disabled={saving} onClick={() => void skipToOffline()}>
                Use offline for now
              </Button>
            ) : (
              <Button variant="ghost" disabled={saving || phase.kind === 'waiting'} onClick={() => setStep((v) => Math.max(1, v - 1))}>
                Back
              </Button>
            )}
          </div>
          <Button variant="primary" data-bt-autofocus="" disabled={!canContinue} onClick={onContinue}>
            {step === 6 ? 'Start using BoardTasks' : 'Continue'}
          </Button>
        </>
      }
    >
      {body()}
    </Dialog>
  );
}
