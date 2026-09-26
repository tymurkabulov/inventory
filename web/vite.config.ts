import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// React Compiler сам мемоизирует компоненты и хуки: ручные useMemo/useCallback
// ради производительности не нужны. Правила, без которых он не работает,
// проверяет eslint (react-hooks, recommended-latest).
export const reactPlugins = () => [react(), babel({ presets: [reactCompilerPreset()] })];

export default defineConfig({
  plugins: [...reactPlugins(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
