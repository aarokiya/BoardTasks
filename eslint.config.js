// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

const MAIN_ONLY_IMPORTS = {
  patterns: [
    {
      group: ['electron', 'node:*', 'fs', 'path', 'os', 'child_process', 'http', 'https', 'crypto', 'better-sqlite3', '**/main/**'],
      message: 'Main-process / Node code must never be imported from shared/ or renderer/.',
    },
  ],
};

module.exports = tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'scripts/**', 'src/renderer/public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] }, tsconfigRootDir: __dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['eslint.config.js', '*.config.ts', '*.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['src/shared/**/*.ts', 'src/renderer/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', MAIN_ONLY_IMPORTS] },
  },
  {
    // Civil dates: never construct a Date from a due string, never toISOString a local Date.
    // The three sanctioned helpers live in civil.ts and are allowlisted there.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/shared/date/civil.ts', 'src/shared/date/format.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toLocaleDateString']",
          message: 'Use formatters in src/shared/date/format.ts — toLocaleDateString on a Date built from a Google due string is off by one day.',
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/setup/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.{js,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/main/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
