import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { findDialogById, insertDialog } from '../src/db/repositories/dialogs.ts';
import { listThreadTail } from '../src/db/repositories/messages.ts';
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
  ({ app, core, pool } = await buildTestApp());
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

describe('GET /w/v1/:token/config', () => {
  it('отдаёт конфиг, кэш 60с и Vary: Origin, БЕЗ Origin-check', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const res = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, allowed_origins: [ORIGIN] });
    expect(res.json().app_url).toBe(`https://widget.aski.pro/app/${token}`);
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.headers.vary).toContain('Origin');
  });

  it('CORS-заголовок эхом ТОЛЬКО для разрешённого origin', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const good = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: ORIGIN } });
    expect(good.headers['access-control-allow-origin']).toBe(ORIGIN);
    const bad = await app.inject({ method: 'GET', url: `/w/v1/${token}/config`, headers: { origin: 'https://evil.example' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('неизвестный токен → 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/w/v1/нет/config' })).statusCode).toBe(404);
  });
});

describe('POST /w/v1/:token/dialogs', () => {
  it('создаёт диалог и chat-сессию ядра: max_duration_s=600, client_reference, Idempotency-Key', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN], instructions: 'Ты консультант.' });
    core.enqueue({ status: 201, body: CREATED('sess_0123456789abcdef') });

    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.channel).toBe('chat');
    expect(body.participant_token.livekit_url).toBe('wss://lk.example');
    expect(body.messages).toEqual([]);

    const call = core.calls[0]!;
    expect(call.headers['idempotency-key']).toBe(`dlg:${body.dialog_id}:1`);
    expect(call.body).toMatchObject({
      channel: 'chat',
      agent: { instructions: 'Ты консультант.' },
      limits: { max_duration_s: 600 },
      client_reference: `widget:dialog:${body.dialog_id}`,
    });
    expect((call.body as { identity?: string }).identity).toBeUndefined(); // identity генерит ядро

    const dialog = await findDialogById(pool, body.dialog_id);
    expect(dialog?.current_core_session_id).toBe('sess_0123456789abcdef');
    expect(dialog?.current_channel).toBe('chat');
  });

  it('чужой Origin → 403 и ядро НЕ дёргалось', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const res = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: 'https://evil.example' }, payload: { visitor_key: VISITOR },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_not_allowed');
    expect(core.calls).toHaveLength(0);
  });

  it('выключенный виджет → 403 widget_disabled', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN], enabled: false });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('widget_disabled');
  });

  it('невалидный visitor_key → 422', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: 'не-uuid' } });
    expect(res.statusCode).toBe(422);
  });

  it('402 от ядра → 402 наружу, диалог в error', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 402, body: { error: { code: 'insufficient_credits', message: 'нет' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('insufficient_credits');
    const { rows } = await pool.query(`SELECT status FROM dialogs`);
    expect(rows[0].status).toBe('error');
  });

  it('продолжение нити: dialog_id → новая сессия с continue_from и история из журнала', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET core_session_ids = '["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
              current_core_session_id = 'sess_aaaaaaaaaaaaaaaa', current_channel = 'chat', status = 'ended'
        WHERE id = $1`, [dialog.id]);
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, role: 'user', text: 'Меня зовут Пётр', seq: 1 } });

    core.enqueue({ status: 204, body: null });                                    // /end предыдущей
    core.enqueue({ status: 201, body: { ...CREATED('sess_bbbbbbbbbbbbbbbb'), continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, dialog_id: dialog.id } });

    expect(res.statusCode).toBe(201);
    expect(res.json().dialog_id).toBe(dialog.id);
    expect(res.json().continued_from).toBe('sess_aaaaaaaaaaaaaaaa');
    expect(res.json().messages.map((m: { text: string }) => m.text)).toEqual(['Меня зовут Пётр']);
    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_aaaaaaaaaaaaaaaa/end');
    expect(core.calls[1]!.body).toMatchObject({ channel: 'chat', continue_from: 'sess_aaaaaaaaaaaaaaaa' });
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('active');
    expect(fresh?.core_session_ids).toEqual(['sess_aaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbb']);
  });

  it('чужой visitor_key к существующему диалогу → 404, а не 403 (не оракул чужих id)', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN }, payload: { visitor_key: randomUUID(), dialog_id: dialog.id } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /w/v1/:token/dialogs/:id/reenter', () => {
  it('выпускает НОВУЮ identity respondent-<uuid> и отдаёт историю', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(`UPDATE dialogs SET current_core_session_id='sess_0123456789abcdef', current_channel='chat' WHERE id=$1`, [dialog.id]);
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, role: 'agent', text: 'Здравствуйте!', seq: 1 } });

    core.enqueue({ status: 201, body: { token: 'jwt2', identity: 'respondent-новая', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' } });
    core.enqueue({ status: 200, body: { messages: [{ seq: 4, role: 'user', text: 'хвост живой сессии', created_at: '2026-08-13T10:05:00Z' }], has_more: false } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/reenter`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });

    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe('chat');
    const sent = core.calls[0]!.body as { identity: string };
    expect(sent.identity).toMatch(/^respondent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Хвост живой сессии подмешан к журналу и сохранён как source='core'.
    expect(res.json().messages.map((m: { text: string }) => m.text)).toEqual(['Здравствуйте!', 'хвост живой сессии']);
    const stored = await listThreadTail(pool, dialog.id, 50);
    expect(stored.filter((m) => m.source === 'core').map((m) => m.text)).toEqual(['хвост живой сессии']);
  });

  it('410 от ядра (сессия закрыта) → 410 gone, клиент пойдёт по пути «Продолжить»', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(`UPDATE dialogs SET current_core_session_id='sess_0123456789abcdef', current_channel='chat' WHERE id=$1`, [dialog.id]);
    core.enqueue({ status: 410, body: { error: { code: 'session_finished', message: 'закрыта' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/reenter`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('session_finished');
  });
});

describe('журнал, завершение и лид', () => {
  const startDialog = async (token: string): Promise<string> => {
    core.enqueue({ status: 201, body: CREATED('sess_0123456789abcdef') });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    return res.json().dialog_id as string;
  };

  it('POST messages идемпотентен по seq, GET отдаёт ленту', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    const body = { visitor_key: VISITOR, role: 'user', text: 'Меня зовут Пётр', seq: 1 };
    expect((await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN }, payload: body })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN }, payload: body })).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: `/w/v1/${token}/dialogs/${id}/messages?visitor_key=${VISITOR}`, headers: { origin: ORIGIN } });
    expect(list.json().messages).toHaveLength(1);
    expect(list.json().status).toBe('active');
  });

  it('текст длиннее 2000 режется до 2000 — ровно как воркер', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: 'user', text: 'я'.repeat(2500), seq: 1 } });
    const stored = await listThreadTail(pool, id, 10);
    expect(stored[0]!.text).toHaveLength(2000);
  });

  it('пустой текст → 422', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/messages`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: 'user', text: '   ', seq: 1 } });
    expect(res.statusCode).toBe(422);
  });

  it('POST end закрывает сессию ядра и диалог', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    core.enqueue({ status: 204, body: null });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/end`, headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR } });
    expect(res.statusCode).toBe(200);
    expect(core.calls.at(-1)!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/end');
    expect((await findDialogById(pool, id))?.status).toBe('ended');
  });

  it('лид требует consent=true и хотя бы один контакт', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await startDialog(token);
    const noConsent = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/lead`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, name: 'Пётр', phone: '+7 900 000-00-00', consent: false } });
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.json().error.code).toBe('consent_required');

    const noContact = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/lead`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, name: 'Пётр', consent: true } });
    expect(noContact.statusCode).toBe(422);
    expect(noContact.json().error.code).toBe('contact_required');

    const ok = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/lead`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, name: 'Пётр', phone: '+7 900 000-00-00', consent: true } });
    expect(ok.statusCode).toBe(201);
    const { rows } = await pool.query('SELECT name, phone, consent FROM leads');
    expect(rows[0]).toMatchObject({ name: 'Пётр', consent: true });
  });
});
