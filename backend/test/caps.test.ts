import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { insertDialog } from '../src/db/repositories/dialogs.ts';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, truncateAll } from './helpers/db.ts';

const ORIGIN = 'https://shop.example';
const VISITOR = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;

const CREATED = (sid: string) => ({
  session_id: sid, room: 'r',
  participant_token: { token: 'jwt', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
});

beforeEach(async () => {
  ({ app, core, pool } = await buildTestApp({ maxDialogsPerVisitorPerDay: 2, maxDialogsPerIpPerDay: 3 }));
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

// IP берётся из РЕАЛЬНОГО адреса соединения (trustProxy=false), поэтому в
// тестах его задаёт remoteAddress инжекта, а не заголовок.
const post = (token: string, body: object, remoteAddress = '203.0.113.7') =>
  app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, remoteAddress, payload: body });

describe('капы бюджет-предохранителя', () => {
  it('третий диалог того же visitor за сутки → 429 visitor_daily_cap, ядро не дёргается', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 201, body: CREATED('sess_1111111111111111') });
    core.enqueue({ status: 201, body: CREATED('sess_2222222222222222') });
    for (let i = 0; i < 2; i += 1) {
      expect((await post(token, { visitor_key: VISITOR })).statusCode).toBe(201);
    }
    const denied = await post(token, { visitor_key: VISITOR });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('visitor_daily_cap');
    expect(core.calls).toHaveLength(2);
  });

  it('кап по IP ловит смену visitor_key', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    for (let i = 0; i < 3; i += 1) core.enqueue({ status: 201, body: CREATED(`sess_${String(i).repeat(16)}`) });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(token, { visitor_key: randomUUID() }, '203.0.113.8')).statusCode).toBe(201);
    }
    const denied = await post(token, { visitor_key: randomUUID() }, '203.0.113.8');
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('ip_daily_cap');
  });

  it('X-Forwarded-For НЕ подменяет IP: иначе кап обходится одним заголовком', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    for (let i = 0; i < 3; i += 1) core.enqueue({ status: 201, body: CREATED(`sess_${String(i).repeat(16)}`) });
    for (let i = 0; i < 3; i += 1) {
      expect((await post(token, { visitor_key: randomUUID() }, '203.0.113.10')).statusCode).toBe(201);
    }
    // Атакующий крутит заголовок, надеясь получить свежую квоту.
    const spoofed = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '198.51.100.1' },
      remoteAddress: '203.0.113.10',
      payload: { visitor_key: randomUUID() },
    });
    expect(spoofed.statusCode).toBe(429);
    expect(spoofed.json().error.code).toBe('ip_daily_cap');
    // И в счётчиках ровно ОДИН ключ — подменённый адрес своей строки не завёл.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ip_day_counters');
    expect(rows[0].n).toBe(1);
  });

  it('IP в БД не попадает — только хэш', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 201, body: CREATED('sess_3333333333333333') });
    await post(token, { visitor_key: VISITOR }, '203.0.113.9');
    const { rows } = await pool.query('SELECT ip_hash FROM ip_day_counters');
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].ip_hash).not.toContain('203.0.113.9');
  });

  it('ретрай POST /dialogs с тем же состоянием шлёт ТОТ ЖЕ Idempotency-Key', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET core_session_ids='["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
              current_core_session_id='sess_aaaaaaaaaaaaaaaa', status='ended' WHERE id=$1`, [dialog.id]);
    // Первая попытка: ядро приняло /end, но создание оборвалось сетью.
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 503, body: { error: { code: 'service_unavailable', message: 'ой' } } });
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, dialog_id: dialog.id } });
    // Вторая попытка — сессия так и не привязана, ключ ОБЯЗАН совпасть.
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 201, body: { ...CREATED('sess_bbbbbbbbbbbbbbbb'), continued_from: 'sess_aaaaaaaaaaaaaaaa' } });
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, dialog_id: dialog.id } });

    const creates = core.calls.filter((c) => c.url === '/api/v1/sessions');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.headers['idempotency-key']).toBe(creates[1]!.headers['idempotency-key']);
    expect(creates[0]!.headers['idempotency-key']).toBe(`dlg:${dialog.id}:2`);
  });

  it('кап считает и ЭСКАЛАЦИЮ: она создаёт платную сессию так же, как старт', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    // Диалог уже есть, квота visitor выбрана двумя прошлыми диалогами.
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat' WHERE id=$1`,
      [dialog.id],
    );
    const denied = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/escalate`,
      headers: { origin: ORIGIN }, remoteAddress: '203.0.113.11',
      payload: { visitor_key: VISITOR, messages_count: 0 },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('visitor_daily_cap');
    expect(core.calls).toHaveLength(0); // ядро не тронуто: ни /end, ни создания
  });
});
