import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CoreClient } from '../src/core/client.ts';
import { applyFinalizedUsage, insertDialog, attachCoreSession, findDialogById, setDialogStatus } from '../src/db/repositories/dialogs.ts';
import { insertMessage, listThreadTail } from '../src/db/repositories/messages.ts';
import { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';

const SECRET = 'секрет-длиной-больше-шестнадцати';
const pool = testPool();
let app: FastifyInstance;
let core: FakeCore; // нужен сценарию transcript.ready: сверка тянет ленту сама

const post = (raw: string, headerOverride?: string) => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return app.inject({
    method: 'POST',
    url: '/w/v1/core-webhooks',
    headers: { 'content-type': 'application/json', 'x-core-signature': headerOverride ?? `t=${t},v1=${v1}` },
    payload: raw,
  });
};

beforeAll(async () => {
  core = new FakeCore();
  await core.start();
  app = await buildApp({
    config: {
      port: 8200, databaseUrl: process.env.DATABASE_URL!, coreBaseUrl: core.baseUrl,
      coreTenantKey: 'sk_test_x', coreWebhookSecret: SECRET,
      appOrigin: 'http://localhost:8200', publicOrigin: 'http://localhost:8200',
      cspConnectSrc: "'self'", ipHashSalt: 'соль', maxDialogsPerVisitorPerDay: 10,
      maxDialogsPerIpPerDay: 30, maxDurationS: 600, trustProxy: false, logLevel: 'silent',
      maxSessionsPerAccountPerDay: 300,
      sessionTtlDays: 30, panelOrigin: 'http://localhost:8200', cookieSecure: false,
      cdnOrigin: 'http://localhost:8200',
      loginMaxFailures: 10, loginLockMinutes: 15,
    },
    pool,
    core: new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 2000 }),
  });
});
beforeEach(() => truncateAll(pool));
afterAll(async () => { await app.close(); await core.stop(); await pool.end(); });

const envelope = (eventId: string, data: unknown, type = 'session.finalized'): string =>
  JSON.stringify({ api_version: 'v1', event_id: eventId, type, created: '2026-08-13T10:00:00Z', data });

describe('POST /w/v1/core-webhooks', () => {
  it('фейк-подпись → 401 и НИЧЕГО не записано', async () => {
    const raw = envelope('evt_bad', { session_id: 'sess_1', status: 'finalized', duration_s: 1, credits_total: 1 });
    const res = await post(raw, 't=1,v1=deadbeef');
    expect(res.statusCode).toBe(401);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM core_events');
    expect(rows[0].n).toBe(0);
  });

  it('session.finalized: usage и credits садятся в диалог по client_reference', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });

    const raw = envelope('evt_1', {
      session_id: 'sess_0123456789abcdef',
      client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 42, credits_total: 7,
      usage_summary: { chat_token: 1200 },
    });
    expect((await post(raw)).statusCode).toBe(200);

    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.usage).toEqual({ chat_token: 1200 });
    expect(fresh?.credits_total).toBe(7);
    expect(fresh?.status).toBe('ended');
  });

  it('ретрай того же event_id не удваивает деньги', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    const raw = envelope('evt_dup', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 42, credits_total: 7, usage_summary: { chat_token: 1200 },
    });
    expect((await post(raw)).statusCode).toBe(200);
    expect((await post(raw)).statusCode).toBe(200);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.credits_total).toBe(7);
    expect(fresh?.usage).toEqual({ chat_token: 1200 });
  });

  it('повторная доставка ОДНОГО transcript.ready-конверта не долбит ядро дважды — дедуп на core_events', async () => {
    // Вскрывающая проба: деньги (session.finalized) идемпотентны САМИ ПО СЕБЕ
    // через settled_session_ids (см. тест «гонка со свипером» выше), поэтому
    // мутация `if (!fresh) return` их не ловит — эта проба целится в другую
    // ветку (transcript.ready), у которой такой собственной идемпотентности
    // нет: без дедупа на core_events повтор конверта дёрнул бы ядро СНОВА.
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    core.enqueue({ status: 200, body: { messages: [
      { seq: 1, role: 'user', text: 'Привет', created_at: '2026-08-13T10:00:00Z' },
    ], has_more: false } });

    const raw = envelope('evt_dup_tr', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference, message_count: 1,
    }, 'transcript.ready');

    const first = await post(raw);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    const callsAfterFirst = core.calls.length;

    const second = await post(raw); // ретрай ТОГО ЖЕ event_id — тело идентично первому
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, deduped: true });
    expect(core.calls.length).toBe(callsAfterFirst); // ядро НЕ дёрнуто повторно
  });

  it('финализация НЕ текущей сессии не роняет диалог в ended', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_старая', channel: 'chat' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_новая', channel: 'voice' });
    const raw = envelope('evt_old', {
      session_id: 'sess_старая', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 10, credits_total: 3,
    });
    expect((await post(raw)).statusCode).toBe(200);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('active');
    expect(fresh?.credits_total).toBe(3);
  });

  it('финализация ТЕКУЩЕЙ сессии диалога в escalating НЕ откатывает статус обратно (гард под T4)', async () => {
    // Вскрывающая проба: в тесте выше «не текущая сессия» уже проверку статуса
    // не задевает — там мимо бьёт условие current_core_session_id, а не
    // status==='active'. Здесь сессия ИМЕННО текущая, чтобы отдельно проверить
    // именно гард по статусу: диалог, ушедший в эскалацию (T4), не обязан
    // молча вернуться в 'ended' только потому, что его chat-сессия закрылась.
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    await setDialogStatus(pool, dialog.id, 'escalating');

    const raw = envelope('evt_esc', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 20, credits_total: 4,
    });
    expect((await post(raw)).statusCode).toBe(200);

    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('escalating'); // НЕ 'ended'
    expect(fresh?.credits_total).toBe(4);      // деньги при этом всё равно учтены
  });

  it('неизвестный тип события принимается 200 и просто ложится в core_events', async () => {
    const raw = envelope('evt_unknown', { anything: true }, 'recording.ready');
    expect((await post(raw)).statusCode).toBe(200);
    const { rows } = await pool.query(`SELECT type FROM core_events WHERE event_id = 'evt_unknown'`);
    expect(rows[0].type).toBe('recording.ready');
  });

  it('конверт без event_id → 400, в БД пусто', async () => {
    const raw = JSON.stringify({ api_version: 'v1', type: 'session.finalized', data: {} });
    expect((await post(raw)).statusCode).toBe(400);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM core_events');
    expect(rows[0].n).toBe(0);
  });

  it('деньги той же сессии из ДРУГОГО события не удваиваются (гонка со свипером)', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    // Свипер успел раньше и уже учёл эту сессию.
    await applyFinalizedUsage(pool, {
      dialogId: dialog.id, sessionId: 'sess_0123456789abcdef',
      usage: { chat_token: 1200 }, creditsTotal: 7,
    });
    const raw = envelope('evt_race', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference,
      status: 'finalized', duration_s: 42, credits_total: 7, usage_summary: { chat_token: 1200 },
    });
    expect((await post(raw)).statusCode).toBe(200);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.credits_total).toBe(7);            // НЕ 14
    expect(fresh?.usage).toEqual({ chat_token: 1200 }); // НЕ 2400
  });

  it('деньги РАЗНЫХ сессий одной нити суммируются', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_1111111111111111', channel: 'chat' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_2222222222222222', channel: 'voice' });
    for (const [id, sid, credits] of [['evt_a', 'sess_1111111111111111', 7], ['evt_b', 'sess_2222222222222222', 5]] as const) {
      const raw = envelope(id, {
        session_id: sid, client_reference: dialog.client_reference,
        status: 'finalized', duration_s: 10, credits_total: credits, usage_summary: { chat_token: 100 },
      });
      expect((await post(raw)).statusCode).toBe(200);
    }
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.credits_total).toBe(12);
    expect(fresh?.usage).toEqual({ chat_token: 200 });
  });

  it('transcript.ready доливает в журнал ТОЛЬКО то, чего клиент не записал', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_0123456789abcdef', channel: 'chat' });
    // Клиент успел записать первую реплику своим путём.
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр',
      source: 'client', coreSessionId: null, seq: 1,
    });
    core.enqueue({ status: 200, body: { messages: [
      { seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' },
      { seq: 2, role: 'agent', text: 'Здравствуйте, Пётр!', created_at: '2026-08-13T10:00:05Z' },
    ], has_more: false } });

    const raw = envelope('evt_tr', {
      session_id: 'sess_0123456789abcdef', client_reference: dialog.client_reference, message_count: 2,
    }, 'transcript.ready');
    expect((await post(raw)).statusCode).toBe(200);

    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows.map((m) => m.text)).toEqual(['Меня зовут Пётр', 'Здравствуйте, Пётр!']);
    expect(rows.filter((m) => m.source === 'core')).toHaveLength(1); // задвоения НЕТ
  });
});
