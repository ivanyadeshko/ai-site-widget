import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppDeps } from '../src/app.ts';
import { escalateDialog, TRANSCRIPT_POLL_DEADLINE_MS } from '../src/dialogs/escalate.ts';
import { findDialogById, insertDialog } from '../src/db/repositories/dialogs.ts';
import { listThreadTail } from '../src/db/repositories/messages.ts';
import { findWidgetByToken } from '../src/db/repositories/widgets.ts';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, truncateAll } from './helpers/db.ts';

const ORIGIN = 'https://shop.example';
const VISITOR = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;
let deps: AppDeps;

beforeEach(async () => {
  ({ app, core, pool, deps } = await buildTestApp());
  await truncateAll(pool);
});
afterEach(async () => { await app.close(); await core.stop(); await pool.end(); });

const TOKEN = { token: 'jwt-voice', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T11:00:00Z' };

const seedChatDialog = async (): Promise<{ token: string; id: string }> => {
  const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN], instructions: 'Ты консультант.' });
  const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
  await pool.query(
    `UPDATE dialogs SET core_session_ids='["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
            current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat' WHERE id=$1`, [dialog.id]);
  const seeded: Array<['user' | 'agent', string]> = [['user', 'Меня зовут Пётр'], ['agent', 'Здравствуйте, Пётр!']];
  for (const [seq, m] of seeded.entries()) {
    await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/messages`, headers: { origin: ORIGIN },
      payload: { visitor_key: VISITOR, role: m[0], text: m[1], seq: seq + 1 } });
  }
  return { token, id: dialog.id };
};

describe('POST /w/v1/:token/dialogs/:id/escalate', () => {
  it('полный успешный путь: end → poll до messages_count → voice continue_from', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });                       // 1. /end чата
    core.enqueue({ status: 200, body: { messages: [                  // 2. транскрипт добрал обе реплики
      { seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' },
      { seq: 2, role: 'agent', text: 'Здравствуйте, Пётр!', created_at: '2026-08-13T10:00:05Z' },
      // Третью реплику клиент в журнал не писал — она известна ТОЛЬКО ядру
      // (ответ аватара, до которого iframe не успел): на ней и проверяем, что
      // лента реально оседает в журнале, а не только дедупится.
      { seq: 3, role: 'agent', text: 'Чем могу помочь?', created_at: '2026-08-13T10:00:07Z' },
    ], has_more: false } });
    core.enqueue({ status: 201, body: { session_id: 'sess_bbbbbbbbbbbbbbbb', room: 'r', participant_token: TOKEN, continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      channel: 'voice', core_session_id: 'sess_bbbbbbbbbbbbbbbb',
      continued_from: 'sess_aaaaaaaaaaaaaaaa', transcript_complete: true,
    });

    expect(core.calls[0]!.url).toBe('/api/v1/sessions/sess_aaaaaaaaaaaaaaaa/end');
    expect(core.calls[1]!.url).toContain('/transcript');
    const created = core.calls[2]!.body as { channel: string; continue_from: string; agent: { instructions: string }; limits: { max_duration_s: number } };
    expect(created.channel).toBe('voice');
    expect(created.continue_from).toBe('sess_aaaaaaaaaaaaaaaa');
    expect(created.limits.max_duration_s).toBe(600);
    expect(created.agent.instructions).toContain('Ты консультант.');
    expect(created.agent.instructions).toContain('Посетитель: Меня зовут Пётр');
    expect(created.agent.instructions.length).toBeLessThanOrEqual(32_000);
    // ОТСТУПЛЕНИЕ ОТ БРИФА (факт, не вкус): в брифе стоял `:1`, но ключ
    // повторяемости считается как «сколько сессий уже привязано + 1»
    // (openSession.ts), а chat-сессия sess_aaaa… у этого диалога уже есть —
    // значит ВТОРАЯ операция и ключ `:2`. Тот же счёт зафиксирован в
    // caps.test.ts («ретрай POST /dialogs шлёт ТОТ ЖЕ Idempotency-Key» → `:2`).
    expect(core.calls[2]!.headers['idempotency-key']).toBe(`dlg:${id}:2`);

    const fresh = await findDialogById(pool, id);
    expect(fresh?.status).toBe('active');
    expect(fresh?.current_channel).toBe('voice');
    expect(fresh?.core_session_ids).toEqual(['sess_aaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbb']);
    // ОТСТУПЛЕНИЕ ОТ БРИФА (факт, не вкус): бриф ждал ДВЕ строки source='core'
    // на ленту из двух реплик — но `persistTranscript` (T2) намеренно дедупит
    // ленту против журнала клиента по тексту+роли в окне 900с, иначе посетитель
    // увидел бы каждую свою реплику дважды. Обе реплики ленты клиент уже
    // записал сам → в журнал ложится РОВНО ОДНА новая, известная только ядру.
    const thread = await listThreadTail(pool, id, 50);
    const fromCore = thread.filter((m) => m.source === 'core');
    expect(fromCore).toHaveLength(1);
    expect(fromCore[0]!.text).toBe('Чем могу помочь?');
    // И дедуп сработал: эхо ленты не задвоило уже записанные реплики.
    expect(thread.filter((m) => m.text === 'Меня зовут Пётр')).toHaveLength(1);
    expect(thread.filter((m) => m.text === 'Здравствуйте, Пётр!')).toHaveLength(1);
  });

  it('недобор ленты за 4с: последняя реплика посетителя уезжает в instructions', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    // ОТСТУПЛЕНИЕ ОТ БРИФА (факт, не вкус): в брифе стояло 12 ответов в
    // ОЧЕРЕДИ, но число опросов задаётся временем (дедлайн 4с / шаг 500мс), а
    // не сценарием — фактически их ~9, и три недоеденных ответа съезжали на
    // следующий вызов: создание сессии получало транскриптный 200 вместо
    // своего 201 и тест падал 422 вместо 201. Лента отдаёт только первую
    // реплику НА КАЖДОМ опросе — это и выражает стаб по url.
    core.stub('/transcript', { status: 200, body: { messages: [{ seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' }], has_more: false } });
    core.enqueue({ status: 201, body: { session_id: 'sess_bbbbbbbbbbbbbbbb', room: 'r', participant_token: TOKEN, continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });

    expect(res.statusCode).toBe(201);
    expect(res.json().transcript_complete).toBe(false);
    const created = core.calls.at(-1)!.body as { agent: { instructions: string } };
    expect(created.agent.instructions).toContain('Ещё не попавшая в историю последняя реплика посетителя');
    expect(created.agent.instructions).toContain('Меня зовут Пётр');
  });

  it('повторный /escalate во время эскалации → 409 escalation_in_progress, второй сессии НЕТ', async () => {
    const { token, id } = await seedChatDialog();
    await pool.query(`UPDATE dialogs SET status='escalating' WHERE id=$1`, [id]);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('escalation_in_progress');
    expect(core.calls).toHaveLength(0);
  });

  it('ГОНКА двух эскалаций: снимок ещё active, а в БД уже escalating → CAS не пускает ВТОРУЮ платную сессию', async () => {
    // Гард по статусу такую гонку не ловит ПРИНЦИПИАЛЬНО: в прочитанном
    // снимке диалог 'active', параллельный запрос переключил его уже ПОСЛЕ
    // чтения. Единственный, кто здесь стоит между посетителем и второй
    // покупкой, — CAS active→escalating, и это его собственная проба
    // (мутпроба 1 брифа: подмена CAS на setDialogStatus обязана валить ИМЕННО
    // этот тест — ручечный «повторный /escalate» после разделения кодов
    // отвечает раньше, на гарде статуса).
    const { token, id } = await seedChatDialog();
    const snapshot = await findDialogById(pool, id);
    expect(snapshot?.status).toBe('active');
    await pool.query(`UPDATE dialogs SET status='escalating' WHERE id=$1`, [id]);

    const widget = await findWidgetByToken(pool, token);
    await expect(escalateDialog(deps, {
      widget: widget!, dialog: snapshot!, messagesCount: 0, visitorKey: VISITOR, ipHash: 'хэш-ip',
    })).rejects.toMatchObject({ status: 409, code: 'escalation_in_progress' });
    expect(core.calls).toHaveLength(0);
  });

  it('лента доезжает НЕ с первого опроса: ждём до messages_count, а не берём первую страницу', async () => {
    // Мутпроба 4 брифа: «вернуть best сразу после первого запроса» обязана
    // валить именно этот тест — тест недобора остаётся зелёным и такую мутацию
    // не видит.
    const { token, id } = await seedChatDialog();
    const first = { seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' };
    const second = { seq: 2, role: 'agent', text: 'Здравствуйте, Пётр!', created_at: '2026-08-13T10:00:05Z' };
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 200, body: { messages: [first], has_more: false } });          // недобор
    core.enqueue({ status: 200, body: { messages: [first, second], has_more: false } });  // добрал
    core.enqueue({ status: 201, body: { session_id: 'sess_bbbbbbbbbbbbbbbb', room: 'r', participant_token: TOKEN, continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });

    expect(res.statusCode).toBe(201);
    expect(res.json().transcript_complete).toBe(true);
    expect(core.calls.filter((c) => c.url.includes('/transcript')).length).toBeGreaterThanOrEqual(2);
    // Лента добралась — довеска «недобранной реплики» в инструкциях быть не должно.
    const created = core.calls.at(-1)!.body as { agent: { instructions: string } };
    expect(created.agent.instructions).not.toContain('Ещё не попавшая в историю');
  });

  it('M2: messages_count без потолка = усилитель нагрузки на ядро → 422, ядро не тронуто', async () => {
    // Ревью: 1e9 задавал НЕДОСТИЖИМОЕ условие выхода из опроса — публичная
    // ручка держала сокет все 4с дедлайна и множила один запрос в ~9
    // обращений к чужому сервису.
    const { token, id } = await seedChatDialog();
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 1e9 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_messages_count');
    expect(core.calls).toHaveLength(0);
  });

  it('L1: has_more=true — опрос не выжигает дедлайн, а сразу уходит в ветку недобора', async () => {
    // Лента длиннее страницы: недостача не «ещё не осела», а наша
    // однастраничность — ждать 4с бессмысленно, это UX ни за что.
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 200, body: {
      messages: [{ seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' }],
      has_more: true,
    } });
    core.enqueue({ status: 201, body: { session_id: 'sess_bbbbbbbbbbbbbbbb', room: 'r', participant_token: TOKEN, continued_from: 'sess_aaaaaaaaaaaaaaaa' } });

    const started = Date.now();
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });

    expect(res.statusCode).toBe(201);
    expect(res.json().transcript_complete).toBe(false);
    expect(Date.now() - started).toBeLessThan(TRANSCRIPT_POLL_DEADLINE_MS);
    expect(core.calls.filter((c) => c.url.includes('/transcript'))).toHaveLength(1);
    // Недобор компенсирован тем же способом, что и по дедлайну.
    const created = core.calls.at(-1)!.body as { agent: { instructions: string } };
    expect(created.agent.instructions).toContain('Ещё не попавшая в историю');
  });

  it('L6: эскалация УЖЕ голосового диалога → 422 already_voice (иначе закрыли бы живой звонок и купили второй)', async () => {
    const { token, id } = await seedChatDialog();
    await pool.query(`UPDATE dialogs SET current_channel='voice' WHERE id=$1`, [id]);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('already_voice');
    expect(core.calls).toHaveLength(0); // живой звонок не тронут, второй не куплен
  });

  it('эскалация завершённого диалога → 409 dialog_not_active (ДРУГОЙ код: ждать бесполезно)', async () => {
    const { token, id } = await seedChatDialog();
    await pool.query(`UPDATE dialogs SET status='ended' WHERE id=$1`, [id]);
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('dialog_not_active');
    expect(core.calls).toHaveLength(0);
  });

  it('402 при создании голоса → 402, диалог в error', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 200, body: { messages: [], has_more: false } });
    core.enqueue({ status: 402, body: { error: { code: 'insufficient_credits', message: 'нет' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 0 } });
    expect(res.statusCode).toBe(402);
    expect((await findDialogById(pool, id))?.status).toBe('error');
  });

  it('503 при создании голоса → 503, диалог возвращается в active (фолбэк в чат возможен)', async () => {
    const { token, id } = await seedChatDialog();
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 200, body: { messages: [], has_more: false } });
    core.enqueue({ status: 503, body: { error: { code: 'service_unavailable', message: 'занято' } } });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 0 } });
    expect(res.statusCode).toBe(503);
    expect((await findDialogById(pool, id))?.status).toBe('active');
  });

  it('эскалировать нечего (сессии ядра у диалога нет) → 409 no_live_session, ядро не дёргается', async () => {
    // Гард дешёвый, но стоит на денежном пути: без него continue_from уехал бы
    // с null и мы бы купили голосовую сессию БЕЗ памяти разговора.
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 0 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_live_session');
    expect(core.calls).toHaveLength(0);
  });

  it('messages_count не число → 422', async () => {
    const { token, id } = await seedChatDialog();
    const res = await app.inject({ method: 'POST', url: `/w/v1/${token}/dialogs/${id}/escalate`,
      headers: { origin: ORIGIN }, payload: { visitor_key: VISITOR, messages_count: 'два' } });
    expect(res.statusCode).toBe(422);
  });
});
