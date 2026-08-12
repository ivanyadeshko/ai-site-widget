import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../app.ts';
import { CoreHttpError } from '../core/client.ts';
import type { DialogRow } from '../db/repositories/dialogs.ts';
import { listThreadTail, maxClientSeq } from '../db/repositories/messages.ts';
import type { WidgetRow } from '../db/repositories/widgets.ts';
import { ApiError, mapCoreError } from '../http/errors.ts';
import type { ParticipantToken } from '../core/types.ts';
import { reconcileTranscript } from './transcriptSync.ts';
import { MESSAGES_PAGE, toPublicMessage, type PublicMessage } from './startDialog.ts';

export type ReenterResult = {
  dialog_id: string; channel: 'chat' | 'voice';
  participant_token: ParticipantToken; messages: PublicMessage[]; next_seq: number;
};

/** identity ре-входа: ВСЕГДА новая и ВСЕГДА с префиксом respondent-. */
export const newRespondentIdentity = (): string => `respondent-${randomUUID()}`;

export async function reenterDialog(
  deps: AppDeps,
  input: { widget: WidgetRow; dialog: DialogRow },
): Promise<ReenterResult> {
  const sessionId = input.dialog.current_core_session_id;
  if (!sessionId) throw new ApiError(409, 'no_live_session', 'В этом диалоге нет живой сессии.');

  let token: ParticipantToken;
  try {
    // Прежнюю identity переиспользовать НЕЛЬЗЯ: LiveKit выкинет живого участника.
    token = await deps.core.issueParticipantToken(sessionId, newRespondentIdentity());
  } catch (err) {
    if (err instanceof CoreHttpError) throw mapCoreError(err);
    throw err;
  }

  // Хвост ЖИВОЙ сессии: лента ядра наполняется и на chat, лаг флаша ≤5с.
  // Та же общая сверка, что на transcript.ready — с дедупом по тексту, иначе
  // каждое повторное открытие вкладки удваивало бы историю.
  await reconcileTranscript(deps, { dialog: input.dialog, sessionId });

  const rows = await listThreadTail(deps.pool, input.dialog.id, MESSAGES_PAGE);
  return {
    dialog_id: input.dialog.id,
    channel: input.dialog.current_channel ?? 'chat',
    participant_token: token,
    messages: rows.map(toPublicMessage),
    next_seq: (await maxClientSeq(deps.pool, input.dialog.id)) + 1,
  };
}
