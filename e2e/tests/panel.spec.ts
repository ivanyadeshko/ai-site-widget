import { randomUUID } from 'node:crypto';
import { test, expect } from '../fixtures/stack.ts';
import { registerFreshAccount } from '../fixtures/account.ts';

/**
 * ГЕРМЕТИЧНЫЙ гейт панели (Task 25). Работает против compose.e2e.yaml с
 * fake-core, секретов не требует, зелёный и на форк-PR (Constraint 3в, D-14).
 *
 * ЧТО ЭТОТ ПРОЕКТ НЕ ПРОВЕРЯЕТ: живой ответ аватара и голос — их без живого
 * ядра поднять физически нельзя (LiveKit data-channel). Это проверяет проект
 * `acceptance` (Task 26, e2e/tests/acceptance.spec.ts) и ручной чек-лист
 * `README.md`. Здесь fake-core лишь отвечает 201 на старт диалога и доставляет
 * подписанный вебхук session.finalized — этого хватает, чтобы пройти путь
 * «регистрация → виджет → сниппет → кнопка на чужой странице → лид → цифры».
 */

const BTN = 'aski-site-widget .btn'; // кнопка лоадера в Shadow DOM (Playwright пронзает открытый shadow)

test('незнакомец с улицы: регистрация → виджет → сниппет → лид → цифры использования', async ({
  page, browser, api, baseURL,
}) => {
  const base = (baseURL ?? 'http://localhost:8200').replace(/\/+$/, '');
  const visitorKey = randomUUID();

  // ── 1. Регистрация свежего аккаунта ─────────────────────────────────────
  await test.step('регистрация владельца сайта', async () => {
    const account = await registerFreshAccount(page, base);
    expect(account.email).toContain('@');
  });

  // ── 2. Создание виджета ─────────────────────────────────────────────────
  const { widgetId, token } = await test.step('создание виджета в кабинете', async () => {
    await page.getByRole('button', { name: 'Создать виджет' }).first().click();
    await page.locator('[data-test="widget-name"] input').fill('Консультант демо-магазина');
    // Панель оборачивает NInput в shrink-to-fit div (data-test), а autosize-
    // textarea при этом схлопывается в ширину 0 → Playwright видит её
    // «невидимой». Значение всё равно проставляется force-fill'ом (v-model
    // слушает input-событие), и canSave срабатывает.
    await page.locator('[data-test="widget-instructions"] textarea').fill(
      'Ты консультант интернет-магазина. Отвечай коротко, предлагай оставить контакт.',
      { force: true },
    );
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/v1/widgets') && r.request().method() === 'POST' && r.status() === 201,
    );
    await page.locator('[data-test="save-widget"]').click();
    const widget = (await (await created).json()).widget as { id: string; publish_token: string };
    // Строка виджета появилась в списке.
    await expect(page.getByText('Консультант демо-магазина')).toBeVisible();
    expect(widget.publish_token).toMatch(/^wgt_/);
    return { widgetId: widget.id, token: widget.publish_token };
  });

  // ── 3. Экран «Установка»: сниппет содержит data-widget="wgt_…" ───────────
  await test.step('сниппет для вставки на сайт', async () => {
    await page.goto(`${base}/panel/widgets/${widgetId}/install`);
    const snippet = page.locator('[data-test="embed-snippet"]');
    await expect(snippet).toBeVisible();
    await expect(snippet).toContainText(`data-widget="${token}"`);
    await expect(snippet).toContainText('data-widget="wgt_');
  });

  // ── 4. Добавить localhost:8200 в разрешённые сайты ──────────────────────
  await test.step('разрешить сайт localhost:8200', async () => {
    await page.goto(`${base}/panel/widgets/${widgetId}`);
    await page.getByPlaceholder('https://shop.example').fill(base);
    await page.locator('[data-test="add-origin"]').click();
    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/widgets/${widgetId}`) && r.request().method() === 'PATCH' && r.status() === 200,
    );
    await page.locator('[data-test="save-widget"]').click();
    await saved;
    await expect(page.locator('[data-test="edit-notice"]')).toBeVisible();
  });

  // ── 5. Демо-страница чужого сайта: кнопка рисуется, iframe открывается ───
  await test.step('кнопка виджета на демо-странице + iframe', async () => {
    // Свежий контекст = пустой кэш: /config кэшируется на 60с, а нам нужен
    // именно свежий ответ (тему поменяем в шаге 6). Заодно это честный
    // «чужой сайт»: без cookie кабинета.
    const demo = await browser.newContext();
    const demoPage = await demo.newPage();
    await demoPage.goto(`${base}/demo.html?token=${token}`);
    await expect(demoPage.locator(BTN)).toBeVisible({ timeout: 15_000 });
    await demoPage.locator(BTN).click();
    // iframe отдал HTML и показал заголовок панели (тема → /config → w.js → init).
    const frame = demoPage.frameLocator('iframe.frame');
    await expect(frame.locator('[data-test="panel-title"]')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('[data-test="panel-title"]')).toContainText('Консультант демо-магазина');
    await demo.close();
  });

  // ── 6. Смена темы: цвет, сторона, заголовок → сквозной путь темы ─────────
  await test.step('смена темы и её проявление на демо-странице', async () => {
    await page.goto(`${base}/panel/widgets/${widgetId}`);
    // Сторона — слева (радиогруппа, детерминированно).
    await page.locator('[data-test="theme-position"]').getByText('Слева').click();
    // Заголовок панели.
    await page.locator('[data-test="theme-title"] input').fill('Служба заботы');
    // Цвет — кликом по свотчу палитры (#b91c1c — третий из swatches
    // WidgetEditView). Свотч коммитит значение сразу; HEX-поле пикера через
    // fill/Enter модель НЕ обновляет (проверено). parseTheme опустит регистр.
    await page.locator('[data-test="theme-color"]').click();
    await page.locator('.n-color-picker-swatch').nth(2).click();
    // Закрыть попап пикера кликом по нейтральному заголовку секции, чтобы он не
    // перехватывал клик по «Сохранить».
    await page.getByText('Оформление', { exact: true }).click();
    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/v1/widgets/${widgetId}`) && r.request().method() === 'PATCH' && r.status() === 200,
    );
    await page.locator('[data-test="save-widget"]').click();
    const patchBody = (await (await saved).json()).widget as { theme: Record<string, unknown> };
    // Панель записала тему в БД именно так, как задал владелец.
    expect(patchBody.theme).toMatchObject({ position: 'left', title: 'Служба заботы', color: '#b91c1c' });

    // Свежий контекст → свежий /config → лоадер рисует новую тему.
    const demo = await browser.newContext();
    const demoPage = await demo.newPage();
    await demoPage.goto(`${base}/demo.html?token=${token}`);
    const btn = demoPage.locator(BTN);
    await expect(btn).toBeVisible({ timeout: 15_000 });
    // Кнопка прижата ВЛЕВО (loader.ts подставляет ${side}:20px) и нужного цвета.
    const box = await btn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { left: cs.left, right: cs.right, bg: cs.backgroundColor };
    });
    expect(box.left, `кнопка не слева: ${JSON.stringify(box)}`).toBe('20px');
    // #b91c1c === rgb(185, 28, 28).
    expect(box.bg, `цвет кнопки не применился: ${JSON.stringify(box)}`).toBe('rgb(185, 28, 28)');
    await demoPage.locator(BTN).click();
    await expect(demoPage.frameLocator('iframe.frame').locator('[data-test="panel-title"]'))
      .toContainText('Служба заботы', { timeout: 20_000 });
    await demo.close();
  });

  // ── 7. Лид через публичный API → появляется на экране «Лиды» ─────────────
  const dialogId = await test.step('лид создан посетителем и виден в панели', async () => {
    const id = await api.startDialog(token, visitorKey);
    await api.submitLead(token, id, visitorKey, {
      name: 'Пётр Демидов', phone: '+7 900 000-00-00', consent: true,
    });
    await page.goto(`${base}/panel/leads`);
    await expect(page.getByText('Пётр Демидов')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('+7 900 000-00-00')).toBeVisible();
    return id;
  });

  // ── 8. Экспорт CSV из авторизованного контекста ─────────────────────────
  await test.step('leads.csv отдаёт этот лид', async () => {
    const res = await page.request.get(`${base}/api/v1/leads.csv`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('Пётр Демидов');
    expect(csv).toContain('+7 900 000-00-00');
  });

  // ── 9. Явное сведение денег вебхуком (без таймеров) ──────────────────────
  await test.step('закрытие диалога + финализация вебхуком', async () => {
    await api.endDialog(token, dialogId, visitorKey);
    const clientReference = `widget:dialog:${dialogId}`;
    const delivery = await api.finalize(clientReference);
    // Ответ фейка приходит ПОСЛЕ ответа BFF на вебхук — деньги уже в БД.
    expect(delivery.bff_status).toBe(200);
  });

  // ── 10. Диалог и НЕнулевые цифры использования ──────────────────────────
  await test.step('диалог виден, credits_total > 0 И usage непустой', async () => {
    await page.goto(`${base}/panel/dialogs`);
    // Ассерт заскоплен НА СТРОКУ нашего диалога (по имени виджета), а не на
    // любую ячейку «12» в таблице: иначе совпадающее число в другой колонке
    // (длительность/счётчик) дало бы зелёный тест при поломанном учёте.
    const dialogRow = page.getByRole('row').filter({ hasText: 'Консультант демо-магазина' });
    await expect(dialogRow.getByRole('cell', { name: '12', exact: true })).toBeVisible({ timeout: 10_000 });

    await page.goto(`${base}/panel/usage`);
    // «Кредитов списано» > 0.
    const creditsStat = page.locator('.n-statistic', { hasText: 'Кредитов списано' })
      .locator('.n-statistic-value__content');
    await expect(creditsStat).toHaveText(/^\s*12\s*$/, { timeout: 10_000 });
    // usage НЕ пустой: колонка метра chat_tokens_in со значением 1200.
    await expect(page.getByRole('columnheader', { name: 'chat_tokens_in' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1200', exact: true })).toBeVisible();
  });
});
