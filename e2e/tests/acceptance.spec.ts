import { randomUUID } from 'node:crypto';
import { test, expect } from '../fixtures/stack.ts';
import { registerFreshAccount, loginAccount } from '../fixtures/account.ts';

/**
 * ПРИЁМКА E с ЖИВЫМ ядром (Task 26). НЕ входит в CI-гейт (D-14): ходит в дев-ядро
 * по HTTPS и ЖЖЁТ кредиты тенанта. Запуск:
 *   E2E_BASE_URL=http://localhost:8200 npx playwright test --project=acceptance
 *
 * Один тест = весь путь «незнакомца с улицы», каждый шаг — говорящий test.step,
 * чтобы отчёт читался как протокол приёмки. Отличие от герметичного panel.spec:
 * здесь агент ОТВЕЧАЕТ по-настоящему, а деньги приходят АСИНХРОННО вебхуком
 * session.finalized уже после закрытия сессии — поэтому цифры проверяются
 * expect.poll, а не мгновенно.
 *
 * Что НЕ проверяется даже здесь: «аватар понял сказанное» — это остаётся ручным
 * чек-листом живого звонка в корневом README.md.
 */

const BTN = 'aski-site-widget .btn';
const AGENT_TIMEOUT = 30_000;

test('приёмка E: незнакомец с улицы на живом ядре — диалог, лид, деньги, админка', async ({
  page, browser, api, baseURL,
}) => {
  const base = (baseURL ?? 'http://localhost:8200').replace(/\/+$/, '');

  const account = await test.step('регистрация владельца сайта', async () =>
    registerFreshAccount(page, base));

  const { widgetId, token } = await test.step('создание виджета с инструкциями агента', async () => {
    await page.getByRole('button', { name: 'Создать виджет' }).first().click();
    await page.locator('[data-test="widget-name"] input').fill('Живой консультант приёмки E');
    await page.locator('[data-test="widget-instructions"] textarea').fill(
      'Ты консультант интернет-магазина доставки. Отвечай кратко и по делу, '
      + 'помогай с вопросами о доставке и предлагай оставить контакт.',
      { force: true },
    );
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/v1/widgets') && r.request().method() === 'POST' && r.status() === 201,
    );
    await page.locator('[data-test="save-widget"]').click();
    const widget = (await (await created).json()).widget as { id: string; publish_token: string };
    return { widgetId: widget.id, token: widget.publish_token };
  });

  await test.step('разрешить сайт (origin посетителя)', async () => {
    await page.goto(`${base}/panel/widgets/${widgetId}`);
    await page.getByPlaceholder('https://shop.example').fill(base);
    await page.locator('[data-test="add-origin"]').click();
    await page.locator('[data-test="save-widget"]').click();
    await expect(page.locator('[data-test="edit-notice"]')).toBeVisible();
  });

  // Демо-страница «чужого сайта» — свежий контекст без cookie кабинета.
  const demo = await browser.newContext();
  const demoPage = await demo.newPage();
  const frame = demoPage.frameLocator('iframe.frame');

  await test.step('открыть виджет на демо-странице', async () => {
    await demoPage.goto(`${base}/demo.html?token=${token}`);
    await expect(demoPage.locator(BTN)).toBeVisible({ timeout: 15_000 });
    await demoPage.locator(BTN).click();
    await expect(frame.locator('[data-test="panel-title"]')).toBeVisible({ timeout: 20_000 });
  });

  await test.step('агент прислал greeting', async () => {
    // Первая реплика роли agent — приветствие. Живое ядро отвечает секунды.
    await expect(frame.locator('[data-test="bubble-agent"]').first()).toBeVisible({ timeout: AGENT_TIMEOUT });
  });

  await test.step('вопрос посетителя → ответ агента по существу', async () => {
    const agentBefore = await frame.locator('[data-test="bubble-agent"]').count();
    await frame.locator('[data-test="input"]').fill('Сколько стоит доставка?');
    await frame.locator('[data-test="send"]').click();
    // Пользовательская реплика осела в ленте.
    await expect(frame.locator('[data-test="bubble-user"]', { hasText: 'Сколько стоит доставка?' })).toBeVisible();
    // Появился НОВЫЙ непустой пузырь агента (ответ, а не только greeting).
    await expect(async () => {
      expect(await frame.locator('[data-test="bubble-agent"]').count()).toBeGreaterThan(agentBefore);
    }).toPass({ timeout: AGENT_TIMEOUT });
    await expect(frame.locator('[data-test="bubble-agent"]').last()).not.toBeEmpty();
  });

  await test.step('заполнение и отправка лид-формы → «Спасибо»', async () => {
    await frame.locator('[data-test="open-lead"]').click();
    await expect(frame.locator('[data-test="lead-form"]')).toBeVisible();
    await frame.locator('[data-test="lead-name"]').fill('Пётр Демидов');
    await frame.locator('[data-test="lead-phone"]').fill('+7 900 000-00-00');
    await frame.locator('[data-test="lead-consent"]').check();
    await frame.locator('[data-test="lead-submit"]').click();
    await expect(frame.getByText('Спасибо! Мы свяжемся с вами.')).toBeVisible({ timeout: 15_000 });
  });

  // Закрытие диалога: dialog_id и visitor_key лоадер держит в localStorage
  // хоста — читаем их и явно закрываем сессию (это запускает финализацию).
  const { dialogId, visitorKey } = await test.step('закрытие диалога', async () => {
    const ids = await demoPage.evaluate((t) => ({
      dialogId: localStorage.getItem(`aski-sw-dialog-${t}`),
      visitorKey: localStorage.getItem(`aski-sw-visitor-${t}`),
    }), token);
    expect(ids.dialogId, 'лоадер не сохранил dialog_id').toBeTruthy();
    expect(ids.visitorKey, 'лоадер не сохранил visitor_key').toBeTruthy();
    await api.endDialog(token, ids.dialogId!, ids.visitorKey!);
    return { dialogId: ids.dialogId!, visitorKey: ids.visitorKey! };
  });
  expect(dialogId).toBeTruthy();
  expect(visitorKey).toBeTruthy();

  await test.step('в панели: лид виден', async () => {
    await page.goto(`${base}/panel/leads`);
    await expect(page.getByText('Пётр Демидов')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('в панели: диалог виден', async () => {
    await page.goto(`${base}/panel/dialogs`);
    await expect(page.locator('.n-data-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Живой консультант приёмки E').first()).toBeVisible();
  });

  await test.step('цифры использования ненулевые (деньги приходят АСИНХРОННО)', async () => {
    // credits_total на коротком диалоге честно бывает нулём (округление
    // per-turn, ср. widget_smoke.py сценарий 5). Надёжный сигнал «деньги
    // сведены» — НЕнулевой usage-метр. Ждём его вебхука до 60с.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    await expect.poll(async () => {
      const res = await page.request.get(
        `${base}/api/v1/usage?from=${from}&to=${to}&group_by=day`,
      );
      if (res.status() !== 200) return 0;
      const totals = (await res.json()).totals as { credits_total: number; usage: Record<string, number> };
      const usageMax = Math.max(0, ...Object.values(totals.usage ?? {}));
      return Math.max(totals.credits_total ?? 0, usageMax);
    }, { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(0);
  });

  await test.step('админка оператора видит тенанта и его виджет', async () => {
    const adminEmail = process.env.E2E_ADMIN_EMAIL;
    const adminPassword = process.env.E2E_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      test.info().annotations.push({
        type: 'skip-admin',
        description: 'E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD не заданы — админ поднимается '
          + 'backend/scripts/grant-admin.mjs. Проверка админки пропущена (см. README).',
      });
      return;
    }
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await loginAccount(adminPage, base, { email: adminEmail, password: adminPassword });
    await adminPage.goto(`${base}/panel/admin/accounts`);
    await expect(adminPage.getByText(account.email)).toBeVisible({ timeout: 15_000 });
    await adminPage.goto(`${base}/panel/admin/widgets`);
    await expect(adminPage.getByText('Живой консультант приёмки E').first()).toBeVisible();
    await adminCtx.close();
  });

  await demo.close();
});
