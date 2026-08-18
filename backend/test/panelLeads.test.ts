import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildTestApp } from './helpers/app.ts';
import { testPool, truncateAll } from './helpers/db.ts';
import { insertDialog } from '../src/db/repositories/dialogs.ts';
import { LEADS_EXPORT_BATCH, insertLead, streamLeadsByAccount } from '../src/db/repositories/leads.ts';
import type { Queryable } from '../src/db/pool.ts';

const pool = testPool();
let app: FastifyInstance;
let close: () => Promise<void>;

const ORIGIN = 'https://widget.aski.pro';
const VISITOR = '11111111-1111-4111-8111-111111111111';

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

const createWidget = async (cookie: string, name = 'Виджет магазина'): Promise<{ id: string }> => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
    payload: {
      name, agent_config: { instructions: 'Ты консультант магазина.' },
      allowed_origins: ['https://shop.example'],
    },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().widget.id as string };
};

/** Лид с диалогом под ним: наружу лид без диалога не появляется никогда. */
const seedLead = async (
  db: Pool, widgetId: string, fields: Partial<{ name: string; phone: string; email: string; comment: string }> = {},
): Promise<string> => {
  const dialog = await insertDialog(db, { widgetId, visitorKey: VISITOR });
  return insertLead(db, {
    dialogId: dialog.id, widgetId,
    name: fields.name ?? 'Пётр',
    phone: fields.phone ?? '+79990001122',
    email: fields.email ?? null,
    comment: fields.comment ?? null,
    consent: true,
  });
};

/** id аккаунта по email — для прямых вызовов репозитория. */
const accountIdOf = async (email: string): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE lower(email) = lower($1)', [email]);
  return rows[0]!.id;
};

describe('лиды в кабинете', () => {
  it('владелец видит ТОЛЬКО свои лиды: чужие не в списке и не в CSV', async () => {
    const alice = await owner('leads-alice@example.com');
    const bob = await owner('leads-bob@example.com');
    const aliceWidget = await createWidget(alice);
    const bobWidget = await createWidget(bob, 'Виджет Боба');
    await seedLead(pool, aliceWidget.id, { name: 'Лид Алисы' });
    await seedLead(pool, bobWidget.id, { name: 'Лид Боба' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/leads', headers: { cookie: alice } });
    expect(list.statusCode).toBe(200);
    expect(list.json().leads).toHaveLength(1);
    expect(list.json().leads[0].name).toBe('Лид Алисы');

    // Изоляция обязана жить в SQL, а не только в фильтре ручки: CSV идёт другим
    // путём (стриминговый генератор) и обязан отдавать ровно то же множество.
    const csv = await app.inject({ method: 'GET', url: '/api/v1/leads.csv', headers: { cookie: alice } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Лид Алисы');
    expect(csv.body).not.toContain('Лид Боба');
  });

  it('keyset-пагинация: три страницы по два лида отдают шесть РАЗНЫХ лидов', async () => {
    const cookie = await owner('leads-page@example.com');
    const widget = await createWidget(cookie);
    for (let i = 0; i < 6; i += 1) await seedLead(pool, widget.id, { name: `Лид ${i}` });
    // Худший случай: у всех лидов ОДНО И ТО ЖЕ время создания. Курсор только по
    // времени здесь либо зациклился бы, либо потерял строки — поэтому пара
    // (created_at, id).
    await pool.query("UPDATE leads SET created_at = timestamptz '2026-08-18 10:00:00+00'");

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const url = `/api/v1/leads?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { leads: { id: string }[]; next_cursor: string | null };
      expect(body.leads).toHaveLength(2);
      seen.push(...body.leads.map((l) => l.id));
      cursor = body.next_cursor;
    }
    expect(new Set(seen).size).toBe(6);
    // Шесть лидов ровно уместились в три страницы: продолжения быть не должно.
    expect(cursor).toBeNull();
  });

  it('фильтр по ЧУЖОМУ виджету — 404, а не тихо пустой список', async () => {
    const alice = await owner('leads-filter-a@example.com');
    const bob = await owner('leads-filter-b@example.com');
    const bobWidget = await createWidget(bob);

    const res = await app.inject({
      method: 'GET', url: `/api/v1/leads?widget_id=${bobWidget.id}`, headers: { cookie: alice },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('widget_not_found');

    const csv = await app.inject({
      method: 'GET', url: `/api/v1/leads.csv?widget_id=${bobWidget.id}`, headers: { cookie: alice },
    });
    expect(csv.statusCode).toBe(404);
  });

  it('CSV: BOM, заголовок и по строке на лид', async () => {
    const cookie = await owner('leads-csv@example.com');
    const widget = await createWidget(cookie);
    await seedLead(pool, widget.id, { name: 'Пётр Кириллович', comment: 'Хочу «Ёлку»' });
    await seedLead(pool, widget.id, { name: 'Мария' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/leads.csv', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('\uFEFF')).toBe(true);

    const lines = res.body.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('created_at,widget,name,phone,email,comment');
    expect(lines).toHaveLength(3);
    expect(res.body).toContain('Пётр Кириллович');
    expect(res.body).toContain('Хочу «Ёлку»');
  });

  it('CSV приходит вложением с датой в имени файла', async () => {
    const cookie = await owner('leads-filename@example.com');
    await createWidget(cookie);
    const res = await app.inject({ method: 'GET', url: '/api/v1/leads.csv', headers: { cookie } });
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  it('экспорт читает БАТЧАМИ, а не тянет всю таблицу в память одним запросом', async () => {
    const cookie = await owner('leads-stream@example.com');
    const widget = await createWidget(cookie);
    const accountId = await accountIdOf('leads-stream@example.com');
    const dialog = await insertDialog(pool, { widgetId: widget.id, visitorKey: VISITOR });
    const total = LEADS_EXPORT_BATCH * 2 + 200;
    await pool.query(
      `INSERT INTO leads (dialog_id, widget_id, name, phone, consent)
       SELECT $1, $2, 'Лид ' || g, '+7999' || g, true FROM generate_series(1, $3) g`,
      [dialog.id, widget.id, total],
    );

    // Считаем ОБРАЩЕНИЯ к БД: один запрос на весь экспорт означал бы, что все
    // строки собраны в память процесса — на большом аккаунте это OOM бэкенда.
    let queries = 0;
    const counting = {
      query: (...args: unknown[]) => {
        queries += 1;
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Queryable;

    const seen: string[] = [];
    for await (const row of streamLeadsByAccount(counting, { accountId, widgetId: null, from: null, to: null })) {
      seen.push(row.id);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(queries).toBe(3);
  });

  it('без cookie сессии лиды закрыты целиком', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/leads' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/leads.csv' })).statusCode).toBe(401);
  });

  it('листинг лидов ограничен по частоте: 31-й запрос в минуту — 429', async () => {
    // GET-ручки панели по умолчанию БЕЗ лимита (rate-limit зарегистрирован с
    // global:false), а лиды — это выгрузка персональных данных: без явного
    // потолка украденная кука выкачивает базу в один поток.
    const cookie = await owner('leads-rate@example.com');
    for (let i = 0; i < 30; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/leads', headers: { cookie } })).statusCode).toBe(200);
    }
    const over = await app.inject({ method: 'GET', url: '/api/v1/leads', headers: { cookie } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('rate_limited');
  });

  it('CSV-экспорт ограничен строже листинга: шестой за минуту — 429', async () => {
    const cookie = await owner('leads-csv-rate@example.com');
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/leads.csv', headers: { cookie } })).statusCode).toBe(200);
    }
    const over = await app.inject({ method: 'GET', url: '/api/v1/leads.csv', headers: { cookie } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('rate_limited');
  });

  it('мусорный курсор и мусорный limit — 422, а не 500', async () => {
    const cookie = await owner('leads-bad-args@example.com');
    const badCursor = await app.inject({ method: 'GET', url: '/api/v1/leads?cursor=%D0%BC%D1%83%D1%81%D0%BE%D1%80', headers: { cookie } });
    expect(badCursor.statusCode).toBe(422);
    expect(badCursor.json().error.code).toBe('invalid_cursor');

    const badLimit = await app.inject({ method: 'GET', url: '/api/v1/leads?limit=100000', headers: { cookie } });
    expect(badLimit.statusCode).toBe(422);
    expect(badLimit.json().error.code).toBe('invalid_limit');
  });
});
