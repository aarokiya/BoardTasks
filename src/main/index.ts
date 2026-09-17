import { app, dialog } from 'electron';
import { registerSchemes } from './security/protocols';
import { bootstrap } from './bootstrap';
import { userDataOverride } from './env';
import { showMainWindow } from './windows/main-window';

// The lock is keyed on the userData path, so an explicit profile has to be set
// before it is requested — otherwise two profiles fight over one lock and the
// second process exits silently (which is exactly what E2E does).
if (userDataOverride) app.setPath('userData', userDataOverride);

// Single-instance lock FIRST — before the database is ever opened.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.enableSandbox();
  registerSchemes();
  app.setAppUserModelId('app.boardtasks.desktop');

  app.on('second-instance', () => {
    showMainWindow();
  });

  // Info.plist registers the `boardtasks://` scheme, so macOS will launch or
  // foreground the app for any such URL — including one embedded in a web page.
  // Handle it explicitly and throw the payload away: nothing in the app takes
  // input from a deep link, and an unhandled scheme that silently grows a
  // handler later is exactly how deep-link injection bugs appear.
  app.on('open-url', (e) => {
    e.preventDefault();
    showMainWindow();
  });

  void app.whenReady().then(() => {
    try {
      bootstrap();
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e);
      dialog.showErrorBox('BoardTasks could not start', msg);
      app.exit(1);
    }
  });
}
