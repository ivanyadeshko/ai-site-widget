// ДЕВИАЦИЯ от буквы брифа (Step 4): бриф диктует `base: '/assets/'`, но это
// не стыкуется со СТАТИКОЙ, поднятой ещё в T5 (apps.ts бэкенда):
//   fastifyStatic({ root: 'embed/app/dist/assets', prefix: '/assets/' })
// то есть URL `/assets/<file>` физически отдаётся из `dist/assets/<file>`.
// Vite строит ссылку на чанк как `base + assetsDir + '/' + file`. При
// `base:'/assets/'` и дефолтном `assetsDir:'assets'` в HTML попадёт
// `/assets/assets/<file>`, а бэкенд отдаст его из `dist/assets/assets/<file>` —
// файла нет, 404. Единственная раскладка, сходящаяся с УЖЕ смерженным T5:
// `base:'/'` (+ дефолтный assetsDir) → ссылка `/assets/<file>` ↔ физический
// `dist/assets/<file>`. Проверено сборкой (см. task-6-report).
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    target: 'es2019',
    outDir: 'dist',
    emptyOutDir: true,
    // index.html — единственный вход; appPage бэкенда отдаёт именно его.
    rollupOptions: { input: 'index.html' },
  },
  test: {
    environment: 'happy-dom',
  },
});
