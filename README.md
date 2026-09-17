# BoardTasks

A premium Google Tasks desktop client for macOS. Offline-first sync, native reminders, a global quick-add with natural-language dates, a command palette, smart views (Today / Upcoming / Overdue), dark & light themes, menu-bar tray, and optional GitHub issue/PR linking.

Built with Electron 44, React 19, TypeScript 5.9, and SQLite (better-sqlite3). No cloud service of its own — your data goes to Google Tasks and a local encrypted store, nowhere else.

## Requirements

- macOS 13+ on Apple Silicon (the packaged build targets arm64)
- A Google account
- For development: Node 22+ (Node 24 recommended), npm 11+

## First run: bring your own Google OAuth client

BoardTasks does not ship Google credentials. On first launch a setup wizard walks you through creating your own OAuth **Desktop app** client in Google Cloud (about ten minutes, free). The walkthrough is also in [`docs/google-cloud-setup.md`](docs/google-cloud-setup.md).

The short version:

1. Create a Google Cloud project.
2. Enable the **Google Tasks API**.
3. Configure the OAuth consent screen (External), add yourself as a test user, then set **Publishing status → In production**. This matters: while a project stays in *Testing*, Google expires refresh tokens after 7 days and you'd have to sign in weekly.
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
npm run package        # unsigned, ad-hoc-signed .dmg + .zip into dist/
```

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

- `contextIsolation`, `sandbox`, no `nodeIntegration`; the renderer is served from a custom `app://` scheme with a strict CSP (`connect-src 'self'` — the UI literally cannot reach the network; all HTTP happens in main).
- Every IPC payload is validated with zod in main; the sender's origin and frame are checked.
- OAuth uses Authorization Code + PKCE with a loopback redirect on `127.0.0.1` and a random port.
- Tokens are encrypted with `safeStorage`. If the Keychain is unavailable the app keeps them in memory for the session rather than falling back to plaintext.
- Logs pass through a scrubber that redacts token shapes structurally.

### Sync model

The local database is the source of truth for the UI. Every edit writes the row and an outbox entry in one transaction; the outbox is drained in order with backoff and jitter, and blocked entries (a child whose parent isn't on the server yet) wait without burning retries. Pulls use `updatedMin` with a safety skew and a watermark taken from the *server's* `updated` timestamps, plus periodic full reconciles. Conflicts are merged per field (your in-progress edit wins; the server wins for fields you haven't touched; both-changed is surfaced for you to resolve). Nothing is ever silently dropped: a change that can't be pushed after repeated failures parks in "Unsynced changes" with Retry / Discard.

Google Tasks has no push API and no time-of-day on due dates, so sync is polled (60 s when focused, less often in the background) and reminder times are stored locally on this Mac.

## Keyboard

`⌘K` command palette · `⌃⇧Space` global Quick Add · `⌘N` new task · `⌘1…7` views · `J/K` move · `Space` complete · `E` rename · `T` due today · `D` pick date · `⌘Z` undo · `⌘/` all shortcuts.

Quick Add understands things like `Ship release notes tomorrow 5pm #Work !1`.

## License

MIT
