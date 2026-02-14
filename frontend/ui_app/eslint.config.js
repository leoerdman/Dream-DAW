import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
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
    rules: {
      // UI tokens v2 migration guardrail:
      // discourage raw colors in component code; use semantic CSS variables instead.
      'no-restricted-syntax': [
        'warn',
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/]",
          message: 'Avoid raw hex colors in TS/TSX. Use semantic tokens (e.g. var(--surface-2), var(--accent)).',
        },
        {
          selector: "Literal[value=/^rgba?\\(/]",
          message: 'Avoid raw rgb/rgba colors in TS/TSX. Use semantic tokens or color-mix with tokens.',
        },
      ],
    },
  },
])
