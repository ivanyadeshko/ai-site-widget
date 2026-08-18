// `defineConfig` берётся из `vitest/config`, а не из `vite`: в vite-версии поле
// `test` не типизировано вовсе и `vue-tsc` валит конфиг TS2769 (та же девиация
// уже задокументирована в embed/loader/vite.config.ts и embed/app/vite.config.ts).
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // base '/panel/' обязателен: SPA раздаётся с префикса /panel, и при base '/'
  // ссылки на чанки уехали бы в корень, где их перехватила бы СТАТИКА ВИДЖЕТА
  // (app.ts: fastifyStatic на embed/loader/dist и embed/app/dist/assets).
  base: '/panel/',
  build: {
    target: 'es2019',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: 'index.html' },
  },
  test: {
    environment: 'happy-dom',
  },
});
