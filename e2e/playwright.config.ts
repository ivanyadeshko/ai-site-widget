import { defineConfig, devices } from '@playwright/test';

/**
 * ⚠️ Проект `panel` — герметичный гейт CI (Task 25): работает против стека
 * compose.e2e.yaml с fake-core, секретов не требует, зелёный и на форк-PR
 * (Constraint 3в). Проекты `acceptance` и `voice` (Task 26) ходят в ЖИВОЕ ядро
 * и в CI-гейт НЕ входят (D-14) — их поднимает человек локально/на деве.
 */
const PANEL_BASE = process.env.E2E_PANEL_BASE_URL ?? 'http://localhost:8200';

export default defineConfig({
  testDir: './tests',
  // Сценарии несут состояние по шагам (регистрация → виджет → диалог → лид):
  // параллелить их внутри файла нельзя, между файлами — незачем.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'panel',
      testMatch: /panel\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: PANEL_BASE },
    },
  ],
});
