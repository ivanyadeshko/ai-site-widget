import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { testPool, truncateAll } from './helpers/db.ts';

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

/** Регистрирует владельца и отдаёт его cookie сессии. */
const owner = async (email: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin: ORIGIN },
    payload: { email, password: 'пароль-владельца' },
  });
  expect(res.statusCode).toBe(201);
  return cookieOf(res);
};

type WidgetBody = {
  name?: unknown;
  agent_config?: unknown;
  allowed_origins?: unknown;
  enabled?: unknown;
};

const createWidget = async (cookie: string, patch: WidgetBody = {}) => app.inject({
  method: 'POST',
  url: '/api/v1/widgets',
  headers: { origin: ORIGIN, cookie },
  payload: {
    name: 'Виджет магазина',
    agent_config: { instructions: 'Ты консультант магазина.' },
    allowed_origins: ['https://shop.example'],
    ...patch,
  },
});

describe('панельный CRUD виджетов', () => {
  it('создание отдаёт 201 с публичным токеном, виджет виден в списке владельца', async () => {
    const cookie = await owner('crud@example.com');
    const created = await createWidget(cookie);
    expect(created.statusCode).toBe(201);

    const widget = created.json().widget;
    expect(widget.publish_token).toMatch(/^wgt_[0-9a-f]{32}$/);
    expect(widget.name).toBe('Виджет магазина');
    expect(widget.enabled).toBe(true);
    expect(widget.allowed_origins).toEqual(['https://shop.example']);
    expect(widget.agent_config.instructions).toBe('Ты консультант магазина.');
    // Поля объявлены здесь, чтобы SPA не переписывалась дважды (Task 13 наполнит сниппет).
    expect(widget).toHaveProperty('embed_snippet');
    expect(widget.app_url).toContain(`/app/${widget.publish_token}`);
    // theme появится только в Task 11 — сейчас колонки нет, поля быть не должно.
    expect(widget).not.toHaveProperty('theme');

    const list = await app.inject({ method: 'GET', url: '/api/v1/widgets', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().widgets).toHaveLength(1);
    expect(list.json().widgets[0].id).toBe(widget.id);
  });

  it('изоляция арендаторов: чужой виджет не виден и не меняется — 404, а не 403', async () => {
    const alice = await owner('alice@example.com');
    const bob = await owner('bob@example.com');
    const widgetId = (await createWidget(alice)).json().widget.id;

    const list = await app.inject({ method: 'GET', url: '/api/v1/widgets', headers: { cookie: bob } });
    expect(list.json().widgets).toEqual([]);

    const read = await app.inject({ method: 'GET', url: `/api/v1/widgets/${widgetId}`, headers: { cookie: bob } });
    expect(read.statusCode).toBe(404);
    expect(read.json().error.code).toBe('widget_not_found');

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/widgets/${widgetId}`,
      headers: { origin: ORIGIN, cookie: bob }, payload: { name: 'Захвачено' },
    });
    expect(patch.statusCode).toBe(404);

    const removed = await app.inject({
      method: 'DELETE', url: `/api/v1/widgets/${widgetId}`, headers: { origin: ORIGIN, cookie: bob },
    });
    expect(removed.statusCode).toBe(404);

    // И самое главное: после всех попыток виджет Алисы на месте и не тронут.
    const mine = await app.inject({ method: 'GET', url: `/api/v1/widgets/${widgetId}`, headers: { cookie: alice } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().widget.name).toBe('Виджет магазина');
  });

  it('без cookie сессии CRUD закрыт целиком', async () => {
    const cookie = await owner('anon-owner@example.com');
    const id = (await createWidget(cookie)).json().widget.id;

    const create = await app.inject({
      method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN },
      payload: { name: 'Ничей', agent_config: { instructions: 'Привет.' }, allowed_origins: [] },
    });
    expect(create.statusCode).toBe(401);
    expect(create.json().error.code).toBe('unauthenticated');

    expect((await app.inject({ method: 'GET', url: '/api/v1/widgets' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/widgets/${id}` })).statusCode).toBe(401);
  });

  it('маска * в allowed_origins запрещена: она сняла бы единственную защиту', async () => {
    const cookie = await owner('mask@example.com');
    for (const origins of [['*'], ['https://*.shop.example'], ['*.example']]) {
      const res = await createWidget(cookie, { allowed_origins: origins });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_origins');
    }
  });

  it('origin нормализуется до схемы и хоста, мусор отвергается', async () => {
    const cookie = await owner('origins@example.com');
    const ok = await createWidget(cookie, {
      allowed_origins: ['https://Shop.Example/path/', 'HTTPS://shop.example', 'http://localhost:5173'],
    });
    expect(ok.statusCode).toBe(201);
    // Дубликаты схлопнулись, путь срезан, регистр опущен.
    expect(ok.json().widget.allowed_origins).toEqual(['https://shop.example', 'http://localhost:5173']);

    const bad = await createWidget(cookie, { allowed_origins: ['не-url'] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('invalid_origins');

    const notArray = await createWidget(cookie, { allowed_origins: 'https://shop.example' });
    expect(notArray.statusCode).toBe(422);

    const ftp = await createWidget(cookie, { allowed_origins: ['ftp://shop.example'] });
    expect(ftp.statusCode).toBe(422);
  });

  it('инструкции агента: пустые и длиннее 8000 символов отвергаются', async () => {
    const cookie = await owner('instr@example.com');

    const tooLong = await createWidget(cookie, { agent_config: { instructions: 'я'.repeat(8001) } });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error.code).toBe('instructions_too_long');

    const empty = await createWidget(cookie, { agent_config: { instructions: '   ' } });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('invalid_instructions');

    const missing = await createWidget(cookie, { agent_config: {} });
    expect(missing.statusCode).toBe(422);

    // voice_id/avatar_id уезжают в тело запроса к ядру — мусор туда не пускаем.
    const badVoice = await createWidget(cookie, {
      agent_config: { instructions: 'Ты консультант.', voice_id: 'голос с пробелом' },
    });
    expect(badVoice.statusCode).toBe(422);
    expect(badVoice.json().error.code).toBe('invalid_voice_id');
  });

  it('PATCH обновляет ЧАСТИЧНО: enabled:false не сносит остальные поля', async () => {
    const cookie = await owner('patch@example.com');
    const before = (await createWidget(cookie, {
      agent_config: { instructions: 'Ты консультант магазина.', greeting: 'Здравствуйте!' },
    })).json().widget;

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/widgets/${before.id}`,
      headers: { origin: ORIGIN, cookie }, payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    const after = res.json().widget;
    expect(after.enabled).toBe(false);
    expect(after.name).toBe(before.name);
    expect(after.allowed_origins).toEqual(before.allowed_origins);
    expect(after.agent_config).toEqual(before.agent_config);
    expect(after.publish_token).toBe(before.publish_token);
  });

  it('DELETE уносит диалоги и лиды виджета каскадом', async () => {
    const cookie = await owner('cascade@example.com');
    const widget = (await createWidget(cookie)).json().widget;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO dialogs (widget_id, visitor_key, client_reference)
       VALUES ($1, gen_random_uuid(), $2) RETURNING id`,
      [widget.id, `ref-${widget.id}`],
    );
    const dialogId = rows[0]!.id;
    await pool.query(
      `INSERT INTO leads (dialog_id, widget_id, name, consent) VALUES ($1, $2, 'Клиент', TRUE)`,
      [dialogId, widget.id],
    );

    const res = await app.inject({
      method: 'DELETE', url: `/api/v1/widgets/${widget.id}`, headers: { origin: ORIGIN, cookie },
    });
    expect(res.statusCode).toBe(204);

    expect((await pool.query('SELECT 1 FROM widgets WHERE id = $1', [widget.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM dialogs WHERE id = $1', [dialogId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM leads WHERE widget_id = $1', [widget.id])).rowCount).toBe(0);
  });

  it('кап на число виджетов аккаунта: 11-й не создаётся', async () => {
    const cookie = await owner('cap@example.com');
    for (let i = 0; i < 10; i += 1) {
      const res = await createWidget(cookie, { name: `Виджет ${i}` });
      expect(res.statusCode).toBe(201);
    }
    const res = await createWidget(cookie, { name: 'Одиннадцатый' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('widget_limit_reached');

    // Кап — на АККАУНТ, а не на витрину: сосед по-прежнему может создавать.
    const neighbour = await owner('cap-neighbour@example.com');
    expect((await createWidget(neighbour)).statusCode).toBe(201);
  });

  it('созданный в панели виджет сразу работает на публичном пути', async () => {
    const cookie = await owner('public@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    const res = await app.inject({
      method: 'GET', url: `/w/v1/${widget.publish_token}/config`, headers: { origin: 'https://shop.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().widget_id).toBe(widget.id);
    expect(res.json().enabled).toBe(true);
  });

  it('ротация меняет токен: старый перестаёт работать, новый работает', async () => {
    const cookie = await owner('rotate@example.com');
    const before = (await createWidget(cookie)).json().widget;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/widgets/${before.id}/rotate-token`,
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.statusCode).toBe(200);

    const after = res.json().widget;
    expect(after.publish_token).toMatch(/^wgt_[0-9a-f]{32}$/);
    expect(after.publish_token).not.toBe(before.publish_token);
    expect(after.id).toBe(before.id);

    const old = await app.inject({
      method: 'GET', url: `/w/v1/${before.publish_token}/config`, headers: { origin: 'https://shop.example' },
    });
    expect(old.statusCode).toBe(404);
    expect(old.json().error.code).toBe('widget_not_found');

    const fresh = await app.inject({
      method: 'GET', url: `/w/v1/${after.publish_token}/config`, headers: { origin: 'https://shop.example' },
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().widget_id).toBe(before.id);
  });

  it('ротация НЕ теряет диалоги: привязка идёт по widget_id, а не по токену', async () => {
    const cookie = await owner('rotate-history@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO dialogs (widget_id, visitor_key, client_reference)
       VALUES ($1, gen_random_uuid(), $2) RETURNING id`,
      [widget.id, `ref-rotate-${widget.id}`],
    );
    const dialogId = rows[0]!.id;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/widgets/${widget.id}/rotate-token`,
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.statusCode).toBe(200);

    const kept = await pool.query<{ widget_id: string }>(
      'SELECT widget_id FROM dialogs WHERE id = $1', [dialogId],
    );
    expect(kept.rowCount).toBe(1);
    expect(kept.rows[0]!.widget_id).toBe(widget.id);
  });

  it('ротация чужого виджета — 404 и токен соседа не меняется', async () => {
    const alice = await owner('rot-alice@example.com');
    const bob = await owner('rot-bob@example.com');
    const widget = (await createWidget(alice)).json().widget;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/widgets/${widget.id}/rotate-token`,
      headers: { origin: ORIGIN, cookie: bob },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('widget_not_found');

    const mine = await app.inject({ method: 'GET', url: `/api/v1/widgets/${widget.id}`, headers: { cookie: alice } });
    expect(mine.json().widget.publish_token).toBe(widget.publish_token);
  });

  it('ротация ограничена по частоте: шестая подряд — 429', async () => {
    const cookie = await owner('rotate-limit@example.com');
    const widget = (await createWidget(cookie)).json().widget;
    const rotate = () => app.inject({
      method: 'POST', url: `/api/v1/widgets/${widget.id}/rotate-token`,
      headers: { origin: ORIGIN, cookie },
    });
    for (let i = 0; i < 5; i += 1) expect((await rotate()).statusCode).toBe(200);
    const sixth = await rotate();
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('rate_limited');
  });

  it('несуществующий и синтаксически кривой id дают 404, а не 500', async () => {
    const cookie = await owner('badid@example.com');
    const ghost = await app.inject({
      method: 'GET', url: '/api/v1/widgets/11111111-1111-4111-8111-111111111111', headers: { cookie },
    });
    expect(ghost.statusCode).toBe(404);
    const junk = await app.inject({ method: 'GET', url: '/api/v1/widgets/не-uuid', headers: { cookie } });
    expect(junk.statusCode).toBe(404);
    expect(junk.json().error.code).toBe('widget_not_found');
  });
});
