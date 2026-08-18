import { defineConfig, devices } from '@playwright/test';

/**
 * ⚠️ Проект `panel` — герметичный гейт CI (Task 25): работает против стека
 * compose.e2e.yaml с fake-core, секретов не требует, зелёный и на форк-PR
 * (Constraint 3в). Проекты `acceptance` и `voice` (Task 26) ходят в ЖИВОЕ ядро
 * и в CI-гейт НЕ входят (D-14) — их поднимает человек локально/на деве.
 */
const PANEL_BASE = process.env.E2E_PANEL_BASE_URL ?? 'http://localhost:8200';
// acceptance/voice ходят в ЖИВОЕ ядро — стенд задаётся снаружи через E2E_BASE_URL.
const ACCEPTANCE_BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8200';

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
    // ↓↓↓ ЖИВОЕ ЯДРО, НЕ в CI-гейте (D-14). Запускать явно:
    //   E2E_BASE_URL=http://localhost:8200 npx playwright test --project=acceptance
    {
      name: 'acceptance',
      testMatch: /acceptance\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: ACCEPTANCE_BASE },
    },
    {
      name: 'voice',
      testMatch: /voice\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: ACCEPTANCE_BASE,
        // Микрофон — из fake-устройства Chromium: реального звука нет, но
        // getUserMedia отдаёт трек, и голосовая панель поднимается.
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
});
