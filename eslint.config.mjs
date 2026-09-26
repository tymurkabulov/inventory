import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'web/public/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    // Полный набор, включая правила React Compiler: чистота рендера, refs в
    // рендере, setState в эффектах. Код, который нарушает их, компилятор не
    // оптимизирует — а сборка идёт через него.
    extends: [reactHooks.configs.flat['recommended-latest']],
    rules: {
      // Пропущенная зависимость эффекта уже стоила нам затёртого ввода в степпере.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
