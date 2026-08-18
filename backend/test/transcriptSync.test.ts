import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { CoreClient } from '../src/core/client.ts';
import { persistTranscript, reconcileTranscript } from '../src/dialogs/transcriptSync.ts';
import { attachCoreSession, insertDialog, type DialogRow } from '../src/db/repositories/dialogs.ts';
import { insertMessage, listThreadTail } from '../src/db/repositories/messages.ts';
import { FakeCore } from './helpers/fakeCore.ts';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';

const pool = testPool();
let app: FastifyInstance;
let core: FakeCore;

beforeAll(async () => {
  core = new FakeCore();
  await core.start();
  app = await buildApp({
    config: {
      port: 8200, databaseUrl: process.env.DATABASE_URL!, coreBaseUrl: core.baseUrl,
      coreTenantKey: 'sk_test_x', coreWebhookSecret: 'секрет-длиной-больше-шестнадцати',
      publicOrigin: 'http://localhost:8200', cspConnectSrc: "'self'", ipHashSalt: 'соль',
      maxDialogsPerVisitorPerDay: 10, maxDialogsPerIpPerDay: 30, maxDurationS: 600,
      maxSessionsPerAccountPerDay: 300,
      trustProxy: false, logLevel: 'silent',
      sessionTtlDays: 30, panelOrigin: 'http://localhost:8200', cookieSecure: false,
      cdnOrigin: 'http://localhost:8200',
      loginMaxFailures: 10, loginLockMinutes: 15,
    },
    pool,
    core: new CoreClient({ baseUrl: core.baseUrl, tenantKey: 'sk_test_x', timeoutMs: 2000 }),
  });
});
beforeEach(async () => {
  core.resetQueue(); // см. FakeCore.resetQueue: не даём недоразобранным ответам утечь между тестами
  await truncateAll(pool);
});
afterAll(async () => { await app.close(); await core.stop(); await pool.end(); });

async function makeDialog(sessionId: string): Promise<DialogRow> {
  const { id: widgetId } = await seedWidget(pool);
  const dialog = await insertDialog(pool, { widgetId, visitorKey: '11111111-1111-4111-8111-111111111111' });
  await attachCoreSession(pool, { dialogId: dialog.id, sessionId, channel: 'chat' });
  return dialog;
}

describe('persistTranscript', () => {
  it('кладёт новые реплики ленты как source=core с привязкой к сессии', async () => {
    const dialog = await makeDialog('sess_0123456789abcdef');
    const result = await persistTranscript(app.deps, {
      dialog, sessionId: 'sess_0123456789abcdef',
      messages: [
        { seq: 1, role: 'user', text: 'Привет', created_at: '2026-08-13T10:00:00Z' },
        { seq: 2, role: 'agent', text: 'Здравствуйте!', created_at: '2026-08-13T10:00:05Z' },
      ],
    });
    expect(result).toEqual({ fetched: 2, stored: 2, skipped: 0 });
    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows.map((r) => [r.text, r.source, r.core_session_id])).toEqual([
      ['Привет', 'core', 'sess_0123456789abcdef'],
      ['Здравствуйте!', 'core', 'sess_0123456789abcdef'],
    ]);
  });

  it('пропускает реплику, уже записанную клиентским путём (дедуп по тексту+роли в окне)', async () => {
    const dialog = await makeDialog('sess_0123456789abcdef');
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр',
      source: 'client', coreSessionId: null, seq: 1,
    });
    const result = await persistTranscript(app.deps, {
      dialog, sessionId: 'sess_0123456789abcdef',
      messages: [{ seq: 1, role: 'user', text: 'Меня зовут Пётр', created_at: '2026-08-13T10:00:00Z' }],
    });
    expect(result).toEqual({ fetched: 1, stored: 0, skipped: 1 });
    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows).toHaveLength(1); // задвоения нет
    expect(rows[0]!.source).toBe('client'); // осталась клиентская версия
  });

  it('ответ АГЕНТА, записанный клиентом, ПОВЫШАЕТСЯ до source=core лентой ядра (не остаётся client)', async () => {
    const dialog = await makeDialog('sess_0123456789abcdef');
    // Клиент оптимистично записал ответ агента своим путём (source=client).
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'agent', text: 'Здравствуйте!',
      source: 'client', coreSessionId: null, seq: 1,
    });
    const result = await persistTranscript(app.deps, {
      dialog, sessionId: 'sess_0123456789abcdef',
      messages: [{ seq: 7, role: 'agent', text: 'Здравствуйте!', created_at: '2026-08-13T10:00:05Z' }],
    });
    expect(result).toEqual({ fetched: 1, stored: 1, skipped: 0 }); // повышение = «сложили в core»
    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows).toHaveLength(1); // дубля НЕТ
    expect(rows[0]!.source).toBe('core'); // лейбл повышен ядром
    expect(rows[0]!.core_session_id).toBe('sess_0123456789abcdef');
    expect(rows[0]!.seq).toBe(7); // ФИКС-РАУНД 2: seq повышен до СОБСТВЕННОГО core-seq (7), не остался клиентским (1)

    // Идемпотентность: повторный core-транскрипт не плодит дубль и не роняет лейбл.
    const again = await persistTranscript(app.deps, {
      dialog, sessionId: 'sess_0123456789abcdef',
      messages: [{ seq: 7, role: 'agent', text: 'Здравствуйте!', created_at: '2026-08-13T10:00:05Z' }],
    });
    expect(again).toEqual({ fetched: 1, stored: 0, skipped: 1 }); // уже core — повышать нечего
    const rows2 = await listThreadTail(pool, dialog.id, 50);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.source).toBe('core');
  });

  it('ФИКС-РАУНД 2: промоут проставляет core-seq — независимая реплика ядра с тем же числом НЕ теряется', async () => {
    const dialog = await makeDialog('sess_0123456789abcdef');
    // Клиент оптимистично записал ответ агента "Hello" со СВОИМ seq=4.
    await insertMessage(pool, {
      dialogId: dialog.id, role: 'agent', text: 'Hello',
      source: 'client', coreSessionId: null, seq: 4,
    });
    // Лента ядра: "Hello" со СВОИМ core-seq=1 (промоутится), И независимая "World"
    // с core-seq=4 — то же число, что клиентский seq у "Hello". Без повышения seq
    // промоут занял бы (core, sess, 4), а вставка "World" (core, sess, 4) молча
    // дропнулась бы по dedup-индексу → перманентная потеря реальной реплики.
    const result = await persistTranscript(app.deps, {
      dialog, sessionId: 'sess_0123456789abcdef',
      messages: [
        { seq: 1, role: 'agent', text: 'Hello', created_at: '2026-08-13T10:00:00Z' },
        { seq: 4, role: 'agent', text: 'World', created_at: '2026-08-13T10:00:05Z' },
      ],
    });
    expect(result).toEqual({ fetched: 2, stored: 2, skipped: 0 }); // ОБЕ прошли
    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows.map((r) => [r.text, r.source, r.seq])).toEqual([
      ['Hello', 'core', 1], // повышен в СВОЙ core-seq=1 (не остался клиентским 4)
      ['World', 'core', 4], // независимая реплика ядра сохранена, не съедена коллизией
    ]);
  });
});

describe('reconcileTranscript', () => {
  it('однa страница: тянет ленту у ядра и складывает в журнал', async () => {
    const dialog = await makeDialog('sess_0123456789abcdef');
    const before = core.calls.length; // FakeCore живёт весь файл — calls не сбрасывается между тестами
    core.enqueue({ status: 200, body: { messages: [
      { seq: 1, role: 'user', text: 'Привет', created_at: '2026-08-13T10:00:00Z' },
    ], has_more: false } });

    const result = await reconcileTranscript(app.deps, { dialog, sessionId: 'sess_0123456789abcdef' });
    expect(result).toEqual({ fetched: 1, stored: 1, skipped: 0 });
    expect(core.calls.length - before).toBe(1);
    expect(core.calls[before]!.url).toBe('/api/v1/sessions/sess_0123456789abcdef/transcript?after_seq=0&limit=500');
  });

  it('пагинация: несколько страниц (has_more) собираются в одну полную ленту', async () => {
    const dialog = await makeDialog('sess_pag');
    const before = core.calls.length;
    core.enqueue({ status: 200, body: { messages: [
      { seq: 1, role: 'user', text: 'A', created_at: '2026-08-13T10:00:00Z' },
      { seq: 2, role: 'agent', text: 'B', created_at: '2026-08-13T10:00:01Z' },
    ], has_more: true } });
    core.enqueue({ status: 200, body: { messages: [
      { seq: 3, role: 'user', text: 'C', created_at: '2026-08-13T10:00:02Z' },
    ], has_more: false } });

    const result = await reconcileTranscript(app.deps, { dialog, sessionId: 'sess_pag' });
    expect(result).toEqual({ fetched: 3, stored: 3, skipped: 0 });

    // Вторая страница запрошена с after_seq = seq последней реплики первой страницы.
    expect(core.calls.length - before).toBe(2);
    expect(core.calls[before]!.url).toBe('/api/v1/sessions/sess_pag/transcript?after_seq=0&limit=500');
    expect(core.calls[before + 1]!.url).toBe('/api/v1/sessions/sess_pag/transcript?after_seq=2&limit=500');

    const rows = await listThreadTail(pool, dialog.id, 50);
    expect(rows.map((r) => r.text)).toEqual(['A', 'B', 'C']);
  });

  it('ядро недоступно: возвращает нулевой SyncResult, а не бросает исключение', async () => {
    const dialog = await makeDialog('sess_down');
    core.enqueue({ status: 503, body: 'сервис недоступен' });
    const result = await reconcileTranscript(app.deps, { dialog, sessionId: 'sess_down' });
    expect(result).toEqual({ fetched: 0, stored: 0, skipped: 0 });
  });
});
