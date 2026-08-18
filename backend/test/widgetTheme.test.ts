import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';
import { DEFAULT_THEME, LAUNCHER_TITLE_PREFIX, TITLE_FALLBACK } from '../src/widgets/theme.ts';

const pool = testPool();
let app: FastifyInstance;
let close: () => Promise<void>;

const ORIGIN = 'https://widget.aski.pro';

beforeEach(async () => {
  await truncateAll(pool);
  const built = await buildTestApp();
  app = built.app;
  close = async () => { await built.app.close(); await built.pool.end(); await built.core.stop(); };
});
afterEach(async () => { await close(); });
afterAll(async () => { await pool.end(); });

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0]! : String(raw);
  return first.split(';')[0]!;
};

const owner = async (email: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    headers: { origin: ORIGIN }, payload: { email, password: 'пароль-владельца' },
  });
  expect(res.statusCode).toBe(201);
  return cookieOf(res);
};

const createWidget = async (cookie: string) => app.inject({
  method: 'POST', url: '/api/v1/widgets',
  headers: { origin: ORIGIN, cookie },
  payload: {
    name: 'Виджет магазина',
    agent_config: { instructions: 'Ты консультант магазина.' },
    allowed_origins: ['https://shop.example'],
  },
});

const patchTheme = async (cookie: string, id: string, theme: unknown) => app.inject({
  method: 'PATCH', url: `/api/v1/widgets/${id}`,
  headers: { origin: ORIGIN, cookie }, payload: { theme },
});

describe('тема виджета', () => {
  it('/config отдаёт ВСЕ поля темы дефолтами, даже когда в БД пусто', async () => {
    // Лоадер (w.js) обязан жить без единого дефолта внутри себя: бюджет 8 КБ
    // gzip дороже, чем повтор пяти значений в JSON конфига (D-9).
    const { token } = await seedWidget(pool);
    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config` });
    expect(res.statusCode).toBe(200);
    const theme = res.json().theme;
    expect(theme).toEqual({
      color: DEFAULT_THEME.color,
      position: DEFAULT_THEME.position,
      button_label: DEFAULT_THEME.button_label,
      title: 'Тестовый виджет',       // пустой title подставляется именем виджета
      launcher_title: 'Открыть чат: Тестовый виджет',
    });
    // Ни одного undefined/null: лоадер подставляет значения без проверок.
    for (const value of Object.values(theme as Record<string, unknown>)) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('');
    }
  });

  it('дефолты темы совпадают с фолбэками лоадера — константы продублированы в двух сборках', () => {
    // `embed/loader/src/loader.ts` держит ТЕ ЖЕ значения на случай отката
    // образа бэкенда (тогда /config приходит без theme). Общего файла у бандла
    // для чужого сайта и у бэкенда нет и быть не может, поэтому расхождение
    // ловится ровно здесь: меняя брендовый цвет, обязаны поменять оба места.
    expect(DEFAULT_THEME).toEqual({ color: '#2563eb', position: 'right', button_label: '💬' });
    // Четвёртая копия — префикс подписи кнопки (loader.ts, фолбэк aria-label).
    expect(LAUNCHER_TITLE_PREFIX).toBe('Открыть чат: ');
  });

  it('дефолтные title/launcher_title подчиняются ТЕМ ЖЕ правилам, что и заданные владельцем', async () => {
    // Дефолт этих полей строится из ИМЕНИ виджета, а `parseWidgetName`
    // разрешает и «<», и «>», и сотню символов. Без чистки /config отдавал бы
    // наружу тему, которую сам же отверг бы на записи, — а инвариант D-9
    // («лоадер не валидирует, потому что валидирует бэкенд») держится ровно на
    // том, что из /config НЕ МОЖЕТ приехать не прошедшее правила значение.
    const cookie = await owner('dirty-name@example.com');
    const created = await app.inject({
      method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
      payload: {
        name: `<img src=x onerror=alert(1)> ${'Э'.repeat(60)}`,
        agent_config: { instructions: 'Ты консультант магазина.' },
        allowed_origins: ['https://shop.example'],
      },
    });
    expect(created.statusCode).toBe(201);
    const widget = created.json().widget;

    const theme = (await app.inject({ method: 'GET', url: `/w/v1/${widget.publish_token}/config` })).json().theme;
    for (const field of ['title', 'launcher_title'] as const) {
      expect(theme[field], `${field} протащил разметку`).not.toMatch(/[<>]/);
    }
    expect(Array.from(theme.title as string).length).toBeLessThanOrEqual(40);
    expect(Array.from(theme.launcher_title as string).length).toBeLessThanOrEqual(60);

    // Самая строгая формулировка инварианта: то, что отдал /config, обязано
    // приниматься обратно валидацией темы. Не принимается — значит наружу
    // уехало невалидное значение.
    const echoed = await app.inject({
      method: 'PATCH', url: `/api/v1/widgets/${widget.id}`,
      headers: { origin: ORIGIN, cookie },
      payload: { theme: { title: theme.title, launcher_title: theme.launcher_title } },
    });
    expect(echoed.statusCode).toBe(200);
  });

  it('имя из одних запрещённых символов не даёт пустого заголовка в /config', async () => {
    // После чистки от «<» и «>» не остаётся ничего, а лоадер подставляет поля
    // темы без проверок: пустой title стал бы пустой шапкой панели, а пустой
    // launcher_title — кнопкой без имени для скринридера.
    const cookie = await owner('junk-name@example.com');
    const created = await app.inject({
      method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
      payload: {
        name: '<<>>',
        agent_config: { instructions: 'Ты консультант магазина.' },
        allowed_origins: ['https://shop.example'],
      },
    });
    const theme = (await app.inject({
      method: 'GET', url: `/w/v1/${created.json().widget.publish_token}/config`,
    })).json().theme;
    expect(theme.title).toBe(TITLE_FALLBACK);
    expect(theme.launcher_title).toBe(`${LAUNCHER_TITLE_PREFIX}${TITLE_FALLBACK}`);
  });

  it('POST принимает тему при создании и отвергает мусорную, а не глотает молча', async () => {
    const cookie = await owner('create-theme@example.com');
    const created = await app.inject({
      method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
      payload: {
        name: 'Виджет магазина',
        agent_config: { instructions: 'Ты консультант магазина.' },
        allowed_origins: ['https://shop.example'],
        theme: { color: '#00ff00', position: 'left' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().widget.theme).toEqual({ color: '#00ff00', position: 'left' });

    const rejected = await app.inject({
      method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
      payload: {
        name: 'Второй виджет',
        agent_config: { instructions: 'Ты консультант магазина.' },
        allowed_origins: [],
        theme: { color: 'красный' },
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe('invalid_theme');
    // Отказ ДО записи: второй виджет не создался.
    const list = await app.inject({ method: 'GET', url: '/api/v1/widgets', headers: { cookie } });
    expect(list.json().widgets).toHaveLength(1);
  });

  it('PATCH сохраняет тему и она видна в публичном /config', async () => {
    const cookie = await owner('theme@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    const patched = await patchTheme(cookie, widget.id, {
      color: '#ff0000', position: 'left', button_label: '🤖',
      title: 'Магазин на связи', launcher_title: 'Спросить консультанта',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().widget.theme).toEqual({
      color: '#ff0000', position: 'left', button_label: '🤖',
      title: 'Магазин на связи', launcher_title: 'Спросить консультанта',
    });

    const config = await app.inject({ method: 'GET', url: `/w/v1/${widget.publish_token}/config` });
    expect(config.json().theme.color).toBe('#ff0000');
    expect(config.json().theme.position).toBe('left');
    expect(config.json().theme.button_label).toBe('🤖');
    expect(config.json().theme.title).toBe('Магазин на связи');
    expect(config.json().theme.launcher_title).toBe('Спросить консультанта');
  });

  it('частичная тема сохраняет только присланное, остальное добирается дефолтами в /config', async () => {
    const cookie = await owner('partial@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    await patchTheme(cookie, widget.id, { position: 'left' });

    // В ответе панели — ровно то, что лежит в БД (владелец видит своё, а не дефолт).
    const read = await app.inject({
      method: 'GET', url: `/api/v1/widgets/${widget.id}`, headers: { cookie },
    });
    expect(read.json().widget.theme).toEqual({ position: 'left' });

    // В /config — полный набор: лоадер не знает дефолтов.
    const config = await app.inject({ method: 'GET', url: `/w/v1/${widget.publish_token}/config` });
    expect(config.json().theme.position).toBe('left');
    expect(config.json().theme.color).toBe(DEFAULT_THEME.color);
    expect(config.json().theme.button_label).toBe(DEFAULT_THEME.button_label);
  });

  it('theme:{} в теле СБРАСЫВАЕТ оформление к дефолтам', async () => {
    // Пара к тесту ниже: отсутствие ключа тему не трогает, а пустой объект —
    // именно сбрасывает. Без этой проверки «сброс» держался бы на комментарии.
    const cookie = await owner('reset-theme@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    await patchTheme(cookie, widget.id, { color: '#ff0000', title: 'Своё название' });
    expect((await patchTheme(cookie, widget.id, {})).json().widget.theme).toEqual({});

    const config = await app.inject({ method: 'GET', url: `/w/v1/${widget.publish_token}/config` });
    expect(config.json().theme.color).toBe(DEFAULT_THEME.color);
    expect(config.json().theme.title).toBe('Виджет магазина');
  });

  it('PATCH без поля theme её НЕ обнуляет (частичность патча)', async () => {
    const cookie = await owner('keep@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    await patchTheme(cookie, widget.id, { color: '#00ff00' });
    const renamed = await app.inject({
      method: 'PATCH', url: `/api/v1/widgets/${widget.id}`,
      headers: { origin: ORIGIN, cookie }, payload: { name: 'Новое имя' },
    });
    expect(renamed.json().widget.theme).toEqual({ color: '#00ff00' });
  });

  it('мусорные значения темы — 422 invalid_theme, в БД ничего не меняется', async () => {
    const cookie = await owner('bad@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    const rejected: unknown[] = [
      { color: 'red' },
      { color: 'javascript:alert(1)' },
      { color: '#fff' },                       // сокращённая запись не принимается
      { position: 'top' },
      { title: 'т'.repeat(500) },
      { launcher_title: 'т'.repeat(61) },
      { button_label: 'три' },                 // > 2 символов
      { button_label: '  ' },                  // пустой после trim — невидимая кнопка
      { color: 123 },
      'строка вместо объекта',
      ['массив вместо объекта'],
      { unknown_field: 'x' },                  // неизвестные поля не молча глотаем
    ];
    for (const theme of rejected) {
      const res = await patchTheme(cookie, widget.id, theme);
      expect(res.statusCode, `не отвергнуто: ${JSON.stringify(theme)}`).toBe(422);
      expect(res.json().error.code).toBe('invalid_theme');
    }
    const read = await app.inject({
      method: 'GET', url: `/api/v1/widgets/${widget.id}`, headers: { cookie },
    });
    expect(read.json().widget.theme).toEqual({});
  });

  it('инъекция в строковых полях отвергается: значения уезжают в Shadow DOM лоадера', async () => {
    // button_label попадает в textContent кнопки, title/launcher_title — в
    // setAttribute/textContent, а сама тема — в шаблонную строку <style>
    // (loader.ts). DOM-API экранирует, но вторая линия обязана быть здесь:
    // лоадер валидации не содержит вовсе (D-9, бюджет 8 КБ).
    const cookie = await owner('inject@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    const payloads = [
      { button_label: '</style><script>' },
      { title: '</style><style>.btn{display:none}' },
      { launcher_title: 'строка\nс переводом' },
      { title: 'управляющий\u0007символ' },
      { launcher_title: '<img src=x onerror=alert(1)>' },
      { color: '#ff0000;background:url(javascript:alert(1))' },
    ];
    for (const theme of payloads) {
      const res = await patchTheme(cookie, widget.id, theme);
      expect(res.statusCode, `пропущено: ${JSON.stringify(theme)}`).toBe(422);
      expect(res.json().error.code).toBe('invalid_theme');
    }
  });

  it('/config остаётся кэшируемым: тема меняется редко, 60 секунд задержки допустимы', async () => {
    const { token } = await seedWidget(pool);
    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config` });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('поле theme доехало ВЕЗДЕ: список, создание, чтение, PATCH и ротация токена', async () => {
    // Страж от рассинхрона: тип Widget продублирован в репозитории, в toPublic()
    // и во фронтовом сторе. Пропуск в ЛЮБОЙ из проекций панели ловится здесь.
    const cookie = await owner('everywhere@example.com');
    const created = await createWidget(cookie);
    expect(created.json().widget).toHaveProperty('theme');
    expect(created.json().widget.theme).toEqual({});
    const id = created.json().widget.id;

    const list = await app.inject({ method: 'GET', url: '/api/v1/widgets', headers: { cookie } });
    expect(list.json().widgets[0]).toHaveProperty('theme');

    const read = await app.inject({ method: 'GET', url: `/api/v1/widgets/${id}`, headers: { cookie } });
    expect(read.json().widget).toHaveProperty('theme');

    const patched = await patchTheme(cookie, id, { color: '#123456' });
    expect(patched.json().widget.theme).toEqual({ color: '#123456' });

    const rotated = await app.inject({
      method: 'POST', url: `/api/v1/widgets/${id}/rotate-token`, headers: { origin: ORIGIN, cookie },
    });
    // Ротация возвращает ту же проекцию: тема обязана пережить смену токена.
    expect(rotated.json().widget.theme).toEqual({ color: '#123456' });
  });
});
