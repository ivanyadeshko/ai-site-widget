import type { AppDeps } from '../app.ts';
import type { TranscriptMessage } from '../core/types.ts';
import type { DialogRow } from '../db/repositories/dialogs.ts';
import { hasSimilarMessage, insertMessage, promoteAgentReplyToCore } from '../db/repositories/messages.ts';

/** Окно, в котором реплика из ленты ядра считается той же, что уже в журнале. */
export const TRANSCRIPT_DEDUP_WINDOW_S = 900;

export type SyncResult = { fetched: number; stored: number; skipped: number };

/**
 * Положить ленту ядра в журнал БЕЗ дублей. Уникальный индекс тут бессилен: одна
 * и та же реплика приезжает двумя путями с разными ключами — от клиента
 * (source='client', его seq) и из ленты (source='core', seq ядра), — поэтому
 * дедупим по тексту+роли в окне.
 *
 * При совпадении расходимся по роли: реплику ПОСЕТИТЕЛЯ оставляем клиентской
 * (его точный ввод каноничнее STT-догадки ядра), а реплику АГЕНТА ПОВЫШАЕМ до
 * source='core' — подтверждённая копия ядра вытесняет оптимистичный client-лейбл
 * (иначе бейдж «не подтверждено» ложно горит на каждом ответе после reload).
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
      if (role === 'agent') {
        // Ядро авторитетнее для реплик АГЕНТА: клиент записал ответ ПЕРВЫМ
        // (source=client), лента ядра ВЫТЕСНЯЕТ этот лейбл на 'core'. Иначе
        // бейдж «не подтверждено» ложно горел бы на каждом ответе после reload.
        // Идемпотентно: уже-core строку повышать нечего (promoted=0 → skip).
        const promoted = await promoteAgentReplyToCore(deps.pool, {
          dialogId: input.dialog.id, text: message.text,
          coreSessionId: input.sessionId, windowSeconds: TRANSCRIPT_DEDUP_WINDOW_S,
        });
        if (promoted > 0) stored += 1; else skipped += 1;
        continue;
      }
      // Реплика ПОСЕТИТЕЛЯ: клиентская версия каноничнее (точный ввод) — оставляем.
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
    // Пагинация ОБЯЗАТЕЛЬНА: getTranscript отдаёт одну страницу (лимит
    // CoreClient — 500), а лента может быть длиннее. Без цикла по has_more
    // хвост длинного диалога молча обрезался бы — и не только здесь: эту же
    // функцию зовут T3 (re-enter живой сессии) и будущая T4 (эскалация),
    // так что дыра тянулась бы во все три сценария разом.
    let afterSeq = 0;
    for (;;) {
      const page = await deps.core!.getTranscript(input.sessionId, afterSeq);
      messages = messages.concat(page.messages);
      if (!page.has_more || page.messages.length === 0) break;
      afterSeq = page.messages[page.messages.length - 1]!.seq;
    }
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
