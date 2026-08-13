import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppDeps } from '../src/app.ts';
import { insertDialog } from '../src/db/repositories/dialogs.ts';
import { findWidgetByToken } from '../src/db/repositories/widgets.ts';
import { openCoreSession } from '../src/dialogs/openSession.ts';
import { buildTestApp } from './helpers/app.ts';
import type { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, truncateAll } from './helpers/db.ts';

const ORIGIN = 'https://shop.example';
const VISITOR = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let core: FakeCore;
let pool: Pool;
let deps: AppDeps;

const CREATED = (sid: string) => ({
  session_id: sid, room: 'r',
  participant_token: { token: 'jwt', identity: 'respondent-core', livekit_url: 'wss://lk.example', expires_at: '2026-08-13T10:00:00Z' },
});

beforeEach(async () => {
  ({ app, core, pool, deps } = await buildTestApp({ maxDialogsPerVisitorPerDay: 2, maxDialogsPerIpPerDay: 3 }));
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

  it('РЕГРЕССИЯ фикс-раунда 1: повторные продолжения ОДНОГО диалога тоже упираются в кап — раньше капа считала строки dialogs (одна на диалог) и продолжение нити её не бампало, что дало воспроизвести 11 платных сессий при капе 2', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });

    core.enqueue({ status: 201, body: CREATED('sess_0000000000000001') });
    const first = await post(token, { visitor_key: VISITOR });
    expect(first.statusCode).toBe(201);
    const dialogId = first.json().dialog_id as string;

    // Второе обращение — продолжение ТОГО ЖЕ диалога (баннер «Продолжить»
    // после silence). Строка dialogs всё та же одна, но это ВТОРАЯ платная
    // сессия ядра — кап (=2) обязан это увидеть.
    core.enqueue({ status: 204, body: null }); // /end предыдущей
    core.enqueue({ status: 201, body: CREATED('sess_0000000000000002') });
    const second = await post(token, { visitor_key: VISITOR, dialog_id: dialogId });
    expect(second.statusCode).toBe(201);

    // Третье продолжение ТОГО ЖЕ единственного диалога — кап обязан сработать
    // здесь, а не позволить бесконечно платить за одну строку dialogs.
    const third = await post(token, { visitor_key: VISITOR, dialog_id: dialogId });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('visitor_daily_cap');

    // Капа сработала ДО дозвона в ядро — ни /end, ни новой сессии на третьей попытке.
    expect(core.calls).toHaveLength(3); // 1 create + 1 end + 1 create, третья попытка ядро не тронула
    const creates = core.calls.filter((c) => c.url === '/api/v1/sessions');
    expect(creates).toHaveLength(2); // ровно 2 платные сессии на единственном диалоге
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

  it('X-Forwarded-For при trustProxy=false логирует РОВНО ОДИН диагностический warn за жизнь инстанса (не флудит лог)', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const warnSpy = vi.spyOn(app.log, 'warn');
    core.enqueue({ status: 201, body: CREATED('sess_1234567890123456') });
    core.enqueue({ status: 201, body: CREATED('sess_6543210987654321') });
    await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '1.2.3.4' }, payload: { visitor_key: VISITOR },
    });
    await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`,
      headers: { origin: ORIGIN, 'x-forwarded-for': '1.2.3.4' }, payload: { visitor_key: randomUUID() },
    });
    const xffWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('X-Forwarded-For'),
    );
    expect(xffWarnings).toHaveLength(1);
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

  // ── ФИКС-РАУНД 1 (M3): квота списывается по ФАКТУ созданной сессии ────────
  // Ревью нашло двойное списание: бамп стоял ПЕРЕД попыткой, а ключ
  // повторяемости на то и заведён, чтобы ретрай получил ТУ ЖЕ сессию —
  // посетитель с плохой сетью выжигал суточную квоту, не купив ничего.
  const visitorCounter = async (): Promise<number> => {
    const { rows } = await pool.query<{ started: number }>(
      `SELECT started FROM visitor_day_counters WHERE visitor_key = $1 AND day = current_date`, [VISITOR]);
    return rows[0]?.started ?? 0;
  };

  it('M3: ретрай с ТЕМ ЖЕ Idempotency-Key списывает квоту ОДИН раз, а не за каждую попытку', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET core_session_ids='["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
              current_core_session_id='sess_aaaaaaaaaaaaaaaa', status='ended' WHERE id=$1`, [dialog.id]);
    const cont = () => app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs`, headers: { origin: ORIGIN },
      remoteAddress: '203.0.113.20', payload: { visitor_key: VISITOR, dialog_id: dialog.id },
    });

    // Попытка 1: /end прошёл, создание оборвалось — СЕССИИ НЕТ, платить не за что.
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 503, body: { error: { code: 'service_unavailable', message: 'ой' } } });
    expect((await cont()).statusCode).toBe(503);
    expect(await visitorCounter()).toBe(0);

    // Попытка 2: ТОТ ЖЕ ключ, ядро отдаёт сессию — вот теперь платим. Один раз.
    core.enqueue({ status: 204, body: null });
    core.enqueue({ status: 201, body: { ...CREATED('sess_bbbbbbbbbbbbbbbb'), continued_from: 'sess_aaaaaaaaaaaaaaaa' } });
    expect((await cont()).statusCode).toBe(201);
    expect(await visitorCounter()).toBe(1);

    const creates = core.calls.filter((c) => c.url === '/api/v1/sessions');
    expect(creates[0]!.headers['idempotency-key']).toBe(creates[1]!.headers['idempotency-key']);
  });

  it('M3: ядро вернуло ТУ ЖЕ сессию (реплей по ключу) — второго списания нет, а РАЗНАЯ сессия платится честно', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const widget = await findWidgetByToken(pool, token);
    const args = {
      widget: widget!, dialog, channel: 'chat' as const, instructions: 'и',
      visitorKey: VISITOR, ipHash: 'хэш-ip',
    };

    core.enqueue({ status: 201, body: CREATED('sess_dddddddddddddddd') });
    await openCoreSession(deps, args);
    expect(await visitorCounter()).toBe(1);

    // Тот же снимок диалога и тот же ключ — idempotency-хранилище ядра отдаёт
    // УЖЕ созданную сессию. Платная сущность одна: счётчик стоит на месте.
    core.enqueue({ status: 201, body: CREATED('sess_dddddddddddddddd') });
    await openCoreSession(deps, args);
    expect(await visitorCounter()).toBe(1);

    // Обратный кейс: сессия ДРУГАЯ — это честная вторая покупка.
    core.enqueue({ status: 201, body: CREATED('sess_eeeeeeeeeeeeeeee') });
    await openCoreSession(deps, args);
    expect(await visitorCounter()).toBe(2);
  });

  it('кап считает и ЭСКАЛАЦИЮ: она создаёт платную сессию так же, как старт (квота выбрана ДВУМЯ РЕАЛЬНЫМИ сессиями, не строками dialogs)', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    core.enqueue({ status: 201, body: CREATED('sess_1111111111111111') });
    core.enqueue({ status: 201, body: CREATED('sess_2222222222222222') });
    let dialogId = '';
    for (let i = 0; i < 2; i += 1) {
      const res = await post(token, { visitor_key: VISITOR });
      expect(res.statusCode).toBe(201);
      dialogId = res.json().dialog_id as string;
    }
    const denied = await app.inject({
      method: 'POST', url: `/w/v1/${token}/dialogs/${dialogId}/escalate`,
      headers: { origin: ORIGIN }, remoteAddress: '203.0.113.11',
      payload: { visitor_key: VISITOR, messages_count: 0 },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('visitor_daily_cap');
    expect(core.calls).toHaveLength(2); // ровно 2 старта — эскалацию ядро не тронуло вообще
  });

  // T4 заменил тело 501-заглушки настоящей эскалацией, и прежняя формулировка
  // этого теста («заглушка НЕ бампает капы») стала неверной по существу:
  // реальный путь создаёт платную сессию ядра и ОБЯЗАН тратить квоту наравне
  // со стартом (решение №3 плана; это проверяет тест выше). Сохраняем то, что
  // осталось истинным и ценным: отказ ГАРДА — до единого обращения к ядру — не
  // должен стоить визитору суточной квоты. Тест пиннит ПОРЯДОК внутри
  // escalateDialog: проверка статуса стоит ПЕРЕД ensureSessionBudget; перенос
  // бампа выше гарда снова начнёт съедать квоту на ретраях клиентской FSM.
  it('отказ ГАРДА на /escalate НЕ бампает капы: ретраи FSM по неэскалируемому диалогу не съедают чужую квоту', async () => {
    const { token, id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat',
              status='ended' WHERE id=$1`,
      [dialog.id],
    );

    // Пять «ретраев» клиентской FSM в диалог, который эскалировать нельзя, —
    // визитор ещё НИ РАЗУ не создавал реальную сессию, капа (=2) не трогается.
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST', url: `/w/v1/${token}/dialogs/${dialog.id}/escalate`,
        headers: { origin: ORIGIN }, remoteAddress: '203.0.113.12',
        payload: { visitor_key: VISITOR, messages_count: 0 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('dialog_not_active');
    }
    expect(core.calls).toHaveLength(0); // ядро на этом пути не трогали вовсе
    // После пяти отказов визитор всё ещё может СТАРТОВАТЬ диалог дважды —
    // счётчик не бампался НИ РАЗУ.
    core.enqueue({ status: 201, body: CREATED('sess_bbbbbbbbbbbbbbbb') });
    core.enqueue({ status: 201, body: CREATED('sess_cccccccccccccccc') });
    expect((await post(token, { visitor_key: VISITOR }, '203.0.113.12')).statusCode).toBe(201);
    expect((await post(token, { visitor_key: VISITOR }, '203.0.113.12')).statusCode).toBe(201);
  });
});
