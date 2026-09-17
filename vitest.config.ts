import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@': resolve(__dirname, 'src/renderer/src'),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/main/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['tests/setup/dom.ts'],
          include: ['src/renderer/**/*.test.{ts,tsx}', 'tests/dom/**/*.test.{ts,tsx}'],
          css: { modules: { classNameStrategy: 'non-scoped' } },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/renderer/src/main.tsx', 'src/main/index.ts', 'src/**/*.test.{ts,tsx}'],
      thresholds: {
        statements: 60,
        branches: 55,
        'src/shared/date/civil.ts': { statements: 100, branches: 100 },
        'src/renderer/src/features/quickadd/parse/**': { statements: 95 },
        'src/renderer/src/features/palette/fuzzy.ts': { statements: 95 },
      },
    },
  },
});
