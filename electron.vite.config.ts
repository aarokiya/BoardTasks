import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      target: 'node22',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        external: ['better-sqlite3', 'electron'],
      },
    },
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      target: 'node22',
      sourcemap: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        // sandbox: true requires a single CJS script.
        output: { format: 'cjs', entryFileNames: 'index.js', inlineDynamicImports: true },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { ...sharedAlias, '@': resolve(__dirname, 'src/renderer/src') } },
    server: { port: 5173, strictPort: true, host: '127.0.0.1' },
    build: {
      target: 'chrome150',
      sourcemap: true,
      minify: 'esbuild',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
