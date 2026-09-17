import { app, dialog } from 'electron';
import { registerSchemes } from './security/protocols';
import { bootstrap } from './bootstrap';
import { showMainWindow } from './windows/main-window';

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
