/* eslint-env node */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  settings: {
    react: { version: '18.2' },
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    'dist-tsc',
    'build',
    'coverage',
    '*.config.ts',
    '*.config.js',
    '*.config.cjs',
    'vite.config.ts',
    'vitest.config.ts',
    // Deno-side edge functions have their own toolchain (deno check +
    // deno test); no Node/ESLint here.
    'supabase/functions',
  ],
  rules: {
    // Fase 1 pragmatics — kept intentionally light.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
    'react/prop-types': 'off',
    'react/no-unknown-property': ['error', { ignore: ['data-design4-root', 'data-doc-id', 'data-node-id', 'data-node-type'] }],
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};
