import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppDeps } from '../src/app.ts';
import { startSweeper, sweepOnce } from '../src/jobs/sweeper.ts';
import { findDialogById, insertDialog } from '../src/db/repositories/dialogs.ts';
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

describe('свипер зависших диалогов', () => {
  it('досинхронивает статус и деньги по карточке ядра', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', current_channel='chat',
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);

    core.enqueue({ status: 200, body: {
      session_id: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat', status: 'finalized',
      duration_s: 120, credits_total: 9, usage_summary: { chat_token: 800 },
    } });

    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(1);
    const fresh = await findDialogById(pool, dialog.id);
    expect(fresh?.status).toBe('ended');
    expect(fresh?.credits_total).toBe(9);
    expect(fresh?.usage).toEqual({ chat_token: 800 });
  });

  it('живую сессию не трогает', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa',
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);
    core.enqueue({ status: 200, body: { session_id: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat', status: 'active' } });
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect((await findDialogById(pool, dialog.id))?.status).toBe('active');
  });

  it('свежий диалог в выборку не попадает — ядро не дёргается', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(`UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa' WHERE id=$1`, [dialog.id]);
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect(core.calls).toHaveLength(0);
  });

  it('деньги не удваиваются, если вебхук уже приезжал', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id='sess_aaaaaaaaaaaaaaaa', status='ended',
              credits_total = 9, usage = '{"chat_token":800}'::jsonb,
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect(core.calls).toHaveLength(0); // ended в выборку не берём вовсе
  });

  // ── ФИКС-РАУНД 1 (M1): зомби не должны затыкать выборку ──────────────────
  // Выборка отсортирована по last_activity_at ASC, поэтому диалог, чью сессию
  // ядро не знает, возвращался ПЕРВЫМ на каждом проходе и вечно занимал место
  // в batch. Ревью воспроизвело: batch=3, synced=0, протухший не обработан.
  const seedStale = async (widgetId: string, sessionId: string, hoursAgo: number): Promise<string> => {
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await pool.query(
      `UPDATE dialogs SET current_core_session_id=$2, current_channel='chat',
              last_activity_at = now() - ($3 || ' hours')::interval WHERE id=$1`,
      [dialog.id, sessionId, String(hoursAgo)]);
    return dialog.id;
  };

  const FINALIZED = (sid: string) => ({
    session_id: sid, channel: 'chat', status: 'finalized',
    duration_s: 60, credits_total: 4, usage_summary: { chat_token: 100 },
  });

  it('M1: зомби (404 ядра) терминализуется в error и ОСВОБОЖДАЕТ выборку живому протухшему диалогу', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    // Два зомби СТАРШЕ живого — они и займут batch=2 на первом проходе.
    const zombie1 = await seedStale(widgetId, 'sess_zzzzzzzzzzzzzzz1', 9);
    const zombie2 = await seedStale(widgetId, 'sess_zzzzzzzzzzzzzzz2', 8);
    const real = await seedStale(widgetId, 'sess_aaaaaaaaaaaaaaaa', 5);

    core.enqueue({ status: 404, body: { error: { code: 'not_found', message: 'нет такой' } } });
    core.enqueue({ status: 404, body: { error: { code: 'not_found', message: 'нет такой' } } });
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 2 })).toBe(0);
    expect((await findDialogById(pool, zombie1))?.status).toBe('error');
    expect((await findDialogById(pool, zombie2))?.status).toBe('error');

    // Второй проход с тем же batch: зомби выбыли из выборки — живой обработан.
    // ДО фикса он не дождался бы своей очереди никогда.
    core.enqueue({ status: 200, body: FINALIZED('sess_aaaaaaaaaaaaaaaa') });
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 2 })).toBe(1);
    const fresh = await findDialogById(pool, real);
    expect(fresh?.status).toBe('ended');
    expect(fresh?.credits_total).toBe(4);
  });

  it('M1: транзиентная ошибка ядра НЕ терминализует — диалог ротируется в хвост и не блокирует batch', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const flaky = await seedStale(widgetId, 'sess_ffffffffffffffff', 9);
    const real = await seedStale(widgetId, 'sess_aaaaaaaaaaaaaaaa', 5);

    core.enqueue({ status: 503, body: { error: { code: 'service_unavailable', message: 'занято' } } });
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 1 })).toBe(0);
    // Статус НЕ тронут: сессия, возможно, жива — терминализовать её нельзя.
    expect((await findDialogById(pool, flaky))?.status).toBe('active');

    // Но метка активности сдвинута, поэтому batch=1 достаётся уже живому.
    core.enqueue({ status: 200, body: FINALIZED('sess_aaaaaaaaaaaaaaaa') });
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 1 })).toBe(1);
    expect((await findDialogById(pool, real))?.status).toBe('ended');
  });

  it('L2: деньги свёл вебхук — свипер закрывает статус, но досинком это НЕ считает', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const id = await seedStale(widgetId, 'sess_aaaaaaaaaaaaaaaa', 5);
    // Вебхук уже учёл эту сессию, а статус остался active (обработчик упал
    // сразу после applyFinalizedUsage — ровно тот сценарий, ради которого
    // свипер и заведён).
    await pool.query(
      `UPDATE dialogs SET settled_session_ids='["sess_aaaaaaaaaaaaaaaa"]'::jsonb,
              credits_total=9, usage='{"chat_token":800}'::jsonb WHERE id=$1`, [id]);
    core.enqueue({ status: 200, body: {
      session_id: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat', status: 'finalized',
      duration_s: 120, credits_total: 9, usage_summary: { chat_token: 800 },
    } });

    // 0, а не 1: по этому числу судят, много ли теряется вебхуков — рапорт о
    // работе, которой не было, обесценивает метрику.
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    const fresh = await findDialogById(pool, id);
    expect(fresh?.status).toBe('ended');   // статус свипер всё же закрыл
    expect(fresh?.credits_total).toBe(9);  // и денег не удвоил
  });

  // ── #3 (whole-branch адверсарий, деньги): досинк ВСЕХ сессий нити ──────────
  // Эскалация финализирует chat-сессию S1 и переключает current на voice S2.
  // Деньги S1 держатся только на вебхуке session.finalized; при его потере S1
  // навсегда выпадал из сверки — свипер смотрел лишь на «текущую» (=S2). Теперь
  // сводит любую сессию из core_session_ids, которой ещё нет в settled.
  it('#3: досинкивает несведённую ПРОШЛУЮ сессию эскалированной нити, не только текущую', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    // S1 (chat) финализирована и вытеснена из current; S2 (voice) стала текущей.
    // Вебхук S1 потерян: S1 в core_session_ids, но НЕ в settled. Деньги S2 уже
    // сведены (вебхук долетел), но статус не закрылся — ровно щель, ради которой
    // свипер и заведён.
    await pool.query(
      `UPDATE dialogs SET core_session_ids='["sess_1111111111111111","sess_2222222222222222"]'::jsonb,
              settled_session_ids='["sess_2222222222222222"]'::jsonb,
              current_core_session_id='sess_2222222222222222', current_channel='voice',
              credits_total=7, usage='{"voice_second":300}'::jsonb,
              last_activity_at = now() - interval '5 hours' WHERE id=$1`, [dialog.id]);

    // Стабим по session_id — порядок обхода нити тест не фиксирует.
    core.stub('/v1/sessions/sess_1111111111111111', { status: 200, body: {
      session_id: 'sess_1111111111111111', channel: 'chat', status: 'finalized',
      duration_s: 60, credits_total: 4, usage_summary: { chat_token: 800 } } });
    core.stub('/v1/sessions/sess_2222222222222222', { status: 200, body: {
      session_id: 'sess_2222222222222222', channel: 'voice', status: 'finalized',
      duration_s: 120, credits_total: 7, usage_summary: { voice_second: 300 } } });

    // synced=1: свёл РОВНО S1 (S2 уже был в settled → повторный settle не считается).
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(1);
    const fresh = await findDialogById(pool, dialog.id);
    expect(new Set(fresh?.settled_session_ids))
      .toEqual(new Set(['sess_2222222222222222', 'sess_1111111111111111']));
    expect(fresh?.status).toBe('ended'); // статус закрыт по терминальной текущей S2
    // Деньги S1 доложены к уже сведённым S2 (7+4), usage слит.
    expect(fresh?.credits_total).toBe(11);
    expect(fresh?.usage).toEqual({ voice_second: 300, chat_token: 800 });

    // Повторный проход — no-op: диалог уже ended, в выборку не попадает, деньги
    // не удваиваются.
    expect(await sweepOnce(deps, { staleMinutes: 120, batch: 10 })).toBe(0);
    expect((await findDialogById(pool, dialog.id))?.credits_total).toBe(11);
  });

  it('L8: крон свипера тикает сам и глохнет по stop()', async () => {
    const { id: widgetId } = await seedWidget(pool, { allowedOrigins: [ORIGIN] });
    await seedStale(widgetId, 'sess_aaaaaaaaaaaaaaaa', 5);
    // Живая сессия: карточка не терминальная, диалог остаётся в выборке —
    // значит КАЖДЫЙ тик обязан сходить в ядро, и по числу вызовов видно, что
    // таймер жив (и что он замолчал после stop()).
    core.stub('/v1/sessions/', { status: 200, body: { session_id: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat', status: 'active' } });

    const sweeper = startSweeper(deps, { intervalMs: 20, staleMinutes: 120, batch: 10 });
    const deadline = Date.now() + 5_000;
    while (core.calls.length < 2 && Date.now() < deadline) await sleep(20);
    expect(core.calls.length).toBeGreaterThanOrEqual(2); // тикает сам

    sweeper.stop();
    await sleep(60); // дожидаемся хвоста уже стартовавшего прохода
    const afterStop = core.calls.length;
    await sleep(120); // ≈6 пропущенных тиков
    expect(core.calls.length).toBe(afterStop); // молчит
  });
});
