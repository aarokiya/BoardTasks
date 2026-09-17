# Manual QA checklist

Everything automation cannot reach. `tests/e2e/06-features.spec.ts` covers the rest — see
[`docs/feature-matrix.md`](feature-matrix.md) for what is already proven and what is known broken.

Work through this before tagging a release. Each item says **why** a machine can't do it, so you
know what you are standing in for.

---

## 1. Real Google OAuth

*Automation can't: we can never hold a real Google session, and the fake server's token endpoint
tells us nothing about Google's actual consent UI.*

- [ ] Fresh profile (`rm -rf ~/Library/Application\ Support/BoardTasks`), launch, walk the whole
      wizard with a **real** Cloud project.
- [ ] Sign-in opens your **system browser**, never a window inside the app.
- [ ] The "unverified app" interstitial appears; **Advanced → Go to …** completes.
- [ ] **Deny consent.** The browser tab must say something useful, the app must return to
      `signed_out` — not hang in `signing_in` forever, and not wipe your credentials.
- [ ] Close the browser tab mid-flow without deciding. The app must recover (Cancel works, a second
      sign-in attempt works).
- [ ] Sign in twice in a row without quitting: the second attempt must not collide on the loopback
      port.
- [ ] After success: tasks arrive, `clientIdHint` shows in Settings ▸ Google account, the sync pill
      goes to "Synced".
- [ ] Leave it a day, relaunch: it must **not** ask you to sign in again (if it does, the Cloud
      project is still in *Testing* — see `docs/google-cloud-setup.md` § The 7-day trap).
- [ ] Revoke access at <https://myaccount.google.com/permissions>, then force a sync. The re-auth
      banner must appear with a sensible reason, and your local tasks must stay visible.

## 2. Notifications

*Automation can't: macOS gives no API to read notification permission or inspect a delivered banner,
and `Notification.isSupported()` is true even when the user has denied us.*

- [ ] Settings ▸ Notifications ▸ **Send a test notification** → a banner appears with the app icon
      and the BoardTasks name (not "Electron").
- [ ] With notifications **denied** in System Settings: the test button must not silently claim
      success, and the "Open notification settings" link must land on the right pane.
- [ ] Set a task due today with a time 2 minutes out. Wait. The reminder fires once, shows the
      due time and the list name.
- [ ] Set **Notify before** to 5 minutes and confirm the next one fires 5 minutes early.
- [ ] Style = *Alerts* in System Settings: the **Complete** action button appears and completing
      from the banner really completes the task (check the row, and that it syncs).
- [ ] Click the banner body: the main window comes forward with that task focused, even if the
      window was closed to the tray.
- [ ] Quit the app, let a reminder time pass by more than a day, relaunch: you get **one** summary
      line, not a wall of banners.

## 3. Tray / menu bar

*Automation can't: `Tray` has no readable state and the menu bar is not in the window tree.*

- [ ] Icon appears in the menu bar and is a **template** image — check it in a **light** menu bar
      and a **dark** one (System Settings ▸ Appearance), and with "Reduce transparency" on.
- [ ] Menu shows live Today / Overdue counts; complete a task and reopen the menu — counts update.
- [ ] **Quick Add** from the tray opens the HUD even with no window open.
- [ ] **Sync Now** from the tray works with every window closed.
- [ ] **Settings…** brings the window back and opens the panel.
- [ ] Turn the tray icon off in Settings: it disappears immediately. Turn it back on: it returns.
- [ ] With the tray icon **off** and **close to tray on**, ⌘W still leaves the app running and ⌘Q
      still quits.

## 4. Global Quick Add shortcut

*Automation can't: Playwright cannot press a system-wide hotkey, and E2E deliberately skips
registration (`src/main/platform/shortcuts.ts:64`).*

- [ ] With BoardTasks in the background and **another app focused**, press ⌃⇧Space. The HUD appears
      over that app and takes focus.
- [ ] Type `Buy milk tomorrow 5pm #Work !1`, Enter. The HUD vanishes, focus returns to the other
      app, and the task exists with the right date, time, list and priority.
- [ ] ⇧Enter keeps the HUD open for a second entry.
- [ ] Esc dismisses. Clicking another app dismisses.
- [ ] The HUD appears on the display the **cursor** is on, in a multi-display setup.
- [ ] The HUD appears over a **full-screen** app (Space with a full-screen window).
- [ ] Run a second app that claims ⌃⇧Space (or register it in System Settings ▸ Keyboard) and
      relaunch: you must get the "used by another app" toast with an Open Settings action, not
      silence. **Note:** there is currently no UI to pick a different shortcut — see
      `docs/feature-matrix.md` row 77.

## 5. VoiceOver and keyboard-only

*Automation can't: axe-style checks find markup problems, not whether the experience is usable.*

- [ ] ⌘F5 on, navigate the whole app with VO+arrows: sidebar tree, task list, inspector, palette.
- [ ] Task rows announce title, due date, list and completion state — and **announce again** when
      you complete one (the `#bt-status` live region).
- [ ] The command palette announces the result count as you type, and the highlighted item.
- [ ] Every dialog (Settings, Shortcuts, Outbox, Onboarding, Delete-list confirm) traps focus and
      returns focus to where you came from on Esc.
- [ ] Tab-only, no mouse: reach and operate every Settings control, including the segmented ones.
- [ ] "Reduce motion" on: no theme cross-fade, no row animations.
- [ ] "Increase contrast" on: focus rings are still visible in both themes.

## 6. Input methods and text

*Automation can't: `keyboard.type()` bypasses the IME entirely.*

- [ ] With a Japanese or Pinyin IME: type into the inline Quick Add and into the HUD. The
      **composition** must not be submitted by Enter — Enter should commit the candidate first, and
      only a second Enter creates the task.
- [ ] Same in the task title rename field and the notes field.
- [ ] Paste a multi-line block into notes: line breaks survive a sync round trip.
- [ ] RTL text (Hebrew/Arabic) in a title renders without breaking the row layout.
- [ ] Emoji and a very long single-word title do not overflow the row or the sidebar.

## 7. Displays, sleep and the clock

*Automation can't: we cannot unplug a monitor or advance the system clock.*

- [ ] Move the window to a second display, quit, unplug the display, relaunch. The window must come
      back **on screen**, not off in the void.
- [ ] Change the display scale / resolution while running: layout reflows, no blank window.
- [ ] Close the laptop at 23:50 with a task due today, open it at 00:10. "Today" must have rolled
      over, the dock badge must be recounted, and the overdue task must have moved to Overdue.
- [ ] Sleep for an hour with a reminder due in the middle: on wake you get the reminder (within
      ~3 s of the resume handler firing), not silence and not a duplicate.
- [ ] Change the system timezone while running, then check that due labels and the next reminder
      re-compute.
- [ ] Set the system clock forward by an hour and back: no reminder storm.

## 8. Network reality

*Automation can't: the fake server's offline mode is not a captive portal or a flaky LTE hop.*

- [ ] Turn Wi-Fi off, make ten edits, turn it on. All ten land, in order, once.
- [ ] Join a captive-portal network (a hotel/airport one, or a guest SSID) without logging in. The
      sync pill must say something honest, not "Synced".
- [ ] Sync while on battery vs. plugged in — the background poll backs off on battery.
- [ ] Edit the same task on your phone's Google Tasks and here within the same minute.
      **Known broken** — your phone's edit is silently overwritten
      (`docs/feature-matrix.md` F1). Confirm whether that has been fixed before shipping.

## 9. Gatekeeper on another Mac

*Automation can't: quarantine only applies to a file that actually arrived from the internet, and
the build machine never sees it.*

- [ ] Build the `.dmg`, upload it somewhere, download it **on a different Mac** (so the quarantine
      xattr is set).
- [ ] Double-click: you should get the "cannot be opened because the developer cannot be verified"
      dialog. That is expected for an unsigned build.
- [ ] Right-click → **Open** → Open works, and only needs doing once.
- [ ] `xattr -dr com.apple.quarantine /Applications/BoardTasks.app` also works, as README says.
- [ ] After that first open, the app launches normally from Spotlight and the Dock.
- [ ] `codesign -dv --verbose=4 /Applications/BoardTasks.app` shows the ad-hoc signature and the app
      still runs (an invalid signature breaks Keychain access, which breaks `safeStorage`).
- [ ] First launch on that Mac: the Keychain prompt appears once; approve it and confirm credentials
      persist across a relaunch. Then **deny** it on a third profile and confirm the app says so
      rather than storing anything in plaintext.

## 10. Feel

*Automation can't judge this at all.*

- [ ] Scroll a 1000-task list on a 120 Hz display — no dropped frames, no flicker at the
      virtualization boundary.
- [ ] Window resize is smooth; the sidebar/inspector collapse thresholds don't oscillate.
- [ ] Launch to first paint: no white flash in dark mode, no visible layout jump.
- [ ] Theme switch (System Settings ▸ Appearance) is a clean cross-fade in **both** the main window
      and the Quick Add HUD. **Known inconsistency:** switching theme from the palette animates
      differently from switching it in Settings (`docs/feature-matrix.md`, duplicate-theme-writers
      note).
