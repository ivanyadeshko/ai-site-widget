import { test, expect } from '../fixtures/stack.ts';
import { registerFreshAccount } from '../fixtures/account.ts';

/**
 * ГОЛОС — СТРУКТУРНЫЕ ассерты, а НЕ распознавание речи (Task 26). НЕ в CI-гейте
 * (D-14), ходит в живое ядро и жжёт кредиты. Микрофон — fake-устройство
 * Chromium (см. проект voice в playwright.config.ts). Запуск:
 *   E2E_BASE_URL=http://localhost:8200 npx playwright test --project=voice
 *
 * Проверяем механику эскалации в голос: панель поднялась, индикатор микрофона
 * активен, ядро прислало подтверждённую (source='core') реплику агента.
 * Проверить, что «аватар понял сказанное», браузером НЕЛЬЗЯ — это остаётся
 * ручным чек-листом живого звонка в корневом README.md.
 */

const BTN = 'aski-site-widget .btn';

test('эскалация в голос: панель, микрофон активен, подтверждённая ядром реплика', async ({
  page, browser, baseURL,
}) => {
  const base = (baseURL ?? 'http://localhost:8200').replace(/\/+$/, '');

  const token = await test.step('регистрация + виджет + разрешённый сайт', async () => {
    await registerFreshAccount(page, base);
    await page.getByRole('button', { name: 'Создать виджет' }).first().click();
    await page.locator('[data-test="widget-name"] input').fill('Голосовой консультант приёмки E');
    await page.locator('[data-test="widget-instructions"] textarea')
      .fill('Ты голосовой консультант. Отвечай кратко и по существу.', { force: true });
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/v1/widgets') && r.request().method() === 'POST' && r.status() === 201,
    );
    await page.locator('[data-test="save-widget"]').click();
    const widget = (await (await created).json()).widget as { id: string; publish_token: string };
    await page.goto(`${base}/panel/widgets/${widget.id}`);
    await page.getByPlaceholder('https://shop.example').fill(base);
    await page.locator('[data-test="add-origin"]').click();
    await page.locator('[data-test="save-widget"]').click();
    await expect(page.locator('[data-test="edit-notice"]')).toBeVisible();
    return widget.publish_token;
  });

  const demo = await browser.newContext();
  const demoPage = await demo.newPage();
  const frame = demoPage.frameLocator('iframe.frame');

  await test.step('открыть чат и дождаться greeting', async () => {
    await demoPage.goto(`${base}/demo.html?token=${token}`);
    await expect(demoPage.locator(BTN)).toBeVisible({ timeout: 15_000 });
    await demoPage.locator(BTN).click();
    await expect(frame.locator('[data-test="bubble-agent"]').first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step('«Позвонить голосом» → голосовая панель', async () => {
    await frame.locator('[data-test="escalate"]').click();
    await expect(frame.locator('[data-test="voice-panel"]')).toBeVisible({ timeout: 20_000 });
  });

  await test.step('индикатор микрофона активен', async () => {
    // micState === 'on' → на кнопке «Выключить микрофон»; отказа/сбоя нет.
    await expect(frame.locator('[data-test="mic-toggle"]'))
      .toHaveText('Выключить микрофон', { timeout: 20_000 });
    await expect(frame.locator('[data-test="mic-warn"]')).toHaveCount(0);
  });

  await test.step('ядро прислало подтверждённую реплику агента (source=core)', async () => {
    await expect(frame.locator('[data-test="bubble-agent"][data-source="core"]').first())
      .toBeVisible({ timeout: 30_000 });
  });

  await demo.close();
});
