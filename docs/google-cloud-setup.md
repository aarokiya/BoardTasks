# Connecting BoardTasks to your Google account

BoardTasks does not ship Google credentials. There are none in this repository and none in the
packaged app. Instead you create a Google Cloud project that belongs to you, and BoardTasks uses it
to talk to your own Google Tasks data.

This takes about five minutes. The in-app wizard walks the same path (`src/shared/setup-steps.ts`
is the shared source of both), so you can follow either.

> **The one step people skip:** step 4, "Publish app". Skipping it means BoardTasks will demand a
> fresh sign-in **every 7 days**, forever. See [The 7-day trap](#the-7-day-trap).

---

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/projectcreate>.
2. Give it a name — `BoardTasks` is fine — and click **Create**.
3. Wait for the notification, then make sure the project picker at the top of the page shows your
   new project. Everything below applies to the *selected* project.

## 2. Enable the Google Tasks API

1. Open <https://console.cloud.google.com/apis/library/tasks.googleapis.com>.
2. Click **Enable**.

If you skip this, sign-in will appear to succeed and then every sync will fail with
*"Tasks API has not been used in project … before or it is disabled."*

## 3. Configure the OAuth consent screen

1. Open <https://console.cloud.google.com/apis/credentials/consent>.
2. Choose User type **External**, then **Create**.
   *Internal* is only offered to Google Workspace organisations. External is correct for a personal
   Gmail account, and it does not mean anybody else can use your project.
3. Fill in:
   - **App name** — whatever you want to see on the consent screen, e.g. `BoardTasks`.
   - **User support email** — your own address.
   - **Developer contact information** — your own address again.
4. **Scopes** — click **Save and continue**. You do not need to add anything here. BoardTasks asks
   for `https://www.googleapis.com/auth/tasks` at sign-in time.
5. **Test users** — click **Add users** and add your own Google address. Then **Save and continue**.

## 4. Set publishing status to "In production"

Back on the OAuth consent screen overview, find **Publishing status** and click **Publish app**,
then confirm.

### The 7-day trap

While an **External** consent screen sits in **Testing**, Google expires every refresh token after
**seven days**. A refresh token is what lets BoardTasks sync in the background without asking you
for anything. When it expires, sync stops and the app asks you to sign in again — and it will do
that every single week, forever. It looks exactly like a bug in BoardTasks. It is not; it is the
publishing status.

BoardTasks detects this: if a sign-in dies between six and eight days after it was granted, the app
says so explicitly and points you back here rather than just saying "please sign in again".

**Publishing does not require verification.** Verification is what Google asks for when you want
*other people* to see a trusted consent screen. You are the only user of your own project, so you
can leave it unverified indefinitely. The consequence is the warning screen in step 6 — and nothing
else.

## 5. Create an OAuth client ID

1. Open <https://console.cloud.google.com/apis/credentials>.
2. **Create credentials** → **OAuth client ID**.
3. Application type: **Desktop app**. ← this matters.
4. Name it anything and click **Create**.
5. Google shows the **Client ID** and **Client secret**. Copy both. (You can reopen the client from
   the Credentials page later to copy them again — nothing is shown only once.)

**Why "Desktop app" specifically:** BoardTasks receives the authorization code on a loopback
address (`http://127.0.0.1:<random port>/callback`). Only the Desktop app client type permits
loopback redirects. A *Web application* client will reject it and sign-in fails with
`redirect_uri_mismatch`.

## 6. Paste them into BoardTasks and sign in

Paste the client ID and client secret into BoardTasks' setup screen and click **Sign in**.

Your normal browser opens — never a window inside the app. That is deliberate: Google blocks
embedded browsers outright, and an app-controlled login window could read your Google password,
which is the exact trust violation OAuth exists to prevent.

You will see:

> **Google hasn't verified this app**

This is expected, because you chose not to submit your own project for verification. Click
**Advanced**, then **Go to *your app name* (unsafe)**, then **Continue**. Grant the Google Tasks
permission, and the browser will tell you that you can close the tab.

---

## Why does it ask for a client secret?

For installed applications, the "client secret" **is not secret**. Google documents this: it is
shipped inside every desktop and mobile app that uses it, anyone can extract it from the binary,
and Google treats it as an identifier rather than a credential.

The real security control is **PKCE** (RFC 7636). For every sign-in, BoardTasks generates 32 bytes
of random data (the *code verifier*), sends only its SHA-256 hash to Google, and must present the
original verifier to redeem the authorization code. Another process on your machine that managed to
intercept the code could not exchange it — it does not have the verifier.

BoardTasks also binds its loopback listener to a **random** port rather than a fixed one, so no
other process can be sitting on the port waiting to catch the redirect.

Your client ID, client secret and tokens are stored as a single encrypted blob via the macOS
Keychain (Electron `safeStorage`), written atomically with mode `0600` to
`~/Library/Application Support/BoardTasks/google-credentials.enc`. If the Keychain is unavailable,
BoardTasks **never** falls back to plaintext: it keeps them in memory for the session, shows a
banner, and you will have to sign in again next launch.

## What BoardTasks can and cannot see

BoardTasks requests exactly one scope: `https://www.googleapis.com/auth/tasks`. That is read/write
access to your Google Tasks, and nothing else — no mail, no calendar, no files, and **not your
identity**. That last one is why the app never displays your email address next to "Signed in":
showing it would mean also requesting `openid email`, which widens the consent screen for a
cosmetic gain.

## Signing out

- **Sign out** revokes the token with Google, deletes the tokens locally, and keeps your client ID
  and secret so signing back in is one click. Your local tasks stay.
- **Sign out and delete local data** does all of the above and empties the local database — tasks,
  lists, the outbox, sync state, GitHub links and trash. Your app preferences (theme, shortcuts)
  are kept. This does not delete anything from Google.
- **Remove credentials** additionally forgets the client ID and secret.

## Troubleshooting

| What you see | What it means |
|---|---|
| `redirect_uri_mismatch` | The OAuth client is a *Web application*, not a *Desktop app*. Create a new Desktop app client (step 5). |
| `invalid_client` | The client ID or secret was mistyped or belongs to a deleted client. Re-copy both. |
| "Tasks API has not been used in project…" | Step 2 was skipped. Enable the Google Tasks API. |
| `access_denied` on the consent screen | Your Google account is not on the Test users list, or you clicked Cancel. If the app is published (step 4), the test-user list no longer applies. |
| BoardTasks asks you to sign in about once a week | The consent screen is still in **Testing**. Do step 4. |
| "Your saved Google credentials could not be unlocked" | The Keychain entry cannot be decrypted — usually after restoring a machine from backup or after the app's signature changed. Re-enter the client ID and secret and sign in again. |
| Sign-in never completes; the browser tab spins | BoardTasks gives up after 5 minutes. Check that no VPN or proxy is intercepting `127.0.0.1`. |

## Revoking access from Google's side

Visit <https://myaccount.google.com/permissions>, find your app, and remove it. BoardTasks will
notice on the next sync and ask you to sign in again. Your local data is untouched, and anything in
the outbox that has not reached Google yet survives the re-authentication.
