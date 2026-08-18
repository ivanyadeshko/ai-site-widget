import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { testPool, truncateAll } from './helpers/db.ts';
import { applyFinalizedUsage, attachCoreSession, insertDialog, setDialogStatus } from '../src/db/repositories/dialogs.ts';
import { insertLead } from '../src/db/repositories/leads.ts';
import { insertMessage } from '../src/db/repositories/messages.ts';

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

describe('диалоги в кабинете', () => {
  it('изоляция арендаторов на ОБЕИХ ручках: чужой диалог не виден и не читается', async () => {
    const alice = await owner('dlg-alice@example.com');
    const bob = await owner('dlg-bob@example.com');
    const aliceWidget = await createWidget(alice);
    const bobWidget = await createWidget(bob, 'Виджет Боба');
    const aliceDialog = await insertDialog(pool, { widgetId: aliceWidget, visitorKey: VISITOR });
    const bobDialog = await insertDialog(pool, { widgetId: bobWidget, visitorKey: VISITOR });
    await insertMessage(pool, {
      dialogId: bobDialog.id, role: 'user', text: 'Секрет Боба', source: 'client', coreSessionId: null, seq: 1,
    });

    const list = await app.inject({ method: 'GET', url: '/api/v1/dialogs', headers: { cookie: alice } });
    expect(list.statusCode).toBe(200);
    expect(list.json().dialogs.map((d: { id: string }) => d.id)).toEqual([aliceDialog.id]);

    // Чужая лента — 404, а не 403: существование чужого диалога не
    // подтверждаем (то же правило, что и у виджетов).
    const thread = await app.inject({
      method: 'GET', url: `/api/v1/dialogs/${bobDialog.id}/messages`, headers: { cookie: alice },
    });
    expect(thread.statusCode).toBe(404);
    expect(thread.json().error.code).toBe('dialog_not_found');
    expect(thread.body).not.toContain('Секрет Боба');
  });

  it('строка листинга несёт СРЕЗ ДЛЯ ВЛАДЕЛЬЦА, а не сырую строку dialogs', async () => {
    const cookie = await owner('dlg-row@example.com');
    const widgetId = await createWidget(cookie);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess-1', channel: 'chat' });
    for (const [seq, text] of [[1, 'Привет'], [2, 'Здравствуйте!']] as const) {
      await insertMessage(pool, {
        dialogId: dialog.id, role: seq === 1 ? 'user' : 'agent', text,
        source: 'client', coreSessionId: null, seq,
      });
    }
    await insertLead(pool, {
      dialogId: dialog.id, widgetId, name: 'Пётр', phone: '+79990001122',
      email: null, comment: null, consent: true,
    });
    await applyFinalizedUsage(pool, {
      dialogId: dialog.id, sessionId: 'sess-1',
      usage: { llm_input_tokens: 120, tts_characters: 42 }, creditsTotal: 7,
    });
    await setDialogStatus(pool, dialog.id, 'ended');

    const row = (await app.inject({ method: 'GET', url: '/api/v1/dialogs', headers: { cookie } })).json().dialogs[0];
    expect(row.widget_name).toBe('Виджет магазина');
    expect(row.status).toBe('ended');
    expect(row.messages_count).toBe(2);
    expect(row.has_lead).toBe(true);
    // Цифры, за которые платят, отдаются КАК ЕСТЬ: округление или пересчёт на
    // лету разошлись бы с тем, что показывает админка по тем же строкам.
    expect(row.credits_total).toBe(7);
    expect(row.usage).toEqual({ llm_input_tokens: 120, tts_characters: 42 });
    expect(typeof row.started_at).toBe('string');
    expect(row.ended_at).not.toBeNull();
  });

  it('лента читается С НАЧАЛА и листается ВПЕРЁД по after_id', async () => {
    // Публичный listThreadTail отдаёт ХВОСТ — это правильно для посетителя,
    // который вернулся в виджет. Владелец в кабинете читает разговор с начала,
    // иначе первая страница чужого диалога начинается с середины фразы.
    const cookie = await owner('dlg-thread@example.com');
    const widgetId = await createWidget(cookie);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    for (let seq = 1; seq <= 5; seq += 1) {
      await insertMessage(pool, {
        dialogId: dialog.id, role: seq % 2 === 1 ? 'user' : 'agent', text: `Реплика ${seq}`,
        source: 'client', coreSessionId: null, seq,
      });
    }

    const first = await app.inject({
      method: 'GET', url: `/api/v1/dialogs/${dialog.id}/messages?limit=2`, headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().messages.map((m: { text: string }) => m.text)).toEqual(['Реплика 1', 'Реплика 2']);
    const afterId = first.json().next_after_id;
    expect(afterId).not.toBeNull();

    const second = await app.inject({
      method: 'GET', url: `/api/v1/dialogs/${dialog.id}/messages?limit=2&after_id=${afterId}`, headers: { cookie },
    });
    expect(second.json().messages.map((m: { text: string }) => m.text)).toEqual(['Реплика 3', 'Реплика 4']);

    const third = await app.inject({
      method: 'GET',
      url: `/api/v1/dialogs/${dialog.id}/messages?limit=2&after_id=${second.json().next_after_id}`,
      headers: { cookie },
    });
    expect(third.json().messages.map((m: { text: string }) => m.text)).toEqual(['Реплика 5']);
    // Страница неполная — продолжения нет, кнопка «ещё» в панели гаснет.
    expect(third.json().next_after_id).toBeNull();
  });

  it('source реплики уезжает наружу: владелец обязан отличать подтверждённое ядром от клиентского', async () => {
    const cookie = await owner('dlg-source@example.com');
    const widgetId = await createWidget(cookie);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'user', text: 'Клиентская', source: 'client', coreSessionId: null, seq: 1,
    });
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'agent', text: 'Подтверждённая', source: 'core', coreSessionId: 'sess-1', seq: 1,
    });

    const messages = (await app.inject({
      method: 'GET', url: `/api/v1/dialogs/${dialog.id}/messages`, headers: { cookie },
    })).json().messages;
    expect(messages.map((m: { source: string }) => m.source)).toEqual(['client', 'core']);
    // id нужен самой панели: по нему листается следующая страница.
    expect(messages[0].id).toBeTruthy();
  });

  it('keyset листинга переживает диалоги с ОДИНАКОВЫМ временем старта', async () => {
    const cookie = await owner('dlg-page@example.com');
    const widgetId = await createWidget(cookie);
    for (let i = 0; i < 4; i += 1) await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query("UPDATE dialogs SET started_at = timestamptz '2026-08-18 10:00:00+00'");

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 2; page += 1) {
      const url = `/api/v1/dialogs?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { dialogs: { id: string }[]; next_cursor: string | null };
      expect(body.dialogs).toHaveLength(2);
      seen.push(...body.dialogs.map((d) => d.id));
      cursor = body.next_cursor;
    }
    expect(new Set(seen).size).toBe(4);
    expect(cursor).toBeNull();
  });

  it('фильтр по чужому виджету — 404; кривой after_id — 422, а не 500', async () => {
    const alice = await owner('dlg-args-a@example.com');
    const bob = await owner('dlg-args-b@example.com');
    const bobWidget = await createWidget(bob);
    const aliceWidget = await createWidget(alice);
    const dialog = await insertDialog(pool, { widgetId: aliceWidget, visitorKey: VISITOR });

    const foreign = await app.inject({
      method: 'GET', url: `/api/v1/dialogs?widget_id=${bobWidget}`, headers: { cookie: alice },
    });
    expect(foreign.statusCode).toBe(404);

    const badAfter = await app.inject({
      method: 'GET', url: `/api/v1/dialogs/${dialog.id}/messages?after_id=не-число`, headers: { cookie: alice },
    });
    expect(badAfter.statusCode).toBe(422);
    expect(badAfter.json().error.code).toBe('invalid_after_id');

    // Кривой uuid в пути — 404, а не 500 от Postgres (22P02).
    const badId = await app.inject({ method: 'GET', url: '/api/v1/dialogs/не-uuid/messages', headers: { cookie: alice } });
    expect(badId.statusCode).toBe(404);
  });

  it('без cookie сессии диалоги закрыты целиком', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/dialogs' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET', url: '/api/v1/dialogs/11111111-1111-4111-8111-111111111111/messages',
    })).statusCode).toBe(401);
  });
});
