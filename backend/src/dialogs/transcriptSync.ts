import type { AppDeps } from '../app.ts';
import type { TranscriptMessage } from '../core/types.ts';
import type { DialogRow } from '../db/repositories/dialogs.ts';
import { hasSimilarMessage, insertMessage } from '../db/repositories/messages.ts';

/** Окно, в котором реплика из ленты ядра считается той же, что уже в журнале. */
export const TRANSCRIPT_DEDUP_WINDOW_S = 900;

export type SyncResult = { fetched: number; stored: number; skipped: number };

/**
 * Положить ленту ядра в журнал БЕЗ дублей. Уникальный индекс тут бессилен: одна
 * и та же реплика приезжает двумя путями с разными ключами — от клиента
 * (source='client', его seq) и из ленты (source='core', seq ядра), — поэтому
 * дедупим по тексту+роли в окне. Витрина склеивается, а source остаётся, чтобы
 * на разборе инцидента было видно, кто что принёс.
 */
export async function persistTranscript(
  deps: AppDeps,
  input: { dialog: DialogRow; sessionId: string; messages: TranscriptMessage[] },
): Promise<SyncResult> {
  let stored = 0;
  let skipped = 0;
  for (const message of input.messages) {
    const role = message.role === 'agent' ? 'agent' : 'user';
    if (await hasSimilarMessage(deps.pool, {
      dialogId: input.dialog.id, role, text: message.text, windowSeconds: TRANSCRIPT_DEDUP_WINDOW_S,
    })) {
      skipped += 1;
      continue;
    }
    if (await insertMessage(deps.pool, {
      dialogId: input.dialog.id, role, text: message.text,
      source: 'core', coreSessionId: input.sessionId, seq: message.seq,
    })) stored += 1;
    else skipped += 1;
  }
  return { fetched: input.messages.length, stored, skipped };
}

/** Сверка на финализации: тянем ленту сами и докладываем расхождение. */
export async function reconcileTranscript(
  deps: AppDeps,
  input: { dialog: DialogRow; sessionId: string; expected?: number },
): Promise<SyncResult> {
  let messages: TranscriptMessage[] = [];
  try {
    messages = (await deps.core!.getTranscript(input.sessionId)).messages;
  } catch (err) {
    deps.log.warn({ err, sessionId: input.sessionId }, 'сверка: ленту получить не удалось');
    return { fetched: 0, stored: 0, skipped: 0 };
  }
  const result = await persistTranscript(deps, { dialog: input.dialog, sessionId: input.sessionId, messages });
  if (input.expected !== undefined && input.expected !== messages.length) {
    deps.log.warn(
      { sessionId: input.sessionId, expected: input.expected, got: messages.length },
      'сверка: message_count вебхука разошёлся с лентой',
    );
  }
  if (result.stored > 0) {
    deps.log.info({ sessionId: input.sessionId, ...result }, 'сверка: журнал дополнен репликами из ленты ядра');
  }
  return result;
}
