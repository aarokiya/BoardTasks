// electron-vite inlines ?raw imports, so migrations ship inside the bundle
// and never depend on locating .sql files at runtime inside an asar.
import init from './001_init.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [{ version: 1, name: 'init', sql: init }];
