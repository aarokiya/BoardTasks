# Feature matrix

Every feature BoardTasks promises — in `README.md`, in the plan, or by having a control in the UI —
checked against the **built** app driven by Playwright against the fake Google server.

- Evidence marked *E2E* is a named test in `tests/e2e/06-features.spec.ts`.
- **PASS** — wired end to end and exercised.
- **PARTIAL** — works, but not as promised, or only through some of its surfaces.
- **FAIL** — the control/menu/setting exists and does nothing, or the behaviour is wrong.

Reproduce with:

```bash
npm run build
npx playwright test tests/e2e/06-features.spec.ts
```

Three tests are `test.fail()` — they assert a **known defect is still present**, so the suite stays
green today and turns red the moment the defect is fixed. Two more are `test.fixme()`: those defects
are *races* that reproduce about three runs in four, so asserting on them would flap; their bodies
are kept as executable descriptions and the measured evidence is written up below.

**Totals: 43 PASS · 9 PARTIAL · 6 FAIL.**

Last run: `26 passed, 2 skipped` — stable over three consecutive runs.

---

## Onboarding & auth

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 1 | Wizard appears on a fresh profile | PASS | E2E *onboarding › the wizard reaches the browser hand-off* — `[role=dialog]` on first launch with no `BT_SKIP_ONBOARDING` |
| 2 | `auth:setCredentials` rejects a malformed client id | PASS | E2E same test — `{ok:false}` for `not-a-client-id` |
| 3 | A well-formed client id is accepted, `clientIdHint` returned | PASS | E2E same test |
| 4 | Sign-in reaches the "complete this in your browser" state | PASS | E2E same test — `auth:getStatus` → `signing_in` |
| 5 | Cancel unwinds the flow | PASS | E2E same test — `auth:cancelSignIn` → `signed_out` |
| 6 | Settings shows the client-id hint afterwards | PASS | E2E same test — `clientIdHint` non-empty after cancel |
| 7 | Sign out keeps cached tasks | PASS | E2E *settings › sign out keeps cached tasks* |
| 8 | Sign out **with wipe** clears them | PASS | E2E same test |
| 9 | Re-auth banner on `invalid_grant` | PARTIAL | `tests/e2e/05-visual.spec.ts` › *the re-auth banner* exists but asserts only `expect(typeof appeared).toBe('boolean')`, i.e. it passes whether or not the banner appears. Component behaviour is covered by `ReauthBanner` DOM tests; the end-to-end path is **unproven**. Owned by the UX track |

## Tasks

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 10 | Create | PASS | E2E *tasks › create, rename, complete…* |
| 11 | Rename / edit | PASS | E2E same |
| 12 | Complete via the row checkbox | PASS | E2E same — `status: 'completed'` after a real click |
| 13 | Reopen | PASS | E2E same |
| 14 | Delete (tombstone, row disappears) | PASS | E2E *tasks › move to another list…* |
| 15 | Undo a delete | PASS | E2E *tasks › create, rename…* — `edit.undo` restores title and row |
| 16 | Restore (`tasks:restore`) | PASS | covered by undo above + `tests/dom/undo/undo.test.ts` |
| 17 | Subtask create | PASS | E2E *tasks › subtasks* |
| 18 | Indent | PASS | E2E same — needs a preceding top-level row (correct: Google allows one nesting level) |
| 19 | Outdent | PASS | E2E same |
| 20 | Move to another list | PASS | E2E *tasks › move to another list…* |
| 21 | Keyboard reorder (`task.moveUp`) | PASS | E2E *tasks › keyboard reorder* |
| 22 | Multi-select bulk complete | PASS | E2E *tasks › move to another list…* |
| 23 | Bulk delete | PASS | E2E same |
| 24 | Clear completed | PASS | E2E same — hides (mirrors Google's `clear`), row leaves the Completed view |

## Lists

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 25 | Create | PASS | E2E *lists › create, rename, recolor…* |
| 26 | Rename | PASS | E2E same |
| 27 | Colour | PASS | E2E same |
| 28 | Set default | PASS | E2E same |
| 29 | Reorder | PASS | E2E same |
| 30 | Delete cascades locally (its tasks go too) | PASS | E2E same |
| 31 | Delete cascades to Google | PASS | E2E same — gone from `/__control/state` after `sync:now` |

## Smart views

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 32 | Today = due today **or** overdue | PASS | E2E *smart views* |
| 33 | Upcoming = the next 7 days only | PASS | E2E same — day +8 is excluded **by design** (`store/selectors/views.ts:16`); it appears in All |
| 34 | Overdue | PASS | E2E same |
| 35 | No Date | PASS | E2E same |
| 36 | Completed | PASS | E2E same |
| 37 | GitHub view membership + `repo#num` chip without a token | PASS | E2E same — linked via `github:link`, chip renders `#1234` |

## Quick Add

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 38 | `__btTriggerQuickAdd()` shows the HUD | PASS | E2E *quick add* |
| 39 | Type + Enter → task exists, HUD hides | PASS | E2E same |
| 40 | ⇧Enter submits and keeps the HUD open | PASS | E2E same |
| 41 | Esc hides | PASS | E2E same |
| 42 | NL parse lands on the row (`tomorrow 9am` → `due`, `dueTime`) | PASS | E2E same |
| 43 | Global `⌃⇧Space` registration | PARTIAL | Skipped in E2E by design (`platform/shortcuts.ts:64`). Registration logic is unit-tested; the real hotkey is **manual QA** |

## Command palette & shortcuts

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 44 | `>` command mode, Enter runs | PASS | E2E *command palette* |
| 45 | `@` task search across all lists | PASS | E2E same |
| 46 | `#` list jump | PASS | E2E same |
| 47 | ⌘Enter completes a task result | PASS | E2E same |
| 48 | ⌘/ cheat sheet lists **every** `COMMANDS` entry that has a shortcut, and nothing else | PASS | E2E *command surface › the cheat sheet…* — labels parsed out of `commands/ids.ts` and compared set-wise |
| 49 | Every shell-owned command (`nav.*`, sidebar, inspector, density, find) is registered | PASS | E2E *command surface › the shell-owned commands…* |

## Sync

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 50 | Outbox flush to Google | PASS | E2E *lists* + `00-smoke`, `02-offline` |
| 51 | Server-side change appears locally within one `sync:now` | PASS | E2E *sync › a server-side change appears locally* |
| 52 | Server-side delete removes it locally | PASS | E2E same |
| 53 | Outbox sheet lists a parked change, offers Retry, discard works | PASS | E2E *sync › the outbox sheet lists a parked change* |
| 54 | Offline → online flush (eventually) | PARTIAL | `tests/e2e/02-offline.spec.ts` — nothing is lost, but see 54b/54c |
| 54b | **Offline is reported as "Syncing…", not offline** | **FAIL** | measured below — see F6 |
| 54c | **"Syncs the moment you reconnect"** | **FAIL** | measured 62 s after a ~20 s outage — see F6 |
| 55 | **Both-sides edit raises a conflict** | **FAIL** | E2E `test.fixme` *sync › a both-sides edit raises a conflict instead of overwriting* — see F1 |
| 56 | **Conflict banner + Keep mine / Use theirs** | **FAIL** | E2E `test.fixme` *sync › both conflict resolutions work* — see F2 |
| 57 | **Rate limit shows a state + countdown** | **FAIL** | E2E `test.fail` *sync › a rate limit is surfaced as rate_limited* — see F3 |
| 58 | A rate limit never loses the change, UI stays usable | PASS | E2E *sync › a rate limit never loses the change* |

## Settings

| # | Setting | Verdict | Evidence |
|---|---|---|---|
| 59 | Theme → `data-theme` flips, `nativeTheme.themeSource` follows | PASS | E2E *settings › theme, density…* |
| 60 | Density → row height actually changes | PASS | E2E same — `comfortable` > `compact` measured from `boundingBox()` |
| 61 | Show completed in lists (via `view.showCompleted`) | PARTIAL | E2E same — the **command** works per-list; the **setting** is never written, see F4 |
| 62 | **Sync interval** | **FAIL** | E2E `test.fail` *settings › the sync interval setting is honoured* — see F5 |
| 63 | Dock badge mode → `app.dock.getBadge()` | PASS | E2E same — `today` gives a count, `off` clears it |
| 64 | Tray icon toggle | PASS | E2E *settings › tray toggle…* — off/on with no crash, setting round-trips |
| 65 | Launch at login → `app.getLoginItemSettings()` | PASS | E2E same — reads back true then false |
| 66 | Close to tray (write path) | PASS | E2E same — E2E forces it off at boot; the write still round-trips |
| 67 | Quick Add shortcut → setting + menu rebuild | PASS | E2E same — `Menu.getApplicationMenu()` still carries `create.quickadd` after the change |
| 68 | Notifications enabled / `notifications:test` | PASS | E2E *settings › notifications* — `{sent:true}` |
| 69 | Lead minutes changes the scheduler's next fire | PASS | E2E same — the `next reminder in Ns` log line moves by ~1800s for a 30-minute lead |
| 70 | Date-only reminder time | PASS | same test writes it; consumed at `notifications/compute.ts:38` |
| 71 | GitHub connect — a 401 surfaces "GitHub rejected this token" | PASS | E2E *github* — real 401 HTTP stub via `BT_GITHUB_BASE_URL` |
| 72 | GitHub disconnect | PASS | E2E same |
| 73 | GitHub link works without a token (degraded chip) | PASS | E2E same |
| 74 | Translucent sidebar | PARTIAL | renderer class flips live; native `vibrancy` is only set in the `BrowserWindow` constructor (`windows/main-window.ts:48`) — needs a restart, and nothing says so |
| 75 | Date order (MDY/DMY) | PARTIAL | drives Quick Add *parsing* only; date *display* (`shared/date/format.ts`) ignores it |
| 76 | Default list | PARTIAL | works, but is only reachable from the sidebar context menu / onboarding, not from Settings |
| 77 | Quick Add shortcut is user-changeable | PARTIAL | consumed everywhere in main, but there is **no UI control** to change it (`SettingsPanel.tsx` "Shortcuts" section only opens the cheat sheet) |

## Native integration

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 78 | App menu has every group | PASS | E2E *command surface* — exactly `BoardTasks, File, Edit, Task, View, Sync, GitHub, Window, Help` |
| 79 | Edit roles present (undo/redo/cut/copy/paste/pasteAndMatchStyle/delete/selectAll) | PASS | E2E same |
| 80 | Every menu item references a real command id | PASS | E2E same |
| 81 | Menu click dispatches into the renderer | PASS | E2E *command surface › a menu click dispatches…* — `nav.upcoming.click()` changes the `<h1>` |
| 82 | Tray exists and rebuilds on task change | PASS | E2E *settings › tray toggle…* + `platform/tray.ts:128` |
| 83 | Dock badge updates | PASS | E2E *settings › theme, density…* |
| 84 | Notification scheduler re-arms after task/settings changes | PASS | E2E *settings › notifications* via the `reminders` debug log |
| 85 | Power resume handler registered | PASS | `platform/power.ts:39-40` + `tests/unit/main/…`; a real sleep is **manual QA** |
| 86 | Window bounds persist across relaunch | PASS | E2E *boot and window state › window bounds survive a relaunch* — 1024×768 comes back |

## Reminder time (local-only)

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 87 | `dueTime` set from Quick Add (`5pm`) and shown on the row | PASS | E2E *reminder time* |
| 88 | Survives a full-pull round trip (server strips time, local keeps it) | PASS | E2E same |
| 89 | **Never** sent to Google | PASS | E2E same — `/__control/state` contains no `17:00`, and `due` is midnight-UTC |

## Boot & packaging

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 90 | `data-theme` is on `<html>` before React mounts (no flash) | PASS | E2E *boot and window state › the theme is applied before React mounts* |
| 91 | Native window background is the theme token | PASS | E2E same — `getBackgroundColor()` ∈ `#ececf0` / `#141417` |
| 92 | Renderer cannot reach the network | PASS | `tests/e2e/04-theme-nav.spec.ts` |
| 93 | `npm run package:dir` succeeds | PASS | see the packaging note at the bottom |
| 94 | The packaged binary launches, migrates its DB and reaches platform-ready | PASS | `tests/e2e/07-packaged.spec.ts` (opt-in, `npm run test:e2e:packaged`) |
| 95 | A second packaged launch reuses the profile (no re-migration) | PASS | same spec |
| 96 | The packaged shell renders (visual) | PASS | `test-results/shots/99-packaged.png` — full shell + setup wizard on a fresh production profile |

---

## The FAIL rows in full

### F1 — a both-sides edit silently overwrites the other device

`src/main/sync/push.ts:325`

```ts
const remote = await deps.api.patchTask(ctx.listRemoteId, ctx.taskRemoteId!, bodyFromWire(fields, nowMs));
```

`patchTask` takes a 4th `etag` argument and sends `If-Match` when it is given one
(`src/main/api/google-tasks.ts:61,163-169`). It is never passed. The client already knows what to do
with the answer — `src/main/api/http-client.ts:176` `if (status === 412) throw new ConflictError(...)`
— but with no precondition the server never answers 412.

`runPush` runs **before** `runPull` (`src/main/sync/engine.ts:181-187`), so the local edit is pushed
blind, wins, and the subsequent pull sees only our own write.

**Measured:** remote title set to `"Conflict A from phone"`, local title set to `"Conflict A from mac"`,
one `sync:now` → `tasks:get` returns `title: "Conflict A from mac"`, `conflict: null`, `sync: "synced"`.
The other device's edit is gone with no banner, no toast, no outbox entry.

**It is a race, not an absolute.** If a background poll happens to pull the remote change *before*
our push goes out, the three-way merge does raise the conflict correctly — observed in roughly one
run in four. The deterministic `sync:now` path always loses, which is why the test is `fixme` rather
than `fail`: a `test.fail()` on a 75%-reproducible defect flaps the suite.

This contradicts `README.md` ("both-changed is surfaced for you to resolve") and
`docs/sync-design.md`.

**Suggested fix:** store the etag on the row (it already is — `push.ts:422`) and pass it:
`patchTask(ctx.listRemoteId, ctx.taskRemoteId!, bodyFromWire(fields, nowMs), ctx.etag)`; catch
`ConflictError` in `runPush` and record a conflict (re-using `merge.ts`'s three-way path) instead of
retrying the push. Owner: **correctness track** (`src/main/sync/**`).

### F2 — delete-vs-edit loses the local edit entirely

`src/main/sync/merge.ts:140-155` raises the "deleted on another device" conflict only while the local
row still has dirty fields. Because push runs first and clears the dirty marks on success, by the
time pull sees `deleted: true` the row is clean and `merge.ts:156` `hardDeleteTask(existing.id)` runs.

**Measured:** remote delete + local notes edit + `sync:now {full:true}` → `tasks:get` returns **null**.

Together with F1 this means **neither** conflict kind the UI can render is reachable, so
`src/renderer/src/features/conflicts/ConflictBanner.tsx` and the `tasks:resolveConflict` route are
dead paths in production. Same owner and same root fix as F1.

### F3 — a rate limit shows "Syncing…" for a minute with no explanation

A 429 with `Retry-After: 60` is absorbed inside the HTTP client's own retry loop
(`src/main/api/http-client.ts:178-181`, capped by `MAX_RETRY_AFTER_MS = 300_000` at `:77`), so
`runPush` never returns and `push.retryAfterMs` — the only thing that can set
`rateLimitedUntil` (`src/main/sync/engine.ts:184`) — stays null.

**Measured:** 24 s after arming a 60 s rate limit, `sync:getState` was
`{status:"syncing", retryAfterMs:null, pendingCount:1}` and the pill read
*"Sync status: Syncing…, 1 unsynced change"*. The `rate_limited` status
(`src/shared/models.ts:176`) and `retryAfterMs` (`:190`) exist in the contract and are never used.

**Suggested fix:** when the parsed retry-after exceeds a few seconds, return from the request with a
`RateLimitError` instead of sleeping inside the client, so the engine can report `rate_limited` and
the pill can count down. Owner: **correctness track**.

### F6 — offline is invisible, and reconnecting is not "the moment you reconnect"

The same shape as F3, and probably the same fix. While the fake server is offline (sockets
destroyed) the HTTP client sits in its own retry/backoff loop, so `runPush` never returns and the
engine's status never leaves `syncing`.

**Measured** (three tasks created during a ~20 s outage):

- while offline, the pill's accessible name was
  **`"Sync status: Syncing…, 3 unsynced changes"`** — never "Offline". The `offline` status kind
  (`src/shared/models.ts:174`) and `src/main/sync/network-monitor.ts`'s classification exist and
  never reach the pill in this path. `tests/e2e/02-offline.spec.ts:16` only passes because its
  regex also accepts the digit `3`.
- after `/__control/online`, the change reached the server **62 s** later. README promises
  "changes you make offline queue up and sync the moment you reconnect". Nothing is lost, but the
  backoff is not reset by the network-restored signal, so the wait is a full backoff cycle.
- with a *short* (≈2 s) outage the flush is immediate — so the latency scales with how long the
  client has been backing off, which is what you would expect from a backoff that connectivity
  never interrupts.

**Consequence right now:** `tests/e2e/02-offline.spec.ts` fails consistently (3/3 runs) at its
20 s flush budget. That spec belongs to the correctness track and was **not** modified here.

**Suggested fix:** (a) let the network monitor's online transition cancel the in-flight backoff and
kick an immediate flush; (b) surface `offline` on the pill as soon as the monitor says so rather
than waiting for a request to resolve. Owner: **correctness track** (`src/main/sync/**`,
`src/main/api/http-client.ts`).

### F4 — `showCompletedInLists` is stored, read, and never written

- Written by: **nothing**.
- Read by: `src/renderer/src/store/selectors/views.ts:116-120` (fallback) and
  `src/main/platform/menu-template.ts:162` (`type:'checkbox', checked: settings.showCompletedInLists`).
- The command that users actually invoke, `view.showCompleted`
  (`src/renderer/src/features/shell/commands.ts:59-67`), toggles a *per-list* map in the renderer
  store (`store.ts:282`) instead.

Consequence: **View ▸ Show / Hide Completed is permanently unchecked** and disagrees with what the
list is showing. `src/main/platform/app-menu.ts:47` even rebuilds the menu when the key changes — it
never changes.

**Suggested fix:** either drop the key and make the menu item stateless, or have `view.showCompleted`
write the setting for the "no per-list override" case. Owner: **UX track** (`src/renderer/src/**`)
with a one-line follow-up in `menu-template.ts` (completeness track) once decided.

### F5 — the Sync interval control does nothing

`src/renderer/src/features/settings/SettingsPanel.tsx:316-327` writes `syncIntervalSec`, the schema
stores it (`src/main/db/repositories/settings.ts:19`), and **nothing reads it**. `createScheduler`
uses the hard-coded `DEFAULT_INTERVALS` (`src/main/sync/scheduler.ts:24-30,76-79`);
`src/main/sync/index.ts:50-61` never passes `intervals`, and nothing subscribes to
`onSettingsChanged` for the key. Polling is always 60 s focused / 300 s background / 900 s on battery.

The hint text under the control describes exactly the hard-coded behaviour, so it reads as working.

**Suggested fix:** pass `intervals: { focused: getSettings().syncIntervalSec * 1000, … }` from
`startSync` and re-arm on `onSettingsChanged`, or remove the control. Owner: **correctness track**
(`src/main/sync/**`) + **UX track** if the control is to be removed.

---

## Dead code and duplicate implementations

Not features, but they make "is this finished?" hard to answer. Reported, not fixed (outside the
completeness track's edit scope).

- **`src/main/ipc/routes/_stub.ts` is an orphan file.** `notImplemented` (`:7`) is exported and the
  module is imported by nothing. Delete the file — it is the single most misleading thing in the
  repo for anyone asking whether a channel is implemented. (Every channel *is* implemented:
  `src/main/ipc/routes.ts` composes nine route modules and the map is exhaustive by type.)
- `src/renderer/src/components/index.ts` — the whole barrel is dead; every consumer imports the
  component file directly.
- Other never-imported exports worth a look: `src/main/ipc/routes/sync.ts:22` `getSyncEngine`,
  `src/renderer/src/lib/ipc.ts:29` `tryCall` (the entire non-throwing IPC variant),
  `src/shared/result.ts:29` `err` + `:28` `ok`, `src/shared/constants.ts:1-2,8`
  `APP_ID`/`APP_NAME`/`URL_SCHEME` (all three bypassed by hard-coded literals),
  `src/renderer/src/commands/ids.ts:83` `commandMeta`, plus 14 unused icons in
  `src/renderer/src/components/icons.tsx`.
- **Two `DatePickerPopover`s** (`features/detail/` and `features/quickadd/`), both reachable, that
  disagree on what "Next week" means (`today+7` vs *next Monday*), on keyboard support (full grid
  nav vs none) and on time entry (`HH:mm` only vs `5pm`/`noon`).
- **Two `Kbd`s** (`components/Kbd.tsx`, `features/shortcuts/Kbd.tsx`) that render Enter as the word
  "Enter" in one place and "⏎" in another.
- **Four writers of `document.documentElement.dataset.theme`** — `renderer/public/boot.js:7`,
  `hooks/useThemeSync.ts:14`, `commands/impl/app.ts:14`, `features/quickadd/QuickAddApp.tsx:55`. The
  optimistic write in `app.ts:14` defeats `applyTheme`'s own flash-suppression guard, so switching
  theme from the palette animates and switching it from Settings does not.
- **Three copies of the "is this one of our origins?" predicate** —
  `security/harden.ts:22` (exported, never imported), `ipc/sender-guard.ts:16-17` (the same body
  re-typed), `security/csp.ts:50` (third spelling, and it captures `isPackaged` once, which the
  comment in `harden.ts:8-16` explicitly warns against). Security-critical; should be one function.

Empty `catch {}` blocks were reviewed one by one. Most are justified (`localStorage`, clipboard,
`new URL()` validators, the logger's own writes, window geometry). Four are not:

- `src/main/db/repositories/tasks.ts:66` — the **entire search** returns `[]` on any SQLite/FTS
  error, indistinguishable from "no matches". No log line.
- `src/renderer/src/app/App.tsx:77` — a missing preload bridge renders the full chrome with nothing
  behind it, instead of reaching the `ErrorBoundary` that already wraps `App`.
- `src/main/sync/merge.ts:108,117` — a corrupt `base_json` silently degrades the three-way merge to
  last-write-wins; a corrupt `conflict_json` makes a conflict vanish from the UI.
- `src/renderer/src/commands/impl/task.ts:223` — `task.openInGoogle` swallows a blocked-by-allowlist
  URL, so the menu item does nothing at all with no toast.

## Test-infrastructure note (fixed)

`app.requestSingleInstanceLock()` ran in `src/main/index.ts` **before** `BT_USER_DATA` was applied in
`bootstrap()`, so the lock was always keyed on the real profile. Any second BoardTasks — another
Playwright run, `npm run dev`, an installed copy — made every subsequent `electron.launch()` exit 0
with "Target page, context or browser has been closed". The override is now applied in `index.ts`
before the lock is requested (`src/main/index.ts:10`), so each E2E profile gets its own lock.

## Packaging

```bash
npm run package:dir
BT_PACKAGED=1 npx playwright test tests/e2e/07-packaged.spec.ts
```

`tests/e2e/07-packaged.spec.ts` spawns `dist/mac-arm64/BoardTasks.app/Contents/MacOS/BoardTasks`
directly and asserts on what it logs and writes: `packaged=true`, the migration runs,
`boardtasks.db` and `logs/main.log` land in the profile, the tray icon is found in
`Contents/Resources`, the notification scheduler starts, and none of `app:// handler failed`,
`renderer failed to load`, `Preload bridge missing` or `BoardTasks could not start` appear. A second
launch against the same profile must **not** re-run migration 1.

**Why not Playwright's Electron driver here.** It was written that way first and it did work once —
`test-results/shots/99-packaged.png` is that run: the packaged app rendering the full shell with the
setup wizard on a fresh production profile. But `electron.launch()` against the ad-hoc-re-signed
bundle (`scripts/adhoc-sign.cjs`) is unreliable — it hangs 180 s waiting for a CDP endpoint on a
bundle that launches instantly by hand. Signing the app differently just for the test would defeat
the point of the test, so the spec reads the process instead of attaching to it.

Two practical notes for anyone extending it:

- Spawn **detached** and kill the whole process group. Electron leaves helper/GPU/renderer children
  behind otherwise, and they accumulate until launches start timing out. With the group kill the
  suite runs in ~5 s and leaves nothing behind; without it, ~2 min and eight zombies.
- `--user-data-dir` (Chromium's own switch) is the only profile override that works here:
  `BT_USER_DATA` is deleted at module load in a packaged build (`src/main/env.ts:30-32`), by design.
