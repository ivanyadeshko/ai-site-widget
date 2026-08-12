import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import { attachCoreSession, type DialogRow } from '../db/repositories/dialogs.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import type { ParticipantToken, SessionCreate } from '../core/types.ts';

export type OpenSessionInput = {
  widget: WidgetRow;
  dialog: DialogRow;
  channel: 'chat' | 'voice';
  instructions: string;
  continueFrom?: string;
};

export type OpenSessionResult = {
  core_session_id: string;
  participant_token: ParticipantToken;
  continued_from?: string;
};

/**
 * Единственная точка создания сессии ядра.
 *
 * Ключ повторяемости — на ЛОГИЧЕСКУЮ операцию, а не на попытку:
 * `dlg:<id>:<число уже привязанных сессий + 1>`. Пока сессия не привязана,
 * повтор (ретрай сети, двойной клик, дубль POST) вычисляет ТОТ ЖЕ ключ и
 * получает от ядра ту же сессию, а не вторую платную. Счётчик, который
 * инкрементился бы перед каждой попыткой, ровно это и ломал: каждый ретрай
 * покупал новую сессию.
 *
 * Он же закрывает гонку двух параллельных запросов по одному диалогу: второй
 * приходит с тем же ключом и получает 409 `idempotency_in_progress` — роль
 * общего замка играет idempotency-хранилище ядра, локальный CAS не нужен.
 */
export async function openCoreSession(deps: AppDeps, input: OpenSessionInput): Promise<OpenSessionResult> {
  const attempt = input.dialog.core_session_ids.length + 1;
  const idempotencyKey = `dlg:${input.dialog.id}:${attempt}`;
  const body: SessionCreate = {
    channel: input.channel,
    agent: {
      instructions: input.instructions,
      ...(input.widget.agent_config.greeting ? { greeting: input.widget.agent_config.greeting } : {}),
      ...(input.widget.agent_config.voice_id ? { voice_id: input.widget.agent_config.voice_id } : {}),
      ...(input.widget.agent_config.avatar_id ? { avatar_id: input.widget.agent_config.avatar_id } : {}),
    },
    ...(input.continueFrom ? { continue_from: input.continueFrom } : {}),
    ...(input.widget.kb_ids.length > 0 ? { knowledge: { base_ids: input.widget.kb_ids, injection: 'auto' } } : {}),
    // Бюджет-предохранитель: 600 вместо дефолтных 1800 у ОБОИХ каналов.
    limits: { max_duration_s: deps.config.maxDurationS },
    client_reference: input.dialog.client_reference,
    metadata: { widget_id: input.widget.id, dialog_id: input.dialog.id },
  };

  let created;
  try {
    created = await deps.core.createSession(body, idempotencyKey);
  } catch (err) {
    // 410 = ключ принадлежит уже ЗАВЕРШЁННОЙ сессии: такое возможно, если
    // прошлая попытка успела создать сессию, но упала до привязки. Один раз
    // пробуем со свежим ключом — иначе диалог залипнет навсегда.
    if (err instanceof CoreHttpError && err.status === 410) {
      deps.log.warn({ dialogId: input.dialog.id, idempotencyKey }, 'ключ повторяемости указывает на закрытую сессию — берём свежий');
      created = await deps.core.createSession(body, `${idempotencyKey}:r${Date.now()}`);
    } else {
      throw err;
    }
  }
  await attachCoreSession(deps.pool, {
    dialogId: input.dialog.id,
    sessionId: created.session_id,
    channel: input.channel,
  });
  return {
    core_session_id: created.session_id,
    participant_token: created.participant_token,
    ...(created.continued_from ? { continued_from: created.continued_from } : {}),
  };
}
