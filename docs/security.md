# Security model

BoardTasks holds a Google OAuth refresh token, a Google client secret and a
GitHub personal access token. Everything below exists to make those three
things hard to reach and boring to steal, and to make the renderer — the only
part of the app that ever touches untrusted content — as close to powerless as
a UI can be.

The shape of the design is one sentence: **the renderer is a view, main is the
computer.** No HTTP, no filesystem, no credentials, no `node` anywhere near the
DOM. Every capability the UI needs is a named, validated, size-bounded IPC
channel.

---

## 1. Process boundary

Both windows (`src/main/windows/main-window.ts`, `quick-add-window.ts`) are
created with:

| Setting | Value | Why |
| --- | --- | --- |
| `contextIsolation` | `true` | Preload and page share no JS realm. |
| `sandbox` | `true` | OS-level renderer sandbox; also `app.enableSandbox()` before `ready` (`src/main/index.ts`). |
| `nodeIntegration` / `InWorker` / `InSubFrames` | `false` | No `require`, in any frame or worker. |
| `webviewTag` | `false` | `<webview>` is a second, weaker window. |
| `webSecurity` | `true` | Same-origin policy stays on. |
| `allowRunningInsecureContent` | `false` | No mixed content. |
| `experimentalFeatures` | `false` | No unshipped web platform surface. |
| `devTools` | `!app.isPackaged` | A shipped build has no DevTools, so no console to paste an attack into. |

The preload script (`src/preload/index.ts`) exposes exactly three things on
`window.boardtasks` and nothing else:

- `invoke(channel, payload)` — rejects any channel not in the `CHANNELS`
  allowlist before `ipcRenderer` is touched at all.
- `onEvent(cb)` — subscribes to the one main→renderer event channel.
- `boot` — five primitive values (`window`, `theme`, `themePreference`,
  `platform`, `e2e`), read from `additionalArguments` so first paint needs no
  IPC round trip. `platform` is a **string copy** of `process.platform`; the
  `process` object itself never crosses the bridge.

Covered by `tests/unit/main/security/preload-bridge.test.ts`.

---

## 2. Content Security Policy

The renderer is served from a custom `app://boardtasks` scheme
(`src/main/security/protocols.ts`), not `file://`, so it has a real origin and
a real CSP. Two policies live in `src/main/security/csp.ts`, selected on
`app.isPackaged`, so the dev policy — the only one with `'unsafe-eval'` —
cannot ship.

Production policy:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: bt-asset:; font-src 'self' data:;
connect-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none';
child-src 'none'; worker-src 'self' blob:; manifest-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`connect-src 'self'` is the load-bearing line. CSP routes `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource` **and** `navigator.sendBeacon` through `connect-src`,
so there is no API by which renderer code can reach `googleapis.com`,
`github.com` or an attacker's host. The other exfiltration routes are closed
individually:

- `img-src` has no `https:` — a crafted task title cannot beacon out through an
  `<img src>`. Remote images (GitHub avatars) are **not** loaded by the
  renderer; `authorAvatarUrl` is stored but never rendered. If avatars are ever
  displayed, main must cache them and serve them from `bt-asset://` — adding
  `https://avatars.githubusercontent.com` to `img-src` is not an option.
- `frame-src`/`child-src`/`object-src` `'none'` — no iframe, no plugin.
- `form-action 'none'` — no form POST to a remote host.
- `base-uri 'none'` — no `<base>` hijack of relative script URLs.
- `window.open` to an external URL is denied by the window-open handler (§3),
  so `<a target=_blank>` cannot open an attacker's page in-app either.

The policy is stamped in `onHeadersReceived`, and **only on responses whose
origin is ours** — the handler never rewrites headers of a third-party
response. It is applied to every resource type, not just `mainFrame`: a
dedicated worker takes its CSP from its own response, so stamping documents
alone would leave `new Worker('/w.js')` unpoliced.

`X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`
and `Referrer-Policy: no-referrer` ride along on the same responses.

Covered by `tests/unit/main/security/csp.test.ts`.

---

## 3. Navigation and external URLs

`src/main/security/harden.ts` installs one `web-contents-created` handler that
applies to every `WebContents` the app will ever own:

- `will-navigate` — anything not at an internal origin is cancelled and offered
  to `openExternalChecked`.
- `will-frame-navigate` — same check for subframes, with no external fallback.
- `will-attach-webview` — always prevented.
- `setWindowOpenHandler` — always `{ action: 'deny' }`, with the URL offered to
  `openExternalChecked`.

`openExternalChecked(url)` is the **only** sanctioned path to
`shell.openExternal`. It requires `https:` and an exact host match against
`EXTERNAL_HOST_ALLOWLIST` in `src/shared/constants.ts`. Everything else —
`http:`, `file:`, `javascript:`, `x-apple.systempreferences:`, a lookalike like
`github.com.evil.example` — is refused, and the rejection logs scheme and host
only, never the query string.

There is exactly one deliberate exception, documented at its call site:
`notifications:openSystemSettings` opens
`x-apple.systempreferences:com.apple.Notifications-Settings.extension`. It is a
module constant with no user input in it, and macOS offers no API to read
notification permission, so it is the only way to help a user who denied it.

**Internal origins are narrower in a packaged build.** `internalOrigins()`
returns `['app://boardtasks']` when packaged and adds the Vite dev origin
(`http://127.0.0.1:5173`) only in development. Any local process can bind
port 5173; a packaged app that treated it as "ourselves" would let a renderer
navigate there and inherit the full privileged IPC surface.

The `boardtasks://` URL scheme is registered in `Info.plist`, so macOS will
foreground the app for such a link. `src/main/index.ts` handles `open-url`
explicitly and **discards the payload**: nothing in the app takes input from a
deep link, and an unhandled scheme that silently grows a handler later is how
deep-link injection bugs appear.

Covered by `tests/unit/main/security/harden.test.ts`.

---

## 4. IPC

`src/main/ipc/router.ts` wraps every channel in the same three steps, in order:

1. **Sender guard** (`sender-guard.ts`). Top frame only (`frame.parent === null`)
   at an internal origin. `URL.origin` is the string `'null'` for non-special
   schemes such as `app://`, so the origin is computed by hand via `originOf()`
   — comparing `URL.origin` would compare `'null'` to `'null'` and trust
   everything.
2. **Zod validation.** Every channel has a schema; ids match `ID_RE`
   (`/^[A-Za-z0-9_\-:.]{1,128}$/`), id arrays cap at 500, free text caps at the
   `LIMITS` constants, numbers are clamped (`app:setZoom` to ±5 then ±3,
   `window:resizeQuickAdd` twice over), and `settings:set` accepts only the
   declared keys — zod strips anything else, so the renderer cannot write an
   arbitrary settings row.
3. **Handler**, whose return value is always a plain, structured-cloneable
   object (rows, arrays, primitives) — no class instances, no functions.

Failures come back as a `Result` envelope, never a thrown error. `toIpcError`
(`ipc/errors.ts`) maps:

- `AppError` → its own code and user-facing message,
- a `SQLITE_*` code → `{ code: 'DB', message: 'A local database error occurred.' }`,
- anything else → `{ code: 'INTERNAL', message: 'Something went wrong…' }`.

**No stack trace, exception message or filesystem path from an unexpected error
reaches the renderer.** The detail is written to the (scrubbed) log and
correlated by an 8-character `traceId` that appears in both places.

Covered by `tests/unit/main/security/sender-guard.test.ts`.

---

## 5. OAuth

`src/main/auth/`. Authorization Code + **PKCE S256** in the **system browser**
— never a `BrowserWindow`. Google blocks embedded user agents, and an embedded
window can read the user's password, which is the exact trust violation OAuth
exists to prevent.

- **PKCE** (`pkce.ts`): 32 random bytes → base64url verifier, `S256` challenge.
  Google documents that an installed app's client secret is not confidential,
  so the code challenge is the real control: it is what stops another local
  process that races us to the loopback port from redeeming the code.
- **Loopback** (`loopback-server.ts`): binds `127.0.0.1` only, on an **ephemeral
  port** (a fixed port can be squatted). Only `/callback` is answered;
  everything else is a flat 404. Keep-alive sockets are `unref`'d and destroyed
  on close, the listener is closed in a `finally`, and a 5-minute timer caps how
  long a sign-in may sit unanswered.
- **State**: validated with a **constant-time compare before anything else** —
  including before the `error` branch, because Google echoes `state` on errors
  too. A callback without a matching state is not the request we started, and
  nothing in it is read.
- **Callback pages** (`callback-pages.ts`): fully self-contained — no script,
  no network, no external CSS. The one attacker-influenced value,
  `error_description`, is HTML-escaped before it is echoed. Responses carry
  `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so the code
  never rides an outbound `Referer`.
- **Token exchange** (`token-endpoint.ts`): `net.fetch` (Chromium's stack, so
  system proxies and enterprise CA roots work) to the constant `https://`
  Google endpoints.
- **Scope**: `https://www.googleapis.com/auth/tasks` only. No `openid`/`email`
  — the account stays anonymous to us rather than widening the consent screen
  for a settings-screen nicety.

Covered by `tests/unit/main/auth/*.test.ts`, including
`callback-escaping.test.ts` and `no-secret-leak.test.ts`.

---

## 6. Credential storage

`secure-store.ts` → Electron `safeStorage` (macOS Keychain). Ciphertext is
written with `atomicWrite` (temp → `fsync` → `rename`) at mode **0600**.

**There is no plaintext fallback.** If `safeStorage.isEncryptionAvailable()` is
false the value is held in memory for the session only, `isPersistent()` reports
false, and the UI surfaces the `keychain_unavailable` state — a working session
that will not survive a restart. A blob that exists but cannot be decrypted
(signing identity changed, Keychain reset) raises `decrypt_failed`, which
becomes `reauth_required`; the undecryptable file is left on disk rather than
destroyed, because deleting it would throw away a recoverable grant.

The refresh token, access token and client secret are held in one JSON blob in
one Keychain entry, and:

- they are **never** returned over IPC — `AuthStatus` carries a state, the last
  12 characters of the client **id**, an optional email and a timestamp;
- they are **never** emitted in a `MainEvent`;
- every one of them is passed to `registerSecret()` on read and on write, so
  the log scrubber redacts them by exact value as well as by shape.

`tests/unit/main/auth/no-secret-leak.test.ts` asserts this across every auth
route response, every emitted event and every file in the profile directory.

---

## 7. Log scrubbing

`src/main/logger.ts`. Every line — console and file — goes through `scrub()`
before it is written. Two layers:

1. **Exact values** registered with `registerSecret()` (client secret, access
   token, refresh token, GitHub PAT).
2. **Structural patterns**: `ya29.…`, `1//…`, `GOCSPX-…`, `ghp_/gho_/ghu_/ghs_/ghr_…`,
   `github_pat_…`, JWTs, `Bearer`/`Basic` headers, secrets in a URL query string
   (`?code=`, `&access_token=`, …), and `name: value` / `name=value` pairs for
   the usual key names.

Two deliberate calibrations: the query-string pattern stops at `&` so the rest
of a URL stays readable, and bare `code` is redacted **only** in a query string
— `code: 'ENOTFOUND'` is a diagnostic, not a secret, and redacting it would
blind the log.

This matters most for errors thrown by `net.fetch`, which echo the request URL
in their message and stack. The log directory is created 0700 and the log file
0600.

Covered by `tests/unit/main/security/logger-scrub.test.ts`.

---

## 8. GitHub

- The PAT lives in the same Keychain-backed store as the Google blob and is
  never logged; only the last 4 characters are ever shown (`tokenHint`).
- `createGithubApi` attaches the token in exactly one place, to `base` — a
  constant (`https://api.github.com`) or a development-only env override. It is
  **never** derived from a pasted URL or from a stored link's host, so a
  crafted `https://evil.example/owner/repo/issues/1` cannot make the token
  follow the hostname.
- Enterprise hosts widen only the **URL parser**, never the API base.
- `owner`/`repo`/`number` are regex-validated by `parseGithubUrl` before they
  reach the database, and `encodeURIComponent`'d again when they are
  interpolated into a request path.
- `buildSearchQuery` builds a query from tokenised input with explicit
  qualifier rules; the result is `encodeURIComponent`'d into the query string.

---

## 9. Test seams are inert in a packaged build

`BT_E2E`, `BT_GOOGLE_BASE_URL`, `BT_GITHUB_BASE_URL`, `BT_FAKE_AUTH`,
`BT_USER_DATA`, `BT_SKIP_ONBOARDING` each tell the app to trust something else:
a different token endpoint, a fabricated credential set, a different profile.
The threat is real and low-effort — "paste this into Terminal to fix syncing"
with `BT_GOOGLE_BASE_URL` pointing at an attacker would hand over a refresh
token on the next sign-in.

`src/main/env.ts` therefore honours them **only when `!app.isPackaged`**, and in
a packaged build does not merely ignore them: it `delete`s them from
`process.env` at module load, before any other module can read one directly.
`globalThis.__btTriggerQuickAdd` and the onboarding skip are gated on the same
flag.

Covered by `tests/unit/main/security/env-seams.test.ts`.

---

## 10. Packaging

- `asar: true`; only `better-sqlite3` is unpacked (a `.node` cannot be
  `dlopen`'d from inside an asar).
- `files` is an allowlist — `out/**` and `package.json`. Source, tests, docs,
  scripts and `.env` are outside it by construction, with explicit `!**/*.map`,
  `!**/*.ts`, `!**/.env*` negations as belt-and-braces. Sourcemaps are built but
  never shipped.
- `build/entitlements.mac.plist` carries four entitlements, each justified in a
  comment in the file, with the dangerous ones (`get-task-allow`,
  `disable-library-validation`, `allow-dyld-environment-variables`) explicitly
  listed as absent. The current build is unsigned and ad-hoc signed by
  `scripts/adhoc-sign.cjs` so it launches on Apple Silicon; enabling Developer
  ID signing is the documented four-line diff in `electron-builder.yml`.
- `npm audit` and `npm audit --omit=dev`: 0 vulnerabilities.

---

## Rules for future changes

1. New IPC channel ⇒ new zod schema that bounds every string, array and number.
   No `z.unknown()`, no `z.any()`.
2. Never call `shell.openExternal` directly. Use `openExternalChecked`. The one
   existing exception is documented at its call site.
3. Never put a token, a secret, or a raw error/stack into an IPC response or a
   `MainEvent`.
4. Adding a host to `EXTERNAL_HOST_ALLOWLIST` or a source to a CSP directive is
   a security change — say why in the commit.
5. A new secret ⇒ `registerSecret()` at every point it is read or written.
6. A new environment-variable seam ⇒ add it to `OVERRIDE_VARS` in
   `src/main/env.ts`, or it will be live in the shipped app.
