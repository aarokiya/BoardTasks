/**
 * The Google Cloud walkthrough, as data, so the onboarding wizard in the
 * renderer and docs/google-cloud-setup.md never drift apart.
 *
 * Pure data: no imports, importable from main, preload and renderer alike.
 * Keep `body` plain text — the wizard renders it as paragraphs, not HTML.
 */

export interface SetupStep {
  title: string;
  body: string;
  /** Opened with the external-link guard; every host here is on EXTERNAL_HOST_ALLOWLIST. */
  url?: string;
}

export const SETUP_STEPS: readonly SetupStep[] = [
  {
    title: 'Create a Google Cloud project',
    body:
      'BoardTasks does not ship its own Google credentials, so you create a project that is yours. ' +
      'Open the Google Cloud console, click the project picker at the top, then "New project". ' +
      'Name it anything — "BoardTasks" is fine — and create it. Make sure the picker shows your new project before continuing.',
    url: 'https://console.cloud.google.com/projectcreate',
  },
  {
    title: 'Enable the Google Tasks API',
    body:
      'With your project selected, open the Google Tasks API page and click "Enable". ' +
      'Without this, sign-in will succeed and then every request will fail with "Tasks API has not been used in project…".',
    url: 'https://console.cloud.google.com/apis/library/tasks.googleapis.com',
  },
  {
    title: 'Configure the OAuth consent screen',
    body:
      'Open "OAuth consent screen" (under APIs & Services) and choose User type "External" — "Internal" is only available to Google Workspace organisations. ' +
      'Fill in an app name and your own email for the user support and developer contact fields. ' +
      'On the Scopes step you do not need to add anything: BoardTasks requests the Google Tasks scope at sign-in. ' +
      'On the Test users step, add your own Google address.',
    url: 'https://console.cloud.google.com/apis/credentials/consent',
  },
  {
    title: 'Set publishing status to "In production"',
    body:
      'This step is the one that bites people. While an External consent screen sits in "Testing", Google expires every refresh token after 7 days — ' +
      'BoardTasks would demand a fresh sign-in every week, forever, and it would look like a bug in BoardTasks. ' +
      'Go back to the OAuth consent screen overview and click "Publish app", then confirm. ' +
      'You do NOT need verification: verification is only required to show other people a trusted consent screen, and you are the only user of your own project.',
    url: 'https://console.cloud.google.com/apis/credentials/consent',
  },
  {
    title: 'Create an OAuth client ID — type "Desktop app"',
    body:
      'Open Credentials, click "Create credentials" → "OAuth client ID", and pick application type "Desktop app". ' +
      'The type matters: a "Web application" client rejects the loopback redirect BoardTasks uses and sign-in will fail with redirect_uri_mismatch. ' +
      'Name it anything and click Create.',
    url: 'https://console.cloud.google.com/apis/credentials/oauthclient',
  },
  {
    title: 'Copy the client ID and client secret into BoardTasks',
    body:
      'Google shows both values once the client is created; you can also reopen the client later to copy them again. ' +
      'Paste them into the fields here. They are encrypted with your macOS Keychain (Electron safeStorage) and never leave this machine except to talk to Google.',
  },
  {
    title: 'Sign in',
    body:
      'BoardTasks opens your normal browser — never an embedded window, which is both blocked by Google and the exact trust violation OAuth exists to prevent. ' +
      'You will see an "unverified app" warning; that is expected for your own unpublished-to-the-world project. ' +
      'Click "Advanced", then "Go to <your app name> (unsafe)", then Continue. ' +
      'Grant the Google Tasks permission and the browser will tell you that you can close the tab.',
  },
];

/** Why the wizard asks for something called a secret. Shown inline under the secret field. */
export const CLIENT_SECRET_EXPLAINER = {
  title: 'Why does it ask for a client secret?',
  body:
    'For installed applications the "client secret" is not actually secret — Google documents this. ' +
    'It ships inside every desktop and mobile app that uses it, so anyone can extract it, and Google treats it as an identifier rather than a credential. ' +
    'The real protection is PKCE: BoardTasks generates a random code verifier per sign-in, sends only its SHA-256 hash to Google, ' +
    'and must present the original verifier to redeem the authorization code. Another process on your machine that intercepted the code could not use it. ' +
    'Your secret is stored encrypted in the macOS Keychain and is only ever sent to Google over HTTPS.',
} as const;
