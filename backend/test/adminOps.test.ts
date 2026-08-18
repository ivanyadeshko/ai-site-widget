import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/auth/password.ts';
import { findAccountLimits } from '../src/db/repositories/accountLimits.ts';
import { applyFinalizedUsage, insertDialog } from '../src/db/repositories/dialogs.ts';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedAccount, seedWidget, testPool, truncateAll } from './helpers/db.ts';

const pool = testPool();
let app: FastifyInstance;
let core: FakeCore;
let close: () => Promise<void>;

const ORIGIN = 'https://widget.aski.pro';
const SHOP = 'https://shop.example';
const PASSWORD = 'пароль-владельца';
const VISITOR = '11111111-1111-4111-8111-111111111111';
const PERIOD = 'from=2026-08-01&to=2026-09-01';
const BALANCE = { balance: 4200, updated_at: '2026-08-18T09:00:00Z' };
const CREATED = {
  session_id: 'sess_0123456789abcdef', room: 'r',
  participant_token: { token: 'jwt', identity: 'respondent-x', livekit_url: 'wss://lk.example', expires_at: '2026-08-19T10:00:00Z' },
};

beforeEach(async () => {
  await truncateAll(pool);
  const built = await buildTestApp();
  app = built.app;
  core = built.core;
  close = async () => { await built.app.close(); await built.pool.end(); await built.core.stop(); };
});
afterEach(async () => { await close(); });
afterAll(async () => { await pool.end(); });

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0]! : String(raw);
  return first.split(';')[0]!;
};

const signIn = async (email: string, isAdmin = false): Promise<{ id: string; cookie: string }> => {
  const account = await seedAccount(pool, { email, passwordHash: await hashPassword(PASSWORD), isAdmin });
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { origin: ORIGIN }, payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return { id: account.id, cookie: cookieOf(res) };
};

let sessionCounter = 0;

/** Диалог в заданном дне, при необходимости со сведёнными деньгами. */
const seedDialogAt = async (
  widgetId: string, startedAt: string,
  settled?: { usage: Record<string, number>; credits: number },
): Promise<string> => {
  const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
  await pool.query('UPDATE dialogs SET started_at = $2::timestamptz WHERE id = $1', [dialog.id, startedAt]);
  if (settled) {
    sessionCounter += 1;
    await applyFinalizedUsage(pool, {
      dialogId: dialog.id, sessionId: `sess-admin-${sessionCounter}`,
      usage: settled.usage, creditsTotal: settled.credits,
    });
  }
  return dialog.id;
};

type AdminWidget = {
  id: string; name: string; enabled: boolean; created_at: string;
  account_id: string | null; owner_email: string | null; owner_blocked: boolean;
  dialogs_total: number; publish_token: string;
};
type AccountBucket = {
  account_id: string; account_email: string;
  dialogs: number; credits_total: number; usage: Record<string, number>;
};

describe('админ-поверхность: виджеты витрины', () => {
  it('показывает виджеты ВСЕХ аккаунтов витрины', async () => {
    // Релиз 2 (Task 27): widgets.account_id — NOT NULL, бесхозных строк
    // (owner_email = null) больше не существует — прежний пункт «включая
    // бесхозные» проверял состояние, которого схема теперь не допускает.
    // Оператор по-прежнему видит виджеты ВСЕХ владельцев (изоляции у админ-
    // поверхности нет — она на то и админская).
    const admin = await signIn('root@example.com', true);
    const alice = await seedAccount(pool, { email: 'alice@example.com' });
    const bob = await seedAccount(pool, { email: 'bob@example.com' });
    await seedWidget(pool, { accountId: alice.id });
    await seedWidget(pool, { accountId: bob.id });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/widgets', headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
    const widgets = res.json().widgets as AdminWidget[];
    expect(widgets).toHaveLength(2);
    // Порядок — по created_at DESC, поэтому сравниваем составом, а не списком.
    expect(new Set(widgets.map((w) => w.owner_email)))
      .toEqual(new Set(['alice@example.com', 'bob@example.com']));
  });

  it('фильтр account_id сужает список до одного владельца', async () => {
    const admin = await signIn('root@example.com', true);
    const alice = await seedAccount(pool, { email: 'alice@example.com' });
    const bob = await seedAccount(pool, { email: 'bob@example.com' });
    const mine = await seedWidget(pool, { accountId: alice.id });
    await seedWidget(pool, { accountId: bob.id });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/widgets?account_id=${alice.id}`, headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const widgets = res.json().widgets as AdminWidget[];
    expect(widgets.map((w) => w.id)).toEqual([mine.id]);
  });

  it('в строке есть блокировка владельца и число диалогов: оператор смотрит сюда по жалобе', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'blocked@example.com' });
    const widget = await seedWidget(pool, { accountId: owner.id });
    await seedDialogAt(widget.id, '2026-08-10T12:00:00Z');
    await app.inject({
      method: 'POST', url: `/api/v1/admin/accounts/${owner.id}/block`,
      headers: { cookie: admin.cookie, origin: ORIGIN },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/widgets', headers: { cookie: admin.cookie } });
    const row = (res.json().widgets as AdminWidget[]).find((w) => w.id === widget.id)!;
    expect(row.owner_blocked).toBe(true);
    expect(row.dialogs_total).toBe(1);
  });
});

describe('админ-поверхность: расход в разрезе аккаунтов', () => {
  it('группирует по аккаунтам за период, метры складываются', async () => {
    const admin = await signIn('root@example.com', true);
    const alice = await seedAccount(pool, { email: 'alice@example.com' });
    const bob = await seedAccount(pool, { email: 'bob@example.com' });
    const aliceWidget = await seedWidget(pool, { accountId: alice.id });
    const bobWidget = await seedWidget(pool, { accountId: bob.id });

    await seedDialogAt(aliceWidget.id, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 100 }, credits: 3 });
    await seedDialogAt(aliceWidget.id, '2026-08-11T12:00:00Z', { usage: { llm_input_tokens: 20, tts_characters: 7 }, credits: 4 });
    await seedDialogAt(bobWidget.id, '2026-08-12T12:00:00Z', { usage: { stt_seconds: 5 }, credits: 1 });
    // Вне периода — в отчёт не попадает.
    await seedDialogAt(bobWidget.id, '2026-07-01T12:00:00Z', { usage: { stt_seconds: 999 }, credits: 999 });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/usage?${PERIOD}`, headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const buckets = res.json().buckets as AccountBucket[];
    const aliceRow = buckets.find((b) => b.account_email === 'alice@example.com')!;
    expect(aliceRow.dialogs).toBe(2);
    expect(aliceRow.credits_total).toBe(7);
    expect(aliceRow.usage).toEqual({ llm_input_tokens: 120, tts_characters: 7 });
    const bobRow = buckets.find((b) => b.account_email === 'bob@example.com')!;
    expect(bobRow.dialogs).toBe(1);
    expect(bobRow.credits_total).toBe(1);
    // Аккаунт без расхода за период остаётся строкой с нулями: «строки нет»
    // оператор читает как сбой отчёта, а не как «клиент молчал».
    expect(buckets.some((b) => b.account_email === 'root@example.com' && b.dialogs === 0)).toBe(true);
  });

  it('итог периода — по ВСЕМ диалогам витрины', async () => {
    // Релиз 2 (Task 27): бесхозных виджетов больше нет (account_id NOT NULL),
    // каждый диалог принадлежит аккаунту. Прежний пункт проверял, что итог
    // включает бесхозные диалоги, которых в разрезе аккаунтов нет; теперь такого
    // расхождения быть не может — инвариант ужесточился до «итог == сумма по
    // аккаунтам», и это ровно то, что должен видеть оператор.
    const admin = await signIn('root@example.com', true);
    const alice = await seedAccount(pool, { email: 'alice@example.com' });
    const bob = await seedAccount(pool, { email: 'bob@example.com' });
    const aliceWidget = await seedWidget(pool, { accountId: alice.id });
    const bobWidget = await seedWidget(pool, { accountId: bob.id });

    await seedDialogAt(aliceWidget.id, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 10 }, credits: 5 });
    await seedDialogAt(bobWidget.id, '2026-08-10T13:00:00Z', { usage: { llm_input_tokens: 1 }, credits: 2 });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/usage?${PERIOD}`, headers: { cookie: admin.cookie },
    });
    const body = res.json() as { buckets: AccountBucket[]; totals: { dialogs: number; credits_total: number } };
    // Итог по витрине — по всем диалогам обоих владельцев.
    expect(body.totals.dialogs).toBe(2);
    expect(body.totals.credits_total).toBe(7);
    // И он в точности совпадает с суммой по аккаунтам: бесхозных денег нет.
    expect(body.buckets.reduce((sum, b) => sum + b.credits_total, 0)).toBe(7);
  });

  it('период разбирается ТЕМИ ЖЕ правилами, что и в кабинете: задом наперёд и длиннее года — 422', async () => {
    const admin = await signIn('root@example.com', true);
    const backwards = await app.inject({
      method: 'GET', url: '/api/v1/admin/usage?from=2026-09-01&to=2026-08-01', headers: { cookie: admin.cookie },
    });
    expect(backwards.statusCode).toBe(422);
    expect(backwards.json().error.code).toBe('invalid_period');

    const tooWide = await app.inject({
      method: 'GET', url: '/api/v1/admin/usage?from=2020-01-01&to=2026-08-01', headers: { cookie: admin.cookie },
    });
    expect(tooWide.statusCode).toBe(422);
    expect(tooWide.json().error.code).toBe('invalid_period');
  });

  it('отчёт ограничен строже листингов: 31-й запрос в минуту — 429', async () => {
    // Самый тяжёлый запрос админки: разворачивает jsonb по ВСЕМ диалогам
    // периода через accounts × widgets × dialogs. Без явного потолка (лимитер
    // зарегистрирован с global:false) один зациклившийся экран кладёт базу
    // витрины целиком, а не только свою страницу.
    const admin = await signIn('rate@example.com', true);
    for (let i = 0; i < 30; i += 1) {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/admin/usage?${PERIOD}`, headers: { cookie: admin.cookie },
      });
      expect(res.statusCode, `запрос ${i + 1}`).toBe(200);
    }
    const over = await app.inject({
      method: 'GET', url: `/api/v1/admin/usage?${PERIOD}`, headers: { cookie: admin.cookie },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('rate_limited');
  });
});

describe('админ-поверхность: лимиты аккаунта', () => {
  it('без своей строки отдаётся дефолт стенда, а не «нет лимита»', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'nolimits@example.com' });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/accounts/${owner.id}/limits`, headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().limits).toEqual({ max_sessions_per_day: null, effective_default: 300 });
  });

  it('PUT записывает кап, и он действует НЕМЕДЛЕННО: следующий старт — 429 account_daily_cap', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'capped@example.com' });
    const widget = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [SHOP] });

    const put = await app.inject({
      method: 'PUT', url: `/api/v1/admin/accounts/${owner.id}/limits`,
      headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { max_sessions_per_day: 0 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().limits.max_sessions_per_day).toBe(0);
    // Кто менял — записано: спор «кто выключил клиента» решается строкой в БД.
    expect((await findAccountLimits(pool, owner.id))!.updated_by).toBe(admin.id);

    const start = await app.inject({
      method: 'POST', url: `/w/v1/${widget.token}/dialogs`,
      headers: { origin: SHOP }, payload: { visitor_key: VISITOR },
    });
    expect(start.statusCode).toBe(429);
    expect(start.json().error.code).toBe('account_daily_cap');
    // Отказ случился ДО денег: ядро не дёрнули вовсе.
    expect(core.calls).toHaveLength(0);
  });

  it('кап поднимается обратно тем же PUT и снова пускает', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'raised@example.com' });
    const widget = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [SHOP] });

    for (const value of [0, 5]) {
      const put = await app.inject({
        method: 'PUT', url: `/api/v1/admin/accounts/${owner.id}/limits`,
        headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { max_sessions_per_day: value },
      });
      expect(put.statusCode).toBe(200);
    }

    core.enqueue({ status: 201, body: CREATED });
    const start = await app.inject({
      method: 'POST', url: `/w/v1/${widget.token}/dialogs`,
      headers: { origin: SHOP }, payload: { visitor_key: VISITOR },
    });
    expect(start.statusCode).toBe(201);
  });

  it('мусорный кап отвергается: отрицательный, запредельный, дробный, не число', async () => {
    const admin = await signIn('root@example.com', true);
    const owner = await seedAccount(pool, { email: 'junk@example.com' });
    for (const value of [-1, 100001, 1.5, '10', null]) {
      const res = await app.inject({
        method: 'PUT', url: `/api/v1/admin/accounts/${owner.id}/limits`,
        headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { max_sessions_per_day: value },
      });
      expect(res.statusCode, String(value)).toBe(422);
      expect(res.json().error.code, String(value)).toBe('invalid_limit');
    }
    // Ни одна из попыток не оставила строки в БД.
    expect(await findAccountLimits(pool, owner.id)).toBeNull();
  });

  it('лимиты несуществующего аккаунта — 404, а не создание строки из воздуха', async () => {
    const admin = await signIn('root@example.com', true);
    const ghost = '11111111-1111-4111-8111-111111111111';
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/accounts/${ghost}/limits`,
      headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { max_sessions_per_day: 10 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('account_not_found');
  });
});

describe('админ-поверхность: баланс кредитов ядра', () => {
  it('отдаёт баланс тенанта и ходит в ядро с Bearer-ключом тенанта', async () => {
    const admin = await signIn('root@example.com', true);
    core.enqueue({ status: 200, body: BALANCE });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/core/credits', headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toEqual(BALANCE);
    expect(typeof res.json().fetched_at).toBe('string');

    const call = core.calls.find((c) => c.url.includes('/credits/balance'))!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('/api/v1/credits/balance');
    expect(call.headers.authorization).toBe('Bearer sk_test_x');
  });

  it('второй запрос подряд берёт баланс из кэша, а не долбит ядро на каждый рендер', async () => {
    const admin = await signIn('root@example.com', true);
    core.enqueue({ status: 200, body: BALANCE });

    const first = await app.inject({ method: 'GET', url: '/api/v1/admin/core/credits', headers: { cookie: admin.cookie } });
    const second = await app.inject({ method: 'GET', url: '/api/v1/admin/core/credits', headers: { cookie: admin.cookie } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().balance).toEqual(BALANCE);
    expect(core.calls.filter((c) => c.url.includes('/credits/balance'))).toHaveLength(1);
  });

  it('недоступное ядро — 503 core_unavailable, а НЕ 500: это не поломка витрины', async () => {
    const admin = await signIn('root@example.com', true);
    core.enqueue({ status: 503, body: { error: { code: 'unavailable', message: 'ядро на профилактике' } } });

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/core/credits', headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('core_unavailable');
  });

  it('провал НЕ кэшируется: как только ядро ожило, баланс приезжает без ожидания окна кэша', async () => {
    const admin = await signIn('root@example.com', true);
    core.enqueue({ status: 500, body: { error: { code: 'boom', message: 'упало' } } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/core/credits', headers: { cookie: admin.cookie } })).statusCode).toBe(503);

    core.enqueue({ status: 200, body: BALANCE });
    const ok = await app.inject({ method: 'GET', url: '/api/v1/admin/core/credits', headers: { cookie: admin.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().balance).toEqual(BALANCE);
  });
});

describe('изоляция админ-поверхности потока IV', () => {
  it('обычный аккаунт получает 404 на КАЖДОЙ новой admin-ручке', async () => {
    const { cookie } = await signIn('plain@example.com');
    const owner = await seedAccount(pool, { email: 'someone@example.com' });
    const reads = [
      '/api/v1/admin/widgets',
      `/api/v1/admin/usage?${PERIOD}`,
      `/api/v1/admin/accounts/${owner.id}/limits`,
      '/api/v1/admin/core/credits',
    ];
    for (const url of reads) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie, origin: ORIGIN } });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe('not_found');
    }

    const write = await app.inject({
      method: 'PUT', url: `/api/v1/admin/accounts/${owner.id}/limits`,
      headers: { cookie, origin: ORIGIN }, payload: { max_sessions_per_day: 1 },
    });
    expect(write.statusCode).toBe(404);
    expect(write.json().error.code).toBe('not_found');
    // Ядро не трогали ни разу: гард роли отработал ДО всякой работы.
    expect(core.calls).toHaveLength(0);
  });

  it('ТЕСТ-СТРАЖ: панельная ручка расхода чужого аккаунта по-прежнему НЕ видит', async () => {
    // Админские срезы заведены ОТДЕЛЬНЫМИ функциями (adminUsageBy*), а не
    // ослаблением скоупа в usageBy*. Если кто-то соблазнится «переиспользовать»
    // их убрав `w.account_id = $1`, красным станет вот это.
    const alice = await signIn('alice@example.com');
    const bob = await seedAccount(pool, { email: 'bob@example.com' });
    const bobWidget = await seedWidget(pool, { accountId: bob.id });
    await seedDialogAt(bobWidget.id, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 77 }, credits: 9 });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/usage?${PERIOD}&group_by=day`, headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toEqual({ dialogs: 0, credits_total: 0, usage: {} });
  });
});
