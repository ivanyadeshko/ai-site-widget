import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import {
  findDialogById, insertDialog, setDialogStatus, type DialogRow,
} from '../db/repositories/dialogs.ts';
import { listThreadTail, maxClientSeq, type MessageRow } from '../db/repositories/messages.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, mapCoreError } from '../http/errors.ts';
import type { ParticipantToken } from '../core/types.ts';
import { checkSessionBudget } from './budget.ts';
import { openCoreSession } from './openSession.ts';

export type PublicMessage = { role: 'user' | 'agent'; text: string; seq: number; source: 'client' | 'core'; created_at: string };

export const toPublicMessage = (row: MessageRow): PublicMessage => ({
  role: row.role, text: row.text, seq: row.seq, source: row.source, created_at: row.created_at.toISOString(),
});

export type StartDialogInput = { widget: WidgetRow; visitorKey: string; ipHash: string; dialogId?: string };
export type StartDialogResult = {
  dialog_id: string; channel: 'chat'; participant_token: ParticipantToken;
  continued_from?: string; messages: PublicMessage[]; next_seq: number;
  /**
   * Нить продолжена, но ядро не смогло отдать новой сессии память
   * предшественника — аватар начнёт с чистого листа. Журнал у клиента цел,
   * поэтому это не ошибка, а повод сказать посетителю правду (L5).
   */
  history_lost?: boolean;
};

export const MESSAGES_PAGE = 200;

export async function startDialog(deps: AppDeps, input: StartDialogInput): Promise<StartDialogResult> {
  // ДОПУСК до денег: сессия ядра — единственное, что жжёт кредиты. Само
  // СПИСАНИЕ квоты живёт в openCoreSession и происходит по факту НОВОЙ сессии
  // (M3): бамп-перед-попыткой списывал дважды за одну сессию на ретраях.
  await checkSessionBudget(deps, {
    visitorKey: input.visitorKey, ipHash: input.ipHash, accountId: input.widget.account_id,
  });

  let dialog: DialogRow;
  let continueFrom: string | undefined;

  if (input.dialogId) {
    const existing = await findDialogById(deps.pool, input.dialogId);
    // Чужой/несуществующий/из другого виджета — один и тот же ответ: не оракул.
    if (!existing || existing.widget_id !== input.widget.id || existing.visitor_key !== input.visitorKey) {
      throw new ApiError(404, 'dialog_not_found', 'Диалог не найден.');
    }
    if (existing.status === 'error') {
      throw new ApiError(409, 'dialog_unusable', 'Диалог завершился ошибкой — начните новый.');
    }
    const last = existing.current_core_session_id ?? existing.core_session_ids.at(-1) ?? null;
    if (last) {
      // continue_from требует ЗАВЕРШЁННУЮ сессию; своя же незакрытая дала бы 422.
      // ФИКС-РАУНД 1: этот вызов раньше не был обёрнут — недоступность ядра
      // здесь падала НЕ пойманным CoreHttpError и уходила в 500 internal
      // (центральный путь «Продолжить» после silence). mapCoreError отдаёт
      // клиенту то же 502/503/504, что и остальные обращения к ядру.
      try {
        await deps.core.endSession(last);
      } catch (err) {
        if (err instanceof CoreHttpError) throw mapCoreError(err);
        throw err;
      }
      continueFrom = last;
    }
    dialog = existing;
  } else {
    dialog = await insertDialog(deps.pool, { widgetId: input.widget.id, visitorKey: input.visitorKey });
  }

  try {
    const opened = await openCoreSession(deps, {
      widget: input.widget, dialog, channel: 'chat',
      instructions: input.widget.agent_config.instructions,
      visitorKey: input.visitorKey, ipHash: input.ipHash,
      // Продолжение нити — единственный путь, где память ЖЕЛАТЕЛЬНА, но не
      // обязательна: отказ ядра продолжить сессию не должен превращать диалог
      // в кирпич (L5). На первичном старте continueFrom нет и флаг не нужен.
      ...(continueFrom ? { continueFrom, historyOptional: true } : {}),
    });
    await setDialogStatus(deps.pool, dialog.id, 'active');
    const rows = await listThreadTail(deps.pool, dialog.id, MESSAGES_PAGE);
    return {
      dialog_id: dialog.id, channel: 'chat', participant_token: opened.participant_token,
      ...(opened.continued_from ? { continued_from: opened.continued_from } : {}),
      ...(opened.history_lost ? { history_lost: true } : {}),
      messages: rows.map(toPublicMessage),
      // Клиент продолжает нумерацию журнала отсюда: после reload у него свой
      // счётчик обнулился бы, и новые реплики затирались бы дедупом по (seq).
      next_seq: (await maxClientSeq(deps.pool, dialog.id)) + 1,
    };
  } catch (err) {
    if (err instanceof CoreHttpError) {
      // 402 — денег нет: диалог мёртв. Остальное оставляем живым, клиент вправе
      // повторить. Коды ядра наружу НЕ схлопываем (mapCoreError).
      await setDialogStatus(deps.pool, dialog.id, err.status === 402 ? 'error' : 'active');
      throw mapCoreError(err);
    }
    throw err;
  }
}
