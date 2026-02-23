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
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Enforce tokenized design colors everywhere in app source.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message: 'Avoid raw hex colors in TS/TSX. Use tokens (e.g. var(--color-text-primary) or var(--token-color-...)).',
        },
        {
          selector: "Literal[value=/^(?:rgba?|hsla?)\\(/]",
          message: 'Avoid raw rgb/rgba/hsl/hsla colors in TS/TSX. Use tokens or color-mix with tokens.',
        },
      ],
    },
  },
])
