import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { setAccountBlocked } from '../src/db/repositories/accounts.ts';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedAccount, seedWidget, truncateAll } from './helpers/db.ts';

const ORIGIN = 'https://shop.example';
const CREATED = (sid: string) => ({
  session_id: sid, room: 'r',
  participant_token: { token: 'jwt', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
});
const VISITOR = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;

beforeEach(async () => {
  ({ app, core, pool } = await buildTestApp());
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

/**
 * Без этого блокировка владельца — косметика: заблокированный аккаунт
 * продолжает жечь кредиты ОБЩЕГО тенанта ядра (D-1) через свои виджеты,
 * которые как стояли на чужих сайтах, так и стоят.
 */
describe('блокировка владельца гасит публичный путь его виджетов', () => {
  it('старт диалога на виджете заблокированного владельца — 403 account_blocked', async () => {
    const owner = await seedAccount(pool, {});
    const { token } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    await setAccountBlocked(pool, owner.id, true);

    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_blocked');
  });

  it('config отдаёт enabled:false — лоадер тихо не рисует кнопку, но это НЕ 404 и НЕ 500', async () => {
    const owner = await seedAccount(pool, {});
    const { token } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    await setAccountBlocked(pool, owner.id, true);

    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it('/app/:token отдаёт 404 — iframe на чужом сайте не грузится вовсе', async () => {
    const owner = await seedAccount(pool, {});
    const { token } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    await setAccountBlocked(pool, owner.id, true);

    const res = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(res.statusCode).toBe(404);
  });

  it('разблокировка возвращает виджет в строй', async () => {
    const owner = await seedAccount(pool, {});
    const { token } = await seedWidget(pool, { accountId: owner.id, allowedOrigins: [ORIGIN] });
    await setAccountBlocked(pool, owner.id, true);
    await setAccountBlocked(pool, owner.id, false);

    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: ORIGIN } });
    expect(res.json().enabled).toBe(true);
    core.enqueue({ status: 201, body: CREATED('sess_unblocked') });
    const start = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR },
    });
    expect(start.statusCode).toBe(201);
  });

  it('виджет с невыключенным владельцем работает по всему публичному пути (config, /app, старт)', async () => {
    // Релиз 2 (Task 27): widgets.account_id — NOT NULL, бесхозных строк больше
    // нет (прежний «страж аддитивности релиза 1» проверял виджет с account_id
    // IS NULL, которого схема теперь не допускает). seedWidget заводит
    // владельца сам; сторожим, что виджет с НЕзаблокированным владельцем
    // проходит config → /app → старт диалога без сучка.
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const cfg = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: ORIGIN } });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().enabled).toBe(true);

    const page = await app.inject({ method: 'GET', url: `/app/${token}` });
    expect(page.statusCode).toBe(200);

    core.enqueue({ status: 201, body: CREATED('sess_legacy') });
    const start = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR },
    });
    expect(start.statusCode).toBe(201);
  });
});
