import { _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const userData = mkdtempSync(join(tmpdir(), 'bt-smoke-'));
const app = await electron.launch({ args: ['out/main/index.js'], env: { ...process.env, BT_E2E: '1', BT_USER_DATA: userData } });
app.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d));
app.process().stderr?.on('data', (d) => process.stdout.write('[main:err] ' + d));
const win = await app.firstWindow();
win.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
console.log('url:', win.url());
try {
  await win.waitForSelector('#root h1', { timeout: 10000 });
  await win.waitForFunction(() => document.body.innerText.includes('Electron'), null, { timeout: 10000 });
  console.log('renderer text:', await win.textContent('#root'));
  console.log('theme attr:', await win.evaluate(() => document.documentElement.dataset.theme));
  console.log('bridge:', await win.evaluate(() => typeof window.boardtasks));
  console.log('csp:', await win.evaluate(() => fetch('https://tasks.googleapis.com/').then(() => 'ALLOWED').catch((e) => 'blocked: ' + e.message)));
  if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });
  console.log('smoke ok');
} catch (e) {
  console.log('FAILED', e.message);
  console.log('html:', (await win.content()).slice(0, 800));
}
try { console.log(readFileSync(join(userData, 'logs', 'main.log'), 'utf8')); } catch {}
await app.close();
