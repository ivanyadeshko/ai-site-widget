// ДЕВИАЦИЯ от буквы брифа: `import { defineConfig } from 'vite'` не типизирует
// поле `test` вообще (`tsc` валит TS2769 — "test" не существует в UserConfig).
// Vitest САМ рекомендует для совмещённых build+test конфигов импортировать
// `defineConfig` из `vitest/config` — это тот же объект vite, но с `test`,
// домешанным через module augmentation.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `build` — дословно из брифа (Step 5).
  build: {
    target: 'es2019',
    minify: 'esbuild',
    lib: { entry: 'src/loader.ts', formats: ['iife'], name: 'AskiSiteWidget' },
    rollupOptions: { output: { entryFileNames: 'w.[hash].js', extend: true } },
    outDir: 'dist',
    emptyOutDir: true,
  },
  // ДЕВИАЦИЯ от буквы брифа (Step 5 даёт только `build`): без `test.environment`
  // `npx vitest run` из Step 3/4 не может дойти даже до RED — `document`,
  // `localStorage`, `MessageEvent` в loader.test.ts просто не существуют под
  // дефолтным node-окружением vitest.
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        settings: {
          // Юнит-тесты обязаны быть сетевым hermetic: без этого happy-dom
          // реально пытается ЗАГРУЗИТЬ src иконки/iframe по сети при клике на
          // кнопку (см. `ensureFrame()` в loader.ts) — в т.ч. по несуществующим
          // https://widget.aski.pro/app/tok из тестовых фикстур — и роняет
          // stderr-мусор с DOMException при отмене на teardown, а в CI без
          // сети рискует таймаутом вместо мгновенного прохождения теста.
          navigation: { disableChildFrameNavigation: true },
        },
      },
    },
  },
});
