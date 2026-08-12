import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/helpers/globalSetup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false, // одна тестовая БД на всех — файлы не топчут друг друга
  },
});
