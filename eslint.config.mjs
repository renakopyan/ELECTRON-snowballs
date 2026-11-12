import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'dist-test/**', 'release/**', 'bin/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Скрипты рендерера подключаются в index.html по очереди и делят глобальную область:
    // то, что не используется в одном файле, нужно соседнему. Неиспользуемое ловит tsc (noUnusedLocals).
    files: ['src/renderer/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  prettier,
];
