// eslint.config.js — flat config for the Expediate framework.
//
// Goals:
//  - Type-aware linting (catches real bugs: floating promises, misused
//    promises, unsafe template strings, etc.) on a program that includes both
//    src/ and tests/ (see tsconfig.eslint.json).
//  - Library-grade strictness on src/, pragmatically relaxed on tests/.
//  - `any`-related rules kept as WARNINGS, not errors: this framework wraps
//    Node's http/https internals where untyped casts are unavoidable. Warnings
//    keep them visible (and trackable) without breaking `npm run lint` / prepack.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 1. Never lint build output, deps, fixtures, coverage, or sub-workspaces.
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'benchmarks/**',
      'loadtest/**',
      'tests/fixtures/**',
      '**/*.js', // fixtures and stray JS — source is .ts only
      '**/*.cjs', // build scripts (scripts/build-cjs.cjs)
    ],
  },

  // 2. Base recommended + type-checked + stylistic rule sets.
  //    `recommendedTypeChecked` (not `strict`) is the right level for a
  //    defensive HTTP framework: it catches real bugs without the stylistic
  //    zealotry of strict rules like no-unnecessary-condition, which would
  //    flag the intentional runtime guards on untrusted request input.
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // 3. Wire up the type-aware parser to the lint program (src + tests).
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // 4. Project-wide rule tuning reflecting deliberate framework conventions.
  {
    files: ['**/*.ts'],
    rules: {
      // The http/https/socket boundary genuinely needs `any`. Keep visible as
      // warnings so the count is tracked and can be chipped away over time.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // The body parser deliberately rejects/throws plain `{ status, message }`
      // objects as its public error contract, not Error instances. Downgrade to
      // warnings rather than fighting an intentional API shape.
      '@typescript-eslint/only-throw-error': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',

      // Control characters in regex are intentional (static-path sanitisation,
      // the \x00 GLOBSTAR placeholder in compileGlob).
      'no-control-regex': 'off',

      // Allow numbers/booleans in template strings (status codes, ports, etc.).
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Permit intentionally-unused args/vars when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // 5. Tests do dirty things on purpose (raw socket pokes, malformed bodies,
  //    `as any` casts). Relax the noisy rules so the suite isn't a lint minefield.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // node:test callbacks and fire-and-forget HTTP requests legitimately
      // leave promises unawaited in tests; don't treat that as an error here.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Empty no-op callbacks (e.g. a `next` stub), `||` defaults, and throwaway
      // reassignments are idiomatic in test scaffolding — not worth flagging.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'no-useless-assignment': 'off',
    },
  },

  // 6. The config file itself isn't part of the TS program — disable type-aware
  //    rules for it to avoid "not found in project" parsing errors.
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
