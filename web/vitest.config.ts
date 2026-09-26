import { defineConfig } from 'vitest/config';
import { reactPlugins } from './vite.config';

export default defineConfig({
  // Тот же React Compiler, что и в сборке: тесты проверяют код, который уходит в бой.
  plugins: reactPlugins(),
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
  },
});
