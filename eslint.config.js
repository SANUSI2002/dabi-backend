import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: { 'no-console': 'off', 'no-unused-vars': ['error', { argsIgnorePattern: '^next$' }] },
  },
  { ignores: ['node_modules/**', 'coverage/**', 'src/generated/**'] },
];
