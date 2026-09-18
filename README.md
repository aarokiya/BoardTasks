# BoardTasks

A premium Google Tasks desktop client for macOS. Offline-first sync, native reminders, a global quick-add with natural-language dates, a command palette, smart views (Today / Upcoming / Overdue), dark & light themes, menu-bar tray, and optional GitHub issue/PR linking.

Built with Electron 44, React 19, TypeScript 5.9, and SQLite (better-sqlite3). No cloud service of its own — your data goes to Google Tasks and a local encrypted store, nowhere else.

## Engineering highlights

- **Offline-first sync engine** over an API with no push, no search and no time-of-day: a transactional outbox, per-field three-way merge, exponential backoff with jitter that is honoured by a wake timer rather than the poll, and a pre-push pull so a remote edit is never overwritten blind.
- **Stable local identity.** Every row has a UUID primary key from the moment it is created, so the UI, undo and the outbox never wait for Google to hand back an id.
- **Civil dates, never `Date`.** Due dates are `YYYY-MM-DD` strings end to end; the unit suite also runs under `TZ=Pacific/Kiritimati` to prove it.
- **Hardened Electron.** Sandboxed renderer on a custom `app://` scheme with a CSP that cannot reach the network, zod-validated IPC with sender checks, OAuth PKCE with a loopback redirect, tokens encrypted with the macOS Keychain, structurally scrubbed logs. Threat model in [`docs/security.md`](docs/security.md).
- **Tested at every layer.** ~1300 vitest tests (node and jsdom), property-based convergence tests for the merge, and 41 Playwright specs that drive the built app against a faithful fake Google Tasks server with scripted outages, rate limits and clock skew, plus a smoke test that spawns the packaged `.app`.

## Requirements

- macOS 13+ on Apple Silicon (the packaged build targets arm64)
- A Google account
- For development: Node 22+ (Node 24 recommended), npm 11+

## First run: bring your own Google OAuth client

BoardTasks does not ship Google credentials. On first launch a setup wizard walks you through creating your own OAuth **Desktop app** client in Google Cloud (about ten minutes, free). The walkthrough is also in [`docs/google-cloud-setup.md`](docs/google-cloud-setup.md).

The short version:

1. Create a Google Cloud project.
2. Enable the **Google Tasks API**.
3. Configure the OAuth consent screen (External), add yourself as a test user, then set **Publishing status → In production**. This matters: while a project stays in _Testing_, Google expires refresh tokens after 7 days and you'd have to sign in weekly.
4. Create credentials → OAuth client ID → **Desktop app**. Copy the Client ID and Client secret into BoardTasks.

The client "secret" for a desktop app is not actually confidential (Google says so); the real protection is PKCE, which BoardTasks uses. Your credentials and refresh token are stored encrypted via the macOS Keychain (Electron `safeStorage`) — never in plaintext, never in this repo.

Sign-in happens in your system browser (never inside the app window). The first time you'll see an "unverified app" screen because it's your own unpublished project: click **Advanced → Go to BoardTasks**.

## Install the packaged app

Download or build `BoardTasks-<version>-arm64.dmg`, drag to Applications. The build is not notarized (no Apple Developer certificate), so on a Mac other than the one that built it Gatekeeper will complain once. Either right-click → **Open**, or:

```bash
xattr -dr com.apple.quarantine /Applications/BoardTasks.app
```

## Develop

```bash
npm install
npm run dev            # electron-vite dev server with HMR + main-process restart
npm run verify         # typecheck + eslint + stylelint + vitest with coverage
npm run test:unit      # fast pure tests (dates, parser, sync engine…)
npm run test:dom       # React component tests (jsdom + Testing Library)
npm run build          # production bundles into out/
npm run test:e2e       # Playwright drives the built app against a fake Google server
npm run package:dir    # unpacked .app into dist/ (what the packaged E2E test launches)
npm run package        # unsigned, ad-hoc-signed .dmg + .zip into dist/
```

`tests/e2e/06-features.spec.ts` is the completeness suite — one test per promised feature, scored in
[`docs/feature-matrix.md`](docs/feature-matrix.md). `tests/e2e/07-packaged.spec.ts` launches the
_packaged_ bundle and is opt-in:

```bash
npm run test:e2e:packaged
```

What no test can reach — real OAuth, notification banners, the menu bar, VoiceOver, Gatekeeper on
another Mac — is a checklist in [`docs/manual-qa.md`](docs/manual-qa.md).

Two pinned versions are load-bearing and must not be bumped casually: `vite` stays on 7.x (electron-vite 5 peers on it) and `typescript` on 5.x (typescript-eslint 8 peers on `<6.1`). The rest is annotated in `package.json`.

### Layout

```
src/main/       Electron main process: SQLite, sync engine, OAuth, notifications, tray, IPC routes
src/preload/    the contextBridge (typed invoke + one event channel; nothing else)
src/renderer/   React UI (CSS Modules + design tokens, zustand store)
src/shared/     types and pure helpers shared by all three (IPC contract, models, civil dates)
tests/          unit (vitest, node), dom (vitest, jsdom), e2e (Playwright + fake Google server)
```

### Security model

Full write-up with the threat model and the rules for future changes: [`docs/security.md`](docs/security.md).

- `contextIsolation`, `sandbox`, no `nodeIntegration`; the renderer is served from a custom `app://` scheme with a strict CSP (`connect-src 'self'` — the UI literally cannot reach the network; all HTTP happens in main).
- Every IPC payload is validated with zod in main; the sender's origin and frame are checked.
- OAuth uses Authorization Code + PKCE with a loopback redirect on `127.0.0.1` and a random port.
- Tokens are encrypted with `safeStorage`. If the Keychain is unavailable the app keeps them in memory for the session rather than falling back to plaintext.
- Logs pass through a scrubber that redacts token shapes structurally.

### Sync model

The local database is the source of truth for the UI. Every edit writes the row and an outbox entry in one transaction; the outbox is drained in order with backoff and jitter, and blocked entries (a child whose parent isn't on the server yet) wait without burning retries. Pulls use `updatedMin` with a safety skew and a watermark taken from the _server's_ `updated` timestamps, plus periodic full reconciles. Conflicts are merged per field: your in-progress edit wins, and the server wins for fields you haven't touched. Nothing is ever silently dropped on the _push_ side: a change that can't be pushed after repeated failures parks in "Unsynced changes" with Retry / Discard.

Google Tasks has no push API and no time-of-day on due dates, so sync is polled (60 s when focused, less often in the background) and reminder times are stored locally on this Mac.

## Known gaps

Verified against the built app; the per-feature audit is in [`docs/feature-matrix.md`](docs/feature-matrix.md) and what needs a human is in [`docs/manual-qa.md`](docs/manual-qa.md).

- **Never exercised against a real Google account.** OAuth, sync, conflicts and rate limits are proven against a faithful fake server (`tests/fixtures/fakeGoogle.ts`) and unit fakes that reproduce the API's quirks, but three real-API behaviours are undocumented — whether deleted-task tombstones flow with `updatedMin`, whether `updatedMin` is inclusive, and whether `If-Match`/412 is honoured. The engine is correct under every combination (idempotent merge + periodic full reconcile), and `npm run probe:api` settles them against a scratch account.
- **Translucent sidebar** takes effect on the next launch (Electron sets vibrancy when the window is created). The setting says so.
- **Date order (M/D/Y vs D/M/Y)** affects how Quick Add parses `9/25`; dates are always _displayed_ as "Sep 25".
- **Reminder times live on this Mac.** Google Tasks has no time-of-day, so `5pm` never reaches your phone.
- **No account email** is shown after sign-in: the app requests only the Tasks scope.
- **Unsigned build**: Gatekeeper needs a right-click → Open (or `xattr -dr com.apple.quarantine`) on a Mac other than the one that built it.

## Keyboard

`⌘K` command palette · `⌃⇧Space` global Quick Add · `⌘N` new task · `⌘1…7` views · `J/K` move · `Space` complete · `E` rename · `T` due today · `D` pick date · `⌘Z` undo · `⌘/` all shortcuts.

Quick Add understands things like `Ship release notes tomorrow 5pm #Work !1`.

## License

MIT
