import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppDeps } from '../src/app.ts';
import { sweepOnce } from '../src/jobs/sweeper.ts';
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
});
