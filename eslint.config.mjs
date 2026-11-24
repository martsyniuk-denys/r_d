import tseslint from 'typescript-eslint';

// Step 1 of the gates, the half that tsc does not cover: style and the bug-shaped
// patterns a type checker accepts. A short list on purpose — every rule here is one
// the code already keeps, so a red lint is a new defect, not old debt.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'infra/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'test/gates/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-self-compare': 'error',
      'no-unsafe-finally': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
    },
  },
);
