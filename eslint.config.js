import js from '@eslint/js'
import { plugin as shadcn } from '@shadcn/lint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'storybook-static', '.storybook/public']),
  {
    files: ['**/*.{ts,tsx,mts}'],
    plugins: { shadcn },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: { 'shadcn/no-raw-colors': 'error' },
  },
  {
    files: ['app/**/{page,layout}.{ts,tsx}'],
    extends: [reactRefresh.configs.next],
  },
  {
    files: ['**/*.stories.{ts,tsx}', '.storybook/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['scripts/check-storybook-coverage.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
])
