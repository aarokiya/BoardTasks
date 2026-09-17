import { _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const userData = mkdtempSync(join(tmpdir(), 'bt-pkg-'));
const app = await electron.launch({ executablePath: 'dist/mac-arm64/BoardTasks.app/Contents/MacOS/BoardTasks', args: [], env: { ...process.env, BT_USER_DATA: userData } });
app.process().stderr?.on('data', (d) => process.stdout.write('[main:err] ' + d));
app.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d));
const win = await app.firstWindow();
win.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
console.log('url:', win.url());
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
try { await win.waitForSelector('#root h1', { timeout: 15000 }); } catch (e) { console.log('FAILED', e.message); console.log(await win.content()); await app.close(); process.exit(1); }
await win.waitForFunction(() => document.body.innerText.includes('packaged'), null, { timeout: 10000 });
console.log('packaged renderer text:', await win.textContent('#root'));
console.log('isPackaged:', await app.evaluate(({ app }) => app.isPackaged));
if (process.env.SHOT) await win.screenshot({ path: process.env.SHOT });
await app.close();
console.log('packaged smoke ok');
