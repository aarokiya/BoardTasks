/**
 * Opt-in: smoke-tests the *packaged* .app bundle.
 *
 * This is the only test that can catch a packaging regression — a renderer path
 * resolved from the project root, an asset missing from the asar, a preload
 * that is not where `paths.ts` thinks it is, a tray icon left out of
 * `extraResources`, a native module that did not survive `asarUnpack`.
 *
 * It deliberately does **not** drive the bundle with Playwright's Electron
 * driver. `scripts/adhoc-sign.cjs` re-signs the app with
 * `codesign --force --deep --sign -`, and attaching a Node loader plus an
 * inspector to the re-signed binary is unreliable: `electron.launch()` sits
 * waiting for a CDP endpoint that never arrives (observed here as a 180 s
 * timeout on a bundle that launches instantly by hand). Testing a
 * differently-signed build than the one we ship would defeat the purpose, so
 * this spawns the real binary and reads back what it logs and what it writes to
 * its profile — which is where every packaging failure surfaces anyway.
 *
 *   npm run test:e2e:packaged
 *
 * or by hand:
 *
 *   npm run package:dir
 *   BT_PACKAGED=1 npx playwright test tests/e2e/07-packaged.spec.ts
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_BINARY = join(process.cwd(), 'dist/mac-arm64/BoardTasks.app/Contents/MacOS/BoardTasks');
const READY = /\[platform] platform integration ready/;

/**
 * Runs the packaged app against `userData` until `until` matches its combined
 * output (or the deadline passes), then terminates it and returns what it said.
 *
 * `--user-data-dir` is Chromium's own switch, honoured before any BoardTasks
 * code runs. That matters twice: a packaged build is production, so
 * `src/main/env.ts` deletes every `BT_*` variable at module load and
 * `BT_USER_DATA` would be ignored — and it keeps the developer's real
 * `~/Library/Application Support/BoardTasks` profile out of the test.
 */
async function runPackaged(userData: string, until: RegExp, timeoutMs = 90_000): Promise<string> {
  // `detached` puts the app in its own process group so the helper/GPU/renderer
  // children go down with it. Without this, every run leaves a handful of
  // Electron helpers alive and the next launch gets slower and slower.
  const child = spawn(APP_BINARY, [`--user-data-dir=${userData}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';

  await new Promise<void>((resolve) => {
    const onChunk = (d: Buffer): void => {
      output += d.toString();
      if (until.test(output)) resolve();
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
    setTimeout(resolve, timeoutMs).unref();
  });

  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  };
  killGroup('SIGTERM');
  await new Promise<void>((r) => setTimeout(r, 1000));
  if (child.exitCode === null) killGroup('SIGKILL');
  await new Promise<void>((r) => setTimeout(r, 500));
  return output;
}

test.describe('packaged build', () => {
  test.skip(process.env['BT_PACKAGED'] !== '1', 'set BT_PACKAGED=1 after `npm run package:dir`');
  test.slow();

  test('the packaged binary launches, opens its database and reaches platform-ready', async () => {
    expect(existsSync(APP_BINARY), `${APP_BINARY} not found — run \`npm run package:dir\` first`).toBe(true);

    const userData = mkdtempSync(join(tmpdir(), 'bt-pkg-'));
    try {
      const output = await runPackaged(userData, READY);

      // --- It really is the packaged bundle, and paths.ts resolved inside it ---
      expect(output, 'the boot line must appear').toMatch(/\[boot] BoardTasks \d+\.\d+\.\d+ electron=\d+/);
      expect(output, '__APP_VERSION__ and app.isPackaged must both be right').toMatch(/packaged=true/);

      // --- better-sqlite3 survived asarUnpack and the schema applied ---
      expect(output, 'the database must open and migrate').toMatch(/\[db:migrate]/);
      expect(existsSync(join(userData, 'boardtasks.db')), 'the profile must contain the database').toBe(true);

      // --- extraResources: the tray template icon is found via resourcesDir() ---
      expect(output, 'the tray must be created').toMatch(/\[tray] tray created/);
      expect(output, 'the tray icon must ship in Contents/Resources').not.toMatch(/tray icon missing/);

      // --- The whole native layer came up ---
      expect(output).toMatch(READY);
      expect(output).toMatch(/\[reminders] notification scheduler started/);

      // --- The two failures a bad renderer path produces ---
      expect(output, 'the app:// handler must serve the renderer').not.toMatch(/app:\/\/ handler failed/);
      expect(output, 'the renderer bundle must load').not.toMatch(/renderer failed to load/);

      // --- And nothing blew up on the way ---
      expect(output).not.toMatch(/BoardTasks could not start/);
      expect(output).not.toMatch(/Preload bridge missing/);

      // --- The log file is where app.revealLogs will look for it ---
      const logPath = join(userData, 'logs', 'main.log');
      expect(existsSync(logPath), 'logs/main.log must exist in the profile').toBe(true);
      expect(readFileSync(logPath, 'utf8')).toMatch(/\[boot]/);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('a second launch reuses the profile instead of re-migrating', async () => {
    // Catches a userData path that moves between runs — the packaged equivalent
    // of "all my tasks disappeared after an update".
    const userData = mkdtempSync(join(tmpdir(), 'bt-pkg-'));
    try {
      const first = await runPackaged(userData, READY);
      expect(first, 'the first run creates the schema').toMatch(/applying migration 1/);

      const second = await runPackaged(userData, READY);
      expect(second).toMatch(READY);
      expect(second, 'migrations must not re-run on an existing profile').not.toMatch(/applying migration 1/);
      expect(second, 'the database must not be treated as damaged').not.toMatch(/damaged|recreated/);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
