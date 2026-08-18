import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';
import { applyFinalizedUsage, insertDialog } from '../src/db/repositories/dialogs.ts';

const pool = testPool();
let app: FastifyInstance;
let close: () => Promise<void>;

const ORIGIN = 'https://widget.aski.pro';
const VISITOR = '11111111-1111-4111-8111-111111111111';
const PERIOD = 'from=2026-08-01&to=2026-09-01';

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

const createWidget = async (cookie: string, name = 'Виджет магазина'): Promise<string> => {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/widgets', headers: { origin: ORIGIN, cookie },
    payload: {
      name, agent_config: { instructions: 'Ты консультант магазина.' },
      allowed_origins: ['https://shop.example'],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().widget.id as string;
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
      dialogId: dialog.id, sessionId: `sess-${sessionCounter}`,
      usage: settled.usage, creditsTotal: settled.credits,
    });
  }
  return dialog.id;
};

describe('использование в кабинете', () => {
  it('метры ядра складываются по дням: ключи объединяются, значения суммируются', async () => {
    const cookie = await owner('usage-day@example.com');
    const widgetId = await createWidget(cookie);
    await seedDialogAt(widgetId, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 100, tts_characters: 20 }, credits: 3 });
    await seedDialogAt(widgetId, '2026-08-10T18:00:00Z', { usage: { tts_characters: 5, stt_seconds: 7 }, credits: 4 });
    await seedDialogAt(widgetId, '2026-08-11T09:00:00Z', { usage: { llm_input_tokens: 1 }, credits: 1 });

    const res = await app.inject({ method: 'GET', url: `/api/v1/usage?${PERIOD}&group_by=day`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const buckets = res.json().buckets as { day: string; dialogs: number; credits_total: number; usage: Record<string, number> }[];
    expect(buckets.map((b) => b.day)).toEqual(['2026-08-10', '2026-08-11']);
    expect(buckets[0]!.dialogs).toBe(2);
    expect(buckets[0]!.credits_total).toBe(7);
    // Набор метров у ядра ПРОИЗВОЛЬНЫЙ (jsonb), поэтому складываем ключи, а не
    // перечисляем их: новый метр обязан появиться в отчёте сам.
    expect(buckets[0]!.usage).toEqual({ llm_input_tokens: 100, tts_characters: 25, stt_seconds: 7 });
    expect(buckets[1]!.usage).toEqual({ llm_input_tokens: 1 });

    // Итог по периоду — сумма всего, а не первой страницы.
    expect(res.json().totals).toEqual({
      dialogs: 3, credits_total: 8,
      usage: { llm_input_tokens: 101, tts_characters: 25, stt_seconds: 7 },
    });
  });

  it('диалог без сведённых денег считается ДИАЛОГОМ, но нулём кредитов', async () => {
    // Иначе владелец видит «диалогов нет» там, где они были: деньги сводятся
    // вебхуком ядра позже, а разговор уже состоялся.
    const cookie = await owner('usage-zero@example.com');
    const widgetId = await createWidget(cookie);
    await seedDialogAt(widgetId, '2026-08-12T10:00:00Z');

    const res = await app.inject({ method: 'GET', url: `/api/v1/usage?${PERIOD}&group_by=day`, headers: { cookie } });
    const bucket = res.json().buckets[0];
    expect(bucket.day).toBe('2026-08-12');
    expect(bucket.dialogs).toBe(1);
    expect(bucket.credits_total).toBe(0);
    expect(bucket.usage).toEqual({});
  });

  it('чужие диалоги не попадают в цифры соседа', async () => {
    const alice = await owner('usage-alice@example.com');
    const bob = await owner('usage-bob@example.com');
    const aliceWidget = await createWidget(alice);
    const bobWidget = await createWidget(bob, 'Виджет Боба');
    await seedDialogAt(aliceWidget, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 10 }, credits: 1 });
    await seedDialogAt(bobWidget, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 999 }, credits: 999 });

    const res = await app.inject({ method: 'GET', url: `/api/v1/usage?${PERIOD}`, headers: { cookie: alice } });
    expect(res.json().totals).toEqual({ dialogs: 1, credits_total: 1, usage: { llm_input_tokens: 10 } });
  });

  it('group_by=widget показывает и виджеты БЕЗ диалогов за период', async () => {
    // Пустая строка информативнее отсутствия строки: владелец сразу видит, что
    // виджет установлен, но им никто не пользуется.
    const cookie = await owner('usage-widget@example.com');
    const busy = await createWidget(cookie, 'Работающий');
    await createWidget(cookie, 'Молчащий');
    await seedDialogAt(busy, '2026-08-10T12:00:00Z', { usage: { llm_input_tokens: 10 }, credits: 2 });

    const res = await app.inject({ method: 'GET', url: `/api/v1/usage?${PERIOD}&group_by=widget`, headers: { cookie } });
    const buckets = res.json().buckets as { widget_name: string; dialogs: number; credits_total: number }[];
    expect(buckets).toHaveLength(2);
    const silent = buckets.find((b) => b.widget_name === 'Молчащий')!;
    expect(silent.dialogs).toBe(0);
    expect(silent.credits_total).toBe(0);
    expect(buckets.find((b) => b.widget_name === 'Работающий')!.dialogs).toBe(1);
  });

  it('период задом наперёд и окно длиннее года — 422, а не тяжёлый запрос', async () => {
    const cookie = await owner('usage-period@example.com');
    const backwards = await app.inject({
      method: 'GET', url: '/api/v1/usage?from=2026-09-01&to=2026-08-01', headers: { cookie },
    });
    expect(backwards.statusCode).toBe(422);
    expect(backwards.json().error.code).toBe('invalid_period');

    const forever = await app.inject({
      method: 'GET', url: '/api/v1/usage?from=2020-01-01&to=2026-09-01', headers: { cookie },
    });
    expect(forever.statusCode).toBe(422);
    expect(forever.json().error.code).toBe('invalid_period');

    const junk = await app.inject({ method: 'GET', url: '/api/v1/usage?from=позавчера', headers: { cookie } });
    expect(junk.statusCode).toBe(422);
  });

  it('без cookie сессии использование закрыто', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/usage' })).statusCode).toBe(401);
  });
});

describe('различимость ротации токена (вводная кросс-ревью)', () => {
  it('404 по неизвестному токену пишет WARN token_rotated_or_deleted с dialog_id из пути', async () => {
    // Ротация токена владельцем ОБРЫВАЕТ живые диалоги (widgets.ts) и в данных
    // выглядит ровно как сбой: посетитель просто перестал слать сообщения.
    // Без этой отметки поддержка и экраны использования не отличают самострел
    // владельца от инцидента платформы.
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const warnSpy = vi.spyOn(app.log, 'warn');

    await pool.query('UPDATE widgets SET publish_token = $2 WHERE id = $1', [widgetId, `${token}x`]);

    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`,
      headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: 'user', text: 'Продолжаю разговор', seq: 2 },
    });
    expect(res.statusCode).toBe(404);

    const rotations = warnSpy.mock.calls.filter(
      (call) => (call[0] as { evt?: string } | undefined)?.evt === 'token_rotated_or_deleted',
    );
    expect(rotations).toHaveLength(1);
    expect((rotations[0]![0] as { dialog_id?: string }).dialog_id).toBe(dialog.id);
  });

  it('токен не уезжает в лог целиком — только хвост', async () => {
    const warnSpy = vi.spyOn(app.log, 'warn');
    const unknown = 'wgt_00000000000000000000000000000001';
    expect((await app.inject({ method: 'GET', url: `/w/v1/${unknown}/config` })).statusCode).toBe(404);

    const rotations = warnSpy.mock.calls.filter(
      (call) => (call[0] as { evt?: string } | undefined)?.evt === 'token_rotated_or_deleted',
    );
    expect(rotations).toHaveLength(1);
    const payload = rotations[0]![0] as { token_tail?: string; dialog_id?: string | null };
    expect(payload.token_tail).toBe(unknown.slice(-6));
    expect(JSON.stringify(payload)).not.toContain(unknown);
    // dialog_id в этом пути нет — поле обязано быть явным null, а не исчезать:
    // grep по логам не должен зависеть от формы события.
    expect(payload.dialog_id).toBeNull();
  });
});
