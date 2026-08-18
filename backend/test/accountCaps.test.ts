import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { insertDialog } from '../src/db/repositories/dialogs.ts';
import { peekAccountDayCounter, upsertAccountLimits } from '../src/db/repositories/accountLimits.ts';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedAccount, seedWidget, truncateAll } from './helpers/db.ts';

const ORIGIN = 'https://shop.example';
const VISITOR_A = '11111111-1111-4111-8111-111111111111';
const VISITOR_B = '22222222-2222-4222-8222-222222222222';
const CREATED = (sid: string) => ({
  session_id: sid, room: 'r',
  participant_token: { token: 'jwt', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
});

let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;

beforeEach(async () => {
  // trustProxy: посетители обязаны различаться и по IP тоже — иначе второй
  // старт упрётся в IP-кап, а не в проверяемый кап аккаунта.
  ({ app, core, pool } = await buildTestApp({ trustProxy: true }));
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

/**
 * Суточные капы считают посетителя и IP, но не ВЛАДЕЛЬЦА сайта. Для платного
 * продукта нужен третий ключ: один аккаунт витрины не должен выжечь баланс
 * общего тенанта ядра (D-1).
 */
describe('суточный кап сессий на аккаунт витрины', () => {
  it('кап 1: второй старт ДРУГОГО посетителя на виджете того же аккаунта — 429 account_daily_cap', async () => {
    const owner = await seedAccount(pool, {});
    await upsertAccountLimits(pool, { accountId: owner.id, maxSessionsPerDay: 1, updatedBy: owner.id });
    const { token } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });

    core.enqueue({ status: 201, body: CREATED('sess_first') });
    const first = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.20' },
      payload: { visitor_key: VISITOR_B },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('account_daily_cap');
    // Ядро второй раз не дёрнули: отказ случился ДО денег.
    expect(core.calls.filter((c) => c.url === '/api/v1/sessions')).toHaveLength(1);
  });

  it('счётчик растёт по ФАКТУ созданной сессии: ретрай с тем же ключом повторяемости его не двигает (зеркало M3)', async () => {
    const owner = await seedAccount(pool, {});
    await upsertAccountLimits(pool, { accountId: owner.id, maxSessionsPerDay: 10, updatedBy: owner.id });
    const { token, id: widgetId } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR_A });
    await pool.query(
      `UPDATE dialogs SET core_session_ids = '["sess_same"]'::jsonb,
              current_core_session_id = 'sess_same', current_channel = 'chat', status = 'ended'
        WHERE id = $1`, [dialog.id]);

    core.enqueue({ status: 204, body: null });                        // /end предыдущей
    core.enqueue({ status: 201, body: CREATED('sess_same') });        // ядро отдало ТУ ЖЕ сессию

    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A, dialog_id: dialog.id },
    });
    expect(res.statusCode).toBe(201);
    // Платная сущность одна — значит и в счётчике аккаунта одна единица… точнее
    // НОЛЬ: новой сессии не появилось вовсе, attach вернул false.
    expect(await peekAccountDayCounter(pool, owner.id)).toBe(0);
  });

  it('виджет с владельцем: одиночный старт проходит (дефолтный кап аккаунта не задет)', async () => {
    // Релиз 2 (Task 27): account_id — NOT NULL, бесхозных виджетов больше нет
    // (прежний тест «account_id IS NULL капом не ограничен» проверял состояние,
    // которого схема не допускает). seedWidget заводит владельца; один старт при
    // дефолтном капе (300) заведомо проходит — кап на этом пути не мешает.
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 201, body: CREATED('sess_owned_1') });
    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A },
    });
    expect(res.statusCode).toBe(201);
  });

  it('аккаунт без строки в account_limits получает дефолт из конфига', async () => {
    const owner = await seedAccount(pool, {});
    const { token } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    // Дефолт продавлен в 1 через конфиг тестового инстанса — строки лимитов нет.
    await app.close(); await core.stop(); await pool.end();
    ({ app, core, pool } = await buildTestApp({ trustProxy: true, maxSessionsPerAccountPerDay: 1 }));

    core.enqueue({ status: 201, body: CREATED('sess_default_1') });
    const first = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.20' },
      payload: { visitor_key: VISITOR_B },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('account_daily_cap');
  });

  it('эскалация чат→голос тратит кап аккаунта наравне со стартом', async () => {
    const owner = await seedAccount(pool, {});
    await upsertAccountLimits(pool, { accountId: owner.id, maxSessionsPerDay: 1, updatedBy: owner.id });
    const { token, id: widgetId } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });

    core.enqueue({ status: 201, body: CREATED('sess_chat') });
    const start = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A },
    });
    expect(start.statusCode).toBe(201);
    expect(await peekAccountDayCounter(pool, owner.id)).toBe(1);
    expect(widgetId).toBeTruthy();

    const escalate = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs/${start.json().dialog_id}/escalate`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A, messages_count: 0 },
    });
    expect(escalate.statusCode).toBe(429);
    expect(escalate.json().error.code).toBe('account_daily_cap');
  });

  it('ТЕСТ-СТРАЖ: ре-вход кап НЕ тратит — новой платной сессии он не создаёт', async () => {
    // Ре-вход только переиздаёт participant-token ЖИВОЙ сессии
    // (reenter.ts → issueParticipantToken). Списывать за него кап значило бы
    // наказывать посетителя за перезагрузку вкладки.
    const owner = await seedAccount(pool, {});
    await upsertAccountLimits(pool, { accountId: owner.id, maxSessionsPerDay: 1, updatedBy: owner.id });
    const { token, id: widgetId } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR_A });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_live', current_channel='chat' WHERE id=$1`,
      [dialog.id],
    );
    // Кап уже выбран: счётчик аккаунта на сегодня равен лимиту.
    await pool.query(
      `INSERT INTO account_day_counters (account_id, day, started) VALUES ($1, current_date, 1)`,
      [owner.id],
    );

    core.enqueue({ status: 201, body: { token: 'jwt2', identity: 'respondent-новая', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' } });
    core.enqueue({ status: 200, body: { messages: [], has_more: false } });

    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/reenter`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      payload: { visitor_key: VISITOR_A },
    });
    expect(res.statusCode).toBe(200);
    expect(await peekAccountDayCounter(pool, owner.id)).toBe(1);
  });
});
