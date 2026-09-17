import { app } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Build-output paths resolved from the app root, NOT from __dirname
 * (Rollup chunks live in out/main/chunks/) and NOT naively from
 * app.getAppPath() (which is out/main when launched as `electron out/main/index.js`
 * but the project root / app.asar when launched as `electron .` or packaged).
 */
let cachedRoot: string | null = null;

export function appRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = app.getAppPath();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'out', 'preload', 'index.js'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = app.getAppPath();
  return cachedRoot;
}

export const outDir = (): string => join(appRoot(), 'out');
export const preloadPath = (): string => join(outDir(), 'preload', 'index.js');
export const rendererDir = (): string => join(outDir(), 'renderer');
export const resourcesDir = (): string => (app.isPackaged ? process.resourcesPath : join(appRoot(), 'build'));
