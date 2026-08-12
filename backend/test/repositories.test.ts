import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedWidget, testPool, truncateAll } from './helpers/db.ts';
import { findWidgetByToken } from '../src/db/repositories/widgets.ts';
import { attachCoreSession, casDialogStatus, countDialogsStartedByVisitor, findDialogByClientReference, insertDialog } from '../src/db/repositories/dialogs.ts';
import { hasSimilarMessage, insertMessage, listThreadTail, maxClientSeq } from '../src/db/repositories/messages.ts';
import { insertCoreEvent } from '../src/db/repositories/coreEvents.ts';
import { bumpIpDayCounter } from '../src/db/repositories/quotas.ts';

const pool = testPool();
beforeEach(() => truncateAll(pool));
afterAll(() => pool.end());

const VISITOR = '11111111-1111-4111-8111-111111111111';

describe('репозитории', () => {
  it('виджет находится по publish_token, JSONB приезжает разобранным', async () => {
    const { token } = await seedWidget(pool, { allowedOrigins: ['https://a.example'] });
    const widget = await findWidgetByToken(pool, token);
    expect(widget?.allowed_origins).toEqual(['https://a.example']);
    expect(widget?.agent_config.instructions).toBe('Ты консультант сайта.');
    expect(await findWidgetByToken(pool, 'нет-такого')).toBeNull();
  });

  it('client_reference диалога — widget:dialog:{id}, свежий диалог без привязанных сессий', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(dialog.client_reference).toBe(`widget:dialog:${dialog.id}`);
    expect(await findDialogByClientReference(pool, dialog.client_reference)).not.toBeNull();
    // Ключ повторяемости считается от ДЛИНЫ core_session_ids, отдельного
    // счётчика нет: два источника правды разъехались бы на первом же ретрае.
    expect(dialog.core_session_ids).toEqual([]);
    expect(dialog.settled_session_ids).toEqual([]);
  });

  it('attachCoreSession копит историю сессий и переключает текущую', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_aaaaaaaaaaaaaaaa', channel: 'chat' });
    await attachCoreSession(pool, { dialogId: dialog.id, sessionId: 'sess_bbbbbbbbbbbbbbbb', channel: 'voice' });
    const fresh = await findDialogByClientReference(pool, dialog.client_reference);
    expect(fresh?.core_session_ids).toEqual(['sess_aaaaaaaaaaaaaaaa', 'sess_bbbbbbbbbbbbbbbb']);
    expect(fresh?.current_core_session_id).toBe('sess_bbbbbbbbbbbbbbbb');
    expect(fresh?.current_channel).toBe('voice');
  });

  it('casDialogStatus переводит статус ТОЛЬКО из ожидаемого — защита от двойной эскалации', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(await casDialogStatus(pool, dialog.id, 'active', 'escalating')).toBe(true);
    expect(await casDialogStatus(pool, dialog.id, 'active', 'escalating')).toBe(false);
  });

  it('журнал идемпотентен по (dialog, source, session, seq)', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    const row = { dialogId: dialog.id, role: 'user' as const, text: 'Меня зовут Пётр', source: 'client' as const, coreSessionId: null, seq: 1 };
    expect(await insertMessage(pool, row)).toBe(true);
    expect(await insertMessage(pool, row)).toBe(false);
    expect((await listThreadTail(pool, dialog.id, 10)).length).toBe(1);
  });

  it('listThreadTail отдаёт ХВОСТ в хронологическом порядке', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    for (let seq = 1; seq <= 5; seq += 1) {
      await insertMessage(pool, { dialogId: dialog.id, role: 'user', text: `реплика ${seq}`, source: 'client', coreSessionId: null, seq });
    }
    const tail = await listThreadTail(pool, dialog.id, 2);
    expect(tail.map((m) => m.text)).toEqual(['реплика 4', 'реплика 5']);
  });

  it('maxClientSeq продолжает нумерацию клиента и не считает реплики ядра', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(await maxClientSeq(pool, dialog.id)).toBe(0);
    await insertMessage(pool, { dialogId: dialog.id, role: 'user', text: 'раз', source: 'client', coreSessionId: null, seq: 7 });
    await insertMessage(pool, { dialogId: dialog.id, role: 'agent', text: 'два', source: 'core', coreSessionId: 'sess_x', seq: 99 });
    expect(await maxClientSeq(pool, dialog.id)).toBe(7);
  });

  it('hasSimilarMessage ловит ту же реплику, приехавшую вторым путём', async () => {
    const { id: widgetId } = await seedWidget(pool);
    const dialog = await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertMessage(pool, { dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр', source: 'client', coreSessionId: null, seq: 1 });
    // Регистр и лишние пробелы не должны мешать: ядро отдаёт свой вариант текста.
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'user', text: '  меня  зовут пётр ', windowSeconds: 600 })).toBe(true);
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'agent', text: 'Меня зовут Пётр', windowSeconds: 600 })).toBe(false);
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'user', text: 'другое', windowSeconds: 600 })).toBe(false);
    expect(await hasSimilarMessage(pool, { dialogId: dialog.id, role: 'user', text: 'Меня зовут Пётр', windowSeconds: 0 })).toBe(false);
  });

  it('core_events дедупятся по event_id', async () => {
    expect(await insertCoreEvent(pool, { eventId: 'evt_1', type: 'session.finalized', payload: { a: 1 } })).toBe(true);
    expect(await insertCoreEvent(pool, { eventId: 'evt_1', type: 'session.finalized', payload: { a: 1 } })).toBe(false);
  });

  it('счётчики капов считают за сутки', async () => {
    const { id: widgetId } = await seedWidget(pool);
    await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    await insertDialog(pool, { widgetId, visitorKey: VISITOR });
    expect(await countDialogsStartedByVisitor(pool, VISITOR)).toBe(2);
    expect(await bumpIpDayCounter(pool, 'hash-a')).toBe(1);
    expect(await bumpIpDayCounter(pool, 'hash-a')).toBe(2);
    expect(await bumpIpDayCounter(pool, 'hash-b')).toBe(1);
  });
});
